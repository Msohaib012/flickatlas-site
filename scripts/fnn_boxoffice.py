#!/usr/bin/env python3
"""
FilmyNewsNetwork box-office reader for FlickAtlas.

Source: https://filmynewsnetwork.com
Data model (verified 2026-10-26 by spike test):
  * The per-movie HTML page (/box-office/movie/<slug>) is a Next.js App Router
    page. Its STATIC HTML contains ONLY today's figure (in the <meta>
    description and a schema.org Dataset JSON-LD block) — there is NO full
    day-wise table in the static HTML. The body is rendered client-side.
  * The page's own JS fetches the site's internal JSON API:
        GET /api/all-box-office?date=YYYYMMDD
    which returns, for that one date, every movie's gross (in INR rupees)
    split by format+language, e.g. "Jailer 2 [2D | Tamil]".
    The `&full=1` variant adds per-period and per-city detail (not needed).
  * The API keeps history: past dates return that date's final figure
    (last_updated ~23:4x IST). So day-wise history is built by calling the
    API once per date and summing the movie's entries for that date.
  * A movie appears as MULTIPLE entries (one per format+language). The
    India Net day figure = SUM of all entries whose base title matches the
    movie (base title = text before " ["). The Hindi version of Jailer 2 is
    listed under a different base title ("Rajini: The Jailer 2") and MUST be
    included, otherwise the total is ~Rs1.4 Cr short (FNN's own page headline
    excludes Hindi: Rs8.23 Cr on Day 12 vs Rs9.61 Cr all-languages).
  * The API covers MORE movies than the per-movie pages: Udta Teer and
    Tu Hai Meri Kiran have NO /box-office/movie/ page but ARE in the API.
  * `gross` is labelled "gross" by FNN but tracks Sacnilk's India Net
    closely language-wise (Day 12 Jailer 2: Tamil 5.86 vs 5.65, Telugu 1.95
    vs 2.00, Hindi 1.39 vs 1.40, Kannada 0.42 vs 0.40), so it is used as-is
    as the India Net figure. It is NOT converted with any GST factor.

Data-quality notes (verified against Sacnilk, 2026-10-26):
  * FNN usually runs LOWER than Sacnilk on opening days and converges later.
    Jailer 2: Day 1 -10%, Day 6 -9%, Day 11 -18%, Day 12 +2%.
    Drishyam: Day 1 -53% (OUTLIER), Day 2 -11%, Day 3 +5%, Day 4 +2%.
    Ranabaali Day 1 -14%, Nayyi Navelli Day 1 -1%.
  * On a small film's opening day FNN can be near-zero (coverage ramp-up):
    Udta Teer Day 1 FNN Rs0.01 Cr vs Sacnilk Rs4.10 Cr; Tu Hai Meri Kiran
    Day 1 FNN Rs0.00 Cr vs Sacnilk Rs0.14 Cr. By Day 4 Udta Teer agrees
    (FNN Rs3.54 Cr vs Sacnilk Rs3.15 Cr).
  * 2026-10-23 is a FROZEN PARTIAL SNAPSHOT in FNN's API (last_updated
    05:39 IST, 55 movies, Rs1.04 Cr total vs Rs51.62 Cr / 210 movies on
    2026-10-25). Every movie reads near-zero that day. The reader DETECTS
    this (past date + snapshot hour < 20:00 IST) and SKIPS the date entirely
    — the guard is in _snapshot_is_final(). Do not remove it.
  * The averaging engine MUST NOT blindly average a near-zero FNN opening
    day with Sacnilk — see the registry averaging rule. This reader reports
    FNN's figures faithfully and flags low-coverage days (entry gross < 1%
    of the movie's peak day is suspicious) in stderr diagnostics only.

Usage:
    python3 fnn_boxoffice.py --movies jailer-2,drishyam-the-conclusion,ranabaali
    python3 fnn_boxoffice.py --movies jailer-2 --end-date 2026-10-26 --out out.json
    python3 fnn_boxoffice.py --movies jailer-2 --today        # today only
    python3 fnn_boxoffice.py --config movies.json             # external config

Output JSON shape (exact):
    {"<tmdb_id>": [{"day": N, "date": "YYYY-MM-DD",
                    "collection_inr_cr": X.XX,
                    "source": "filmynewsnetwork"}]}

Stdlib only. No API keys. Browser User-Agent. 1-2s sleep between requests.
"""

import argparse
import datetime as dt
import json
import re
import sys
import time
import urllib.error
import urllib.request

BASE_URL = "https://filmynewsnetwork.com"
API_URL = BASE_URL + "/api/all-box-office?date={yyyymmdd}"
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
SOURCE = "filmynewsnetwork"
SLEEP_SECONDS = 1.5
MAX_RETRIES = 2

# ---------------------------------------------------------------------------
# Movie registry.
#   slug:     FNN per-movie page slug (for reference; the reader uses the API,
#             not the page). None means the movie has NO FNN page but IS in
#             the API (Udta Teer, Tu Hai Meri Kiran).
#   tmdb_id:  FlickAtlas TMDB id (from live js/daywise-data.js).
#   day1:     Sacnilk-anchored Day 1 date (YYYY-MM-DD). TMDB release_date can
#             be a day early (Jailer 2: TMDB 14 Oct, Sacnilk Day 1 15 Oct),
#             so day1 is explicit, never derived from TMDB.
#   titles:   FNN base titles (text before " [") to match, case-insensitive,
#             punctuation-insensitive. All format/language entries with a
#             matching base title are summed for the India Net day figure.
# ---------------------------------------------------------------------------
MOVIES = {
    "jailer-2": {
        "slug": "jailer-2",
        "tmdb_id": "1234139",
        "day1": "2026-10-15",
        "titles": ["Jailer 2", "Rajini: The Jailer 2"],
    },
    "drishyam-the-conclusion": {
        "slug": "drishyam-the-conclusion",
        "tmdb_id": "1269325",
        "day1": "2026-10-02",
        "titles": ["Drishyam The Conclusion", "Drishyam: The Conclusion"],
    },
    "ranabaali": {
        "slug": "ranabaali",
        "tmdb_id": "1389379",
        "day1": "2026-10-16",
        "titles": ["Ranabaali"],
    },
    "nayyi-navelli": {
        "slug": "nayyi-navelli",
        "tmdb_id": "1654581",
        "day1": "2026-10-16",
        "titles": ["Nayyi Navelli"],
    },
    # API-only (no FNN per-movie page, but present in the daily API data).
    "udta-teer": {
        "slug": None,
        "tmdb_id": "1375156",
        "day1": "2026-10-23",
        "titles": ["Udta Teer"],
    },
    "tu-hai-meri-kiran": {
        "slug": None,
        "tmdb_id": "1785611",
        "day1": "2026-10-23",
        "titles": ["Tu Hai Meri Kiran"],
    },
}


def normalize_title(title):
    """Lowercase, strip punctuation, collapse whitespace — for matching."""
    s = title.lower()
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _snapshot_is_final(api_data, yyyymmdd):
    """Guard against frozen partial snapshots (verified 2026-10-26).

    FNN's API stores one snapshot per date. Normal dates are snapshotted
    end-of-day (~23:4x IST). But 2026-10-23 froze at 05:39 IST with only
    55 movies and Rs1.04 Cr TOTAL gross (vs Rs51.62 Cr / 210 movies on
    2026-10-25) — every movie's figure for that date is near-zero and
    WRONG. Averaging it would poison the final figure.
    Rule: for a PAST date (before today IST) the snapshot must be from
    20:00 IST or later, else the date is unreliable and skipped. Today's
    date is always accepted (it is live/partial by nature — the hourly
    pipeline overwrites it as the day progresses). A missing/unparseable
    last_updated does not block (warn only).
    """
    if not api_data:
        return False
    last_updated = api_data.get("last_updated")
    if not last_updated:
        print(f"  [warn] {yyyymmdd}: no last_updated, proceeding anyway",
              file=sys.stderr)
        return True
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})", last_updated)
    if not m:
        print(f"  [warn] {yyyymmdd}: unparseable last_updated "
              f"{last_updated!r}, proceeding anyway", file=sys.stderr)
        return True
    snap = dt.datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)),
                       int(m.group(4)), int(m.group(5)))
    req_date = dt.date(int(yyyymmdd[:4]), int(yyyymmdd[4:6]),
                       int(yyyymmdd[6:8]))
    if req_date < today_ist() and snap.hour < 20:
        print(f"  [warn] {yyyymmdd}: PARTIAL snapshot frozen at "
              f"{last_updated} (only {api_data.get('total_movies')} movies) "
              f"— date skipped, do not average", file=sys.stderr)
        return False
    return True


def fetch_date(yyyymmdd):
    """GET /api/all-box-office?date=YYYYMMDD. Returns parsed JSON or None."""
    url = API_URL.format(yyyymmdd=yyyymmdd)
    last_err = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if data.get("success"):
                if not _snapshot_is_final(data, yyyymmdd):
                    return None
                return data
            print(f"  [warn] {yyyymmdd}: API success=false",
                  file=sys.stderr)
            return None
        except (urllib.error.URLError, urllib.error.HTTPError,
                TimeoutError, json.JSONDecodeError) as e:
            last_err = e
            if attempt < MAX_RETRIES:
                time.sleep(SLEEP_SECONDS * 2)
    print(f"  [warn] {yyyymmdd}: fetch failed after retries: {last_err}",
          file=sys.stderr)
    return None


def movie_gross_for_date(api_data, title_set):
    """Sum gross (INR rupees) across all entries whose base title matches.

    api_data is one /api/all-box-office response for a single date.
    title_set is a set of normalized base titles for the movie.
    Returns (gross_inr, entry_count).
    """
    total = 0.0
    count = 0
    for entry in api_data.get("movies", []):
        base = entry.get("movie", "").split(" [")[0]
        if normalize_title(base) in title_set:
            try:
                total += float(entry.get("gross") or 0)
            except (TypeError, ValueError):
                continue
            count += 1
    return total, count


def build_daywise(movie_key, movie, end_date, date_cache):
    """Build the day-wise series for one movie.

    Calls the API once per date from day1 to end_date (shared date_cache
    across movies so each date is fetched at most once). Returns a list of
    rows in the output shape. Dates with no matching entries are skipped
    (never invented) and logged to stderr.
    """
    day1 = dt.date.fromisoformat(movie["day1"])
    title_set = {normalize_title(t) for t in movie["titles"]}
    rows = []
    d = day1
    while d <= end_date:
        yyyymmdd = d.strftime("%Y%m%d")
        if yyyymmdd not in date_cache:
            date_cache[yyyymmdd] = fetch_date(yyyymmdd)
            time.sleep(SLEEP_SECONDS)
        api_data = date_cache[yyyymmdd]
        if api_data is None:
            print(f"  [warn] {movie_key} {d}: no API data, skipped",
                  file=sys.stderr)
            d += dt.timedelta(days=1)
            continue
        gross_inr, count = movie_gross_for_date(api_data, title_set)
        if count == 0 or gross_inr <= 0:
            print(f"  [warn] {movie_key} {d}: no FNN entries "
                  f"(count={count}, gross={gross_inr}), skipped",
                  file=sys.stderr)
            d += dt.timedelta(days=1)
            continue
        day_no = (d - day1).days + 1
        rows.append({
            "day": day_no,
            "date": d.isoformat(),
            "collection_inr_cr": round(gross_inr / 1e7, 2),
            "source": SOURCE,
        })
        d += dt.timedelta(days=1)
    return rows


def today_ist():
    """Today's date in Asia/Kolkata (IST, UTC+5:30)."""
    return (dt.datetime.now(dt.timezone.utc)
            + dt.timedelta(hours=5, minutes=30)).date()


def main(argv=None):
    global SLEEP_SECONDS
    ap = argparse.ArgumentParser(
        description="FilmyNewsNetwork box-office reader (day-wise, India Net).")
    ap.add_argument("--movies", default=",".join(MOVIES),
                    help="Comma-separated movie keys (default: all).")
    ap.add_argument("--end-date", default=None,
                    help="Last date to fetch, YYYY-MM-DD (default: today IST).")
    ap.add_argument("--today", action="store_true",
                    help="Fetch only today's figure for each movie.")
    ap.add_argument("--config", default=None,
                    help="Optional JSON file with extra/override movie entries "
                         "(same shape as MOVIES).")
    ap.add_argument("--out", default=None,
                    help="Output JSON file (default: stdout).")
    ap.add_argument("--stage", default=None, metavar="DIR",
                    help="Also write the per-source staging JSON "
                         "(<DIR>/filmynewsnetwork.json) for the multi-source "
                         "averaging engine; deterministic (only writes when "
                         "changed).")
    ap.add_argument("--sleep", type=float, default=SLEEP_SECONDS,
                    help="Seconds to sleep between API calls (default 1.5).")
    args = ap.parse_args(argv)

    SLEEP_SECONDS = args.sleep

    movies = dict(MOVIES)
    if args.config:
        with open(args.config, encoding="utf-8") as f:
            extra = json.load(f)
        movies.update(extra)

    end_date = (dt.date.fromisoformat(args.end_date) if args.end_date
                else today_ist())

    date_cache = {}
    result = {}
    for key in [k.strip() for k in args.movies.split(",") if k.strip()]:
        if key not in movies:
            print(f"[error] unknown movie key: {key} "
                  f"(known: {', '.join(sorted(movies))})", file=sys.stderr)
            continue
        movie = movies[key]
        if args.today:
            # Single-date mode: fetch only end_date, day number from day1.
            day1 = dt.date.fromisoformat(movie["day1"])
            yyyymmdd = end_date.strftime("%Y%m%d")
            api_data = fetch_date(yyyymmdd)
            if api_data is None:
                print(f"  [warn] {key} {end_date}: no API data",
                      file=sys.stderr)
                continue
            title_set = {normalize_title(t) for t in movie["titles"]}
            gross_inr, count = movie_gross_for_date(api_data, title_set)
            if count == 0 or gross_inr <= 0:
                print(f"  [warn] {key} {end_date}: no FNN entries",
                      file=sys.stderr)
                continue
            result[movie["tmdb_id"]] = [{
                "day": (end_date - day1).days + 1,
                "date": end_date.isoformat(),
                "collection_inr_cr": round(gross_inr / 1e7, 2),
                "source": SOURCE,
            }]
            continue
        print(f"[fnn] {key} (TMDB {movie['tmdb_id']}) "
              f"day1={movie['day1']} .. {end_date}", file=sys.stderr)
        rows = build_daywise(key, movie, end_date, date_cache)
        if rows:
            result[movie["tmdb_id"]] = rows
        print(f"[fnn] {key}: {len(rows)} day-wise rows", file=sys.stderr)

    out = json.dumps(result, indent=2, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(out + "\n")
        print(f"[fnn] wrote {args.out}", file=sys.stderr)
    else:
        print(out)
    if args.stage:
        # Staging file for the multi-source averaging engine: one file
        # per source, filename = source id. Deterministic (sorted keys,
        # no timestamps) so an unchanged file never triggers a spurious
        # pipeline commit.
        import os as _os
        _os.makedirs(args.stage, exist_ok=True)
        stage_path = _os.path.join(args.stage, "filmynewsnetwork.json")
        stage_content = json.dumps(result, ensure_ascii=False, indent=2,
                                   sort_keys=True) + "\n"
        existing = ""
        if _os.path.exists(stage_path):
            with open(stage_path, encoding="utf-8") as f:
                existing = f.read()
        if existing != stage_content:
            with open(stage_path, "w", encoding="utf-8") as f:
                f.write(stage_content)
            n = sum(len(v) for v in result.values())
            print(f"[fnn] staging {stage_path} written "
                  f"({n} row(s), {len(result)} movie(s))", file=sys.stderr)
        else:
            print(f"[fnn] staging {stage_path} unchanged", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
