#!/usr/bin/env python3
"""
overseas_ai.py — Tavily + Gemini extraction of per-day OVERSEAS box
office (primary route) plus shows / occupancy / tickets when stated.

For every released movie whose day-wise rows are missing overseas
figures, search Tavily for its overseas day-wise collection and have
Gemini extract the per-day overseas figure FROM the search results.

Grounding rules (hard — same as the reader route):
  * A figure is used ONLY if a search result explicitly states it for
    a specific day number (e.g. "added Rs 5 crore from overseas
    markets on Day 8", "Overseas, the film collected ₹43.00 Cr on
    Day 2"). A snippet that states only a TOTAL ("overseas total
    ₹255 Cr") grounds NO day.
  * Scope must be OVERSEAS (international markets) — worldwide totals
    and India figures are rejected, never used as overseas.
  * Never estimate or derive overseas from India Net. No result for a
    day = that day stays blank.
  * The extracted day must exist in the movie's baseline day-wise
    rows; otherwise it is skipped (nothing to attach it to).

Output: extras-only staging JSON for the averaging engine
(out/boxoffice-staging/overseas-ai.json):
    {"<tmdb_id>": [{"day": N, "date": "YYYY-MM-DD",
                    "overseas_inr_cr": X.XX, "shows": N,
                    "occupancy_pct": Y.Y, "tickets": N,
                    "source": "overseas-ai"}]}
Only fields Gemini actually extracted are present. The engine merges
these into the baseline and averages them with the Sacnilk-direct
figures where both report a day.

Modes (same pattern as scripts/gemini_reviews.py):
  * Pipeline (GitHub Actions): TAVILY_API_KEY(+_BACKUP) and
    GEMINI_API_KEY_1..6 env keys, via gemini_batch.call_gemini.
  * Local (this VM): no env keys -> the custom.tavily / custom.gemini
    connector surrogates.
No keys at all -> SKIP, exit 0 (the pipeline continues; the
Sacnilk-direct route still fills overseas where it can).

Quota: missing-only. A movie whose days are all filled is never
searched again. 2 searches per movie per run. Coverage rule (owner
order 2026-10-30 19:27 PKT — "AI ka use karke sab ki pooch hi rakha
karo, daily har cycle me, overseas bhi Indian bhi"): EVERY cycle
attempts EVERY movie that is missing overseas figures — this filler
runs at both daily Tavily slots (08:00 + 18:00 UTC, alongside the
India-Net filler). The only limiter is the run's search budget
(--max-searches; the pipeline passes 48, enough for the whole
current catalogue): candidates are ordered homepage-window first
(released within the last 14 days — the homepage selector's own
eligibility window — newest first), then the rest newest-first;
a movie the budget cuts is stamped "deferred" in the attempts file
(out/overseas-ai-attempts.json) and LEADS the next cycle, so no
title is ever skipped silently cycle after cycle. The attempts
file also records each searched movie's missing-day signature for
the dashboard. One movie's search/Gemini failure never blocks the
others.
"""

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.request

try:
    # Per-run record for the stats dashboard (out/step-runs.json).
    # A missing/broken helper must never break this script.
    import step_runs
except Exception:  # noqa: BLE001 - record helper is best-effort
    step_runs = None

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
TAVILY_API = "https://api.tavily.com/search"
SOURCE = "overseas-ai"

# Sanity caps for extracted figures (same as the averaging engine).
MAX_DAY_CR = 120.0
MAX_SHOWS = 30000
MAX_TICKETS = 5000000

FIG_SCHEMA = {
    "type": "object",
    "properties": {
        "days": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "day": {"type": "integer"},
                    "overseas_inr_cr": {"type": "number"},
                    "shows": {"type": "integer"},
                    "occupancy_pct": {"type": "number"},
                    "tickets": {"type": "integer"},
                },
                "required": ["day"],
            },
        },
    },
    "required": ["days"],
}


def log(msg):
    print("overseas-ai: %s" % msg, flush=True)


def load_js_object(path, var):
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    start = raw.index("{")
    end = raw.rindex("}")
    return json.loads(raw[start:end + 1])


# --- Tavily --------------------------------------------------------------

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
    """Local VM path: custom.tavily connector surrogate."""
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
    """Keep results that name the film and mention overseas /
    international collections. Pure India-net pieces and pages that
    never mention overseas cannot ground an overseas figure."""
    t = (title or "").lower()
    first = t.split()[0] if t.split() else t
    out, seen = [], set()
    for r in results or []:
        text = ((r.get("title") or "") + " " +
                (r.get("content") or "")).strip()
        low = text.lower()
        if t not in low and first not in low:
            continue
        if "overseas" not in low and "international" not in low:
            continue
        url = r.get("url") or ""
        if url in seen:
            continue
        seen.add(url)
        out.append({"title": r.get("title") or "", "url": url,
                    "content": (r.get("content") or "")[:800]})
    return out


def search_overseas(title, local):
    """Two Tavily queries per movie; returns (snippets, n_searches)."""
    snippets, n = [], 0
    for query, mx in (("%s overseas box office day wise" % title, 6),
                      ("%s overseas collection day" % title, 5)):
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


# --- Gemini --------------------------------------------------------------

def build_prompt(title, snippets):
    lines = []
    for s in snippets:
        lines.append("SOURCE: %s\n%s" % (s["url"], s["content"]))
    joined = "\n\n".join(lines)
    return (
        "You extract per-day overseas box office figures for the film "
        "'%s' from the search results below. Reply with JSON only.\n\n"
        "RULES (follow exactly):\n"
        "1. Only use a figure if a source EXPLICITLY states it for a "
        "specific day number (e.g. 'added Rs 5 crore from overseas on "
        "Day 8', 'Overseas, the film collected 43 Cr on Day 2').\n"
        "2. OVERSEAS means money from overseas / international markets "
        "that day, in Rs Cr. NEVER use a worldwide total, an India "
        "figure, or a running total as a day figure. A source that "
        "states only a total ('overseas total 255 Cr') grounds NO day.\n"
        "3. NEVER estimate, derive, or guess. If no source states a "
        "day's overseas figure, omit that day entirely.\n"
        "4. shows = shows screened that day (India); occupancy_pct = "
        "overall occupancy %% that day; tickets = footfalls / tickets "
        "sold that day (India). Include one ONLY when a source states "
        "it tied to the same day number.\n"
        "5. Days are 1-based from the release day. Ignore any day "
        "number above 60.\n\n"
        "SEARCH RESULTS:\n%s" % (title, joined))


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


def validate(raw, baseline_days):
    """Validate Gemini's extraction. baseline_days: {day: date_str}
    from the movie's existing day-wise rows — a day with no baseline
    row cannot be attached and is skipped."""
    if not isinstance(raw, dict):
        return None
    days = raw.get("days")
    if not isinstance(days, list):
        return None
    out = {}
    for d in days:
        if not isinstance(d, dict):
            continue
        try:
            day = int(d.get("day"))
        except (TypeError, ValueError):
            continue
        if day < 1 or day > 60 or day not in baseline_days:
            continue
        entry = {}
        ov = d.get("overseas_inr_cr")
        if ov is not None:
            try:
                ov = float(ov)
            except (TypeError, ValueError):
                ov = None
            if ov is not None and 0 < ov <= MAX_DAY_CR:
                entry["overseas_inr_cr"] = round(ov, 2)
        for key, cap in (("shows", MAX_SHOWS), ("tickets", MAX_TICKETS)):
            v = d.get(key)
            if v is not None:
                try:
                    v = int(v)
                except (TypeError, ValueError):
                    v = None
                if v is not None and 0 < v <= cap:
                    entry[key] = v
        occ = d.get("occupancy_pct")
        if occ is not None:
            try:
                occ = float(occ)
            except (TypeError, ValueError):
                occ = None
            if occ is not None and 0 < occ <= 100:
                entry["occupancy_pct"] = round(occ, 1)
        if entry:
            out[day] = entry
    return out or None


def main():
    ap = argparse.ArgumentParser(
        description="Tavily+Gemini per-day overseas box-office extraction")
    ap.add_argument("--published", default="js/published-titles.js")
    ap.add_argument("--daywise", default="js/daywise-data.js")
    ap.add_argument("--out", default="out/boxoffice-staging/overseas-ai.json",
                    help="extras-only staging JSON for the averaging engine")
    ap.add_argument("--limit", type=int, default=0,
                    help="max movies searched this run (0 = no limit)")
    ap.add_argument("--max-searches", type=int, default=0,
                    help="max Tavily searches this run (0 = no limit; "
                         "each movie costs 2)")
    ap.add_argument("--attempts",
                    default="out/overseas-ai-attempts.json",
                    help="per-movie attempt/deferral ledger "
                         "(missing-day signature, timestamps)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--movie", default=None,
                    help="only run one TMDB id (testing)")
    args = ap.parse_args()

    try:
        published = load_js_object(args.published, "FA_PUBLISHED")
    except Exception as e:
        log("FATAL: cannot read %s: %s" % (args.published, e))
        return 2
    try:
        daywise = load_js_object(args.daywise, "FA_DAYWISE")
    except Exception as e:
        log("FATAL: cannot read %s: %s" % (args.daywise, e))
        return 2

    keys = PIPELINE_KEYS() if PIPELINE_CALL else []
    local_tavily = not tavily_keys()
    if not keys and local_tavily:
        # Local mode still works (surrogates); pipeline mode with no
        # keys at all cannot search — SKIP exit 0.
        try:
            sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
            import dynamic_credentials  # noqa: F401
        except Exception:
            log("no Gemini/Tavily keys available — SKIP, exit 0")
            return 0
    log("gemini mode: %s" % ("pipeline keys (%d)" % len(keys) if keys
                             else "local connector surrogate"))
    log("tavily mode: %s" % ("local connector surrogate" if local_tavily
                             else "env keys (primary + backup)"))

    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    existing = {}
    if os.path.exists(args.out):
        try:
            with open(args.out, encoding="utf-8") as f:
                existing = json.load(f)
        except (OSError, ValueError):
            existing = {}

    # Attempt/deferral ledger: {tid: {"attempted_at": iso,
    # "missing": "2,3,5", "deferred": bool}}. It never suppresses a
    # movie — every candidate is attempted every cycle; it only
    # remembers which movies the search budget cut last cycle so
    # they lead this one (no silent starvation).
    attempts = {}
    if os.path.exists(args.attempts):
        try:
            with open(args.attempts, encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                attempts = loaded
        except (OSError, ValueError):
            attempts = {}
    now_dt = dt.datetime.now(dt.timezone.utc)
    now_iso = now_dt.replace(microsecond=0).isoformat().replace(
        "+00:00", "Z")
    deferred_ids = {tid for tid, rec in attempts.items()
                    if isinstance(rec, dict) and rec.get("deferred")}

    out = {}
    made, skipped, failed = [], [], []
    searches_total = 0
    candidates = []
    for movie in published.values():
        tid = str(movie.get("id"))
        if args.movie and tid != args.movie:
            continue
        title = movie.get("title") or ""
        rel = (movie.get("release_date") or "").strip()
        if rel and rel > today:
            continue
        rows = daywise.get(tid) or daywise.get(int(movie["id"] or 0)) or []
        if not rows:
            continue
        baseline = {}
        for r in rows:
            try:
                dnum = int(re.sub(r"\D", "", str(r.get("day", "0"))) or 0)
            except ValueError:
                dnum = 0
            if dnum >= 1 and r.get("date"):
                baseline[dnum] = r["date"]
        missing = []
        for r in rows:
            try:
                dnum = int(re.sub(r"\D", "", str(r.get("day", "0"))) or 0)
            except ValueError:
                continue
            if dnum >= 1 and r.get("overseas") is None:
                missing.append(dnum)
        if not missing:
            skipped.append((title, tid, "overseas complete"))
            continue
        candidates.append({"movie": movie, "tid": tid, "title": title,
                           "rel": rel, "baseline": baseline,
                           "missing": missing})
    # Priority tiers (owner order 2026-10-30): (0) movies the last
    # cycle's budget deferred — they lead, so the budget can never
    # starve a title; (1) the homepage window — released within the
    # last 14 days (the homepage selector's eligibility rule; newest
    # first); (2) everything else, newest first. Fewest missing days,
    # then title, break ties. Stable multi-pass sort, primary last.
    try:
        window_start = (dt.date.fromisoformat(today)
                        - dt.timedelta(days=14)).isoformat()
    except ValueError:
        window_start = today

    def tier(c):
        if c["tid"] in deferred_ids:
            return 0
        if c["rel"] and c["rel"] >= window_start:
            return 1
        return 2

    def deferred_cycles(c):
        # Fairness inside the deferred tier: the title cut by the
        # budget in the most consecutive cycles goes first. A searched
        # title resets to 0, so the longest-waiting title always
        # leads eventually — provably no starvation, no timestamps.
        rec = attempts.get(c["tid"]) or {}
        return int(rec.get("deferred_cycles") or 0)

    candidates.sort(key=lambda c: c["title"].lower())
    candidates.sort(key=lambda c: len(c["missing"]))
    candidates.sort(key=lambda c: c["rel"] or "", reverse=True)
    candidates.sort(key=deferred_cycles, reverse=True)
    candidates.sort(key=tier)
    for cand in candidates:
        tid, title = cand["tid"], cand["title"]
        baseline, missing = cand["baseline"], cand["missing"]
        signature = ",".join(str(d) for d in sorted(missing))
        if args.limit and len(made) >= args.limit:
            skipped.append((title, tid, "limit reached"))
            continue
        if (args.max_searches
                and searches_total + 2 > args.max_searches):
            # The budget is the ONLY limiter. The cut is loud (log +
            # ledger) and the movie leads the next cycle.
            prev = attempts.get(tid) or {}
            attempts[tid] = {
                "attempted_at": prev.get("attempted_at"),
                "missing": signature, "deferred": True,
                "deferred_at": now_iso,
                "deferred_cycles": (int(prev.get("deferred_cycles")
                                        or 0) + 1
                                    if prev.get("deferred") else 1)}
            skipped.append((title, tid, "deferred — search budget"))
            continue
        snippets, n_searches = search_overseas(title, local_tavily)
        searches_total += n_searches
        attempts[tid] = {
            "attempted_at": now_iso,
            "missing": signature, "deferred": False,
            "deferred_cycles": 0}
        if not snippets:
            skipped.append((title, tid, "no overseas snippets"))
            continue
        prompt = build_prompt(title, snippets)
        raw = None
        for attempt in range(2):
            if keys and PIPELINE_CALL:
                raw = PIPELINE_CALL(keys, prompt, FIG_SCHEMA)
            else:
                raw = call_local(prompt, FIG_SCHEMA)
            if raw is None:
                log("  %s: gemini call failed (attempt %d)"
                    % (title, attempt + 1))
                continue
            break
        if raw is None:
            failed.append((title, tid, "gemini failed"))
            continue
        got = validate(raw, baseline)
        if not got:
            skipped.append((title, tid, "no grounded day figures"))
            continue
        entries = []
        for day in sorted(got):
            e = {"day": day, "date": baseline[day], "source": SOURCE}
            e.update(got[day])
            entries.append(e)
        out[tid] = entries
        made.append((title, tid, sorted(got)))
        log("  %s: days %s" % (title, sorted(got)))

    log("searched %d movie(s), %d searches; filled %d, skipped %d, "
        "failed %d" % (len(made) + len(skipped) + len(failed),
                       searches_total, len(made), len(skipped),
                       len(failed)))
    for t, tid, why in skipped:
        log("  skip %s (%s): %s" % (t, tid, why))
    for t, tid, why in failed:
        log("  FAIL %s (%s): %s" % (t, tid, why))

    if not args.dry_run:
        # Persist the ledger (only entries for movies still in the
        # catalogue are worth keeping).
        attempts = {tid: rec for tid, rec in attempts.items()
                    if isinstance(rec, dict) and tid in published}
        content = json.dumps(attempts, ensure_ascii=False, indent=2,
                             sort_keys=True) + "\n"
        existing_content = ""
        if os.path.exists(args.attempts):
            with open(args.attempts, encoding="utf-8") as f:
                existing_content = f.read()
        if existing_content != content:
            os.makedirs(os.path.dirname(args.attempts) or ".",
                        exist_ok=True)
            with open(args.attempts, "w", encoding="utf-8") as f:
                f.write(content)

    if args.dry_run:
        log("DRY-RUN — nothing written")
        print(json.dumps(out, indent=2, sort_keys=True))
        return 0
    # Merge with the existing file per day (a movie not searched this
    # run keeps its earlier extraction; a re-searched movie keeps days
    # found earlier that this run did not re-find) and write only when
    # changed.
    merged = {}
    for tid, entries in existing.items():
        merged[tid] = {e["day"]: e for e in entries
                       if isinstance(e, dict) and "day" in e}
    for tid, entries in out.items():
        slot = merged.setdefault(tid, {})
        for e in entries:
            slot[e["day"]] = e
    merged = {tid: [merged[tid][d] for d in sorted(merged[tid])]
              for tid in sorted(merged)}
    content = json.dumps(merged, ensure_ascii=False, indent=2,
                         sort_keys=True) + "\n"
    existing_content = ""
    if os.path.exists(args.out):
        with open(args.out, encoding="utf-8") as f:
            existing_content = f.read()
    if existing_content == content:
        log("staging %s unchanged" % args.out)
        if step_runs is not None:
            step_runs.record(
                "overseas_ai", status="success",
                checked={"candidates": len(made) + len(skipped)
                         + len(failed),
                         "detail": "published movies with missing "
                                   "overseas day figures; Tavily "
                                   "searches: %d" % searches_total},
                changed={"added": [], "updated": [], "count": 0},
                reason="no-new-data")
        return 0
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(content)
    log("staging %s written (%d movie(s), %d day(s))"
        % (args.out, len(merged),
           sum(len(v) for v in merged.values())))
    if step_runs is not None:
        step_runs.record(
            "overseas_ai", status="success",
            checked={"candidates": len(made) + len(skipped)
                     + len(failed),
                     "detail": "published movies with missing overseas "
                               "day figures; Tavily searches: %d"
                               % searches_total},
            changed={"added": ["%s (%s)" % (t, i) for t, i, _ in made],
                     "updated": [], "count": len(made)})
    return 0


if __name__ == "__main__":
    sys.exit(main())

