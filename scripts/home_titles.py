#!/usr/bin/env python3
"""Build js/home-titles-data.js — the homepage's slim titles file.

The homepage (index.html) used to load js/published-titles.js
(window.FA_PUBLISHED — every published title WITH its full detail
payload: trailer, genres, budget, revenue, tagline, certification,
seasons, networks...; ~833 KB raw) as a plain blocking <script>
before js/page-index.js, so on a slow connection every homepage rail
waited on that one file and the categories appeared missing — the
same failure the 2026-11-04 home-articles slimming (commit 154eef16)
fixed for articles.

The homepage never reads the detail payload. Its proven needs —
established by reading every consumer of a title record on the
homepage (js/page-index.js, the record-taking helpers of js/ui.js,
and js/home-boxoffice.js, which receives the catalogue in
selectionForDisplay) — are, per title:

  id, type, media_type, title, poster_path, backdrop_path,
  vote_average, vote_count, overview, industry, original_language,
  origin_country, production_countries, spoken_languages,
  published_at, date_kind, status, providers, release_date,
  first_air_date, popularity, pakistan_theatrical_release_date,
  pakistan_release_source, ott_release_date, ott_release_provider,
  ott_release_source

Why each group is load-bearing:
  - Cards/hero (UI.posterCard / UI.ottCard / hero slides):
    id, type, media_type, title, poster_path, backdrop_path
    (hero background), vote_average (rating badge + hero meta),
    release_date / first_air_date (card date line), overview
    (hero synopsis, sliced to 200 chars at render).
  - Sorting/filtering pools in page-index.js: release_date,
    first_air_date, published_at (newest/oldest tie-breaks),
    date_kind (festival-only titles stay out of Spotlight and
    Box Office), popularity + vote_count + vote_average
    (Coming Soon order, Trending heat, OTT rail order, Advance
    Booking rank, box-office popularSort), poster_path (pool gates).
  - Industry (UI.industryOf — the canonical Bollywood / Pakistani /
    World rule behind EVERY homepage filter): origin_country,
    production_countries, industry, original_language,
    spoken_languages. Dropping any of these reclassifies titles.
  - Freshness + streaming-only (UI.isFresh / UI.isStreamingOnly):
    release_date, first_air_date, type, id, providers.
  - OTT rails: providers (the from-published fallback groups AND
    the platform-name matching), ott_release_date,
    ott_release_provider, ott_release_source (confirmed TV OTT
    dates), status (Pakistani-drama "Returning Series" airing gate
    — also read directly by page-index for the dramas rail).
  - Pakistani titles: pakistan_theatrical_release_date +
    pakistan_release_source drive dateOf() and the Lollywood rail.

Dropped (detail-page-only data; no homepage consumer reads them):
  trailer, categories, source, budget, revenue, genres, tagline,
  certification, runtime, networks, number_of_seasons,
  number_of_episodes, channel, episode_run_time, seasons,
  created_by.

Unlike home-articles there is NO count subsetting: the homepage
filters and sorts the full catalogue itself (industry pools, the
box-office 14/90-day windows, the OTT joins), so every published
title is emitted — only its fields are slimmed. The slim file sets
the SAME window.FA_PUBLISHED global, so js/page-index.js runs
unchanged; index.html simply loads this file instead of
js/published-titles.js. Every other page keeps loading the full
file, and the full file stays the single source of truth.

Writers of js/published-titles.js call write_home_titles() right
after their own write (scripts/publish-titles.py,
scripts/refresh-metadata.py, scripts/title-seed.py); the hourly
workflow also runs this file as a step before the commit, so the
slim file can never go stale against the full file. Running it by
hand rebuilds the slim file from the current js/published-titles.js:

    python3 scripts/home_titles.py

Stdlib only; writes the file only when its content changed.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLISHED_JS = os.path.join(ROOT, "js", "published-titles.js")
HOME_JS = os.path.join(ROOT, "js", "home-titles-data.js")

# The homepage-proven field set (see module docstring). Order here is
# the key order written per record; fields absent from a source
# record stay absent (never invented). `media_type` is carried
# defensively: no current record has it, but typeOf() /
# UI.posterCard / the box-office candidate pool all read it as a
# fallback for `type`.
HOME_FIELDS = ("id", "type", "media_type", "title", "poster_path",
               "backdrop_path", "vote_average", "vote_count",
               "overview", "industry", "original_language",
               "origin_country", "production_countries",
               "spoken_languages", "published_at", "date_kind",
               "status", "providers", "release_date", "first_air_date",
               "popularity", "pakistan_theatrical_release_date",
               "pakistan_release_source", "ott_release_date",
               "ott_release_provider", "ott_release_source")

HEADER = ("/* FlickAtlas — homepage titles: ALL published titles, "
          "slim fields only (no trailer/genres/budget/seasons "
          "detail payload). GENERATED by scripts/home_titles.py "
          "from js/published-titles.js — do not edit by hand. "
          "Loaded ONLY by index.html in place of the full file; "
          "every other page keeps js/published-titles.js. */")


def build_home_titles(published):
    """{tmdb_id: full record} -> {tmdb_id: slim record}: every
    record projected onto HOME_FIELDS, catalogue order preserved."""
    out = {}
    for tid, rec in (published or {}).items():
        if not isinstance(rec, dict):
            continue
        out[str(tid)] = {k: rec[k] for k in HOME_FIELDS if k in rec}
    return out


def read_js_map(path, var):
    """Parse `window.VAR = {...};` into a dict. Returns {} if missing."""
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    start = raw.index("{")
    end = raw.rindex("}")
    return json.loads(raw[start:end + 1])


def write_home_titles(root=ROOT, published=None):
    """(Re)write <root>/js/home-titles-data.js. Returns True when
    the file changed. `published` may pass the caller's in-memory
    FA_PUBLISHED map; otherwise the map is read from disk."""
    if published is None:
        published = read_js_map(
            os.path.join(root, "js", "published-titles.js"),
            "FA_PUBLISHED")
    slim = build_home_titles(published)
    content = (HEADER + "\nwindow.FA_PUBLISHED = " +
               json.dumps(slim, ensure_ascii=False, indent=2) + ";\n")
    path = os.path.join(root, "js", "home-titles-data.js")
    existing = ""
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            existing = f.read()
    if existing == content:
        return False
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return True


def main():
    published = read_js_map(PUBLISHED_JS, "FA_PUBLISHED")
    changed = write_home_titles(ROOT, published)
    slim = build_home_titles(published)
    print(f"home-titles: {len(slim)} of {len(published)} titles "
          f"-> js/home-titles-data.js (changed: {changed})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
