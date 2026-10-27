#!/usr/bin/env python3
"""Auto-pipeline: Gemini batch processor for FlickAtlas.

Reads the fetch queue (out/queue.json — one representative item per story,
already clustered by scripts/fetch.py), and for each NEW story:
  0. RANK stage (two-stage pipeline): the queue holds ~260 stories but
     each run writes only 2 posts, so queue order alone means the tail is
     never even read. First, ONE Gemini call ranks the newest RANK_COUNT
     unprocessed headlines by newsworthiness (title/source/category/
     published only — no article fetch) AND groups stories about the
     SAME event (semantic dedup: same story different wording, different
     title same information, or same title+information different writing
     = one group; same title different information = different groups).
     Each group's representative (highest-ranked member) is processed;
     the other members are recorded in out/processed.json as duplicates
     (never retried, never counted in the daily cap). The rank call ALSO
     assigns each candidate its TRUE category (the script's hinted
     category is keyword-based and often wrong); the write loop then
     attempts items ROUND-ROBIN across those categories — one per
     category first, repeats only on a second pass — so one batch never
     lands in a single category. A failed/empty ranking falls back
     to queue order; missing/invalid groups skip dedup only.
     The rank pool ALSO carries a per-category top-up (build_candidate_
     pool): the newest 2 pending items of every category missing from
     the newest RANK_COUNT, so a slow category's stories are never
     invisible to the rank call. And the write loop enforces a
     NEEDS-BASED DAILY ALLOCATION (CATEGORY_QUOTAS, sums to DAILY_CAP,
     owner principle 2026-10-28): every category gets a guaranteed
     share by need — more where the need is higher, less where lower —
     so all categories move together and none is starved while another
     feasts. A category whose quota is full is deferred while categories
     with room remain; leftover room goes to any category with fresh
     items, so the day's budget is never wasted.
  1. Computes a FACT fingerprint (film/person + day + rupee amounts + date)
     from the title/URL — NOT the wording — so two differently-worded
     articles about the same film+day+amount share one fingerprint.
  2. Skips anything whose fingerprint is already in out/processed.json
     (the pipeline's memory — a file, not Gemini's memory).
  3. Fetches the source article text (browser UA, r.jina.ai fallback).
  4. Calls Gemini (key rotation across GEMINI_API_KEY_1..6) with a
     structured-output schema: the draft article + its final category
     (one of the 11 pipeline categories) + optional box-office row.
  5. Attaches an `images` array to each article (spec §5): the article's
     main title's TMDB poster/backdrop (source "TMDB"), else the source
     page's own og:image (source = the outlet NAME only). Empty when
     no image is available — image URLs are never invented.
  6. Writes out/gemini-batch.json and updates out/processed.json.

The script has no brain: it only matches facts (names, days, amounts).
Gemini is the only reader — it reads the full article and makes the final
call on category, content and numbers. When the script is unsure, it does
NOT group/skip — the item goes to Gemini.

Env:
  GEMINI_API_KEY_1..6  (at least one required)
  TMDB_API_KEY         (optional; resolves film name -> TMDB id)
  BATCH_SIZE           (default 2; how many NEW stories per run — kept
                        small on purpose: Google treats mass-published thin
                        AI content as scaled-content spam, so the pipeline
                        publishes FEW, LONG, fact-rich articles, not 240/day)
  DAILY_CAP            (default 20; max articles published per UTC day)
  MAX_GEMINI_CALLS     (default 6; bounds quota use per run — the RANK
                        call counts as 1 of these)
  RANK_COUNT           (default 60; how many newest unprocessed headlines
                        the RANK stage considers each run)
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
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

# Sibling module: deterministic day-wise box-office extraction (regex
# fallback when Gemini's box_office object is empty/incomplete).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import boxoffice_extract

try:
    # Per-run record for the stats dashboard (out/step-runs.json).
    # A missing/broken helper must never break this script.
    import step_runs
except Exception:  # noqa: BLE001 - record helper is best-effort
    step_runs = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.environ.get("OUT_DIR", os.path.join(ROOT, "out"))

MODEL = "gemini-3.5-flash-lite"
INR_TO_USD = 94.65  # site FA_RATES (config.js)
TMDB_IMG = "https://image.tmdb.org/t/p"  # same base as site CONFIG.IMG

CATEGORIES = ["movies", "tv_dramas", "episodes", "box_office",
              "celebrities_events", "upcoming_releases", "ott_streaming",
              "trailers", "awards", "music_ost", "viral"]

# Needs-based daily allocation (owner principle 2026-10-28): all
# categories move TOGETHER — none starved, none feasting; more where
# the need is higher, less where it is lower, by need. The quotas sum
# to DAILY_CAP (40 in the workflow); the total cap still binds, and
# leftover room flows to any category with fresh items (see main()).
# Why each number (from the 2026-10-26/27 published splits + supply):
#   movies 6, box_office 6 — the high-volume core; box_office was
#     taking 9-12/day, but the day-wise FIGURES come from the
#     multisource reader, not these articles, so 6 covers the real
#     collection news and frees slots for the rest.
#   celebrities_events 5 — was 8-10/day; 5 covers significant news,
#     routine gossip already ranks low.
#   upcoming_releases 4, ott_streaming 4 — daily announcements and
#     OTT releases; OTT is thin and needs steady feeding.
#   tv_dramas 4 — Pakistani dramas air daily and need daily coverage
#     (the owner's example). Episode SUMMARIES are separate: they have
#     their own budget in scripts/episode-guides.py
#     (SUMMARY_MAX_PER_DAY=2, 1/run) and do NOT draw from this cap.
#   trailers 3 — teasers/trailers drop daily; 3 covers the big ones.
#   episodes 2, awards 2, music_ost 2, viral 2 — a guaranteed floor:
#     each was 0-1/day (starved), never zero again while fresh items
#     exist. Unused quota flows to leftovers, never wasted.
CATEGORY_QUOTAS = {
    "movies": 6,
    "box_office": 6,
    "celebrities_events": 5,
    "upcoming_releases": 4,
    "ott_streaming": 4,
    "tv_dramas": 4,
    "trailers": 3,
    "episodes": 2,
    "awards": 2,
    "music_ost": 2,
    "viral": 2,
}

# Display name (scripts/fetch.py classify) -> pipeline slug. The queue's
# script category is keyword-based and often wrong; it is used ONLY to
# make sure every category is represented in the rank pool (the rank
# call assigns the true category). Unmapped names fall back to "movies".
SCRIPT_CATEGORY_TO_SLUG = {
    "Box Office": "box_office",
    "Awards": "awards",
    "Trailers": "trailers",
    "Music / OST": "music_ost",
    "Episodes": "episodes",
    "Upcoming releases": "upcoming_releases",
    "OTT / Streaming": "ott_streaming",
    "TV & Dramas": "tv_dramas",
    "Celebrity news & events": "celebrities_events",
    "Movies": "movies",
    "Entertainment viral": "viral",
}

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


def extract_page_image(html, base_url):
    """The source page's own image (og:image / twitter:image), absolute URL.
    Returns '' when the page carries no usable image. Only http(s) URLs
    are accepted; relative paths are resolved against the article URL."""
    if not html:
        return ""
    m = re.search(
        r'<meta[^>]+(?:property|name)=["\'](?:og:image|twitter:image)["\']'
        r'[^>]+content=["\']([^"\']+)["\']',
        html, re.IGNORECASE)
    if not m:
        m = re.search(
            r'<meta[^>]+content=["\']([^"\']+)["\']'
            r'[^>]+(?:property|name)=["\'](?:og:image|twitter:image)["\']',
            html, re.IGNORECASE)
    if not m:
        return ""
    url = urllib.parse.urljoin(base_url or "", m.group(1).strip())
    if not url.lower().startswith(("http://", "https://")):
        return ""
    return url


def fetch_article_text(url):
    """Direct fetch with a browser UA; r.jina.ai fallback.
    Returns (text, image_url): the article text (or '') and the source
    page's og:image URL (or ''). A 404/soft-404 page is treated as
    unreadable (no Gemini call, quota saved)."""
    image = ""
    for target in (url, "https://r.jina.ai/" + url):
        try:
            req = urllib.request.Request(target, headers={"User-Agent": BROWSER_UA})
            with urllib.request.urlopen(req, timeout=20) as r:
                raw = r.read().decode("utf-8", "ignore")
            if not image:
                image = extract_page_image(raw, url)
            text = clean_text(raw)
            if target.startswith("https://r.jina.ai/"):
                text = re.sub(r"(?is)^title:.*?\n", "", text)
            if re.search(r"page not found", text[:300], re.IGNORECASE):
                print(f"  fetch {target[:60]}: soft 404, trying next")
                continue
            if len(text) >= 400:
                return text[:12000], image
        except Exception as e:
            print(f"  fetch {target[:60]}: {e}")
            continue
    return "", image


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

# RANK stage schema: Gemini returns the candidate indices ordered most
# newsworthy first, plus "groups" of indices about the SAME story
# (semantic dedup — the script's fingerprint only sees titles/numbers,
# Gemini's brain sees meaning). Indices refer to the numbered list in
# RANK_PROMPT. Every candidate index appears in exactly one group; a
# story with no duplicate is a group of one.
RANK_SCHEMA = {
    "type": "object",
    "properties": {
        "ranked": {"type": "array", "items": {"type": "integer"}},
        "groups": {"type": "array", "items": {"type": "array",
                                               "items": {"type": "integer"}}},
        # OPTIONAL: one category per candidate, in the same index order
        # as the input list (categories[i] = candidate i's category).
        # Gemini assigns the TRUE category (the script's hinted category
        # is keyword-based and often wrong); the caller uses this to
        # round-robin across categories so one batch never lands in a
        # single category. Old-format responses without it still work.
        "categories": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["ranked", "groups"],
}


def gemini_keys():
    keys = []
    for i in range(1, 7):
        k = os.environ.get(f"GEMINI_API_KEY_{i}", "").strip()
        if k:
            keys.append(k)
    if not keys:
        k = os.environ.get("GEMINI_API_KEY", "").strip()
        if k:
            keys.append(k)
    return keys


def call_gemini(keys, prompt, schema=None, max_tokens=4096):
    """Try each key in turn; 429/5xx moves to the next key. Returns dict or None.
    schema defaults to ARTICLE_SCHEMA; pass RANK_SCHEMA for ranking calls."""
    schema = ARTICLE_SCHEMA if schema is None else schema
    last_err = None
    for key in keys:
        try:
            body = json.dumps({
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {
                    "responseMimeType": "application/json",
                    "responseSchema": schema,
                    "maxOutputTokens": max_tokens,
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
- Detailed, not concise: 6-8 body sections, 1-2 original paragraphs each,
  roughly 500-700 words of body text in total. Full, substantive
  paragraphs — more short sections with clear headings, so a reader can
  scan the article and jump to the part they want.
- Cover the news itself, background and context, the people or titles
  involved, reactions or significance, and records or legacy.
- End with a final section headed "News Overview": 2-3 sentences recapping
  the story in your own words, adding no new facts, numbers, dates, names
  or quotes beyond what the sections above already state.
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

RANK_PROMPT = """You are the news editor for FlickAtlas, an entertainment-info
magazine (Bollywood, Pakistani dramas, Hollywood, world cinema).

Below are {n} fresh entertainment stories (title, outlet, category,
publish time). Rank them by NEWSWORTHINESS — most newsworthy first.
Return ONLY JSON with these fields:
{{"ranked": [3, 0, 12, ...], "groups": [[3, 7], [0], [12, 5], ...], "categories": ["box_office", "movies", ...]}}
- "ranked": every index exactly once, most newsworthy first.
- "categories": one category per story, in the SAME order as the
  numbered list below (categories[i] is story [i]'s category). Pick
  from: movies, tv_dramas, episodes, box_office, celebrities_events,
  upcoming_releases, ott_streaming, trailers, awards, music_ost, viral.
  Use your judgment — correct the hinted category shown with each story
  when it is wrong.
- "groups": group stories about the SAME event/story together, even if
  the title wording differs. Same title but DIFFERENT information =
  different groups. Different title but SAME information = same group.
  Same title and same information, only different writing = same group.
  Within a group, list the strongest/most complete version first.
  Every candidate index appears in exactly one group; a story with no
  duplicate is a group of one.

Rank HIGH:
- Big films / big stars, box-office numbers (day collections, records,
  advance booking), major announcements (trailer, release date, casting).
- Fresh, significant events: awards, controversies with real stakes,
  major OTT releases.
Rank LOW:
- Routine gossip, minor celebrity quotes, repetitive updates on the
  same story, clickbait-style speculation, low-value viral clips.
- Stories that look like duplicates of each other — group them together
  (the "groups" field handles this); keep the strongest version first
  in its group.

Stories:
{items}
"""


def _parse_published(value):
    """Parse a queue item's published date to an aware UTC datetime.
    Queue dates arrive in mixed formats — RFC 2822
    ('Sun, 25 Oct 2026 22:36:11 +0530') and ISO 8601
    ('2026-10-25T22:09:40+05:30'). Returns None when missing or
    unparseable (the item then sorts as oldest)."""
    if not value:
        return None
    s = str(value).strip()
    dt = None
    try:
        dt = parsedate_to_datetime(s)
    except (TypeError, ValueError):
        dt = None
    if dt is None:
        try:
            dt = datetime.fromisoformat(s)
        except ValueError:
            return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _published_ts(item):
    """Sort key for newest-first ordering; 0.0 when the date is missing
    or unparseable (sorts last, queue order preserved by stable sort)."""
    dt = _parse_published(item.get("published"))
    return dt.timestamp() if dt else 0.0


def round_robin_order(ordered, cat_of):
    """Reorder ranked items so the write loop attempts one per category
    before any repeat: [best of cat A, best of cat B, ... , 2nd of A,
    2nd of B, ...]. Items keep ranked order within a category;
    categories are ordered by first appearance in `ordered`. With
    batch_size 4 and 4+ distinct categories, the first 4 attempted are
    one per category; with fewer categories, the second pass fills the
    batch with repeats. cat_of(item) -> category slug."""
    by_cat = {}
    for item in ordered:
        by_cat.setdefault(cat_of(item), []).append(item)
    out = []
    i = 0
    while True:
        progressed = False
        for items in by_cat.values():
            if i < len(items):
                out.append(items[i])
                progressed = True
        if not progressed:
            break
        i += 1
    return out


def script_category_slug(item):
    """Queue item's script category (fetch.py display name) -> slug.
    Only used for rank-pool representation; the rank call assigns the
    true category. Unknown names fall back to "movies"."""
    return SCRIPT_CATEGORY_TO_SLUG.get(
        (item.get("category") or "").strip(), "movies")


def published_today_by_category(processed, today):
    """Articles published today (UTC) per FINAL category. Same counting
    rule as the daily cap: quality-rejected and duplicates do not count
    (they were never published). The category recorded in processed.json
    is the final one from the write call — that is the ground truth."""
    counts = {c: 0 for c in CATEGORIES}
    for rec in processed.values():
        if str(rec.get("processed_at", ""))[:10] != today:
            continue
        if rec.get("quality_rejected") or rec.get("duplicate"):
            continue
        cat = rec.get("category") or "movies"
        counts[cat if cat in CATEGORIES else "movies"] += 1
    return counts


def build_candidate_pool(pending, rank_count):
    """Rank pool: the newest `rank_count` pending items, PLUS a
    per-category top-up. Without the top-up, a slow category's items
    age out of the newest-100 pool within ~2h of fetch (the queue
    turns over fast) and are never ranked at all — no quota can save
    an item the rank call never sees. The top-up adds the newest 2
    pending items of every slug-category missing from the pool, so
    every category with fresh items is always in front of Gemini.
    Pool size is at most rank_count + 2 per category."""
    newest = sorted(pending, key=_published_ts, reverse=True)
    pool = newest[:rank_count]
    in_pool = {id(it) for it in pool}
    have = {script_category_slug(it) for it in pool}
    beyond = {}
    for item in newest[rank_count:]:
        beyond.setdefault(script_category_slug(item), []).append(item)
    for cat, items in beyond.items():
        if cat in have:
            continue
        for item in items[:2]:
            if id(item) not in in_pool:
                pool.append(item)
                in_pool.add(id(item))
    return pool


def rank_stories(keys, candidates):
    """One Gemini call ranking candidate items by newsworthiness, grouping
    stories about the same event (semantic dedup — the script's
    fingerprint only sees titles/numbers, Gemini's brain sees meaning),
    AND assigning each candidate its TRUE category (the script's hinted
    category is keyword-based and often wrong — Gemini corrects it).
    Returns (ordered, dup_pairs, cat_map):
    - ordered: the candidate list reordered best-first, with each
      duplicate group's representative only (representative = the group
      member ranked highest). Candidates Gemini omits from 'ranked' go
      last, in newest-first order.
    - dup_pairs: [(duplicate_item, representative_item), ...] for every
      non-representative group member, so the caller can record them as
      processed duplicates.
    - cat_map: {id(candidate_item): gemini_category_slug} — one entry
      per candidate. Invalid/missing entries fall back to the item's
      script category, then to "movies".
    Returns (None, [], {}) on ranking failure (caller falls back to
    queue order). When 'groups' is missing/empty/invalid but 'ranked' is
    fine, dedup is skipped and (ordered, [], cat_map) is returned —
    ranking order kept, no item dropped."""
    lines = []
    for i, item in enumerate(candidates):
        lines.append(
            f"[{i}] {(item.get('title') or '').strip()} — "
            f"{(item.get('source') or '').strip()} | "
            f"{(item.get('category') or '').strip()} | "
            f"{(item.get('published') or '').strip()}")
    result = call_gemini(keys, RANK_PROMPT.format(n=len(candidates),
                                                  items="\n".join(lines)),
                         schema=RANK_SCHEMA, max_tokens=2048)
    if not result:
        return None, [], {}
    ranked = result.get("ranked") or []
    # Gemini-assigned categories, parallel to the candidate list. Validate
    # each slug; fall back to the script category, then "movies".
    raw_cats = result.get("categories")
    cat_map = {}
    for i, item in enumerate(candidates):
        c = None
        if isinstance(raw_cats, list) and i < len(raw_cats):
            v = raw_cats[i]
            if isinstance(v, str) and v.strip() in CATEGORIES:
                c = v.strip()
        if c is None:
            s = item.get("category") or ""
            c = s if s in CATEGORIES else "movies"
        cat_map[id(item)] = c
    seen, order = set(), []
    for idx in ranked:
        # JSON booleans are ints in Python — exclude them explicitly.
        if (isinstance(idx, int) and not isinstance(idx, bool)
                and 0 <= idx < len(candidates) and idx not in seen):
            seen.add(idx)
            order.append(idx)
    if not order:
        return None, [], {}
    for i in range(len(candidates)):
        if i not in seen:
            order.append(i)
    ordered = [candidates[i] for i in order]
    # Semantic dedup: parse "groups". A missing/empty/invalid groups
    # field skips dedup — ranking order is kept, nothing is dropped.
    groups = result.get("groups")
    if not isinstance(groups, list) or not groups:
        return ordered, [], cat_map
    rank_pos = {idx: pos for pos, idx in enumerate(order)}
    group_of, rep_of = {}, {}
    gid = 0
    for group in groups:
        if not isinstance(group, list):
            continue
        members = []
        for idx in group:
            if (isinstance(idx, int) and not isinstance(idx, bool)
                    and 0 <= idx < len(candidates)
                    and idx not in group_of and idx not in members):
                members.append(idx)
        if not members:
            continue
        rep = min(members, key=lambda i: rank_pos[i])
        for idx in members:
            group_of[idx] = gid
        rep_of[gid] = rep
        gid += 1
    if not rep_of:
        return ordered, [], cat_map
    ordered, dup_pairs = [], []
    for idx in order:
        if idx not in group_of or idx == rep_of[group_of[idx]]:
            ordered.append(candidates[idx])
        else:
            dup_pairs.append((candidates[idx],
                              candidates[rep_of[group_of[idx]]]))
    return ordered, dup_pairs, cat_map


def resolve_tmdb_id(film, api_key):
    """Film name -> TMDB id via the TMDB search API. Returns str or ''."""
    tmdb_id, _ = tmdb_search_title(film, api_key)
    return tmdb_id


def tmdb_search_title(name, api_key):
    """Title name -> (TMDB id, media_type). Tries movie search first, then
    TV search. Returns ("", "") when nothing matches. The search API is
    authoritative here — Gemini's tmdb_id is never trusted for images,
    so a hallucinated id can never attach the wrong film's poster."""
    if not api_key or not name:
        return "", ""
    for media, path in (("movie", "search/movie"), ("tv", "search/tv")):
        try:
            q = urllib.parse.quote(name)
            url = (f"https://api.themoviedb.org/3/{path}?api_key={api_key}"
                   f"&query={q}&language=en-US&page=1")
            req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA})
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.load(r)
            results = data.get("results") or []
            if results:
                return str(results[0]["id"]), media
        except Exception as e:
            print(f"  tmdb lookup '{name}' ({media}): {e}")
    return "", ""


def tmdb_details(tmdb_id, media_type, api_key):
    """TMDB details for one title (movie or tv). Returns the record dict
    or None. Only poster_path / backdrop_path / title are used."""
    if not api_key or not tmdb_id:
        return None
    kind = "tv" if media_type == "tv" else "movie"
    try:
        url = (f"https://api.themoviedb.org/3/{kind}/{tmdb_id}"
               f"?api_key={api_key}&language=en-US")
        req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except Exception as e:
        print(f"  tmdb details '{tmdb_id}' ({kind}): {e}")
        return None


def build_images(result, item, page_image, tmdb_key):
    """The article's `images` array: [{url, caption, source}].
    - The article's main title (box_office film, else first entities
      title): its TMDB poster/backdrop, source "TMDB".
    - Else the source page's own image (og:image), source = the outlet
      NAME only (never a link, never a URL).
    - Else [] — an image URL is never invented."""
    bo = result.get("box_office") or {}
    entities = result.get("entities") or {}
    film = (bo.get("film") or "").strip()
    if not film:
        titles = [str(t).strip() for t in (entities.get("titles") or [])
                  if str(t or "").strip()]
        film = titles[0] if titles else ""
    if film and tmdb_key:
        tmdb_id, media = tmdb_search_title(film, tmdb_key)
        if tmdb_id:
            details = tmdb_details(tmdb_id, media, tmdb_key)
            if details:
                name = details.get("title") or details.get("name") or film
                imgs = []
                bd = details.get("backdrop_path") or ""
                pp = details.get("poster_path") or ""
                if bd:
                    imgs.append({"url": f"{TMDB_IMG}/w1280{bd}",
                                 "caption": name, "source": "TMDB"})
                if pp:
                    imgs.append({"url": f"{TMDB_IMG}/w500{pp}",
                                 "caption": name, "source": "TMDB"})
                if imgs:
                    return imgs
    # Fallback: the story's own image from the source page.
    if page_image:
        source_name = (item.get("source") or "").strip()
        if source_name:
            caption = (result.get("headline") or item.get("title") or "").strip()
            return [{"url": page_image, "caption": caption[:120],
                     "source": source_name}]
    return []


# ---------------------------------------------------------------- main
def _gemini_row_date(bo, entry, item):
    """Row date for a Gemini box_office object. Gemini's date is taken
    verbatim when present (validate_box_row rejects it if it is invalid
    or in the future — e.g. the live Drishyam row's "2026-00-00");
    otherwise derive Day N from the film's release date (release +
    N-1), which is always a real date. The old fallback (the source
    article's published date [:10]) is dropped — a source published
    date is often RFC2822, whose [:10] is not a date at all."""
    d = (bo.get("date") or "").strip()
    if d:
        return d
    rel = (entry.get("release_date") or "").strip()
    try:
        return (date.fromisoformat(rel) +
                timedelta(days=int(bo["day"]) - 1)).isoformat()
    except (ValueError, TypeError):
        return ""


def main():
    queue_path = os.path.join(OUT_DIR, "queue.json")
    processed_path = os.path.join(OUT_DIR, "processed.json")
    batch_path = os.path.join(OUT_DIR, "gemini-batch.json")
    batch_size = int(os.environ.get("BATCH_SIZE", "2"))
    daily_cap = int(os.environ.get("DAILY_CAP", "20"))
    max_calls = int(os.environ.get("MAX_GEMINI_CALLS", "6"))

    keys = gemini_keys()
    if not keys:
        print("No Gemini keys configured (set GEMINI_API_KEY_1..6) — skipping batch.")
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
    # Quality-rejected fingerprints do not count — they were never
    # published. Neither do semantic duplicates — they are the same story
    # as a published item, recorded only so they are never retried.
    today = time.strftime("%Y-%m-%d", time.gmtime())
    today_count = sum(
        1 for rec in processed.values()
        if str(rec.get("processed_at", ""))[:10] == today
        and not rec.get("quality_rejected")
        and not rec.get("duplicate"))
    if today_count >= daily_cap:
        print(f"daily cap reached ({today_count}/{daily_cap} today) — "
              "nothing to publish, skipping batch.")
        if step_runs is not None:
            # Record the REAL reason: without this the aggregate step
            # synthesizes "no-new-data" for the run and the cap stays
            # invisible in the panel. (Owner decision: raise vs keep.)
            step_runs.record(
                "gemini_batch", status="success",
                checked={"candidates": 0,
                         "detail": f"daily cap {today_count}/{daily_cap} "
                                   "reached; batch skipped"},
                changed={"added": [], "updated": [], "count": 0},
                reason="cap")
        return 0
    # The batch may only fill the remaining room under the cap.
    batch_size = min(batch_size, daily_cap - today_count)

    # Needs-based daily allocation (owner principle 2026-10-28): every
    # category gets a guaranteed share of the day's DAILY_CAP, by need.
    # A category whose quota is full is deferred while categories with
    # room remain; leftover room goes to any category with fresh items.
    # The quotas sum to 40 (= the workflow's DAILY_CAP); if DAILY_CAP
    # ever changes, the total cap still binds and the overflow below
    # fills the rest, so no scaling logic is needed here.
    published_by_cat = published_today_by_category(processed, today)
    quota_left = {c: max(0, CATEGORY_QUOTAS.get(c, 0)
                         - published_by_cat.get(c, 0))
                  for c in CATEGORIES}
    print(f"quota today: published {published_by_cat}; "
          f"remaining {quota_left}")

    # ---- RANK stage (two-stage pipeline) --------------------------------
    # The queue holds ~260 stories but each run writes only 2 posts. In
    # queue order alone, the tail is never even read. So: rank the newest
    # RANK_COUNT unprocessed headlines with ONE Gemini call (headlines
    # only, no article fetch), then process in ranked order. The write
    # loop, batch size, daily cap, quality gate and dedup below are
    # unchanged. A failed/empty ranking falls back to plain queue order
    # — never a crash, never a wasted run. The ranking call counts as
    # 1 of MAX_GEMINI_CALLS, so the counter starts here, before it.
    gemini_calls = 0
    rank_count = int(os.environ.get("RANK_COUNT", "60"))
    pending = [item for item in queue if fingerprint(item) not in processed]
    ordered = list(queue)
    ranked_count = 0  # headlines Gemini actually ranked this run
    cat_map = {}  # id(item) -> Gemini-assigned category (rank call)
    if pending:
        if rank_count > 0:
            candidates = build_candidate_pool(pending, rank_count)
            print(f"rank: {len(pending)} unprocessed, ranking newest "
                  f"{len(candidates)} (incl. per-category top-up)")
            gemini_calls += 1
            ranked, dup_pairs, cat_map = rank_stories(keys, candidates)
            if ranked:
                ranked_count = len(candidates)
                # Semantic dedup: these are the same story as a
                # higher-ranked item (different wording). Record them as
                # processed duplicates so they are never retried and never
                # count toward the daily cap. Their representative stays
                # in the queue and is processed normally.
                excluded_ids = {id(it) for it in ranked}
                if dup_pairs:
                    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                    for dup, rep in dup_pairs:
                        fp = fingerprint(dup)
                        if fp not in processed:
                            processed[fp] = {
                                "url": dup.get("url"),
                                "title": dup.get("title"),
                                "duplicate": True,
                                "duplicate_of": rep.get("url"),
                                "processed_at": now,
                            }
                        excluded_ids.add(id(dup))
                    print(f"rank: {len(dup_pairs)} duplicate(s) recorded")
                ordered = ranked + [it for it in queue
                                   if id(it) not in excluded_ids]
                print(f"rank: order set, top: "
                      f"{(ranked[0].get('title') or '')[:60]}")
            else:
                print("rank: ranking failed/empty — falling back to "
                      "queue order")
        else:
            print("rank: RANK_COUNT<=0 — ranking disabled, queue order")
    else:
        print("rank: nothing unprocessed — skipping ranking")

    # Category-diverse attempt order: one per category first (Gemini's
    # categories from the rank call; script category as fallback — e.g.
    # when ranking failed and `ordered` fell back to queue order).
    # The write loop below is unchanged; it just attempts items in this
    # order, so the first batch_size that pass are one per category.
    def _cat_of(item):
        c = cat_map.get(id(item)) or item.get("category") or "movies"
        return c if c in CATEGORIES else "movies"
    attempt_order = round_robin_order(ordered, _cat_of)

    # Quota-first attempt order: items whose PREDICTED category still
    # has daily quota room go first (round-robin across those
    # categories); items whose category quota is full go last as
    # leftover fill, so an unused quota never wastes budget. Predicted
    # category = the rank call's assignment (script category fallback);
    # the FINAL category is decided by the write call and counted in
    # processed.json, so a rank-vs-final misprediction can overshoot a
    # quota by one — the total DAILY_CAP still binds, and the next run
    # sees the category over quota and defers it.
    preferred = [it for it in attempt_order
                 if quota_left.get(_cat_of(it), 0) > 0]
    overflow = [it for it in attempt_order
                if quota_left.get(_cat_of(it), 0) <= 0]
    attempt_order = preferred + overflow
    print(f"quota: {len(preferred)} under-quota first, "
          f"{len(overflow)} leftover")

    tmdb_key = os.environ.get("TMDB_API_KEY", "").strip()
    # Published titles (for box-office tmdb_id resolution): local,
    # no secret, no API call. TMDB_API_KEY is not a repo secret, so the
    # old TMDB-API lookup always returned "" and every row was silently
    # dropped. Rows are only produced for PUBLISHED titles.
    published = boxoffice_extract.load_published(ROOT)
    articles, box_rows, skipped = [], [], []
    for item in attempt_order:
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
        text, page_image = fetch_article_text(url)
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
            "images": build_images(result, item, page_image, tmdb_key),
            "source_url": url,
            "source": item.get("source") or "",
            "published": item.get("published") or "",
        }
        articles.append(article)
        # --- box-office rows (day-wise) ---
        # Gemini's box_office object first; when it is empty/incomplete,
        # a deterministic regex fallback over the article Gemini just
        # wrote (scripts/boxoffice_extract.py: facts first, then body).
        # tmdb_id comes from FA_PUBLISHED, never the TMDB API (the API
        # key is not a repo secret, so resolve_tmdb_id() always returned
        # "" and every row was silently dropped). A film that is not
        # published gets NO row — it could never display.
        bo = result.get("box_office") or {}
        n_bo_before = len(box_rows)
        if bo.get("film") and bo.get("day") and bo.get("collection_inr_crore") is not None:
            # A zero/missing collection means Gemini had no number (e.g. the
            # source was a 404 page) — never write a 0 into the day-wise data.
            if float(bo["collection_inr_crore"]) <= 0:
                print("  box office: collection missing/zero, row dropped")
            else:
                tmdb_id = (bo.get("tmdb_id") or "").strip()
                entry = None
                if tmdb_id:
                    entry = next((e for e in published.values()
                                  if e["tmdb_id"] == tmdb_id), None)
                if entry is None:
                    entry = boxoffice_extract.match_published(
                        bo.get("film"), published)
                if entry is None:
                    print(f"  box office: '{bo.get('film')}' not published, row dropped")
                else:
                    # The row is validated BEFORE it is appended — Gemini's
                    # own box_office object used to bypass the extractor's
                    # advance/pre-sales exclusion entirely, and nothing
                    # checked the date. Two bogus rows went live 2026-10-26
                    # that way (Ramayana Day 1 pre-sales for an unreleased
                    # film; Drishyam Day 24 with date "2026-00-00").
                    # Every rejection is logged, never silent.
                    row = {
                        "tmdb_id": entry["tmdb_id"],
                        "film": entry["title"],
                        "day": int(bo["day"]),
                        "date": _gemini_row_date(bo, entry, item),
                        "collection_usd": round(float(bo["collection_inr_crore"]) * 1e7 / INR_TO_USD),
                        "collection_inr_crore": float(bo["collection_inr_crore"]),
                        "sources": bo.get("sources") or [item.get("source") or ""],
                        "article_url": url,
                    }
                    ok, reason = boxoffice_extract.validate_box_row(
                        row, entry, article=article)
                    if not ok:
                        print(f"  box office: row rejected ({row['film']} "
                              f"Day {row['day']}): {reason}")
                    else:
                        box_rows.append(row)
        if len(box_rows) == n_bo_before:
            # Gemini gave no usable row — extract day-wise figures from
            # the article itself. No extra Gemini call, no invented
            # figures; the extractor only takes single-day figures that
            # are actually stated (never totals, never weekend splits).
            # The extractor validates its own rows; the gate below is
            # defence in depth (a row must pass in both places).
            fb_rows = boxoffice_extract.extract_box_rows(article, published)
            kept = []
            for r in fb_rows:
                ent = next((e for e in published.values()
                            if e["tmdb_id"] == r["tmdb_id"]), None)
                ok, reason = boxoffice_extract.validate_box_row(
                    r, ent, article=article)
                if not ok:
                    print(f"  box office: fallback row rejected "
                          f"({r['film']} Day {r['day']}): {reason}")
                else:
                    kept.append(r)
            fb_rows = kept
            if fb_rows:
                print(f"  box office: fallback extracted {len(fb_rows)} row(s) "
                      f"({', '.join('Day ' + str(r['day']) for r in fb_rows)})")
                box_rows.extend(fb_rows)
        processed[fp] = {
            "url": url, "title": title,
            "article_id": None,  # filled by apply-auto.py
            "category": cat,
            "processed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

    print(f"batch categories: {', '.join(a.get('category') for a in articles)}")
    out = {"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "count": len(articles), "articles": articles,
           "box_office": box_rows, "skipped": skipped,
           "ranked": ranked_count, "unprocessed": len(pending)}
    with open(batch_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    with open(processed_path, "w", encoding="utf-8") as f:
        json.dump(processed, f, ensure_ascii=False, indent=1)
    print(f"batch: {len(articles)} articles, {len(box_rows)} box-office rows, "
          f"{len(skipped)} skipped -> {batch_path}")
    if step_runs is not None:
        reason = None
        if not articles and not box_rows:
            reason = "no-new-data"
        # Per-category split published today (final categories), so the
        # panel shows whether all categories are moving together.
        today_split = {c: published_by_cat.get(c, 0)
                       + sum(1 for a in articles
                             if a.get("category") == c)
                       for c in CATEGORIES}
        split_txt = ", ".join(f"{c} {today_split[c]}/{CATEGORY_QUOTAS[c]}"
                              for c in CATEGORIES)
        step_runs.record(
            "gemini_batch", status="success",
            checked={"candidates": len(articles) + len(skipped),
                     "detail": "news queue items drafted this run; "
                               "%d still unprocessed; today by category: "
                               "%s" % (len(pending), split_txt)},
            changed={"added": [a.get("headline") or a.get("title") or ""
                               for a in articles],
                     "updated": [], "count": len(articles)},
            reason=reason)
    return 0


if __name__ == "__main__":
    sys.exit(main())






