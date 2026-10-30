#!/usr/bin/env python3
"""Backfill + rotate TMDB watch-providers in js/published-titles.js.

The title seeder (scripts/title-seed.py) bakes a `providers` field into
every NEW title it writes, but titles published before the providers
feature have none (the OTT page shows titles but names no platform).
This script fills providers for those titles, using the SAME
fetch_providers() logic as the seeder (TMDB watch/providers, IN
flatrate first, US fallback; only the flatrate list is kept).

It runs daily in the hourly pipeline (02:00 UTC slot): titles with no
providers are always checked first. With --rotate N it then also
re-fetches the N provider-carrying titles whose last verification is
oldest (state in out/providers-state.json), so a listed title landing
on — or leaving — a platform is noticed within a few days instead of
never (owner order 2026-10-30).

Usage:
  TMDB_API_KEY=<key> backfill_providers.py [--dry-run] [--apply]
      [--out js/published-titles.js] [--force] [--limit N]
      [--rotate N] [--state out/providers-state.json]
  --dry-run (default) prints what it would write, writes nothing.
  --apply writes the file (only when something changed).
  --force re-fetches even titles that already have providers.
  --limit N caps how many titles are processed (default: all).
  --rotate N re-verify the N stalest provider-carrying titles after
      the missing-provider pass (default 0: off).
The key comes from --key, TMDB_API_KEY, or js/config.js TMDB_KEY —
it is never hardcoded and never printed.
Exits 0; prints what it did. Best-effort: a failed fetch for one
title skips that title, never the whole run.
"""
import argparse
import importlib.util
import json
import os
import sys
import time
from datetime import datetime, timezone

try:
    import step_runs
except Exception:  # best-effort run telemetry
    step_runs = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, "js", "published-titles.js")
DEFAULT_STATE = os.path.join(ROOT, "out", "providers-state.json")
TITLE_SEED = os.path.join(ROOT, "scripts", "title-seed.py")


def load_title_seed():
    """Import scripts/title-seed.py by path (hyphenated filename)."""
    spec = importlib.util.spec_from_file_location("title_seed", TITLE_SEED)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_state(path):
    """Rotation state {"checked": {tid: iso-stamp}}; tolerant of a
    missing or corrupt file (rotation simply starts from scratch)."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(path, state):
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=1, sort_keys=True)
    except OSError as e:
        print(f"backfill-providers: cannot write state {path} ({e})",
              file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(
        description="Backfill TMDB watch-providers into "
                    "js/published-titles.js")
    ap.add_argument("--key", default=None,
                    help="TMDB API key (or TMDB_API_KEY env var, "
                         "or js/config.js TMDB_KEY)")
    ap.add_argument("--out", default=DEFAULT_OUT,
                    help="output file (default: js/published-titles.js)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print what it would do, do NOT write the file "
                         "(default)")
    ap.add_argument("--apply", action="store_true",
                    help="write the file (only when something changed)")
    ap.add_argument("--force", action="store_true",
                    help="re-fetch even titles that already have providers")
    ap.add_argument("--limit", type=int, default=0,
                    help="max titles to process (0 = all)")
    ap.add_argument("--rotate", type=int, default=0,
                    help="after the missing-provider pass, also "
                         "re-verify the N stalest provider-carrying "
                         "titles (default 0: off)")
    ap.add_argument("--state", default=DEFAULT_STATE,
                    help="rotation state file (default: "
                         "out/providers-state.json)")
    args = ap.parse_args()

    ts = load_title_seed()
    key = ts.read_key(args)
    if not key:
        print("backfill-providers: no TMDB key — set TMDB_API_KEY, "
              "--key, or js/config.js TMDB_KEY", file=sys.stderr)
        return 2

    pt = ts.load_publish_titles()
    published = pt.read_js_map(args.out, "FA_PUBLISHED")
    print(f"backfill-providers: {len(published)} titles published"
          f"{' [DRY RUN]' if not args.apply else ' [APPLY]'}")

    # Work list: titles with no providers first (the daily safety
    # net), then — with --rotate N — the N provider-carrying titles
    # whose last verification is oldest. --force keeps its old
    # meaning: every title.
    state = load_state(args.state)
    checked_map = dict(state.get("checked") or {})
    dict_tids = [tid for tid in sorted(published)
                 if isinstance(published[tid], dict)]
    if args.force:
        todo = list(dict_tids)
    else:
        todo = [tid for tid in dict_tids
                if not (published[tid].get("providers") or [])]
        if args.rotate > 0:
            carrying = [tid for tid in dict_tids
                        if (published[tid].get("providers") or [])]
            carrying.sort(key=lambda tid: (checked_map.get(tid) or "",
                                           tid))
            todo += carrying[:args.rotate]
    if args.limit:
        todo = todo[:args.limit]
    unchanged = len(dict_tids) - len(todo)

    updated, skipped = 0, 0
    processed = 0
    now_stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for tid in todo:
        entry = published[tid]
        processed += 1
        media = entry.get("type") or "movie"
        try:
            providers = ts.fetch_providers(tid, media, key)
        except Exception as e:
            print(f"  SKIP {tid} ({entry.get('title') or '?'}): "
                  f"providers fetch failed ({e})")
            skipped += 1
            continue
        providers = pt.preserve_verified_ott_provider(entry, providers)
        prov = ", ".join(p.get("name") for p in providers) or "none"
        if args.apply:
            entry["providers"] = providers
            checked_map[tid] = now_stamp
            print(f"  updated {tid} ({entry.get('title') or '?'}, "
                  f"{media}): providers {prov}")
        else:
            print(f"  would update {tid} ({entry.get('title') or '?'}, "
                  f"{media}): providers {prov}")
        updated += 1
        time.sleep(0.3)  # Conservative pacing across separate TMDB requests

    if args.apply:
        changed = pt.write_js_map(args.out, "FA_PUBLISHED", published,
                                  pt.HEADER)
        if checked_map != (state.get("checked") or {}):
            save_state(args.state, {"checked": checked_map})
        print(f"backfill-providers: +{updated} updated, {skipped} "
              f"skipped, {unchanged} already have providers | "
              f"file changed: {changed}")
    else:
        print(f"backfill-providers (dry run): would update {updated}, "
              f"{skipped} skipped, {unchanged} already have providers "
              f"| file NOT written")
    if step_runs is not None and args.apply:
        failed_all = processed > 0 and updated == 0 and skipped == processed
        reason = "source-fail" if failed_all else (
            "no-new-data" if processed == 0 or updated == 0 else None)
        detail = ("missing-provider titles fetched first, then the "
                  "--rotate stalest provider-carrying titles; processed "
                  "counts only upstream requests; zero processed means "
                  "unchanged check, not a new upstream fetch")
        step_runs.record(
            "providers_backfill", status="failed" if failed_all else "success",
            checked={"candidates": processed, "processed": processed,
                     "succeeded": updated, "failed": skipped,
                     "already_have_providers": unchanged, "detail": detail},
            changed={"added": [], "updated": [], "count": updated},
            reason=reason)
    return 1 if processed > 0 and updated == 0 and skipped == processed else 0


if __name__ == "__main__":
    sys.exit(main())
