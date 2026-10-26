#!/usr/bin/env python3
"""
gemini_reviews.py — FlickAtlas movie-review generator (Gemini).

Fills js/reviews-data.js with a "FlickAtlas Review" for every RELEASED
published movie that has no review entry yet. It NEVER overwrites an
existing entry (the Movies Flare Udta Teer seed and any earlier review
stay exactly as they are).

Grounding (only these inputs — never anything else):
  * Tavily web search for the movie's reviews/stories (queries
    "<Movie> review" and "<Movie> movie review story plot") — the
    review is written FROM what reviewers say, and scores must follow
    the sources (praised performances score high; a weak second half
    shows up in weaknesses/verdict). A movie with no usable review
    coverage yet is SKIPPED and retried the next day — reviews
    typically appear 2-3 days after release, so day-1 absence is
    normal, not a failure. Once a review exists, the movie is never
    searched again (only movies missing a review are searched, once
    per day each).
  * TMDB overview, genres, runtime, language/industry (from
    js/published-titles.js) and top cast + director (TMDB credits API).
  * The BollyMovieReviewz critic average ("Average Ratings: X/5") where
    scripts/wp_boxoffice.py found one (out/bmr-reviews.json, --bmr).
    Used as a reference point, not a target.
  * TMDB vote_average / vote_count are shown beside the review, never
    fed to the model as a target score.

Guardrails:
  * Scores 0-10 in 0.5 steps; overall within 1 point of the category mean.
  * Text must not invent plot details beyond the synopsis and cast list;
    no invented character names, scenes, songs or dialogue; never claim
    the film was watched. Categories the synopsis says nothing about get
    a moderate score (6-7.5) and general wording only.
  * A movie is SKIPPED (slot stays empty) when it is unreleased, its
    overview is missing or under 100 chars, no usable review coverage
    is found yet, or Gemini fails/validates badly twice. Nothing is
    ever padded with invented plot.

Modes:
  * Pipeline (GitHub Actions): GEMINI_API_KEY_1..6 env keys, reusing
    gemini_batch.call_gemini (same model + JSON-schema call as article
    writing), and TAVILY_API_KEY (+ BACKUP) env keys for the search
    leg. No Gemini keys -> prints SKIP, exits 0.
  * Local (this VM): no env keys -> the custom.gemini / custom.tavily
    connector surrogates inject the keys (same pattern as
    custom.gemini/bin/gemini_ask.py and
    custom.tavily/bin/tavily_search.py). Model falls back to
    gemini-3.5-flash if flash-lite 404s on the local key.

Usage:
  python3 scripts/gemini_reviews.py --published js/published-titles.js \
      --reviews-out js/reviews-data.js [--bmr out/bmr-reviews.json] \
      [--limit N] [--dry-run]
Exit 0 always unless the input files are unreadable (never fail the
pipeline run over reviews). Deterministic output (sorted keys) so an
unchanged reviews-data.js never triggers a spurious commit.
"""

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
try:
    import gemini_batch as _gb
    PIPELINE_MODEL = _gb.MODEL
    PIPELINE_CALL = _gb.call_gemini
    PIPELINE_KEYS = _gb.gemini_keys
except Exception:  # pragma: no cover - local runs without the batch module
    PIPELINE_MODEL = "gemini-3.5-flash-lite"
    PIPELINE_CALL = None
    PIPELINE_KEYS = lambda: []  # noqa: E731

MODEL_FALLBACK = "gemini-3.5-flash"
MIN_OVERVIEW = 100
TMDB_API = "https://api.themoviedb.org/3"

CAT_LABELS = {
    "story": "Story & Screenplay",
    "direction": "Direction",
    "performances": "Performances",
    "comedy": "Comedy & Entertainment",
    "music": "Music & BGM",
    "action": "Action & Cinematography",
}

REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "overall": {"type": "number"},
        "categories": {
            "type": "object",
            "properties": {
                "story": {"type": "number"},
                "direction": {"type": "number"},
                "performances": {"type": "number"},
                "comedy": {"type": "number"},
                "music": {"type": "number"},
                "action": {"type": "number"},
            },
            "required": ["story", "direction", "performances",
                         "comedy", "music", "action"],
        },
        "story_plot": {"type": "string"},
        "comedy": {"type": "string"},
        "performances": {"type": "string"},
        "strengths": {"type": "array", "items": {"type": "string"}},
        "weaknesses": {"type": "string"},
        "verdict": {"type": "string"},
    },
    "required": ["overall", "categories", "story_plot", "comedy",
                 "performances", "strengths", "weaknesses", "verdict"],
}

HEADER = """/* FlickAtlas — movie reviews data. Keyed by TMDB movie id.
   Two kinds of entry:
   - "Movies Flare": the Udta Teer seed, transcribed from the Movies Flare
     Instagram carousel the user shared (2026-10-27). Scores + text are
     Movies Flare's own, reproduced faithfully; never edit them here.
   - "FlickAtlas Review": written by FlickAtlas (Gemini) from the film's
     TMDB overview, cast, genres and runtime, plus the BollyMovieReviewz
     critic average where one exists. Editorial opinion, not a quote from
     any critic — never attribute these scores to Movies Flare or BMR.
   scripts/gemini_reviews.py is the SOLE writer of new entries: it adds
   entries for movies that have none and NEVER overwrites an existing
   entry. A critic average from BollyMovieReviewz is stored under
   "critic" (score_10 = raw/5 * 10) and shown beside the review. */
"""


def log(msg):
    print(msg, flush=True)


def load_js_object(path, var):
    """Read `window.<var> = {...};` from a site JS data file."""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    m = re.search(re.escape("window." + var) + r"\s*=\s*(\{.*\})\s*;",
                  text, re.S)
    if not m:
        raise ValueError("%s: window.%s object not found" % (path, var))
    return json.loads(m.group(1))


def write_reviews(path, data):
    body = (HEADER + "window.FA_REVIEWS = " +
            json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) +
            ";\n")
    existing = ""
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            existing = f.read()
    if existing == body:
        return False
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)
    return True


def tmdb_key(args):
    key = (args.key or os.environ.get("TMDB_API_KEY", "")).strip()
    if key:
        return key
    for cand in (os.path.join(HERE, "..", "js", "config.js"), "js/config.js"):
        try:
            with open(cand, encoding="utf-8") as f:
                m = re.search(r"TMDB_KEY\s*:\s*\"([0-9a-f]{32})\"", f.read())
            if m:
                return m.group(1)
        except OSError:
            pass
    return ""


def tmdb_credits(tmdb_id, key):
    """Top 5 cast + director from the TMDB credits endpoint (best effort)."""
    if not key:
        return [], ""
    url = "%s/movie/%s/credits?api_key=%s" % (TMDB_API, tmdb_id, key)
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=25) as r:
            data = json.load(r)
    except Exception as e:
        log("  credits fetch failed for %s: %s" % (tmdb_id, e))
        return [], ""
    cast = [c.get("name", "") for c in (data.get("cast") or [])[:5]
            if c.get("name")]
    director = ""
    for c in data.get("crew") or []:
        if c.get("job") == "Director" and c.get("name"):
            director = c["name"]
            break
    return cast, director


TAVILY_API = "https://api.tavily.com/search"
REVIEW_WORDS = ("review", "rating", "verdict", "story", "performance",
                "direction", "worth watching", "watch", "film", "movie")


def tavily_keys():
    keys = []
    for name in ("TAVILY_API_KEY", "TAVILY_API_KEY_BACKUP"):
        k = os.environ.get(name, "").strip()
        if k:
            keys.append(k)
    return keys


def tavily_search_http(query, max_results):
    """Direct Tavily call with the env keys (pipeline mode)."""
    keys = tavily_keys()
    if not keys:
        return None
    last_err = None
    for key in keys:
        body = json.dumps({"query": query, "search_depth": "basic",
                           "max_results": max_results,
                           "include_answer": False}).encode("utf-8")
        req = urllib.request.Request(
            TAVILY_API, data=body,
            headers={"Authorization": "Bearer " + key,
                     "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r).get("results") or []
        except Exception as e:
            last_err = e
            log("  tavily key ...%s failed: %s" % (key[-4:], e))
    log("  tavily: all keys failed (%s)" % last_err)
    return []


def tavily_search_local(query, max_results):
    """Local VM path: custom.tavily connector surrogate (primary, then
    backup on failure) — same helper as bin/tavily_search.py."""
    try:
        sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
        sys.path.insert(0,
                        "/home/hatch/workspace/custom-connectors/custom.tavily/bin")
        import tavily_search as _ts
        data = _ts.search(query, max_results=max_results)
        return data.get("results") or []
    except Exception as e:
        log("  local tavily failed: %s" % e)
        return []


def usable_snippets(title, results):
    """Keep results that name the film and talk about the film itself
    (review/rating/story language). Pure box-office pieces (collection
    figures, no review language) do NOT ground a review."""
    t = (title or "").lower()
    first = t.split()[0] if t.split() else t
    out, seen = [], set()
    for r in results or []:
        text = ((r.get("title") or "") + " " +
                (r.get("content") or "")).strip()
        low = text.lower()
        if t not in low and first not in low:
            continue
        if ("box office" in low and "collection" in low
                and "review" not in low):
            continue
        if not any(w in low for w in REVIEW_WORDS):
            continue
        url = r.get("url") or ""
        if url in seen:
            continue
        seen.add(url)
        out.append({"title": r.get("title") or "", "url": url,
                    "content": (r.get("content") or "")[:600]})
    return out


def search_reviews(title, local):
    """Two Tavily queries per movie; returns (snippets, n_searches).
    Snippets are de-duplicated by URL and capped at 6."""
    snippets, n = [], 0
    for query, mx in (("%s review" % title, 8),
                      ("%s movie review story plot" % title, 5)):
        res = (tavily_search_local(query, mx) if local
               else tavily_search_http(query, mx))
        n += 1
        if res:
            snippets += usable_snippets(title, res)
        time.sleep(1)
    dedup, seen = [], set()
    for s in snippets:
        if s["url"] in seen:
            continue
        seen.add(s["url"])
        dedup.append(s)
    return dedup[:6], n


def build_prompt(movie, cast, director, bmr, snippets):
    title = movie.get("title", "")
    year = (movie.get("release_date") or "")[:4]
    genres = ", ".join(movie.get("genres") or []) or "—"
    runtime = movie.get("runtime") or "—"
    lang = movie.get("original_language", "")
    industry = movie.get("industry", "")
    overview = movie.get("overview") or ""
    va = movie.get("vote_average")
    vc = movie.get("vote_count")
    lines = [
        "You are writing a FlickAtlas movie review in the Movies Flare "
        "format: an overall score out of 10, six category scores, and "
        "short review sections. Write the review ONLY from the facts "
        "given below. Do not invent plot details, character names, "
        "scenes, songs or dialogue beyond what the synopsis, cast list "
        "and search results state. Do not claim to have watched the "
        "film. Write in plain, lively English, third person.",
        "",
        "Film: %s (%s) — %s — %s min — language %s, %s"
        % (title, year, genres, runtime, lang, industry),
        "Synopsis (TMDB overview): %s" % overview,
        "Top cast: %s" % (", ".join(cast) if cast else "not available"),
        "Director: %s" % (director or "not available"),
    ]
    if isinstance(va, (int, float)) and va:
        lines.append("TMDB audience rating: %s/10 (%s votes) — shown "
                     "beside the review, NOT a target for your scores."
                     % (va, vc or 0))
    if bmr:
        lines.append(
            "BollyMovieReviewz critic average: %s/5 (%s critics "
            "counted) — use as a reference point, not a target."
            % (bmr.get("score_5"), bmr.get("count") or "?"))
    lines.append("")
    lines.append("What reviewers are saying on the web (search results — "
                 "write FROM these):")
    for s in snippets:
        lines.append("- %s (%s): %s" % (s["title"], s["url"], s["content"]))
    lines += [
        "",
        "Rules:",
        "- Scores are numbers from 0 to 10 in 0.5 steps.",
        "- overall should be within 1 point of the mean of the six "
        "category scores.",
        "- Scores must follow what the sources say: if reviewers praise "
        "the performances, score performances high; if they call the "
        "second half weak, say so in weaknesses and verdict. Never "
        "write anything the inputs do not support.",
        "- story_plot: 2-4 sentences, retells ONLY the synopsis and the "
        "search results, in your own words.",
        "- comedy: 2-4 sentences on the film's humour and entertainment "
        "value as implied by the synopsis and the reviewers; if the "
        "inputs say nothing about comedy, keep it general (premise, "
        "characters), never describe a specific joke or scene.",
        "- performances: 2-4 sentences on the cast from their roles as "
        "given and what reviewers said; name only cast members from "
        "the list above.",
        "- strengths: 3-6 short phrases (what works).",
        "- weaknesses: 2-4 sentences (what doesn't) — honest risks "
        "implied by the premise and the reviewers (a familiar setup, "
        "a weak second half); never invent specific flaws you cannot "
        "ground.",
        "- verdict: 2-4 sentences, with a recommendation.",
        "- For categories the inputs say nothing about (music, action, "
        "cinematography), give a moderate score (6-7.5) and keep any "
        "mention general — never describe a specific song, shot or "
        "action scene.",
        "- Never invent numbers, dates or quotes.",
    ]
    return "\n".join(lines)


def round_half(x):
    return round(float(x) * 2) / 2.0


def validate(raw):
    """Schema-shape + range check. Returns a cleaned entry or None."""
    if not isinstance(raw, dict):
        return None
    try:
        overall = round_half(raw["overall"])
        cats = {}
        for k in CAT_LABELS:
            v = round_half(raw["categories"][k])
            if not (0 <= v <= 10):
                return None
            cats[CAT_LABELS[k]] = v
        if not (0 <= overall <= 10):
            return None
        texts = {}
        for k in ("story_plot", "comedy", "performances",
                  "weaknesses", "verdict"):
            t = (raw.get(k) or "").strip()
            if not (40 <= len(t) <= 800):
                return None
            texts[k] = t
        strengths = raw.get("strengths") or []
        if not (3 <= len(strengths) <= 8):
            return None
        strengths = [str(s).strip() for s in strengths]
        if any(not (2 <= len(s) <= 80) for s in strengths):
            return None
    except (KeyError, TypeError, ValueError):
        return None
    entry = {"source": "FlickAtlas Review", "overall": overall,
             "categories": cats}
    entry.update(texts)
    entry["strengths"] = strengths
    return entry


def call_local(prompt, schema):
    """Local VM path: custom.gemini connector surrogate injects the key."""
    try:
        sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
        from dynamic_credentials import (add_surrogate_to_request,
                                         read_json_response)
    except Exception as e:
        log("  local gemini unavailable: %s" % e)
        return None
    for model in (PIPELINE_MODEL, MODEL_FALLBACK):
        body = json.dumps({
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": schema,
                "maxOutputTokens": 4096,
            },
        }).encode("utf-8")
        req = urllib.request.Request(
            "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent" % model,
            data=body, headers={"Content-Type": "application/json"})
        try:
            add_surrogate_to_request(req, "custom.gemini",
                                     allowed_hosts=["generativelanguage.googleapis.com"])
            with urllib.request.urlopen(req, timeout=90) as r:
                resp = read_json_response(r)
            text = resp["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(text)
        except Exception as e:
            log("  local gemini %s failed: %s" % (model, e))
    return None


def main():
    ap = argparse.ArgumentParser(description="FlickAtlas review generator")
    ap.add_argument("--published", default="js/published-titles.js")
    ap.add_argument("--reviews-out", default="js/reviews-data.js")
    ap.add_argument("--bmr", default=None,
                    help="BollyMovieReviewz critic averages JSON "
                         "(out/bmr-reviews.json from wp_boxoffice.py)")
    ap.add_argument("--key", default=None, help="TMDB API key")
    ap.add_argument("--limit", type=int, default=0,
                    help="max new reviews this run (0 = no limit)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-credits", action="store_true",
                    help="skip TMDB credits fetch (overview-only grounding)")
    args = ap.parse_args()

    try:
        published = load_js_object(args.published, "FA_PUBLISHED")
    except Exception as e:
        log("FATAL: cannot read %s: %s" % (args.published, e))
        return 2
    reviews = {}
    if os.path.exists(args.reviews_out):
        try:
            reviews = load_js_object(args.reviews_out, "FA_REVIEWS")
        except Exception as e:
            log("FATAL: cannot read %s: %s" % (args.reviews_out, e))
            return 2
    bmr = {}
    if args.bmr and os.path.exists(args.bmr):
        try:
            with open(args.bmr, encoding="utf-8") as f:
                bmr = json.load(f)
        except Exception as e:
            log("bmr file unreadable, continuing without it: %s" % e)

    keys = PIPELINE_KEYS() if PIPELINE_CALL else []
    if keys:
        log("gemini mode: pipeline keys (%d), model %s" % (len(keys), PIPELINE_MODEL))
    else:
        log("gemini mode: local connector surrogate (no env keys)")
    local_tavily = not tavily_keys()
    log("tavily mode: %s" % ("local connector surrogate" if local_tavily
                             else "env keys (primary + backup)"))

    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    movies = [v for v in published.values()
              if v and v.get("type") == "movie" and v.get("id") is not None]
    movies.sort(key=lambda v: str(v.get("title") or ""))
    key = tmdb_key(args)
    made, skipped, failed = [], [], []
    searches_total = 0
    for movie in movies:
        tid = str(movie["id"])
        if tid in reviews:
            continue
        rel = (movie.get("release_date") or "")
        if rel and rel > today:
            skipped.append((movie.get("title"), tid, "unreleased (%s)" % rel))
            continue
        ov = (movie.get("overview") or "").strip()
        if len(ov) < MIN_OVERVIEW:
            skipped.append((movie.get("title"), tid,
                            "overview too thin (%d chars)" % len(ov)))
            continue
        if args.limit and len(made) >= args.limit:
            skipped.append((movie.get("title"), tid, "limit reached"))
            continue
        # Search-first: no usable review coverage yet -> skip and retry
        # tomorrow (reviews typically appear 2-3 days after release).
        snippets, n_searches = search_reviews(
            movie.get("title") or "", local_tavily)
        searches_total += n_searches
        usable_chars = sum(len(s["content"]) for s in snippets)
        if len(snippets) < 2 or usable_chars < 300:
            skipped.append((movie.get("title"), tid,
                            "no review coverage yet (%d usable snippets, "
                            "%d chars)" % (len(snippets), usable_chars)))
            continue
        cast, director = ([], "") if args.no_credits else tmdb_credits(tid, key)
        b = bmr.get(tid) or bmr.get(int(movie["id"])) if isinstance(bmr, dict) else None
        prompt = build_prompt(movie, cast, director, b, snippets)
        entry = None
        for attempt in range(2):
            if keys and PIPELINE_CALL:
                raw = PIPELINE_CALL(keys, prompt, REVIEW_SCHEMA)
            else:
                raw = call_local(prompt, REVIEW_SCHEMA)
            if raw is None:
                log("  %s: gemini call failed (attempt %d)"
                    % (movie.get("title"), attempt + 1))
                continue
            entry = validate(raw)
            if entry is None:
                log("  %s: validation failed (attempt %d)"
                    % (movie.get("title"), attempt + 1))
                continue
            break
        if entry is None:
            failed.append((movie.get("title"), tid, "gemini/validation failed"))
            continue
        if b:
            entry["critic"] = {
                "source": "BollyMovieReviewz",
                "score_10": round(float(b["score_5"]) * 2, 1),
                "raw": "%s/5" % b["score_5"],
                "count": b.get("count"),
                "url": b.get("url"),
            }
        reviews[tid] = entry
        made.append((movie.get("title"), tid, entry["overall"]))
        log("  + %s (%s): overall %s" % (movie.get("title"), tid, entry["overall"]))
        time.sleep(2)

    log("generated=%d skipped=%d failed=%d total_reviews=%d tavily_searches=%d"
        % (len(made), len(skipped), len(failed), len(reviews), searches_total))
    for title, tid, why in skipped:
        log("  skip %s (%s): %s" % (title, tid, why))
    for title, tid, why in failed:
        log("  FAIL %s (%s): %s" % (title, tid, why))
    if args.dry_run:
        log("dry-run: not writing %s" % args.reviews_out)
        return 0
    if made:
        if write_reviews(args.reviews_out, reviews):
            log("wrote %s (%d entries)" % (args.reviews_out, len(reviews)))
        else:
            log("%s unchanged" % args.reviews_out)
    else:
        log("no new reviews; %s untouched" % args.reviews_out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
