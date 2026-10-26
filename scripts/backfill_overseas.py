#!/usr/bin/env python3
"""
backfill_overseas.py — ONE-TIME manual backfill of per-day overseas
(plus shows / occupancy) from Sacnilk quicknews pages.

For every movie with day-wise rows whose baseline lacks an overseas
figure, fetch that day's quicknews page
(/quicknews/<slug>_Box_Office_Collection_Day_<N>) and parse the
overseas-standing sentence ("Overseas, the film collected RsX Cr on
Day N...") plus the summary table's shows/occupancy for the listed
days. A 404 (no quicknews page for that film/day) simply means no
overseas figure exists for that day — it stays blank, never invented.

Output: extras-only staging JSON for the averaging engine
(default out/boxoffice-staging/overseas-backfill.json):
    {"<tmdb_id>": [{"day": N, "date": "YYYY-MM-DD",
                    "overseas_inr_cr": X.XX, "shows": N,
                    "occupancy_pct": Y.Y, "source": "overseas-backfill"}]}
Run the engine afterwards to merge into js/daywise-data.js. The
staging file is for the local backfill run; the ongoing Sacnilk
reader captures each new day's overseas/shows/occupancy from that
day's quicknews page on its normal run, so this script is not part
of the hourly pipeline.
"""

import argparse
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import sacnilk_boxoffice as sb  # noqa: E402


def log(msg):
    print("backfill-overseas: %s" % msg, flush=True)


def load_js_object(path, var):
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    start = raw.index("{")
    end = raw.rindex("}")
    return json.loads(raw[start:end + 1])


def main():
    ap = argparse.ArgumentParser(
        description="One-time overseas backfill from Sacnilk quicknews")
    ap.add_argument("--published", default="js/published-titles.js")
    ap.add_argument("--daywise", default="js/daywise-data.js")
    ap.add_argument("--out",
                    default="out/boxoffice-staging/overseas-backfill.json")
    ap.add_argument("--movie", default=None,
                    help="only run one TMDB id (testing)")
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

    out = {}
    fetched, filled, missing_pages = 0, 0, 0
    for tid in sorted(daywise):
        if args.movie and tid != args.movie:
            continue
        rows = daywise[tid]
        entry = published.get(tid) or published.get(str(tid))
        if not entry:
            log("  %s: not in published, skipping" % tid)
            continue
        title = entry.get("title") or tid
        rel = (entry.get("release_date") or "").strip()
        year = rel[:4] if len(rel) >= 4 else ""
        slug = sb.SLUG_OVERRIDES.get(str(tid)) or sb.slugify(title, year)
        if not slug:
            log("  %s: empty slug, skipping" % title)
            continue
        # Days lacking overseas in the baseline.
        need = {}
        for r in rows:
            try:
                dnum = int(re.sub(r"\D", "", str(r.get("day", "0"))) or 0)
            except ValueError:
                continue
            if dnum >= 1 and r.get("overseas") is None and r.get("date"):
                need[dnum] = r["date"]
        if not need:
            log("  %s: overseas complete, skipping" % title)
            continue
        log("  %s (%s): %d day(s) need overseas" % (title, tid, len(need)))
        entries = {}
        for day in sorted(need):
            html = sb.fetch_quicknews(slug, day)
            time.sleep(args.sleep)
            fetched += 1
            if html is None:
                missing_pages += 1
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
                slot = entries.setdefault(d, {"day": d, "date": need[d],
                                              "source": "overseas-backfill"})
                for k in ("overseas_inr_cr", "shows", "occupancy_pct"):
                    if k in ex:
                        slot[k] = ex[k]
            if got.get("overseas_inr_cr") is not None:
                filled += 1
        if entries:
            out[tid] = [entries[d] for d in sorted(entries)]
        log("  %s: filled %d day(s)" % (title, len(entries)))

    log("fetched %d quicknews page(s), %d overseas day figure(s), "
        "%d page(s) missing (404)" % (fetched, filled, missing_pages))
    if args.dry_run:
        log("DRY-RUN — nothing written")
        print(json.dumps(out, indent=2, sort_keys=True))
        return 0
    content = json.dumps(out, ensure_ascii=False, indent=2,
                         sort_keys=True) + "\n"
    existing = ""
    if os.path.exists(args.out):
        with open(args.out, encoding="utf-8") as f:
            existing = f.read()
    if existing == content:
        log("staging %s unchanged" % args.out)
        return 0
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(content)
    log("staging %s written (%d movie(s), %d day(s))"
        % (args.out, len(out), sum(len(v) for v in out.values())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
