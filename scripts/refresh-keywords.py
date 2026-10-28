#!/usr/bin/env python3
"""Daily keyword refresh for FlickAtlas news articles.

Owner order 2026-10-28: every post in every category must have keywords
— SEO-friendly, trending, what people actually search — and Gemini
refreshes them once a day. This script is the daily refresh for NEWS
articles (movie/show/day-wise meta keywords are formulaic from their
own fields and already complete: 84/84 movie, 15/15 tv, 18/18 daywise
entries carry "k" in the live seo-meta.json).

Design (quota-safe, never destructive):
  * ONE batched Gemini call per day refreshes up to KEYWORDS_MAX_PER_DAY
    (default 15) articles — one call, not one per article — so the
    refresh does NOT draw from DAILY_CAP (it publishes no articles)
    and costs ~1 Gemini call/day against the ~70 the batch already
    makes. The 15/day article cap bounds the work.
  * Owner rule (2026-10-28): keywords are written when the post is
    made; ONE refresh 3 days later (REFRESH_AFTER_DAYS, default 3).
    Per group (news / episode articles) only the 15 NEWEST due posts
    are refreshed (POOL_PER_GROUP, default 15) — older due posts are
    dropped, never carried forward. A post refreshed once is never
    refreshed again. A missing keywords field qualifies on the same
    age rule (wipe repair) — the panel publish-export used to rebuild
    js/articles-data.js from an allow-list without "keywords"
    (fixed in the panel worker 2026-10-28, but the repair path stays).
  * State lives in out/keyword-refresh.json (committed — see
    scripts/commit_with_retry.sh): {aid: {refreshed_at, source}}.
  * Gemini failure (no keys, all keys 429/5xx, bad JSON) skips the
    WHOLE run: old keywords stay untouched, never blanked, and the
    run records reason "source-fail". Per-article bad output falls
    back to entities-derived keywords for that article only.
  * Only the "keywords" field is written — headline/body/facts/
    entities are never touched. The file's header comment is
    preserved verbatim. The script is idempotent: a second run the
    same day finds nothing due (everything due was refreshed) and
    records "no-new-data".
  * Every run records itself in out/step-runs.json via step_runs
    ("keywords_refresh") with the closed reason vocabulary.
  * Movie/show/day-wise keywords are formulaic from their own fields
    and regenerate hourly via scripts/seo_assets.py — this Gemini
    refresh covers news + episode articles only.

Grounding: every refreshed phrase must share a content word (>= 4
letters) with the article's own headline/entities/dek — a phrase
naming a person, film or event NOT in the article is dropped and the
article falls back to entities-derived keywords.

Usage: refresh-keywords.py [--dry-run]
  --dry-run: select + report only; writes nothing, records nothing.
Exits 0 in all cases (never fails the pipeline run).
Env:
  GEMINI_API_KEY_1..6 (at least one required; same rotation as
  scripts/gemini_batch.py — the caller is imported from there)
  KEYWORDS_MAX_PER_DAY (default 15)
  KEYWORDS_REFRESH_AFTER_DAYS (default 3)
  KEYWORDS_POOL_PER_GROUP (default 15)
"""
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import step_runs
except Exception:  # noqa: BLE001 - record helper is best-effort
    step_runs = None

try:
    # Same model, keys and rotation as the draft step — one implementation.
    from gemini_batch import call_gemini, gemini_keys
except Exception as e:  # noqa: BLE001 - refresh must never fail the run
    print(f"refresh-keywords: gemini_batch import failed ({e}) — skipping")
    call_gemini = None
    gemini_keys = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.environ.get("OUT_DIR", os.path.join(ROOT, "out"))
ART_PATH = os.path.join(ROOT, "js", "articles-data.js")
STATE_PATH = os.path.join(OUT_DIR, "keyword-refresh.json")

MAX_PER_DAY = int(os.environ.get("KEYWORDS_MAX_PER_DAY", "15"))
REFRESH_AFTER_DAYS = int(os.environ.get("KEYWORDS_REFRESH_AFTER_DAYS", "3"))
POOL_PER_GROUP = int(os.environ.get("KEYWORDS_POOL_PER_GROUP", "15"))
KEYWORDS_WANT = 5
KEYWORDS_MIN = 4

STOP = set("the a an and or of to in on for with after amid at by from as is "
           "are was were be been has have had will would its it this that "
           "film movie news latest box office collection collections".split())

REFRESH_SCHEMA = {
    "type": "object",
    "properties": {
        "results": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "keywords": {"type": "array",
                             "items": {"type": "string"}},
            },
            "required": ["id", "keywords"],
        }},
    },
    "required": ["results"],
}

REFRESH_PROMPT = """You are the SEO editor for FlickAtlas, an entertainment-info
magazine. For EACH story below, write 4-5 short search phrases a reader
would actually type into Google to find THIS story right now — what is
trending on this story. Build each phrase ONLY from the story's own
headline, people, titles and facts given below — never invent a person,
film, show or event that is not in the story. Plain phrases only: no
generic suffixes such as "latest news", "biography", "upcoming movies"
(the site adds those itself). At least one phrase must name the story's
main film/show when the story is about one. Return ONLY JSON:
{{"results": [{{"id": "<story id>", "keywords": ["...", "..."]}}, ...]}}
Include every story id exactly once, in the same order as below.

Stories:
{items}
"""


# ---------------------------------------------------------------- keywords
# Mirrored helpers (see scripts/gemini_batch.py — keep in sync).
def clean_keyword_phrase(value):
    """One keyword phrase: plain text, no URLs, no markup, <= 80 chars."""
    s = re.sub(r"\s+", " ", str(value or "")).strip()
    if not s or len(s) > 80 or "http" in s.lower() or "<" in s:
        return ""
    return s


def derive_keywords_from_entities(entities, headline=""):
    """Keywords derived from an article's own entities (no Gemini call)."""
    ents = entities or {}
    people = [clean_keyword_phrase(p)
              for p in (ents.get("people") or [])]
    titles = [clean_keyword_phrase(t)
              for t in (ents.get("titles") or [])]
    out = []
    for name in people[:2] + titles[:2]:
        if name and name.lower() not in {o.lower() for o in out}:
            out.append(name)
    for p in people[:2]:
        for t in titles[:1]:
            combo = clean_keyword_phrase(f"{p} {t}")
            if combo and combo.lower() not in {o.lower() for o in out}:
                out.append(combo)
            if len(out) >= KEYWORDS_WANT:
                break
        if len(out) >= KEYWORDS_WANT:
            break
    if len(out) < KEYWORDS_MIN:
        # Headline's leading entity first ("Jailer 2", "Doosra") —
        # the capitalised-sequence scan below would return a generic
        # phrase such as "Box Office Collection" instead.
        lead = re.match(r"([A-Z][a-z]+(?:\s+\d+)?)", headline or "")
        if lead and lead.group(1).lower() not in {
                "the", "a", "an", "in", "on", "at", "to", "of", "for",
                "new", "latest", "top", "first", "big", "breaking"}:
            s = clean_keyword_phrase(lead.group(1))
            if s and s.lower() not in {o.lower() for o in out}:
                out.append(s)
    if len(out) < KEYWORDS_MIN:
        seqs = re.findall(
            r"\b([A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|De|Di|Da|Van|Von)){1,2})\b",
            headline or "")
        for s in seqs:
            s = clean_keyword_phrase(s)
            if s and s.lower() not in {o.lower() for o in out}:
                out.append(s)
            if len(out) >= KEYWORDS_MIN:
                break
    if not out and headline:
        h = clean_keyword_phrase(headline)
        if h:
            out.append(h)
    return out[:KEYWORDS_WANT]


def _content_words(*texts):
    words = set()
    for t in texts:
        for w in re.findall(r"[a-z0-9]+", (t or "").lower()):
            if len(w) >= 4 and w not in STOP:
                words.add(w)
    return words


def _is_grounded(phrase, article):
    """A refreshed phrase must share a content word with the article's
    own headline/entities/dek — otherwise it names something the
    article never mentions (an invented person/film/event)."""
    ents = article.get("entities") or {}
    vocab = _content_words(
        article.get("headline") or "",
        article.get("dek") or "",
        " ".join(str(x) for x in (ents.get("people") or [])),
        " ".join(str(x) for x in (ents.get("titles") or [])))
    words = [w for w in re.findall(r"[a-z0-9]+", phrase.lower())
             if len(w) >= 4 and w not in STOP]
    return any(w in vocab for w in words)


def normalize_refresh_keywords(raw, article):
    """Gemini's refreshed phrases for one article, cleaned + grounded.
    Drops ungrounded phrases; tops up from the article's own entities
    when fewer than 4 survive; falls back to entities-only. Returns
    (keywords, source) where source is "gemini" (all phrases kept),
    "mixed" (some dropped/topped up) or "derived" (Gemini gave nothing
    usable). Never returns []."""
    out = []
    for kw in raw if isinstance(raw, list) else []:
        s = clean_keyword_phrase(kw)
        if not s or s.lower() in {o.lower() for o in out}:
            continue
        if _is_grounded(s, article):
            out.append(s)
        if len(out) >= KEYWORDS_WANT:
            break
    kept = len(out)
    if len(out) < KEYWORDS_MIN:
        for s in derive_keywords_from_entities(
                article.get("entities") or {},
                article.get("headline") or ""):
            if s.lower() not in {o.lower() for o in out}:
                out.append(s)
            if len(out) >= KEYWORDS_WANT:
                break
    if not out:
        # Headline-only last resort — still never empty.
        h = clean_keyword_phrase(article.get("headline") or "")
        if h:
            out.append(h)
    source = ("gemini" if kept == len(out) and kept >= KEYWORDS_MIN
              else "derived" if kept == 0 else "mixed")
    return out, source


# ---------------------------------------------------------------- io
def read_js_articles(path):
    """Parse `window.FA_ARTICLES = {...};` -> (header_prefix, dict)."""
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    start = raw.index("{")
    end = raw.rindex("}")
    return raw[:start], json.loads(raw[start:end + 1])


def write_js_articles(path, header, data):
    content = (header + json.dumps(data, ensure_ascii=False, indent=2)
               + ";\n")
    existing = ""
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            existing = f.read()
    if existing == content:
        return False
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return True


def load_state(path):
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(
                    data.get("articles"), dict):
                return data
        except Exception:
            pass
    return {"articles": {}}


def save_state(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def _published_ts(value):
    """Sort key for oldest-first ordering; 0.0 when missing/unparseable."""
    if not value:
        return 0.0
    s = str(value).strip()
    dt = None
    try:
        dt = parsedate_to_datetime(s)
    except (TypeError, ValueError):
        dt = None
    if dt is None:
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return 0.0
    if dt is None:
        return 0.0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).timestamp()


def _refreshed_ts(rec):
    try:
        return datetime.fromisoformat(
            str((rec or {}).get("refreshed_at") or "").replace("Z", "+00:00")
        ).timestamp()
    except ValueError:
        return 0.0


_EP_HEADLINE_RE = re.compile(r"\bEpisode\s+\d+\b|\bLast Episode\b",
                                 re.I)


def _is_episode(article):
    """Episode articles (Pakistani drama episodes) form their own
    refresh group — they live in the same articles file but are a
    different section on the site from news."""
    return bool(_EP_HEADLINE_RE.search(article.get("headline") or ""))


def select_candidates(articles, state, now_ts):
    """Today's refresh set under the owner rule (2026-10-28): one
    refresh per post, 3 days after it was published; per group
    (news / episode) only the 15 NEWEST due posts are taken — older
    due posts are dropped, never carried forward. A post refreshed
    once is never refreshed again (state record + keywords present);
    a missing keywords field qualifies on the same age rule, even
    when the state says refreshed (wipe repair)."""
    refreshed = state.get("articles") or {}
    due_after = now_ts - REFRESH_AFTER_DAYS * 86400
    groups = {"news": [], "episode": []}
    for aid, art in articles.items():
        if not isinstance(art, dict) or not (art.get("headline") or ""):
            continue
        if _published_ts(art.get("published")) > due_after:
            continue  # not 3 days old yet — its one refresh is later
        if aid in refreshed and art.get("keywords"):
            continue  # already refreshed once — never again
        groups["episode" if _is_episode(art) else "news"].append(
            (aid, art))
    picked = []
    for group in ("news", "episode"):
        due = groups[group]
        due.sort(key=lambda t: _published_ts(t[1].get("published")),
                 reverse=True)
        picked.extend(due[:POOL_PER_GROUP])
    picked.sort(key=lambda t: _published_ts(t[1].get("published")),
                reverse=True)
    return picked[:MAX_PER_DAY]


def _prompt_item(aid, art):
    ents = art.get("entities") or {}
    facts = [str(f) for f in (art.get("facts") or [])[:2] if str(f).strip()]
    lines = [f"[{aid}] {(art.get('headline') or '').strip()}"]
    if art.get("dek"):
        lines.append(f"  dek: {str(art['dek']).strip()[:200]}")
    people = [str(p) for p in (ents.get("people") or []) if str(p).strip()]
    titles = [str(t) for t in (ents.get("titles") or []) if str(t).strip()]
    if people:
        lines.append("  people: " + ", ".join(people[:5]))
    if titles:
        lines.append("  titles: " + ", ".join(titles[:5]))
    for f in facts:
        lines.append(f"  fact: {f[:200]}")
    return "\n".join(lines)


def record(status, checked, changed, reason):
    if step_runs is not None:
        # Explicit path: step_runs.DEFAULT_PATH is derived from
        # step_runs.py's own location, which is NOT this script's
        # OUT_DIR when the module was imported from elsewhere.
        step_runs.record(
            "keywords_refresh", category="Trending News",
            status=status, checked=checked, changed=changed,
            reason=reason,
            path=os.path.join(OUT_DIR, "step-runs.json"))


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    dry_run = "--dry-run" in argv
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    now_ts = time.time()

    if not os.path.exists(ART_PATH):
        print(f"refresh-keywords: no articles file: {ART_PATH}")
        record("success", {"candidates": 0,
                           "detail": "js/articles-data.js missing"},
               {"added": [], "updated": [], "count": 0}, "no-new-data")
        return 0
    header, articles = read_js_articles(ART_PATH)
    state = load_state(STATE_PATH)
    candidates = select_candidates(articles, state, now_ts)
    print(f"refresh-keywords: {len(articles)} articles, "
          f"{len(candidates)} due today (cap {MAX_PER_DAY}, "
          f"3-day rule, newest {POOL_PER_GROUP} per group)")
    if not candidates:
        record("success",
               {"candidates": 0,
                "detail": "no article due for a keyword refresh today"},
               {"added": [], "updated": [], "count": 0}, "no-new-data")
        return 0
    if dry_run:
        for aid, art in candidates:
            print(f"  DRY-RUN would refresh: {aid} "
                  f"{(art.get('headline') or '')[:70]}")
        return 0

    if call_gemini is None or gemini_keys is None:
        print("refresh-keywords: no Gemini access — skipping, "
              "old keywords untouched")
        record("success",
               {"candidates": len(candidates),
                "detail": "Gemini unavailable; old keywords left untouched"},
               {"added": [], "updated": [], "count": 0}, "source-fail")
        return 0
    keys = gemini_keys()
    if not keys:
        print("refresh-keywords: no Gemini keys configured — skipping, "
              "old keywords untouched")
        record("success",
               {"candidates": len(candidates),
                "detail": "no Gemini keys; old keywords left untouched"},
               {"added": [], "updated": [], "count": 0}, "source-fail")
        return 0

    items = "\n\n".join(_prompt_item(aid, art) for aid, art in candidates)
    result = call_gemini(keys, REFRESH_PROMPT.format(items=items),
                         schema=REFRESH_SCHEMA, max_tokens=4096)
    if not result or not isinstance(result.get("results"), list):
        print("refresh-keywords: Gemini refresh call failed — skipping, "
              "old keywords untouched")
        record("success",
               {"candidates": len(candidates),
                "detail": "Gemini refresh call failed; old keywords left "
                          "untouched"},
               {"added": [], "updated": [], "count": 0}, "source-fail")
        return 0
    by_id = {}
    for r in result["results"]:
        if isinstance(r, dict) and r.get("id"):
            by_id[str(r["id"])] = r.get("keywords") or []

    refreshed, sources = [], {}
    for aid, art in candidates:
        kws, source = normalize_refresh_keywords(by_id.get(aid), art)
        art["keywords"] = kws
        state.setdefault("articles", {})[aid] = {
            "refreshed_at": now, "source": source}
        refreshed.append(aid)
        sources[source] = sources.get(source, 0) + 1
    changed = write_js_articles(ART_PATH, header, articles)
    save_state(STATE_PATH, {**state, "updated_at": now})
    print(f"refresh-keywords: refreshed {len(refreshed)} articles "
          f"(sources {sources}), file changed: {changed}")
    record("success",
           {"candidates": len(candidates),
            "detail": f"keyword refresh: {len(refreshed)} articles, "
                      f"sources {sources}"},
           {"added": [], "updated": [
               (articles[aid].get("headline") or aid)[:80]
               for aid in refreshed],
            "count": len(refreshed)}, None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
