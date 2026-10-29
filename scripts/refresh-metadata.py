#!/usr/bin/env python3
"""Daily metadata refresh for already-published FlickAtlas titles.

The seeder never touches a title once it is published, so poster /
overview / release_date / trailer / providers freeze at bake time
(audit 2026-10-27 §6). This script re-fetches TMDB details for
recent published titles and updates ONLY the TMDB-sourced fields.

SAFEGUARDS (owner order — never touch editorial data):
  - Reviews, summaries and box-office rows live in OTHER files
    (js/reviews-data.js, js/articles-data.js, js/daywise-data.js);
    this script only ever writes js/published-titles.js.
  - Inside an entry, only the TMDB_FIELDS whitelist is overwritten.
    `published_at`, `categories` and `source` are always kept, and
    any key present in the existing entry but NOT in the fresh build
    is preserved (it may be a manual correction).
  - A field is only overwritten when the fresh value is meaningful
    and different: non-empty strings, non-empty lists, a trailer
    object (never None), non-zero numbers. TMDB must never blank a
    field it used to have (a missing overview / a zeroed budget is
    treated as "unknown", not as "deleted").
  - Providers are re-fetched separately: a failed providers request
    leaves the existing providers alone (an empty list is only
    written when TMDB actually returns no flatrate entry).
  - Release dates use the India-theatrical rule (pick_release_date
    in publish-titles.py), so a festival premiere stops being the
    baked date as soon as a theatrical date exists.

Scope: movies with a baked release_date within [today-90d,
today+90d] (plus entries with no baked date at all — they need one),
and TV that is currently airing. Newest first, capped at --max
(default 50) titles per run so a bad TMDB day can never rewrite the
whole catalogue. Daily cadence (06:00 UTC + 25-hour overdue catch-up
in the hourly pipeline).

Usage:
  TMDB_API_KEY=<key> refresh-metadata.py [--dry-run]
      [--out js/published-titles.js] [--max 50]
Exits 0; prints what it did. Writes the file only when something
changed. The key comes from TMDB_API_KEY, --key, or js/config.js —
it is never hardcoded and never printed.
"""
import argparse
import importlib.util
import json
import os
import re
import sys
import time
import urllib.parse
from datetime import date, timedelta

try:
    # Per-run record for the stats dashboard (out/step-runs.json).
    # A missing/broken helper must never break the refresh run.
    import step_runs
except Exception:  # noqa: BLE001 - record helper is best-effort
    step_runs = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, "js", "published-titles.js")
CONFIG_JS = os.path.join(ROOT, "js", "config.js")
PUBLISH_TITLES = os.path.join(ROOT, "scripts", "publish-titles.py")
TITLE_SEED = os.path.join(ROOT, "scripts", "title-seed.py")

FRESH_DAYS = 90
DEFAULT_MAX = 50

# TMDB-sourced fields the refresh may overwrite. Everything else in
# an entry (published_at, categories, source, providers — providers
# are handled separately below — and any unknown/manual key) is kept.
TMDB_FIELDS_MOVIE = {
    "title", "poster_path", "backdrop_path", "vote_average",
    "vote_count", "overview", "industry", "original_language",
    "origin_country", "trailer", "budget", "revenue", "genres",
    "tagline", "status", "production_countries", "spoken_languages",
    "certification", "release_date", "runtime", "date_kind",
    # date_kind (festival-only flag, owner decision 2026-10-27) is
    # recomputed by every refresh: a title that gains a theatrical
    # date flips festival -> release, and vice versa. It is a
    # non-empty string either way, so the "never blank" safeguard
    # never blocks it.
}
TMDB_FIELDS_TV = {
    "title", "poster_path", "backdrop_path", "vote_average",
    "vote_count", "overview", "industry", "original_language",
    "origin_country", "trailer", "budget", "revenue", "genres",
    "tagline", "status", "production_countries", "spoken_languages",
    "certification", "first_air_date", "networks",
    "number_of_seasons", "number_of_episodes", "channel",
    "episode_run_time", "seasons", "created_by",
}


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read_key(args):
    if args.key:
        return args.key
    env = os.environ.get("TMDB_API_KEY", "").strip()
    if env:
        return env
    if os.path.exists(CONFIG_JS):
        with open(CONFIG_JS, encoding="utf-8") as f:
            raw = f.read()
        m = re.search(r'TMDB_KEY:\s*"([^"]+)"', raw)
        if m:
            return m.group(1)
    return ""


def parse_date(value):
    if not value:
        return None
    try:
        y, m, d = (int(p) for p in str(value).strip().split("-"))
        return date(y, m, d)
    except (ValueError, TypeError):
        return None


def in_scope(entry, today):
    """Recent (90d window) or dateless movies, and currently-airing TV."""
    if (entry or {}).get("type") == "tv":
        if (entry.get("status") or "") == "Returning Series":
            return True
        for field in ("last_air_date", "first_air_date"):
            d = parse_date(entry.get(field))
            if d and (today - d).days <= FRESH_DAYS:
                return True
        return False
    d = parse_date(entry.get("release_date"))
    if d is None:
        return True  # no baked date — it needs one
    return abs((d - today).days) <= FRESH_DAYS


def _meaningful(value):
    """True when a fresh value is worth overwriting with (never blank
    a field TMDB used to have)."""
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip() != ""
    if isinstance(value, (list, dict)):
        return len(value) > 0
    if isinstance(value, (int, float)):
        return value != 0
    return True


def merge_entry(existing, fresh, media):
    """Merge a fresh build_entry into the existing entry, honouring
    the safeguards. Returns (merged_entry, [changed field names])."""
    allowed = (TMDB_FIELDS_MOVIE if media == "movie"
               else TMDB_FIELDS_TV)
    merged = dict(existing)
    changed = []
    for field in sorted(allowed):
        if field not in fresh:
            continue
        new = fresh[field]
        old = existing.get(field)
        if new == old:
            continue
        if not _meaningful(new):
            continue  # never blank / never zero-out a field
        merged[field] = new
        changed.append(field)
    return merged, changed


def fetch_providers_safe(tid, media, key, ts):
    """Providers list, or None when the request itself failed (so the
    caller keeps the existing providers instead of blanking them)."""
    try:
        data = ts.tmdb_get(f"/{media}/{tid}/watch/providers", key)
    except Exception:
        return None
    if not data:
        return None
    results = data.get("results") or {}
    for region in ("IN", "US"):
        entry = results.get(region) or {}
        flatrate = entry.get("flatrate") or []
        if not flatrate:
            continue
        out = []
        for p in flatrate:
            name = (p.get("provider_name") or "").strip()
            if not name:
                continue
            out.append({"name": name,
                        "logo_path": p.get("logo_path") or "",
                        "region": region, "type": "flatrate"})
        if out:
            return out
    return []


def main():
    ap = argparse.ArgumentParser(
        description="Daily TMDB metadata refresh for published titles")
    ap.add_argument("--key", default=None)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--max", type=int, default=DEFAULT_MAX,
                    help="max titles refreshed per run (default 50)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    key = read_key(args)
    if not key:
        print("refresh-metadata: no TMDB key — set TMDB_API_KEY, --key, "
              "or js/config.js TMDB_KEY", file=sys.stderr)
        return 2

    pt = load_module("publish_titles", PUBLISH_TITLES)
    ts = load_module("title_seed", TITLE_SEED)
    published = pt.read_js_map(args.out, "FA_PUBLISHED")
    today = date.today()

    # In scope, newest first (most likely to have changed).
    scoped = [e for e in published.values()
              if e and in_scope(e, today)]
    scoped.sort(key=lambda e: (e.get("release_date")
                               or e.get("first_air_date") or ""),
                reverse=True)
    todo = scoped[:args.max]
    print(f"refresh-metadata: {len(published)} published, "
          f"{len(scoped)} in scope, refreshing {len(todo)} "
          f"(max {args.max}){' [DRY RUN]' if args.dry_run else ''}")

    updated, checked, failed = [], 0, 0
    for entry in todo:
        tid = str(entry.get("id"))
        media = entry.get("type") or "movie"
        try:
            details = ts.fetch_typed(tid, media, key, pt)
        except Exception as e:
            print(f"  SKIP {tid}: TMDB request failed ({e})")
            failed += 1
            continue
        if details is None:
            print(f"  SKIP {tid}: no such title on TMDB")
            failed += 1
            continue
        fresh = pt.build_entry(details, media,
                               list(entry.get("categories") or []),
                               entry.get("published_at") or "")
        merged, changed = merge_entry(entry, fresh, media)
        # Providers (separate: a failed fetch must not blank them).
        try:
            prov = fetch_providers_safe(tid, media, key, ts)
        except Exception:
            prov = None
        if prov is not None and prov != entry.get("providers"):
            merged["providers"] = prov
            changed.append("providers")
        checked += 1
        time.sleep(0.3)  # Conservative pacing across separate TMDB requests
        if not changed:
            continue
        if args.dry_run:
            print(f"  would update {tid} ({entry.get('title')}, "
                  f"{', '.join(sorted(set(changed)))})")
            updated.append((entry.get("title"), tid, changed))
            continue
        published[tid] = merged
        print(f"  updated {tid} ({entry.get('title')}, "
              f"{', '.join(sorted(set(changed)))})")
        updated.append((entry.get("title"), tid, changed))
        time.sleep(0.3)

    if not args.dry_run and updated:
        changed_file = pt.write_js_map(args.out, "FA_PUBLISHED",
                                       published, pt.HEADER)
        print(f"refresh-metadata: {len(updated)} updated, "
              f"{checked} checked | file changed: {changed_file}")
    else:
        print(f"refresh-metadata (dry run): would update "
              f"{len(updated)}, {checked} checked | file NOT written"
              if args.dry_run else
              f"refresh-metadata: 0 updated, {checked} checked | "
              f"file unchanged")

    if step_runs is not None and not args.dry_run:
        names = [f"{t} ({i})" for t, i, _ in updated]
        reason = None
        status = "success"
        if todo and checked == 0 and failed:
            reason = "source-fail"
            status = "failed"
        elif not updated:
            reason = "no-new-data"
        step_runs.record(
            "metadata_refresh", status=status,
            checked={"candidates": len(todo), "valid": checked,
                     "failed": failed,
                     "detail": "published titles in the 90-day window, "
                               "newest first; counts are valid detail "
                               "responses and failed detail requests"},
            changed={"added": [], "updated": names,
                     "count": len(updated)},
            reason=reason)
    return 1 if todo and checked == 0 and failed else 0


if __name__ == "__main__":
    sys.exit(main())

