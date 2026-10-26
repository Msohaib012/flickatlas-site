#!/usr/bin/env python3
"""
MovieMint box-office reader for FlickAtlas.

Source: https://moviemintbo.com
Data model (verified 2026-10-26 by spike test):
  * Next.js App Router site. The per-movie page (/movie/<slug>) STATIC HTML
    is only a shell ("Connecting to server" splash) — NO figures, NO
    __NEXT_DATA__, NO /api/ refs in the static HTML or the JS chunks.
    There is NO usable /api/ route on the main domain (all /api/* 404).
  * The data comes from the page's React Server Component (RSC) payload:
        GET /movie/<slug>?date=YYYYMMDD   with header  RSC: 1
    (the server 307-redirects to ?date=YYYYMMDD&_rsc; urllib follows it).
    The flight payload contains a "data" object for that ONE date:
        config:   movieId, title, tmdbId, releaseDate, language, note
        date:     "YYYYMMDD" (the date the payload is for — VERIFY it)
        metadata: lastUpdated "YYYY-MM-DD HH:MM IST", source "BookMyShow"
        summary:  totalGross (INR rupees), totalShows, totalTicketsSold, ...
        indiaStates / indiaLanguages / indiaFormats / indiaTerritories:
                  per-state / per-language / per-format gross breakdowns
  * The /box-office/<slug> pages carry NO data object in their RSC payload
    (shell only) — the reader always uses /movie/<slug>.
  * The API keeps history: ?date= accepts past dates and returns that date's
    end-of-day snapshot (lastUpdated ~23:4x IST). Day-wise history is built
    by calling once per date (shared date cache across movies is NOT
    possible — each movie is a separate RSC call).

GROSS vs NET (verified against Sacnilk, 2026-10-26):
  * MovieMint's totalGross is BOOKMYSHOW GROSS (ticket price incl. GST),
    NOT India Net. Across ALL 63 movie-days measured (full day-wise
    histories, 2026-10-26) it runs 1.01x-1.34x Sacnilk India Net
    (mean 1.177, median 1.178, stdev 0.072). The ratio is movie-dependent:
        Jailer 2:      mean 1.131 (D1 1.08, D12 1.20)
        Drishyam:      mean 1.236 (D1 1.28, D25 1.21) — systematically high
        Ranabaali:     mean 1.093 (D1 1.01, D11 1.18) — systematically low
        Nayyi Navelli: mean 1.161
        Udta Teer:     mean 1.216
  * The reader therefore converts gross -> estimated India Net with a
    single documented divisor GROSS_TO_NET = 1.18 (the measured mean
    1.177, rounded; it minimises error: mean abs err 5.1%, mean signed
    err -0.3% over 63 days). The RAW gross is preserved in every row as
    collection_gross_inr_cr so the averaging engine (or a human) can
    audit or re-derive it. The residual error of the conversion is up to
    ~+/-13% on a single day (same order as existing inter-source noise:
    FNN vs Sacnilk already differs by up to +/-18% on some days), and
    there is a residual per-movie bias (Drishyam ~+5%, Ranabaali ~-7%)
    that a single global divisor cannot remove.
  * The language split sums to totalGross (Jailer 2 Day 12: Tamil 6.91 +
    Telugu 2.34 + Hindi 1.64 + Kannada 0.48 = 11.37 ~ 11.36), and the
    config note confirms the Hindi version is INCLUDED in the total
    ("Includes the Hindi version, which is listed separately as
    'Rajini: The Jailer 2'") — unlike FNN's page headline, which excludes
    it. No alias-summing is needed here.

Guards (do not remove):
  * DATE-MISMATCH GUARD: a request for a date outside the movie's tracked
    range silently falls back to TODAY's data (verified: ?date=20261014
    for Jailer 2 returned the 2026-10-26 payload). The reader VERIFIES
    data["date"] == requested YYYYMMDD and SKIPS the row on mismatch.
  * PAST-DATE SNAPSHOT GUARD: for a past date the snapshot must be from
    20:00 IST or later (lastUpdated), else the date is skipped — a
    mid-day snapshot would understate the day (same class of bug as
    FNN's frozen 2026-10-23 snapshot). Today's date is always accepted
    (live/partial by nature — the hourly pipeline overwrites it).

Movies NOT on MovieMint (verified via sitemap, 2026-10-26):
  Tu Hai Meri Kiran, Pehla Pyaar Doosri Baar, Clayface — no /movie/ page.
  NOTE: /movie/drishyam-3 is the MALAYALAM Drishyam 3 (Mohanlal), NOT
  the Hindi "Drishyam: The Conclusion" — the Hindi film's slug is
  drishyam-the-conclusion. Do not confuse them.

Usage:
    python3 moviemint_boxoffice.py --movies jailer-2,udta-teer
    python3 moviemint_boxoffice.py --movies jailer-2 --end-date 2026-10-26 --out out.json
    python3 moviemint_boxoffice.py --movies jailer-2 --today        # today only

Output JSON shape (exact, plus audit fields per row):
    {"<tmdb_id>": [{"day": N, "date": "YYYY-MM-DD",
                    "collection_inr_cr": X.XX,          # estimated India Net
                    "collection_gross_inr_cr": Y.YY,    # raw MovieMint gross
                    "source": "moviemintbo"}]}

Stdlib only. No API keys. Browser User-Agent. 1-2s sleep between requests.
"""

import argparse
import datetime as dt
import json
import sys
import time
import urllib.error
import urllib.request

BASE_URL = "https://moviemintbo.com"
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
SOURCE = "moviemintbo"
SLEEP_SECONDS = 1.5
MAX_RETRIES = 2

# Gross (BookMyShow, incl. GST) -> estimated India Net divisor.
# Measured mean MM/Sacnilk ratio over all 63 movie-days, 2026-10-26: 1.177.
GROSS_TO_NET = 1.18

# ---------------------------------------------------------------------------
# Movie registry.
#   slug:    MovieMint /movie/<slug> (verified in the sitemap).
#   tmdb_id: FlickAtlas TMDB id (from live js/daywise-data.js).
#   day1:    Sacnilk-anchored Day 1 date (YYYY-MM-DD). TMDB release_date can
#            be a day early (Jailer 2: TMDB 14 Oct, Sacnilk Day 1 15 Oct),
#            so day1 is explicit, never derived from TMDB.
# ---------------------------------------------------------------------------
MOVIES = {
    "jailer-2": {
        "slug": "jailer-2",
        "tmdb_id": "1234139",
        "day1": "2026-10-15",
    },
    "drishyam-the-conclusion": {
        "slug": "drishyam-the-conclusion",
        "tmdb_id": "1269325",
        "day1": "2026-10-02",
    },
    "ranabaali": {
        "slug": "ranabaali",
        "tmdb_id": "1389379",
        "day1": "2026-10-16",
    },
    "nayyi-navelli": {
        "slug": "nayyi-navelli",
        "tmdb_id": "1654581",
        "day1": "2026-10-16",
    },
    "udta-teer": {
        "slug": "udta-teer",
        "tmdb_id": "1375156",
        "day1": "2026-10-23",
    },
}


def today_ist():
    """Today's date in Asia/Kolkata (IST, UTC+5:30)."""
    return (dt.datetime.now(dt.timezone.utc)
            + dt.timedelta(hours=5, minutes=30)).date()


def _extract_data(text):
    """Extract the flight-payload "data" object from an RSC response.

    Returns the parsed dict, or None if the payload has no data object.
    The flight format escapes $undefined as a JSON string; replace it
    with null before parsing.
    """
    i = text.find('"data":{')
    if i < 0:
        return None
    seg = text[i + 7:]
    depth = 0
    end = None
    instr = False
    esc = False
    for j, ch in enumerate(seg):
        if instr:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                instr = False
        else:
            if ch == '"':
                instr = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = j + 1
                    break
    if end is None:
        return None
    clean = seg[:end].replace('"$undefined"', "null")
    try:
        return json.loads(clean)
    except json.JSONDecodeError as e:
        print(f"  [warn] RSC data object unparseable: {e}", file=sys.stderr)
        return None


def _snapshot_is_final(data, yyyymmdd):
    """Guard against partial/frozen snapshots (same class as FNN 23 Oct).

    For a PAST date (before today IST) the snapshot's lastUpdated must be
    20:00 IST or later, else the date is unreliable and skipped. Today's
    date is always accepted (live/partial by nature). A missing or
    unparseable lastUpdated does not block (warn only).
    """
    if not data:
        return False
    meta = data.get("metadata") or {}
    last_updated = meta.get("lastUpdated")
    if not last_updated:
        print(f"  [warn] {yyyymmdd}: no lastUpdated, proceeding anyway",
              file=sys.stderr)
        return True
    m = None
    import re
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})",
                  last_updated)
    if not m:
        print(f"  [warn] {yyyymmdd}: unparseable lastUpdated "
              f"{last_updated!r}, proceeding anyway", file=sys.stderr)
        return True
    snap_hour = int(m.group(4))
    req_date = dt.date(int(yyyymmdd[:4]), int(yyyymmdd[4:6]),
                       int(yyyymmdd[6:8]))
    if req_date < today_ist() and snap_hour < 20:
        print(f"  [warn] {yyyymmdd}: PARTIAL snapshot (lastUpdated "
              f"{last_updated}) — date skipped, do not average",
              file=sys.stderr)
        return False
    return True


def fetch_movie_date(slug, yyyymmdd):
    """GET /movie/<slug>?date=YYYYMMDD with RSC: 1. Returns the data dict.

    Verifies the payload's own "date" field matches the requested date
    (the server silently falls back to today for out-of-range dates).
    Returns None on any failure, mismatch, or non-final snapshot.
    """
    url = f"{BASE_URL}/movie/{slug}?date={yyyymmdd}"
    last_err = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": USER_AGENT, "RSC": "1"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                text = resp.read().decode("utf-8", errors="ignore")
            data = _extract_data(text)
            if data is None:
                print(f"  [warn] {slug} {yyyymmdd}: no data object in RSC",
                      file=sys.stderr)
                return None
            # DATE-MISMATCH GUARD: out-of-range dates fall back to today.
            if str(data.get("date")) != yyyymmdd:
                print(f"  [warn] {slug} {yyyymmdd}: payload date is "
                      f"{data.get('date')} (fallback) — skipped",
                      file=sys.stderr)
                return None
            if not _snapshot_is_final(data, yyyymmdd):
                return None
            return data
        except (urllib.error.URLError, urllib.error.HTTPError,
                TimeoutError) as e:
            last_err = e
            if attempt < MAX_RETRIES:
                time.sleep(SLEEP_SECONDS * 2)
    print(f"  [warn] {slug} {yyyymmdd}: fetch failed after retries: "
          f"{last_err}", file=sys.stderr)
    return None


def row_for_date(data, day_no, date_iso):
    """Build one output row from a date's data dict. None if no gross."""
    summary = data.get("summary") or {}
    gross_inr = summary.get("totalGross")
    if not gross_inr:
        return None
    try:
        gross_inr = float(gross_inr)
    except (TypeError, ValueError):
        return None
    if gross_inr <= 0:
        return None
    gross_cr = gross_inr / 1e7
    return {
        "day": day_no,
        "date": date_iso,
        "collection_inr_cr": round(gross_cr / GROSS_TO_NET, 2),
        "collection_gross_inr_cr": round(gross_cr, 2),
        "source": SOURCE,
    }


def build_daywise(movie_key, movie, end_date):
    """Build the day-wise series for one movie, day1..end_date."""
    day1 = dt.date.fromisoformat(movie["day1"])
    rows = []
    d = day1
    while d <= end_date:
        yyyymmdd = d.strftime("%Y%m%d")
        data = fetch_movie_date(movie["slug"], yyyymmdd)
        time.sleep(SLEEP_SECONDS)
        if data is None:
            d += dt.timedelta(days=1)
            continue
        row = row_for_date(data, (d - day1).days + 1, d.isoformat())
        if row is None:
            print(f"  [warn] {movie_key} {d}: no gross in payload, skipped",
                  file=sys.stderr)
        else:
            rows.append(row)
        d += dt.timedelta(days=1)
    return rows


def main(argv=None):
    global SLEEP_SECONDS
    ap = argparse.ArgumentParser(
        description="MovieMint box-office reader (day-wise, India Net est.).")
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
                         "(<DIR>/moviemint.json) for the multi-source "
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

    result = {}
    for key in [k.strip() for k in args.movies.split(",") if k.strip()]:
        if key not in movies:
            print(f"[error] unknown movie key: {key} "
                  f"(known: {', '.join(sorted(movies))})", file=sys.stderr)
            continue
        movie = movies[key]
        if args.today:
            day1 = dt.date.fromisoformat(movie["day1"])
            yyyymmdd = end_date.strftime("%Y%m%d")
            data = fetch_movie_date(movie["slug"], yyyymmdd)
            if data is None:
                print(f"  [warn] {key} {end_date}: no data",
                      file=sys.stderr)
                continue
            row = row_for_date(data, (end_date - day1).days + 1,
                               end_date.isoformat())
            if row is None:
                print(f"  [warn] {key} {end_date}: no gross in payload",
                      file=sys.stderr)
                continue
            result[movie["tmdb_id"]] = [row]
            continue
        print(f"[moviemint] {key} (TMDB {movie['tmdb_id']}) "
              f"day1={movie['day1']} .. {end_date}", file=sys.stderr)
        rows = build_daywise(key, movie, end_date)
        if rows:
            result[movie["tmdb_id"]] = rows
        print(f"[moviemint] {key}: {len(rows)} day-wise rows",
              file=sys.stderr)

    out = json.dumps(result, indent=2, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(out + "\n")
        print(f"[moviemint] wrote {args.out}", file=sys.stderr)
    else:
        print(out)
    if args.stage:
        # Staging file for the multi-source averaging engine: one file
        # per source, filename = source id. Deterministic (sorted keys,
        # no timestamps) so an unchanged file never triggers a spurious
        # pipeline commit. The engine reads collection_inr_cr and
        # ignores the extra collection_gross_inr_cr audit key.
        import os as _os
        _os.makedirs(args.stage, exist_ok=True)
        stage_path = _os.path.join(args.stage, "moviemint.json")
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
            print(f"[moviemint] staging {stage_path} written "
                  f"({n} row(s), {len(result)} movie(s))", file=sys.stderr)
        else:
            print(f"[moviemint] staging {stage_path} unchanged",
                  file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
