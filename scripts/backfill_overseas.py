#!/usr/bin/env python3
"""
backfill_overseas.py — per-day overseas (plus shows / occupancy) sweep
from Sacnilk quicknews pages.

History: written as a ONE-TIME manual backfill (2026-10-2x). The
2026-10-30 chain audit found it was never wired into the pipeline, so
the only days that ever gained overseas figures were the ones the
Sacnilk reader happened to catch live (it fetches only the CURRENT
day's quicknews page) plus whatever this script's single manual run
left in staging. It is now the permanent gap sweep of the daily
overseas slot (hourly-pipeline.yml step 5d, mirrored in overseas.yml):

  * For every movie with day-wise rows whose baseline lacks an
    overseas figure for a COMPLETED day (date < today), fetch that
    day's quicknews page (/quicknews/<slug>_Box_Office_Collection_Day_<N>)
    and parse the overseas-standing sentence ("Overseas, the film
    collected RsX Cr on Day N...") plus the summary table's
    shows/occupancy for the listed days. A 404 (no quicknews page for
    that film/day) simply means no overseas figure exists for that
    day — it stays blank, never invented.
  * Today's rows are NOT swept: the page is still updating and the
    Sacnilk reader's live overlay owns the current day.
  * Attempt state (out/overseas-sweep-state.json): every fetched
    (movie, day) is stamped with its outcome. A day that produced no
    figure is not re-fetched for --retry-days days (default 7), so the
    sweep never burns fetches on the same dead end daily. A day that
    later gains a figure leaves the missing set on its own.
  * Priorities: freshest titles first (latest day-wise date), newest
    missing day first within a title; --max-pages bounds the run
    (0 = unbounded, the old manual behaviour).
  * The staging file is MERGED per (movie, day) with what is already
    there — never overwritten — so earlier extractions (this sweep,
    the original manual backfill) survive untouched.

Output: extras-only staging JSON for the averaging engine
(default out/boxoffice-staging/overseas-backfill.json):
    {"<tmdb_id>": [{"day": N, "date": "YYYY-MM-DD",
                    "overseas_inr_cr": X.XX, "shows": N,
                    "occupancy_pct": Y.Y, "source": "overseas-backfill"}]}
The engine (multisource_boxoffice.py, hourly) averages/merges it into
js/daywise-data.js, where the renderers read the "overseas" field.
"""

import argparse
import datetime as dt
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import sacnilk_boxoffice as sb  # noqa: E402

try:
    # Per-run record for the stats dashboard (out/step-runs.json).
    # A missing/broken helper must never break this script.
    import step_runs
except Exception:  # noqa: BLE001 - record helper is best-effort
    step_runs = None

STEP_NAME = "overseas_sweep"
OVERSEAS_KEYS = ("overseas_inr_cr", "shows", "occupancy_pct")


def log(msg):
    print("backfill-overseas: %s" % msg, flush=True)


def load_js_object(path, var):
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    start = raw.index("{")
    end = raw.rindex("}")
    return json.loads(raw[start:end + 1])


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            value = json.load(f)
        return value if isinstance(value, type(default)) else default
    except (OSError, ValueError):
        return default


def write_json_if_changed(path, value):
    content = json.dumps(value, ensure_ascii=False, indent=2,
                         sort_keys=True) + "\n"
    existing = ""
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            existing = f.read()
    if existing == content:
        return False
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return True


def day_num(row):
    try:
        return int(re.sub(r"\D", "", str(row.get("day", "0"))) or 0)
    except ValueError:
        return 0


def recent_attempt(state, key, now, retry_days):
    """True when (movie, day) was attempted < retry_days ago and the
    attempt produced no overseas figure — do not re-fetch yet."""
    rec = state.get(key)
    if not isinstance(rec, dict) or rec.get("outcome") == "filled":
        return False
    stamp = rec.get("attempted_at")
    if not stamp:
        return False
    try:
        when = dt.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return False
    if when.tzinfo is None:
        when = when.replace(tzinfo=dt.timezone.utc)
    return (now - when).total_seconds() < retry_days * 86400


def main():
    ap = argparse.ArgumentParser(
        description="Per-day overseas sweep from Sacnilk quicknews")
    ap.add_argument("--published", default="js/published-titles.js")
    ap.add_argument("--daywise", default="js/daywise-data.js")
    ap.add_argument("--out",
                    default="out/boxoffice-staging/overseas-backfill.json")
    ap.add_argument("--state", default="out/overseas-sweep-state.json",
                    help="per-(movie, day) attempt markers")
    ap.add_argument("--movie", default=None,
                    help="only run one TMDB id (testing)")
    ap.add_argument("--max-pages", type=int, default=0,
                    help="max quicknews pages fetched this run "
                         "(0 = no limit; the pipeline passes a bound)")
    ap.add_argument("--retry-days", type=float, default=7.0,
                    help="days before a figure-less (movie, day) is "
                         "re-fetched (default 7)")
    ap.add_argument("--sleep", type=float, default=0.7,
                    help="seconds between fetches (default 0.7)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    raw_pub = load_js_object(args.published, "FA_PUBLISHED")
    published = {str(tid): e for tid, e in raw_pub.items()
                 if isinstance(e, dict) and e.get("type") == "movie"}
    try:
        daywise = load_js_object(args.daywise, "FA_DAYWISE")
    except Exception as e:
        log("FATAL: cannot read %s: %s" % (args.daywise, e))
        return 2

    now = dt.datetime.now(dt.timezone.utc)
    today = now.date().isoformat()
    now_iso = now.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    state = load_json(args.state, {})
    existing = load_json(args.out, {})

    # Work list: titles with at least one completed day missing
    # overseas. Freshest titles first (latest day-wise date), so a
    # bounded run spends its pages where they matter most.
    work = []
    for tid in sorted(daywise):
        if args.movie and tid != args.movie:
            continue
        rows = daywise[tid]
        entry = published.get(tid) or published.get(str(tid))
        if not entry:
            continue
        need = {}
        for r in rows:
            dnum = day_num(r)
            if (dnum >= 1 and r.get("overseas") is None
                    and r.get("date") and r["date"] < today):
                need[dnum] = r["date"]
        if not need:
            continue
        latest = max((r.get("date") or "") for r in rows)
        work.append((latest, entry.get("title") or tid, tid, entry, need))
    work.sort(key=lambda w: (w[0], w[1]), reverse=True)

    merged = {}
    for tid, entries in existing.items():
        if isinstance(entries, list):
            merged[tid] = {e["day"]: e for e in entries
                           if isinstance(e, dict) and "day" in e}

    fetched, filled, missing_pages, deferred = 0, 0, 0, 0
    filled_titles = []
    for _latest, title, tid, entry, need in work:
        rel = (entry.get("release_date") or "").strip()
        year = rel[:4] if len(rel) >= 4 else ""
        slug = sb.SLUG_OVERRIDES.get(str(tid)) or sb.slugify(title, year)
        if not slug:
            log("  %s: empty slug, skipping" % title)
            continue
        # Newest missing day first; days on attempt cooldown wait.
        todo = []
        for day in sorted(need, reverse=True):
            if recent_attempt(state, "%s:%d" % (tid, day), now,
                              args.retry_days):
                deferred += 1
                continue
            todo.append(day)
        if not todo:
            continue
        log("  %s (%s): %d day(s) need overseas" % (title, tid, len(todo)))
        entries = merged.setdefault(tid, {})
        title_filled = 0
        for day in todo:
            if args.max_pages and fetched >= args.max_pages:
                log("  page budget %d reached — remaining days roll to "
                    "the next run" % args.max_pages)
                break
            try:
                html = sb.fetch_quicknews(slug, day)
            except Exception as e:  # one title's fetch must not
                # block the rest of the sweep  # noqa: BLE001
                log("  %s Day %d: fetch error (%s)" % (title, day, e))
                html = None
            fetched += 1
            if not args.dry_run:
                time.sleep(args.sleep)
            key = "%s:%d" % (tid, day)
            if html is None:
                missing_pages += 1
                state[key] = {"attempted_at": now_iso,
                              "outcome": "no-page",
                              "attempts": int((state.get(key) or {})
                                              .get("attempts") or 0) + 1}
                continue
            _per_day, _adv, extras = sb.parse_quicknews(html)
            # The page's own day gets its overseas figure (the Day-1
            # phrasing keys it to None — that IS this page's day). Merge
            # it into the day's entry (the summary table may already
            # have put shows/occupancy under the same day).
            if None in extras:
                extras.setdefault(day, {}).update(extras.pop(None))
            got = extras.get(day) or {}
            # Shows/occupancy from this page's summary table cover all
            # days up to this one — take them for any needed day.
            for d, ex in extras.items():
                if d is None or d not in need:
                    continue
                slot = entries.setdefault(
                    d, {"day": d, "date": need[d],
                        "source": "overseas-backfill"})
                for k in OVERSEAS_KEYS:
                    if k in ex:
                        slot[k] = ex[k]
            if got.get("overseas_inr_cr") is not None:
                filled += 1
                title_filled += 1
                state[key] = {"attempted_at": now_iso,
                              "outcome": "filled",
                              "attempts": int((state.get(key) or {})
                                              .get("attempts") or 0) + 1}
            else:
                state[key] = {"attempted_at": now_iso,
                              "outcome": "no-figure",
                              "attempts": int((state.get(key) or {})
                                              .get("attempts") or 0) + 1}
        if any("overseas_inr_cr" in (entries.get(d) or {}) for d in need):
            if title_filled:
                filled_titles.append("%s (%s)" % (title, tid))
        log("  %s: filled %d day(s)" % (title, title_filled))

    log("fetched %d quicknews page(s), %d overseas day figure(s), "
        "%d page(s) missing (404), %d day(s) deferred by attempt "
        "cooldown" % (fetched, filled, missing_pages, deferred))
    if args.dry_run:
        log("DRY-RUN — nothing written")
        print(json.dumps({tid: [merged[tid][d] for d in sorted(merged[tid])]
                          for tid in sorted(merged) if merged[tid]},
                         indent=2, sort_keys=True))
        return 0
    out_value = {tid: [merged[tid][d] for d in sorted(merged[tid])]
                 for tid in sorted(merged) if merged[tid]}
    changed = write_json_if_changed(args.out, out_value)
    write_json_if_changed(args.state, state)
    log("staging %s %s (%d movie(s), %d day(s))"
        % (args.out, "written" if changed else "unchanged",
           len(out_value), sum(len(v) for v in out_value.values())))
    if step_runs is not None:
        step_runs.record(
            STEP_NAME, status="success",
            checked={"candidates": sum(len(w[4]) for w in work),
                     "detail": "completed day-wise rows missing "
                               "overseas; quicknews pages fetched: %d; "
                               "attempt cooldown deferred: %d"
                               % (fetched, deferred)},
            changed={"added": filled_titles, "updated": [],
                     "count": filled},
            reason=None if filled else "no-new-data")
    return 0


if __name__ == "__main__":
    sys.exit(main())
