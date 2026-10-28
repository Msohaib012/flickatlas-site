#!/usr/bin/env python3
"""Worldwide theatrical totals writer for FlickAtlas.

Merges per-source WORLDWIDE total staging files
(out/boxoffice-staging/*-worldwide.json, written by the Tavily pass-2
gap-filler and any future reader) with the curated seed
(scripts/worldwide-seed.json — human-verified figures, see
backfill-worldwide.json) into js/worldwide-data.js
(window.FA_WORLDWIDE, total_usd per TMDB id).

Scope rule (mirrors scripts/multisource_boxoffice.py): worldwide totals
are TOTALS, not day-wise. They are NEVER written into
js/daywise-data.js and NEVER averaged with India Net figures. They render
only as a labelled "Worldwide total" fallback on Box Office cards for
titles with no India-Net day-wise rows.

Merge rule (deterministic, no timestamps):
  * a title in the seed keeps the SEED figure, unless a staging entry for
    the same title is strictly NEWER (as_of) AND differs by more than 5%
    — a real update to a still-running total (e.g. Wildwood rising),
    not search noise. A stale or near-identical staging figure never
    overrides a human-verified seed figure.
  * a title only in staging is added as-is (it passed the reader's
    own strict acceptance, e.g. tavily pick_worldwide).
  * a title only in the seed is kept as-is.

The output header is byte-identical to the seeded js/worldwide-data.js
on purpose: all writers must emit the same header, or the file
flip-flops between headers on every hourly run (a spurious diff).

CLI: python3 scripts/worldwide_boxoffice.py --staging out/boxoffice-staging
  --root DIR  (repo root; default: parent of this script's dir)
  --seed FILE (default: <root>/scripts/worldwide-seed.json)
  --dry-run   (print what it would write, write nothing)

This file is stdlib only.
"""

import argparse
import json
import os
import sys
from datetime import date

WORLDWIDE_HEADER = (
    "/* FlickAtlas — worldwide theatrical totals. GENERATED from "
    "scripts/worldwide-seed.json (verified figures, see "
    "backfill-worldwide.json) by scripts/worldwide_boxoffice.py — do not "
    "edit by hand. Keyed by TMDB movie id; total_usd = reported worldwide "
    "theatrical total in USD (NOT day-wise, NOT India Net). Shown only as "
    "a labelled fallback on Box Office cards for titles with no India-Net "
    "day-wise rows. */")


def read_json(path):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_js_map(path, var, data, header):
    content = (header + "\nwindow." + var + " = " +
               json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + ";\n")
    existing = ""
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            existing = f.read()
    if existing == content:
        return False
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return True


def usable(entry):
    """A staging/seed entry is usable only with a sane USD total."""
    if not isinstance(entry, dict):
        return False
    total = entry.get("total_usd")
    return (isinstance(total, (int, float)) and not isinstance(total, bool)
            and 10000 <= total <= 3000000000)


def merge(seed, staging_files):
    """seed: {tmdb: entry}; staging_files: list of {tmdb: entry} dicts.
    Returns (merged, notes) where notes lists human-readable decisions."""
    merged = {}
    notes = []
    for tid, entry in sorted(seed.items()):
        if usable(entry):
            merged[str(tid)] = dict(entry)
        else:
            notes.append(f"{tid}: seed entry unusable, dropped")
    for name, staging in staging_files:
        for tid, entry in sorted(staging.items()):
            tid = str(tid)
            if not usable(entry):
                notes.append(f"{tid}: staging {name} entry unusable, ignored")
                continue
            if tid not in merged:
                merged[tid] = dict(entry)
                notes.append(f"{tid}: added from staging {name}")
                continue
            old = merged[tid]
            try:
                old_date = date.fromisoformat(str(old.get("as_of", "")))
                new_date = date.fromisoformat(str(entry.get("as_of", "")))
            except ValueError:
                notes.append(f"{tid}: staging {name} kept out (unparsable as_of)")
                continue
            if new_date <= old_date:
                notes.append(f"{tid}: staging {name} not newer than seed, kept seed")
                continue
            old_total = float(old["total_usd"])
            new_total = float(entry["total_usd"])
            if abs(new_total - old_total) <= 0.05 * old_total:
                notes.append(f"{tid}: staging {name} within 5% of seed, kept seed")
                continue
            merged[tid] = dict(entry)
            notes.append(f"{tid}: staging {name} newer and >5% different, updated "
                         f"${old_total:,.0f} -> ${new_total:,.0f}")
    return merged, notes


def main():
    ap = argparse.ArgumentParser(
        description="Merge worldwide-total staging files + seed into "
                    "js/worldwide-data.js.")
    ap.add_argument("--staging", default=None,
                    help="staging dir (default: <root>/out/boxoffice-staging)")
    ap.add_argument("--root", default=None,
                    help="repo root (default: parent of this script's dir)")
    ap.add_argument("--seed", default=None,
                    help="seed JSON (default: <root>/scripts/worldwide-seed.json)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print what it would write, write nothing")
    args = ap.parse_args()

    root = args.root or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    staging_dir = args.staging or os.path.join(root, "out", "boxoffice-staging")
    seed_path = args.seed or os.path.join(root, "scripts", "worldwide-seed.json")

    seed_raw = read_json(seed_path)
    seed = seed_raw.get("figures", seed_raw) if isinstance(seed_raw, dict) else {}
    staging_files = []
    if os.path.isdir(staging_dir):
        for name in sorted(os.listdir(staging_dir)):
            if name.endswith("-worldwide.json"):
                staging_files.append((name, read_json(os.path.join(staging_dir, name))))
    merged, notes = merge(seed, staging_files)
    for note in notes:
        print(f"worldwide: {note}")
    print(f"worldwide: seed {len(seed)} title(s), "
          f"{len(staging_files)} staging file(s), merged {len(merged)} title(s)")
    if args.dry_run:
        print("worldwide: DRY-RUN — js/worldwide-data.js not written")
        print(json.dumps(merged, ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    out_path = os.path.join(root, "js", "worldwide-data.js")
    changed = write_js_map(out_path, "FA_WORLDWIDE", merged, WORLDWIDE_HEADER)
    print(f"worldwide: {out_path} written: {changed} ({len(merged)} title(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
