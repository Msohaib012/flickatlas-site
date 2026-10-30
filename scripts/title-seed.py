#!/usr/bin/env python3
"""Seed chosen TMDB titles into js/published-titles.js (title seeder).

FlickAtlas is published-only: TMDB is a data source, not a catalogue.
The news pipeline writes ARTICLES but never adds TITLE pages — that is
why the catalogue stays at 2 titles while news grows. This script is
the SEPARATE title system (Sacnilk model): it picks titles from TMDB
lists and publishes them as FA_PUBLISHED entries, so the Movies /
Spotlight / Trending / Dramas sections fill up.

Sources (TMDB lists — bounded page counts in SOURCE_PAGES, default one page):
  trending     — /trending/movie/week (global trending)
  now_playing  — /movie/now_playing?region=IN (in cinemas now, India)
  upcoming     — /movie/upcoming?region=IN (coming soon, India)
  bollywood    — /discover/movie?with_original_language=hi (Hindi films;
               the movie lists above are world-dominated by popularity,
               so Bollywood needs its own source)
  hindi_recent_movies — Hindi-only recent releases, sorted by primary date
               rather than all-time popularity (last 90 days)
  hindi_recent_tv — Hindi-language recent premieres, sorted by first-air
               date rather than global popularity (last 90 days)
  india_window — /discover/movie?region=IN, India release date inside
               the fresh window (last 7 days .. next 7 days). Page-1-
               only lists are popularity-sorted, so small/regional
               releases (Dhood, Doosra, Crime 302 — now_playing pages
               2-4, 2026-10-23) NEVER surfaced (audit 2026-10-27 §4a);
               this date-filtered source finds them by DATE, not rank.
  pk_dramas    — /discover/tv?with_origin_country=PK (Pakistani dramas)
  pk_movies    — /discover/movie?with_origin_country=PK (Pakistani
               films — Lollywood had dramas only, no movies, because
               there was no movies source; primary_release_date.gte
               keeps it to the last 90 days + upcoming)

Record assembly is NOT duplicated here: it reuses scripts/publish-titles.py
(fetch_title, build_entry, read_js_map, write_js_map, HEADER) via
importlib, so the baked entry shape is byte-identical to the existing
seed titles (no cast/crew arrays — the detail pages fetch credits live).

OTT providers (2026-10-26): every entry also gets a `providers` field
— the TMDB watch/providers flatrate (streaming) list for the title,
IN region first, US as fallback. Shape (baked in so the OTT page can
name platforms without a live call):
  "providers": [{"name": "Netflix",
                 "logo_path": "/rK1KljqmbvO9HQa1PBFLILWah72.png",
                 "region": "IN", "type": "flatrate"}]
Empty list [] when TMDB has no streaming provider for the title (most
new/upcoming titles and TV dramas have none — they are in cinemas or
on TV/YouTube, not on a TMDB-tracked streamer). Enrichment is
best-effort: one extra API call per title, only the flatrate list is
kept, and a failure never drops the title (it is written with
providers []). Existing titles get providers from
scripts/backfill_providers.py (one-time), not from this seeder.

Rules (selection, in order):
  - skip titles already in FA_PUBLISHED (by TMDB id)
  - skip titles with no poster_path
  - movies: skip when release_date is in the past and older than
    FRESH_DAYS (90); future (upcoming) dates always pass
  - tv: no date rule at list level (a long-running drama's first air
    date is old but it may still be airing); currency is checked at
    details level instead (last_air_date / next episode / status)
  - dedup within the run (a title can appear in several lists)
  - reserve up to two fresh slots for each date-ranked Hindi Recent source;
    the rest of the safety ceiling stays in the existing all-source mix
  - one-time OTT backlog (2026-10-30): ids in
    scripts/ott-backfill-list.json are published FIRST, up to
    BACKLOG_PER_RUN per run, outside the ceiling — the 90-day gate
    above applies to source-list selection only, never to this
    curated list (its titles are old by design and provider-verified)
  - reserve at most two of the four daily backfill slots for Hindi Recent
    movies/TV, leaving at least two slots for the global newest-first pool
Details-level rules (after fetching each picked id):
  - tv: skip when not currently airing (no episode in the last
    FRESH_DAYS, no next episode scheduled, status not Returning Series)
  - skip when the assembled entry has no poster or no title

Usage:
  TMDB_API_KEY=<key> title-seed.py [--dry-run] [--out js/published-titles.js]
  --dry-run fetches + assembles but does NOT write the file.
The key comes from TMDB_API_KEY, --key, or js/config.js (TMDB_KEY) —
it is never hardcoded and never printed.
Exits 0; prints what it did.
"""
import argparse
import importlib.util
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta

try:
    # Per-run record for the stats dashboard (out/step-runs.json).
    # A missing/broken helper must never break the seeder run.
    import step_runs
except Exception:  # noqa: BLE001 - record helper is best-effort
    step_runs = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, "js", "published-titles.js")
CONFIG_JS = os.path.join(ROOT, "js", "config.js")
PUBLISH_TITLES = os.path.join(ROOT, "scripts", "publish-titles.py")

FIRST_RUN_MAX = 15
# Flexible pace (his order 2026-10-26): NO fixed daily quota.
# - Fresh titles (released in the last 7 days, or releasing in the
#   next 7 days) are all added — however many there are, that is the
#   need. - Backfill (older titles, up to 90 days) is capped at 4/day
#   so the catalogue fills gradually, newest first, in sequence.
# - SAFETY_CEILING is a hard cap per run so a bad source list can
#   never dump a massive batch at once.
FRESH_WINDOW_DAYS = 7
# Trending drip (2026-10-28): non-fresh TMDB-trending titles added per
# seeder run, ahead of the general backfill — so the Trending Worldwide
# rail gains the titles TMDB says are trending a few at a time
# ("thori thori kar ke") instead of starving behind BACKFILL_PER_DAY.
TRENDING_DRIP_PER_RUN = 5
BACKFILL_PER_DAY = 4
SAFETY_CEILING = 20
# One-time OTT catalogue backlog (owner order 2026-10-30): the rolling
# 90-day freshness gate meant 2025 / direct-to-OTT releases could NEVER
# enter the catalogue, so the OTT rails starved. A curated, verified
# list (scripts/ott-backfill-list.json — TMDB ids of movies that TODAY
# carry flatrate providers) is drained FIRST, ahead of every other
# phase, at BACKLOG_PER_RUN per run and OUTSIDE the normal ceiling, so
# the daily fresh flow is never starved by the drain. The list is
# static: ids already in FA_PUBLISHED are skipped, so the lane empties
# itself; the file can be deleted once drained. Missing/corrupt file =
# empty backlog, never a crash.
BACKLOG_PER_RUN = 30
BACKLOG_LIST = os.path.join(ROOT, "scripts", "ott-backfill-list.json")
FRESH_DAYS = 90
HINDI_RECENT_SOURCES = ("hindi_recent_movies", "hindi_recent_tv")
HINDI_RECENT_PER_SOURCE = 2
HINDI_FRESH_RESERVE_MAX = HINDI_RECENT_PER_SOURCE * len(HINDI_RECENT_SOURCES)
HINDI_BACKFILL_RESERVE_MAX = 2

# (source name, media type, TMDB list path) — order is the round-robin
# priority (first pick of each source first).
# PAGES: how many pages of each source to read. The movie lists are
# popularity-sorted, so page 1 alone is blind to small/regional
# releases (audit 2026-10-27 §4a: 8 films from 2026-10-23 sat on
# now_playing pages 2-4 and could NEVER arrive). Pages 1-2 + the
# date-filtered india_window source close that gap (spike-tested
# 2026-10-27: all 13 missing targets found).
SOURCES = [
    ("trending", "movie",
     "/trending/movie/week"),
    ("trending_tv", "tv",
     # 2026-10-28: there was NO international TV source at all — TMDB
     # /trending/tv/week was 20/20 missing from the catalogue, so the
     # OTT TV rails could never fill. Currency is checked on details
     # (tv_is_current), like pk_dramas.
     "/trending/tv/week"),
    ("now_playing", "movie",
     "/movie/now_playing?region=IN"),
    ("upcoming", "movie",
     "/movie/upcoming?region=IN"),
    ("bollywood", "movie",
     "/discover/movie?with_original_language=hi&sort_by=popularity.desc"),
    ("hindi_recent_movies", "movie",
     # Keep the existing broad/popularity source for its current purpose;
     # this bounded 90-day source ensures recent Hindi releases are not
     # hidden beyond its first two popularity-ranked pages. Upcoming Hindi
     # films remain covered by the existing upcoming/Bollywood sources.
     "/discover/movie?with_original_language=hi"
     "&primary_release_date.gte={cutoff}"
     "&primary_release_date.lte={today}"
     "&sort_by=primary_release_date.desc"),
    ("india_window", "movie",
     # India releases inside the fresh window, by DATE not rank:
     # {fresh_start} = 7 days ago, {fresh_end} = 7 days ahead.
     # The release_date filter matches any regional release date, so
     # a film whose India date is in the window shows up even when
     # its primary date is outside it (TMDB quirk, audit §8) — the
     # fresh/backfill split below still uses the primary date, so an
     # extra candidate is never wrongly forced in as "fresh".
     "/discover/movie?region=IN&release_date.gte={fresh_start}"
     "&release_date.lte={fresh_end}&sort_by=popularity.desc"),
    ("world_window", "movie",
     # World releases inside the fresh window, by PRIMARY release date:
     # every other movie source is IN-region (now_playing/upcoming/
     # india_window), so a US/EU release not playing in India never
     # entered any candidate list — World Cinema fell 3-4 days behind
     # (2026-10-28 audit: 11/20 of now_playing-IN page 1 missing).
     # Date-sorted, not popularity-sorted, so small releases surface.
     "/discover/movie?primary_release_date.gte={fresh_start}"
     "&primary_release_date.lte={fresh_end}&sort_by=primary_release_date.desc"),
    ("pk_dramas", "tv",
     # Air-date filter (first_air_date.gte, {cutoff} = 90 days ago):
     # popularity-sorted PK discover is dominated by ENDED all-time hits
     # (Meri Zindagi Hai Tu, Tamasha) that the currency check then drops.
     # Restricting to recent premieres surfaces currently-airing dramas
     # (Dar-E-Nijaat, Rutba, Mitti De Baway, ...).
     "/discover/tv?with_origin_country=PK&first_air_date.gte={cutoff}"
     "&sort_by=popularity.desc"),
    ("new_tv", "tv",
     # Newly-premiering international series (first_air_date in the
     # 90-day window, popularity desc): trending_tv only surfaces what
     # is already trending; this catches new series before they trend.
     "/discover/tv?first_air_date.gte={cutoff}"
     "&first_air_date.lte={horizon}&sort_by=popularity.desc"),
    ("hindi_recent_tv", "tv",
     # Dedicated Hindi recent-TV discovery: the general new_tv feed below
     # is global and popularity-ranked, so lower-ranked Hindi premieres
     # can sit beyond its first two pages. Only already-premiered series
     # enter this recent feed; future shows remain in new_tv/upcoming paths.
     "/discover/tv?with_original_language=hi"
     "&first_air_date.gte={cutoff}"
     "&first_air_date.lte={today}"
     "&sort_by=first_air_date.desc"),
    ("pk_movies", "movie",
     # Pakistani films (Lollywood). PRIMARY release date, not plain
     # release_date: the plain filter matches ANY regional re-release
     # date and pulls in old films (The Legend of Maula Jatt, 2022,
     # appeared in a release_date.gte spike query — 2026-10-26).
     # {cutoff} = 90 days ago; {horizon} = 90 days ahead (keeps
     # 2027-2030 fan films out — movie_fresh passes any future date).
     "/discover/movie?with_origin_country=PK"
     "&primary_release_date.gte={cutoff}"
     "&primary_release_date.lte={horizon}&sort_by=popularity.desc"),
]

# Pages read per source (see SOURCES comment above).
SOURCE_PAGES = {
    "now_playing": 2,
    "upcoming": 2,
    "bollywood": 2,
    "india_window": 2,
    "world_window": 2,
    "new_tv": 2,
    "trending_tv": 1,
    "hindi_recent_movies": 5,
    "hindi_recent_tv": 5,
}

# --- Drama tracker <-> published catalogue sync (owner order 2026-10-26) ---
# The episode tracker (scripts/episode-guides.py) posts episodes for any
# drama on the 4 official PK channels, but it takes the drama name from the
# YouTube video title — which is often a SHORT name ("Dar", "Zehar") while
# TMDB / FA_PUBLISHED uses the full name ("Dar-E-Nijaat", "Zehar-e-Mohabbat").
# That is why the Pakistani Dramas list and the Drama Episodes list showed
# different dramas (only Bano overlapped, 2026-10-26). The rule that keeps
# them in sync: on every seeder run, reconcile_tracker_dramas() reads the
# tracker's episode dramas from FA_ARTICLES and publishes any that are
# missing, so published ⊇ episode dramas. It NEVER guesses: a drama is added
# only when (a) it is in DRAMA_ALIASES (a verified mapping), or (b) a TMDB
# search returns exactly ONE Pakistani/Urdu result with a poster whose name
# matches the tracker name exactly. Anything ambiguous is logged + skipped.
# Titles in NON_DRAMA_TITLES are never published as dramas (a chat show
# and a sitcom the tracker picks up as "episodes").
DRAMA_ALIASES = {
    "Dar": 328722,          # tracker short name -> Dar-E-Nijaat (published)
    "Zehar": 332593,        # tracker short name -> Zehar-e-Mohabbat
    # Aangan: TMDB has TWO entries for it (90172 and 337270, both PK/Urdu,
    # first_air 2018-12-20), so the reconcile search is ambiguous and skips
    # it. 90172 is the canonical one — its overview matches the tracker's
    # episode text verbatim ("Set before 1940s, a Hindustani family..."),
    # it has 36 episodes on Hum TV; 337270 is a stub (1 ep, no network).
    "Aangan": 90172,
}
NON_DRAMA_TITLES = {
    "Exclusive Chat with Zahid Ahmed",  # interview/chat show, not a drama
    "Bulbulay Season 2",                # sitcom, not a drama serial
    "Bulbulay",                          # same show, short name
}


def reconcile_tracker_dramas(key, published, pt, out_dir):
    """Publish any Pakistani drama the episode tracker found but the
    catalogue does not have yet. Returns the list of added entries.
    Defensive by design: any failure is logged and the seeder continues;
    nothing is ever removed or modified, only added. A drama is added
    only on a verified alias or an unambiguous single TMDB match."""
    added = []
    try:
        arts_path = os.path.join(out_dir, "articles-data.js")
        articles = pt.read_js_map(arts_path, "FA_ARTICLES")
    except Exception as e:
        print(f"  reconcile dramas: cannot read articles-data.js ({e})")
        return added
    # Drama names from episode headlines ("<Drama> Episode N — Watch on ...").
    names = set()
    for a in (articles or {}).values():
        h = (a or {}).get("headline") or ""
        if "Watch on" not in h:
            continue
        m = re.match(r"^(.*?)\s+Episode\s+\d+", h)
        name = (m.group(1).strip() if m else h.split(" — ")[0].strip())
        if name:
            names.add(name)
    for name in sorted(names):
        if name in NON_DRAMA_TITLES:
            print(f"  reconcile dramas: SKIP {name!r} (not a drama)")
            continue
        # Already published under this name (or its alias target)?
        tid = DRAMA_ALIASES.get(name)
        if tid is not None and str(tid) in published:
            continue
        if tid is None:
            # Exact-name match against published titles.
            if any((v or {}).get("title") == name for v in published.values()):
                continue
            # Resolve via TMDB search: exactly ONE PK/Urdu poster result
            # whose name matches exactly, else skip (never guess).
            try:
                data = tmdb_get(
                    "/search/tv?query=" + urllib.parse.quote(name), key)
            except Exception as e:
                print(f"  reconcile dramas: search failed for {name!r} ({e})")
                continue
            cands = []
            for r in (data or {}).get("results") or []:
                if not r.get("poster_path"):
                    continue
                if (r.get("original_language") != "ur"
                        and "PK" not in (r.get("origin_country") or [])):
                    continue
                if str(r.get("name") or "").strip().lower() != name.lower():
                    continue
                cands.append(r)
            if len(cands) != 1:
                print(f"  reconcile dramas: SKIP {name!r} "
                      f"({len(cands)} unambiguous TMDB matches)")
                continue
            tid = cands[0]["id"]
            if str(tid) in published:
                continue
        try:
            details = fetch_typed(tid, "tv", key, pt)
        except Exception as e:
            print(f"  reconcile dramas: fetch failed for {name!r} ({tid}, {e})")
            continue
        if not details:
            print(f"  reconcile dramas: no TMDB title {tid} for {name!r}")
            continue
        entry = pt.build_entry(details, "tv", ["tv"],
                               time.strftime("%Y-%m-%d", time.gmtime()))
        if not entry.get("poster_path") or not entry.get("title"):
            print(f"  reconcile dramas: SKIP {name!r} (no poster/title)")
            continue
        if entry.get("industry") != "pakistani":
            print(f"  reconcile dramas: SKIP {name!r} "
                  f"(industry {entry.get('industry')!r})")
            continue
        try:
            entry["providers"] = fetch_providers(tid, "tv", key)
        except Exception:
            entry["providers"] = []
        published[str(tid)] = entry
        added.append(entry)
        print(f"  reconcile dramas: added {tid} ({entry['title']}, "
              f"tracker name {name!r})")
        time.sleep(0.3)
    return added


TMDB_BASE = "https://api.themoviedb.org/3"


def load_publish_titles():
    """Import scripts/publish-titles.py by path (hyphenated filename)."""
    spec = importlib.util.spec_from_file_location(
        "publish_titles", PUBLISH_TITLES)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read_key(args):
    """TMDB key: --key, then TMDB_API_KEY, then js/config.js TMDB_KEY.
    Returns "" when none is found (caller reports it, never the value)."""
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


def tmdb_get(path, key):
    """GET one TMDB endpoint. Returns parsed JSON, or None on failure."""
    url = (TMDB_BASE + path +
           ("&" if "?" in path else "?") +
           "api_key=" + urllib.parse.quote(key))
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "FlickAtlas-title-seed/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        print(f"  TMDB {e.code} on {path}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"  TMDB error on {path}: {e}", file=sys.stderr)
        return None


TRENDING_HEADER = (
    "/* FlickAtlas — trending movies (TMDB /trending/movie/week). "
    "GENERATED by the nightly title seeder (scripts/title-seed.py) — "
    "do not edit by hand. Ordered by TMDB trending rank. */")


def _source_recorder():
    try:
        import pipeline_schedule
        return pipeline_schedule
    except Exception:
        return None


def refresh_trending(key, out_dir, dry_run=False):
    """Refresh the authentic global top-20 movie trending snapshot."""
    if dry_run:
        # Dry runs may inspect the source but must never touch source state.
        try:
            tmdb_get("/trending/movie/week", key)
        except Exception as e:
            print(f"title-seed: trending refresh failed ({e})")
        return False
    recorder = _source_recorder()
    try:
        data = tmdb_get("/trending/movie/week", key)
        results = (data or {}).get("results")
        if not isinstance(results, list) or not results:
            raise ValueError("invalid or empty results")
        top = results[:20]
        if any(not isinstance(it, dict) or not it.get("id") for it in top):
            raise ValueError("invalid top-20 result")
        # TMDB ordering is authoritative: take first 20, then poster filter.
        ids = [int(it["id"]) for it in top if it.get("poster_path")]
        if not ids:
            raise ValueError("top 20 contains no poster-bearing titles")
    except Exception as e:
        print(f"title-seed: trending refresh failed ({e})")
        if recorder:
            try: recorder.record_source("trending_worldwide", False, str(e))
            except Exception: pass
        return False
    path = os.path.join(out_dir, "trending-data.js")
    content = (TRENDING_HEADER + "\nwindow.FA_TRENDING = " +
               json.dumps(ids) + ";\n")
    try:
        existing = open(path, encoding="utf-8").read() if os.path.exists(path) else ""
        if existing != content:
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            print(f"title-seed: trending-data.js written ({len(ids)} IDs)")
        else:
            print(f"title-seed: trending-data.js unchanged ({len(ids)} IDs)")
        if recorder:
            recorder.record_source("trending_worldwide", True,
                                   f"valid top {len(ids)} snapshot")
        return True
    except Exception as e:
        if recorder:
            try: recorder.record_source("trending_worldwide", False, str(e))
            except Exception: pass
        return False


def fetch_typed(tid, media_type, key, pt):
    """Fetch details for a KNOWN media type (no movie-first guessing).

    publish-titles.fetch_title tries movie first, then tv — but TMDB
    movie and tv ids share a namespace, so a tv id can collide with a
    different movie (e.g. tv 303911 = Meri Zindagi Hai Tu, movie 303911
    = Miss 420). The seeder knows the media type from the source list,
    so it fetches the right endpoint directly."""
    if media_type == "movie":
        path = f"/movie/{tid}?append_to_response=videos,release_dates"
    else:
        path = f"/tv/{tid}?append_to_response=videos,content_ratings"
    return pt.tmdb_get(path, key)


def fetch_providers(tid, media_type, key):
    """TMDB watch/providers for one title -> providers list (best-effort).

    GET /{movie|tv}/{id}/watch/providers. IN flatrate (streaming)
    first, US flatrate as fallback, PK flatrate third (2026-10-28:
    Pakistani dramas have no IN/US listing, so without PK they can
    never gain providers and OTT TV Series stays empty). Each provider is
    {name, logo_path, region, type}. Only the flatrate list is kept
    (rent/buy are not streaming, and the OTT page is streaming-only).
    Returns [] when TMDB has no streaming provider for the title, or
    on any failure — never raises, so a providers failure can never
    drop a title from the seeder run."""
    try:
        data = tmdb_get(f"/{media_type}/{tid}/watch/providers", key)
    except Exception as e:
        print(f"  providers {tid}: request failed ({e})",
              file=sys.stderr)
        return []
    if not data:
        return []
    results = data.get("results") or {}
    for region in ("IN", "US", "PK"):
        entry = results.get(region) or {}
        flatrate = entry.get("flatrate") or []
        if not flatrate:
            continue
        out = []
        for p in flatrate:
            name = (p.get("provider_name") or "").strip()
            if not name:
                continue
            out.append({
                "name": name,
                "logo_path": p.get("logo_path") or "",
                "region": region,
                "type": "flatrate",
            })
        if out:
            return out
    return []


def parse_date(value):
    """YYYY-MM-DD -> date, or None when missing/unparseable."""
    if not value:
        return None
    try:
        y, m, d = (int(p) for p in str(value).strip().split("-"))
        return date(y, m, d)
    except (ValueError, TypeError):
        return None


def movie_fresh(item, today):
    """Movies: a past release older than FRESH_DAYS is stale; a future
    (upcoming) date always passes."""
    d = parse_date(item.get("release_date"))
    if d is None:
        return True
    if d > today:
        return True
    return (today - d).days <= FRESH_DAYS


def tv_is_current(details):
    """TV currency (matches the pk-dramas.js CURRENT definition): an
    episode aired inside the window, a next episode is scheduled, or
    it premiered inside the window."""
    today = date.today()
    if details.get("status") == "Returning Series":
        return True
    if details.get("next_episode_to_air"):
        return True
    last = parse_date(details.get("last_air_date"))
    if last and (today - last).days <= FRESH_DAYS:
        return True
    first = parse_date(details.get("first_air_date"))
    if first and (today - first).days <= FRESH_DAYS:
        return True
    return False


def fetch_lists(key):
    """Fetch every source list (pages 1..SOURCE_PAGES, default 1).
    Returns {source: [items]}. {cutoff} in a path is the freshness
    cutoff (FRESH_DAYS ago); {fresh_start}/{fresh_end} bound the
    fresh window (7 days either side of today)."""
    cutoff = (date.today() - timedelta(days=FRESH_DAYS)).isoformat()
    horizon = (date.today() + timedelta(days=FRESH_DAYS)).isoformat()
    today = date.today().isoformat()
    fresh_start = (date.today() - timedelta(days=FRESH_WINDOW_DAYS)).isoformat()
    fresh_end = (date.today() + timedelta(days=FRESH_WINDOW_DAYS)).isoformat()
    out = {}
    for name, media, path in SOURCES:
        pages = SOURCE_PAGES.get(name, 1)
        items = []
        total = None
        for page in range(1, pages + 1):
            paged = path.format(cutoff=cutoff, horizon=horizon,
                                fresh_start=fresh_start,
                                fresh_end=fresh_end, today=today)
            sep = "&" if "?" in paged else "?"
            data = tmdb_get(f"{paged}{sep}page={page}", key)
            items.extend((data or {}).get("results") or [])
            if total is None:
                total = (data or {}).get("total_results")
            time.sleep(0.3)  # TMDB rate limit is 40 req / 10 s
        out[name] = items
        print(f"  {name}: {len(items)} candidates (pages {pages}, "
              f"total {total})")
    return out


def _item_date(item, media):
    """Sort key date: release_date for movies, first_air_date for tv."""
    return (item.get("release_date") or item.get("first_air_date") or "")


def _is_fresh(date_str, today):
    """True if date_str is within FRESH_WINDOW_DAYS of today (either
    side): released in the last 7 days, or releasing in the next 7."""
    if not date_str:
        return False
    try:
        d = date.fromisoformat(date_str)
    except ValueError:
        return False
    return abs((d - today).days) <= FRESH_WINDOW_DAYS


def _round_robin(ordered, per_source, cap, picked, seen):
    """One round-robin pass over `ordered` sources, taking from
    per_source[name] lists in order, until cap or exhaustion.
    Appends (tid, media, source) to picked. Returns the new count.
    Items already in `seen` are skipped, not counted as a round: an
    earlier phase's picks must not consume this pass's rounds
    (2026-10-28: the trending drip's 5 picks blocked Phase 2 from
    reaching the older trending titles behind them, so the drip
    could never drain)."""
    idx = {name: 0 for name, _, _ in ordered}
    while len(picked) < cap:
        progressed = False
        for name, media, _ in ordered:
            if len(picked) >= cap:
                break
            items = per_source.get(name) or []
            while idx[name] < len(items) and items[idx[name]] in seen:
                idx[name] += 1
            if idx[name] >= len(items):
                continue
            tid = items[idx[name]]
            idx[name] += 1
            seen.add(tid)
            picked.append((tid, media, name))
            progressed = True
        if not progressed:
            break
    return picked


def _reserve_source_slots(source_names, candidates, quotas, max_total,
                          picked, seen, media_of):
    """Take a small fair reserve from named sources, skipping duplicates.

    `candidates` maps each source to an ordered list of TMDB IDs. The
    per-source quotas and total limit are both hard bounds; unused slots
    remain available to the ordinary all-source selector.
    """
    counts = {name: 0 for name in source_names}
    positions = {name: 0 for name in source_names}
    taken = 0
    while taken < max_total:
        progressed = False
        for name in source_names:
            if taken >= max_total:
                break
            if counts[name] >= quotas.get(name, 0):
                continue
            items = candidates.get(name) or []
            while positions[name] < len(items) and items[positions[name]] in seen:
                positions[name] += 1
            if positions[name] >= len(items):
                continue
            tid = items[positions[name]]
            positions[name] += 1
            seen.add(tid)
            picked.append((tid, media_of[name], name))
            counts[name] += 1
            taken += 1
            progressed = True
        if not progressed:
            break
    return counts


def select(lists, published, cap):
    """List-level selection: apply the cheap rules, sort each source
    newest-first, then pick in two phases. Returns [(tid, media,
    source)] in attempt order.

    Pace (owner order 2026-10-26): no fixed overall daily quota.
    Fresh titles are selected first, with up to two guaranteed slots for
    each date-ranked Hindi Recent source; ordinary round-robin across all
    sources fills the remaining fresh capacity. The trending drip remains
    ahead of backfill. Of the four daily backfill slots, at most two are
    reserved fairly for Hindi Recent movies/TV and at least two remain for
    the existing global newest-first pool. SAFETY_CEILING is still the hard
    cap. Upcoming titles sort nearest-first; released titles sort newest
    first. The source order still rotates daily for the unreserved pool."""
    today = date.today()
    per_source = {}
    for name, media, _ in SOURCES:
        seen_here = {}
        for item in lists.get(name) or []:
            tid = str(item.get("id") or "")
            if not tid.isdigit():
                continue
            if tid in published:
                continue
            if tid in seen_here:
                continue
            if not item.get("poster_path"):
                continue
            # Trending source is exempt from the 90-day freshness gate:
            # a title on TMDB /trending/movie/week is trending NOW, so
            # its release age is irrelevant (2026-10-28: Obsession
            # 2026-05-13 and Moana 2026-07-08 were trending but
            # unseedable because of this gate).
            if name != "trending" and media == "movie" and not movie_fresh(item, today):
                continue
            # tv: no list-level date rule (currency checked on details)
            seen_here[tid] = _item_date(item, media)
        # Sort by date: upcoming ascending (nearest first), everything
        # else descending (newest first); no-date items last in both.
        if name == "upcoming":
            items = sorted(seen_here.items(),
                           key=lambda kv: (kv[1] == "", kv[1]))
        else:
            items = sorted(seen_here.items(),
                           key=lambda kv: (kv[1] != "", kv[1]),
                           reverse=True)
        per_source[name] = [(tid, d) for tid, d in items]
    # Rotate the source order daily so every source gets picked over
    # the cycle instead of the same first sources every day.
    offset = today.toordinal() % len(SOURCES)
    ordered = SOURCES[offset:] + SOURCES[:offset]
    # Split each source into fresh (within 7 days) and backfill.
    fresh = {n: [t for t, d in v if _is_fresh(d, today)]
             for n, v in per_source.items()}
    backfill = {n: [t for t, d in v if not _is_fresh(d, today)]
                for n, v in per_source.items()}
    picked, seen = [], set()
    media_of = {n: m for n, m, _ in SOURCES}
    # These dedicated date-ranked Hindi sources would otherwise depend on
    # the rotating global source order when fresh lists exceed the cap.
    fresh_reserve = min(HINDI_FRESH_RESERVE_MAX, cap // 4)
    _reserve_source_slots(
        HINDI_RECENT_SOURCES, fresh,
        {n: HINDI_RECENT_PER_SOURCE for n in HINDI_RECENT_SOURCES},
        fresh_reserve, picked, seen, media_of)
    # Phase 1: all remaining fresh titles, in the existing rotating mix.
    _round_robin(ordered, fresh, cap, picked, seen)
    hindi_counts = {n: 0 for n in HINDI_RECENT_SOURCES}
    for _tid, _media, source in picked:
        if source in hindi_counts:
            hindi_counts[source] += 1
    # Phase 1b — TRENDING DRIP (2026-10-28): non-fresh trending titles
    # enter a few per run, ahead of the general backfill, so the
    # Trending Worldwide rail keeps gaining the titles TMDB says are
    # trending instead of starving behind the 4/day backfill queue
    # (2026-10-28: 9 of the 20 trending IDs were stuck in backfill).
    # Titles that leave TMDB trending drop out of the rail at render
    # time, because the rail renders only the current FA_TRENDING list.
    for tid in (backfill.get("trending") or [])[:TRENDING_DRIP_PER_RUN]:
        if len(picked) >= cap:
            break
        if tid in seen:
            continue
        seen.add(tid)
        picked.append((tid, "movie", "trending"))
    # Phase 1b (TV): the same drip for the new trending_tv source —
    # without it, trending series starve behind the 4/day backfill
    # queue exactly like trending movies did (2026-10-28: 20/20
    # trending_tv titles missing from the catalogue).
    for tid in (backfill.get("trending_tv") or [])[:TRENDING_DRIP_PER_RUN]:
        if len(picked) >= cap:
            break
        if tid in seen:
            continue
        seen.add(tid)
        picked.append((tid, "tv", "trending_tv"))
    # Phase 2: backfill, at most BACKFILL_PER_DAY (and under ceiling).
    # Up to two slots go fairly to recent Hindi sources; at least two
    # remain in the global newest-first pool, so this does not replace
    # the existing all-language sources or daily backfill limit.
    # GLOBAL newest-first (2026-10-28 fix): the old per-source
    # round-robin let a 2023 title from an early source jump ahead of
    # an Oct title from a later source while the 4/day cap stayed fixed
    # — the queue drained in source order, not date order (2026-10-28:
    # Sumo Didi 2023 was picked while Verity 2026-10-02 waited). The
    # cap is unchanged (owner order: 4/day); only the ORDER is now
    # truly newest-first: released by date desc, then upcoming by date
    # asc, no-date last. Dates are read from per_source (the
    # fresh/backfill split above drops them).
    backfill_start = len(picked)
    backfill_cap = min(cap, backfill_start + BACKFILL_PER_DAY)
    remaining_quota = {
        n: max(0, HINDI_RECENT_PER_SOURCE - hindi_counts[n])
        for n in HINDI_RECENT_SOURCES
    }
    backfill_slots = backfill_cap - backfill_start
    global_backfill_floor = min(2, backfill_slots)
    backfill_reserve = min(HINDI_BACKFILL_RESERVE_MAX,
                           max(0, backfill_slots - global_backfill_floor))
    _reserve_source_slots(
        HINDI_RECENT_SOURCES, backfill, remaining_quota,
        backfill_reserve, picked, seen, media_of)
    released, upcoming, nodate = [], [], []
    for n, v in per_source.items():
        if n in ("trending", "trending_tv"):
            continue  # handled by Phase 1b above
        for tid, d in v:
            if tid in seen or _is_fresh(d, today):
                continue
            (nodate if not d else
             upcoming if d > today.isoformat() else
             released).append((tid, d, media_of[n], n))
    released.sort(key=lambda t: t[1], reverse=True)
    upcoming.sort(key=lambda t: t[1])
    for tid, _d, media, source in released + upcoming + nodate:
        if len(picked) >= backfill_cap:
            break
        if tid in seen:
            continue
        seen.add(tid)
        picked.append((tid, media, source))
    return picked


def load_backlog_ids(path=BACKLOG_LIST):
    """Read the one-time OTT backlog list -> ordered TMDB id strings.

    File shape: {"titles": [{"id": 123, ...}, ...]} (extra fields are
    the audit record; only `id` is consumed). A missing or corrupt
    file is an empty backlog — this lane must never break the run."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return []
    except Exception as e:
        print(f"title-seed: backlog list unreadable ({e}); "
              "treating as empty", file=sys.stderr)
        return []
    out = []
    for entry in (data or {}).get("titles") or []:
        tid = str((entry or {}).get("id") or "")
        if tid.isdigit():
            out.append(tid)
    return out


def main():
    ap = argparse.ArgumentParser(
        description="Seed TMDB titles into js/published-titles.js")
    ap.add_argument("--key", default=None,
                    help="TMDB API key (or TMDB_API_KEY env var, "
                         "or js/config.js TMDB_KEY)")
    ap.add_argument("--out", default=DEFAULT_OUT,
                    help="output file (default: js/published-titles.js)")
    ap.add_argument("--dry-run", action="store_true",
                    help="fetch + assemble but do NOT write the file")
    args = ap.parse_args()

    key = read_key(args)
    if not key:
        print("title-seed: no TMDB key — set TMDB_API_KEY, --key, or "
              "js/config.js TMDB_KEY", file=sys.stderr)
        return 2

    pt = load_publish_titles()
    published = pt.read_js_map(args.out, "FA_PUBLISHED")
    cap = FIRST_RUN_MAX if len(published) <= 2 else SAFETY_CEILING
    print(f"title-seed: {len(published)} titles published; "
          f"ceiling {cap} (first run: {len(published) <= 2})"
          f"{' [DRY RUN]' if args.dry_run else ''}")

    # Drama sync (owner order 2026-10-26): publish any Pakistani drama
    # the episode tracker found but the catalogue lacks, so the Pakistani
    # Dramas list and the Drama Episodes list stay in sync. Defensive:
    # a failure here never breaks the seeder run.
    reconciled = []
    try:
        rec = reconcile_tracker_dramas(key, published, pt,
                                       os.path.dirname(args.out))
        reconciled = rec or []
        if rec:
            print(f"title-seed: drama reconcile +{len(rec)}")
    except Exception as e:
        print(f"title-seed: drama reconcile failed ({e})", file=sys.stderr)

    lists = fetch_lists(key)
    picked = select(lists, published, cap)
    print(f"title-seed: {len(picked)} candidates selected")

    # One-time OTT backlog FIRST (owner order 2026-10-30): curated ids
    # from scripts/ott-backfill-list.json, ahead of the normal picks
    # and outside the ceiling (see BACKLOG_PER_RUN). The publish loop
    # below applies the same details/poster/title checks and provider
    # enrichment as any other pick; ids already published are skipped
    # here and again in the loop, so a drained list is inert.
    backlog_ids = [t for t in load_backlog_ids()
                   if t not in published]
    if backlog_ids:
        already = {str(t) for t, _m, _s in picked}
        front = [(t, "movie", "ott_backfill")
                 for t in backlog_ids[:BACKLOG_PER_RUN]
                 if t not in already]
        picked = front + picked
        print(f"title-seed: ott backlog {len(backlog_ids)} remaining, "
              f"{len(front)} prepended this run")

    today = time.strftime("%Y-%m-%d", time.gmtime())
    added, skipped = [], 0
    for tid, media, source in picked:
        # This seeder adds titles only; never rebuild an existing published
        # record and drop owner-verified OTT/theatrical date annotations.
        if str(tid) in published:
            continue
        try:
            details = fetch_typed(tid, media, key, pt)
        except Exception as e:
            print(f"  SKIP {tid} ({source}): TMDB request failed ({e})")
            skipped += 1
            continue
        if details is None:
            print(f"  SKIP {tid} ({source}): no such title on TMDB")
            skipped += 1
            continue
        found_media = media
        if found_media == "tv" and not tv_is_current(details):
            print(f"  SKIP {tid} ({source}): tv not currently airing")
            skipped += 1
            continue
        categories = (["movies"] if found_media == "movie" else ["tv"])
        entry = pt.build_entry(details, found_media, categories, today)
        if not entry.get("poster_path") or not entry.get("title"):
            print(f"  SKIP {tid} ({source}): assembled entry has no "
                  "poster/title")
            skipped += 1
            continue
        # Providers enrichment (best-effort): TMDB watch/providers,
        # IN first, US fallback. A failure never drops the title —
        # it is written with providers [].
        try:
            entry["providers"] = fetch_providers(tid, found_media, key)
        except Exception as e:
            print(f"  providers {tid}: enrichment failed ({e})")
            entry["providers"] = []
        prov = ", ".join(p.get("name")
                         for p in entry["providers"]) or "none"
        time.sleep(0.3)  # TMDB rate limit is 40 req / 10 s
        if args.dry_run:
            print(f"  would add {tid} ({entry['title']}, "
                  f"{found_media}, {entry['industry']}, from {source}, "
                  f"trailer {'Y' if entry['trailer'] else 'none'}, "
                  f"providers {prov})")
            added.append(entry)
            continue
        published[tid] = entry
        print(f"  added {tid} ({entry['title']}, {found_media}, "
              f"{entry['industry']}, from {source}, "
              f"trailer {'Y' if entry['trailer'] else 'none'}, "
              f"providers {prov})")
        added.append(entry)
        time.sleep(0.3)

    if not args.dry_run:
        changed = pt.write_js_map(args.out, "FA_PUBLISHED", published,
                                  pt.HEADER)
        print(f"title-seed: +{len(added)} new, {skipped} skipped | "
              f"file changed: {changed}")
    else:
        print(f"title-seed (dry run): would add {len(added)}, "
              f"{skipped} skipped | file NOT written")

    # Trending Worldwide (user order 2026-10-26): refresh the
    # authentic TMDB trending list on every seeder run so the homepage
    # section stays fresh daily.
    refresh_trending(key, os.path.dirname(args.out), args.dry_run)

    # OTT section (owner order 2026-10-27): rebuild js/ott-data.js from
    # the just-written catalogue so new titles with providers join the
    # OTT section automatically. Best-effort: a failure here never
    # breaks the seeder run. Skipped on dry runs (nothing was written).
    if not args.dry_run:
        try:
            import build_ott  # same scripts/ dir
            build_ott.build(
                os.path.join(os.path.dirname(args.out), "ott-data.js"),
                args.out)
        except Exception as e:
            print(f"title-seed: ott-data rebuild failed ({e})",
                  file=sys.stderr)

    # Per-run record for the stats dashboard (out/step-runs.json).
    # Dry runs record nothing (nothing was written).
    if step_runs is not None and not args.dry_run:
        cand = sum(len(v) for v in lists.values())
        added_names = ([f"{e.get('title')} ({e.get('id')})"
                        for e in added]
                       + [f"{e.get('title')} ({e.get('id')})"
                          for e in reconciled])
        reason = None
        if not added_names:
            reason = "source-fail" if cand == 0 else "no-new-data"
        step_runs.record(
            "title_seed",
            checked={"candidates": cand,
                     "sources": {n: len(v) for n, v in lists.items()},
                     "picked": len(picked), "skipped": skipped,
                     "cap": cap,
                     "detail": "Hindi recent movies/TV date-ranked p1-5 + "
                               "existing regional/trending sources retained"},
            changed={"added": added_names, "updated": [],
                     "count": len(added_names)},
            reason=reason)
    return 0


if __name__ == "__main__":
    sys.exit(main())



