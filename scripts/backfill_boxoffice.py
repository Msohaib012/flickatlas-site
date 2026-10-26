#!/usr/bin/env python3
"""One-time backfill: extract day-wise box-office rows from articles
already published (js/articles-data.js) and merge them into
js/daywise-data.js via apply-auto.py.

Run ONCE from the repo root, after scripts/boxoffice_extract.py is in
place. The ongoing pipeline (gemini_batch.py + the regex fallback) covers
every NEW box-office article; this script only recovers the rows the old
pipeline never produced.

Usage:
  python3 scripts/backfill_boxoffice.py            # dry run (default):
                                                   # print the rows, write nothing
  python3 scripts/backfill_boxoffice.py --apply    # write
                                                   # out/boxoffice-backfill.json
                                                   # and run apply-auto.py to merge

What it produces (verified 2026-10-26 against the 48 live articles):
  - Udta Teer (1375156): Day 1 $433,175 (confirms the existing row),
    Day 2 $765,980 (CORRECTION: the existing row is $739,567 = Rs 7.00 cr;
    two concordant newer articles say Rs 7.25 cr), Day 3 $867,406 (NEW).
  - Nothing else: Jailer 2 / Ranabaali are not published (rows could never
    display), Clayface articles report weekend totals (never split into
    days), the NAZA roundup has no day figures, and the Ramayana article
    is advance booking (pre-sales are not a day's collection).

The merge follows apply-auto.py section 2 exactly (same film+day row is
UPDATED, never duplicated; zero/missing is never written). Re-running is
idempotent: the same rows just re-assert the same values.
"""
import argparse
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import boxoffice_extract

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "out")


def read_js_map(path, var):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    return json.loads(raw[raw.index("{"):raw.rindex("}") + 1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true",
                    help="write out/boxoffice-backfill.json and run apply-auto.py")
    args = ap.parse_args()

    articles = read_js_map(os.path.join(ROOT, "js", "articles-data.js"),
                           "FA_ARTICLES")
    published = boxoffice_extract.load_published(ROOT)
    rows = boxoffice_extract.extract_all(articles, published)
    print(f"backfill: {len(articles)} articles, {len(published)} published "
          f"movies -> {len(rows)} box-office rows")
    for r in rows:
        print(f"  {r['tmdb_id']} {r['film']} Day {r['day']} {r['date']} "
              f"${r['collection_usd']:,} "
              f"(Rs {r['collection_inr_crore']} cr)")
    if not args.apply:
        print("dry run: nothing written (re-run with --apply to merge)")
        return 0
    if not rows:
        print("no rows to backfill")
        return 0
    os.makedirs(OUT_DIR, exist_ok=True)
    bf_path = os.path.join(OUT_DIR, "boxoffice-backfill.json")
    with open(bf_path, "w", encoding="utf-8") as f:
        json.dump({"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                              time.gmtime()),
                   "count": len(rows), "box_office": rows},
                  f, ensure_ascii=False, indent=1)
    print(f"wrote {bf_path}")
    res = subprocess.run([sys.executable,
                          os.path.join(ROOT, "scripts", "apply-auto.py")],
                         cwd=ROOT)
    return res.returncode


if __name__ == "__main__":
    sys.exit(main())
