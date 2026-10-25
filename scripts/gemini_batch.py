#!/usr/bin/env python3
"""Auto-pipeline: Gemini batch processor for FlickAtlas.

Reads the fetch queue (out/queue.json — one representative item per story,
already clustered by scripts/fetch.py), and for each NEW story:
  1. Computes a FACT fingerprint (film/person + day + rupee amounts + date)
     from the title/URL — NOT the wording — so two differently-worded
     articles about the same film+day+amount share one fingerprint.
  2. Skips anything whose fingerprint is already in out/processed.json
     (the pipeline's memory — a file, not Gemini's memory).
  3. Fetches the source article text (browser UA, r.jina.ai fallback).
  4. Calls Gemini (key rotation across GEMINI_API_KEY_1..5) with a
     structured-output schema: the draft article + its final category
     (one of the 11 pipeline categories) + optional box-office row.
  5. Writes out/gemini-batch.json and updates out/processed.json.

The script has no brain: it only matches facts (names, days, amounts).
Gemini is the only reader — it reads the full article and makes the final
call on category, content and numbers. When the script is unsure, it does
NOT group/skip — the item goes to Gemini.

Env:
  GEMINI_API_KEY_1..5  (at least one required)
  TMDB_API_KEY         (optional; resolves film name -> TMDB id)
  BATCH_SIZE           (default 2; how many NEW stories per run — kept
                        small on purpose: Google treats mass-published thin
                        AI content as scaled-content spam, so the pipeline
                        publishes FEW, LONG, fact-rich articles, not 240/day)
  DAILY_CAP            (default 20; max articles published per UTC day)
  MAX_GEMINI_CALLS     (default 6; bounds quota use per run)
Quality gate (Google safety): a draft is published ONLY if it has
  >= 300 words of body text, >= 3 sections and >= 4 facts. Thin drafts
  are marked quality-rejected in processed.json (never retried — a thin
  story stays thin; a real update gets a new fingerprint and is tried).
"""
import json
import os
import re
import sys
import time
import urllib.request
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.environ.get("OUT_DIR", os.path.join(ROOT, "out"))

MODEL = "gemini-3.5-flash-lite"
INR_TO_USD = 94.65  # site FA_RATES (config.js)

CATEGORIES = ["movies", "tv_dramas", "episodes", "box_office",
              "celebrities_events", "upcoming_releases", "ott_streaming",
              "trailers", "awards", "music_ost", "viral"]

# ---------------------------------------------------------------- fingerprints
RUPEE_RE = re.compile(
    r"(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d+)?)\s*(crore|cr|lakh|million)?",
    re.IGNORECASE)
DAY_RE = re.compile(r"\bday\s*(\d+)\b", re.IGNORECASE)
STOP = set("the a an and or of to in on for with after amid at by from as is "
           "are was were be been has have had will would its it this that "
           "box office collection collections earns earned nets net gross "
           "day india worldwide total".split())


def norm_words(text):
    t = re.sub(r"[^a-z0-9 ]", " ", (text or "").lower())
    return {w for w in t.split() if w not in STOP and len(w) > 1}


def _norm_unit(unit):
    """'cr' and 'crore' are the same unit; normalise so differently-worded
    titles about the same amount share one fingerprint."""
    u = (unit or "").lower()
    if u in ("cr", "crore"):
        return "crore"
    return u


def fingerprint(item):
    """Fact fingerprint: leading entity + day + rupee amounts + publish date.
    Two differently-worded articles about the same film+day+amount match;
    a different day or a different amount does NOT match (it is an update).
    The full wording is deliberately NOT in the fingerprint — the script
    matches facts, not prose."""
    title = item.get("title") or ""
    # leading entity: the first 2 capitalised words (usually the film/person
    # name, which titles lead with). Falls back to the first 2 content words.
    caps = [w.lower() for w in re.findall(r"[A-Za-z0-9][\w'\-]*", title)
            if w[0].isupper() or any(c.isdigit() for c in w)]
    entity = ",".join(caps[:2]) if caps else ",".join(
        sorted(norm_words(title))[:2])
    amounts = sorted({f"{m.group(1)}:{_norm_unit(m.group(2))}"
                      for m in RUPEE_RE.finditer(title)})
    days = sorted({m.group(1) for m in DAY_RE.finditer(title)})
    pub = (item.get("published") or "")[:10]
    key = "|".join([entity, ",".join(days), ",".join(amounts), pub])
    import hashlib
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:20]


# ---------------------------------------------------------------- article text
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
              "AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/126.0.0.0 Safari/537.36")


def clean_text(html):
    html = re.sub(r"(?is)<(script|style|nav|header|footer|noscript)[^>]*>.*?</\1>", " ", html)
    html = re.sub(r"(?is)<[^>]+>", " ", html)
    html = re.sub(r"&(amp|lt|gt|quot|#39|nbsp);", " ", html)
    return re.sub(r"\s+", " ", html).strip()


def fetch_article_text(url):
    """Direct fetch with a browser UA; r.jina.ai fallback. Returns text or ''.
    A 404/soft-404 page is treated as unreadable (no Gemini call, quota saved)."""
    for target in (url, "https://r.jina.ai/" + url):
        try:
            req = urllib.request.Request(target, headers={"User-Agent": BROWSER_UA})
            with urllib.request.urlopen(req, timeout=20) as r:
                raw = r.read().decode("utf-8", "ignore")
            text = clean_text(raw)
            if target.startswith("https://r.jina.ai/"):
                text = re.sub(r"(?is)^title:.*?\n", "", text)
            if re.search(r"page not found", text[:300], re.IGNORECASE):
                print(f"  fetch {target[:60]}: soft 404, trying next")
                continue
            if len(text) >= 400:
                return text[:12000]
        except Exception as e:
            print(f"  fetch {target[:60]}: {e}")
            continue
    return ""


# ---------------------------------------------------------------- quality gate
# Google safety: mass-published thin AI content is treated as scaled-content
# spam (March 2024 core update). The pipeline therefore publishes FEW, LONG,
# fact-rich articles. A draft must clear every bar below to go live.
MIN_BODY_WORDS = 300
MIN_SECTIONS = 3
MIN_FACTS = 4


def body_word_count(body):
    total = 0
    for s in (body or []):
        if not isinstance(s, dict):
            continue
        for p in (s.get("p") or []):
            total += len(str(p).split())
    return total


def quality_check(result):
    """Returns (ok, reason). A thin/generic draft is rejected, never published."""
    headline = (result.get("headline") or "").strip()
    if len(headline) < 10:
        return False, "headline-too-short"
    body = result.get("body") or []
    sections = [s for s in body if isinstance(s, dict) and s.get("h")]
    if len(sections) < MIN_SECTIONS:
        return False, f"only-{len(sections)}-sections"
    words = body_word_count(body)
    if words < MIN_BODY_WORDS:
        return False, f"only-{words}-words"
    facts = [f for f in (result.get("facts") or []) if str(f).strip()]
    if len(facts) < MIN_FACTS:
        return False, f"only-{len(facts)}-facts"
    return True, ""


# ---------------------------------------------------------------- Gemini
ARTICLE_SCHEMA = {
    "type": "object",
    "properties": {
        "category": {"type": "string", "enum": CATEGORIES},
        "headline": {"type": "string"},
        "dek": {"type": "string"},
        "body": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "h": {"type": "string"},
                "p": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["h", "p"],
        }},
        "facts": {"type": "array", "items": {"type": "string"}},
        "entities": {"type": "object", "properties": {
            "titles": {"type": "array", "items": {"type": "string"}},
            "people": {"type": "array", "items": {"type": "string"}},
        }},
        "box_office": {"type": "object", "properties": {
            "film": {"type": "string"},
            "tmdb_id": {"type": "string"},
            "day": {"type": "integer"},
            "date": {"type": "string"},
            "collection_inr_crore": {"type": "number"},
            "sources": {"type": "array", "items": {"type": "string"}},
        }},
    },
    "required": ["category", "headline", "dek", "body", "facts"],
}


def gemini_keys():
    keys = []
    for i in range(1, 6):
        k = os.environ.get(f"GEMINI_API_KEY_{i}", "").strip()
        if k:
            keys.append(k)
    if not keys:
        k = os.environ.get("GEMINI_API_KEY", "").strip()
        if k:
            keys.append(k)
    return keys


def call_gemini(keys, prompt):
    """Try each key in turn; 429/5xx moves to the next key. Returns dict or None."""
    last_err = None
    for key in keys:
        try:
            body = json.dumps({
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {
                    "responseMimeType": "application/json",
                    "responseSchema": ARTICLE_SCHEMA,
                    "maxOutputTokens": 4096,
                },
            }).encode("utf-8")
            req = urllib.request.Request(
                f"https://generativelanguage.googleapis.com/v1beta/models/"
                f"{MODEL}:generateContent",
                data=body,
                headers={"x-goog-api-key": key, "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=90) as r:
                resp = json.load(r)
            text = resp["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(text)
        except Exception as e:
            last_err = e
            print(f"  gemini key ...{key[-4:]} failed: {e}")
            continue
    print(f"  gemini: all keys failed ({last_err})")
    return None


PROMPT = """You are writing for FlickAtlas, an entertainment-info magazine.
Write ONE original article from the source article below. Do NOT copy
sentences from the source; rewrite everything in your own words.

Rules:
- Detailed, not concise: 4-6 body sections, 2-3 original paragraphs each,
  roughly 500-700 words of body text. Full, substantive paragraphs.
- Cover the news itself, background and context, the people or titles
  involved, reactions or significance, and records or legacy.
- Pick the final category from this list only: movies, tv_dramas,
  episodes, box_office, celebrities_events, upcoming_releases,
  ott_streaming, trailers, awards, music_ost, viral.
- facts: a list of plain factual statements (numbers, dates, names).
- entities: titles (films/shows) and people named in the article.
- box_office: ONLY if the article is about a film's box-office
  collections. Give the film name, the day number (1 = release day),
  the date (YYYY-MM-DD), and the collection for THAT day in INR crore
  (a number, e.g. 7.0). If the article gives a total, do NOT put it in
  collection_inr_crore — that field is the single day's collection only.
  tmdb_id: the film's TMDB id if you know it, else leave it empty.
- Never invent numbers, dates or quotes. If a fact is not in the source,
  do not write it.

Source article:
---
{article}
---
Source URL: {url}
"""


def resolve_tmdb_id(film, api_key):
    """Film name -> TMDB id via the TMDB search API. Returns str or ''."""
    if not api_key or not film:
        return ""
    try:
        q = urllib.parse.quote(film)
        url = (f"https://api.themoviedb.org/3/search/movie?api_key={api_key}"
               f"&query={q}&language=en-US&page=1")
        req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.load(r)
        results = data.get("results") or []
        if results:
            return str(results[0]["id"])
    except Exception as e:
        print(f"  tmdb lookup '{film}': {e}")
    return ""


# ---------------------------------------------------------------- main
def main():
    queue_path = os.path.join(OUT_DIR, "queue.json")
    processed_path = os.path.join(OUT_DIR, "processed.json")
    batch_path = os.path.join(OUT_DIR, "gemini-batch.json")
    batch_size = int(os.environ.get("BATCH_SIZE", "2"))
    daily_cap = int(os.environ.get("DAILY_CAP", "20"))
    max_calls = int(os.environ.get("MAX_GEMINI_CALLS", "6"))

    keys = gemini_keys()
    if not keys:
        print("No Gemini keys configured (set GEMINI_API_KEY_1..5) — skipping batch.")
        return 0
    print(f"gemini keys: {len(keys)} | batch size: {batch_size} | "
          f"daily cap: {daily_cap} | model: {MODEL}")

    if not os.path.exists(queue_path):
        print(f"ERROR: queue not found: {queue_path}")
        return 1
    with open(queue_path, encoding="utf-8") as f:
        queue = json.load(f)

    processed = {}
    if os.path.exists(processed_path):
        with open(processed_path, encoding="utf-8") as f:
            processed = json.load(f)
    print(f"queue: {len(queue)} stories | already processed: {len(processed)}")

    # Daily cap: count what this pipeline already published today (UTC).
    # Quality-rejected fingerprints do not count — they were never published.
    today = time.strftime("%Y-%m-%d", time.gmtime())
    today_count = sum(
        1 for rec in processed.values()
        if str(rec.get("processed_at", ""))[:10] == today
        and not rec.get("quality_rejected"))
    if today_count >= daily_cap:
        print(f"daily cap reached ({today_count}/{daily_cap} today) — "
              "nothing to publish, skipping batch.")
        return 0
    # The batch may only fill the remaining room under the cap.
    batch_size = min(batch_size, daily_cap - today_count)

    tmdb_key = os.environ.get("TMDB_API_KEY", "").strip()
    articles, box_rows, skipped = [], [], []
    gemini_calls = 0
    for item in queue:
        if len(articles) >= batch_size:
            break
        if gemini_calls >= max_calls:
            print(f"  max Gemini calls per run reached ({max_calls})")
            break
        fp = fingerprint(item)
        if fp in processed:
            skipped.append({"url": item.get("url"), "reason": "already-processed"})
            continue
        title = item.get("title") or ""
        url = item.get("url") or ""
        print(f"[{len(articles)+1}/{batch_size}] {title[:80]}")
        text = fetch_article_text(url)
        if len(text) < 400:
            print("  source unreadable, skipping (no Gemini call, quota saved)")
            skipped.append({"url": url, "reason": "source-unreadable"})
            continue
        gemini_calls += 1
        result = call_gemini(keys, PROMPT.format(article=text, url=url))
        if not result:
            skipped.append({"url": url, "reason": "gemini-failed"})
            continue
        ok, reason = quality_check(result)
        if not ok:
            print(f"  quality gate rejected draft: {reason} — not published")
            skipped.append({"url": url, "reason": f"quality-gate:{reason}"})
            processed[fp] = {
                "url": url, "title": title,
                "article_id": None,
                "category": result.get("category") or item.get("category") or "movies",
                "quality_rejected": True,
                "quality_reason": reason,
                "processed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            continue
        cat = result.get("category") or item.get("category") or "movies"
        if cat not in CATEGORIES:
            cat = "movies"
        article = {
            "category": cat,
            "headline": result.get("headline") or title,
            "dek": result.get("dek") or "",
            "body": result.get("body") or [],
            "facts": result.get("facts") or [],
            "entities": result.get("entities") or {"titles": [], "people": []},
            "source_url": url,
            "source": item.get("source") or "",
            "published": item.get("published") or "",
        }
        articles.append(article)
        bo = result.get("box_office") or {}
        if bo.get("film") and bo.get("day") and bo.get("collection_inr_crore") is not None:
            # A zero/missing collection means Gemini had no number (e.g. the
            # source was a 404 page) — never write a 0 into the day-wise data.
            if float(bo["collection_inr_crore"]) <= 0:
                print("  box office: collection missing/zero, row dropped")
            else:
                tmdb_id = (bo.get("tmdb_id") or "").strip()
                if not tmdb_id:
                    tmdb_id = resolve_tmdb_id(bo.get("film"), tmdb_key)
                if tmdb_id:
                    box_rows.append({
                    "tmdb_id": tmdb_id,
                    "film": bo.get("film"),
                    "day": int(bo["day"]),
                    "date": bo.get("date") or (item.get("published") or "")[:10],
                    "collection_usd": round(float(bo["collection_inr_crore"]) * 1e7 / INR_TO_USD),
                    "collection_inr_crore": float(bo["collection_inr_crore"]),
                    "sources": bo.get("sources") or [item.get("source") or ""],
                    "article_url": url,
                })
        processed[fp] = {
            "url": url, "title": title,
            "article_id": None,  # filled by apply-auto.py
            "category": cat,
            "processed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

    out = {"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "count": len(articles), "articles": articles,
           "box_office": box_rows, "skipped": skipped}
    with open(batch_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    with open(processed_path, "w", encoding="utf-8") as f:
        json.dump(processed, f, ensure_ascii=False, indent=1)
    print(f"batch: {len(articles)} articles, {len(box_rows)} box-office rows, "
          f"{len(skipped)} skipped -> {batch_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
