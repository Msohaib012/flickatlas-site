#!/usr/bin/env python3
"""
BollyBourse box-office reader for FlickAtlas.

Source: https://bollybourse.com
Data model (verified 2026-10-26 by spike test):
  * Per-movie day pages: /movie/<slug>/day-N — the figure is in the STATIC
    HTML (server-rendered). No JS/API discovery needed.
  * EVERY day page carries the FULL day-wise table:
        <details class="all"><summary>Every day of the run</summary>
        <table><thead>Day | Date | India net | Change | Shows</thead><tbody>
    one <tr> per day, newest first. So ONE fetch per movie (the latest
    day page) yields the whole history.
  * The table's "India net" column is explicitly labelled India net, and
    the page footer says "India net figures are trade estimates compiled
    from public reports." Scope = India Net day-wise, same as Sacnilk.
  * The current day's row carries a "so far" marker in the figure cell
    (e.g. "Rs8.29 Cr so far") and the page header says "Live". That row is
    a LIVE partial-day figure — it is flagged "estimate": true. Past days
    have no marker and are final.
  * A day page that does not exist yet returns HTTP 404 (e.g. Tu Hai Meri
    Kiran /day-4 on 26 Oct — Day 4 not published yet). The 404 page has NO
    day-wise table. The reader falls back to the previous day's page, whose
    table still holds the full history up to the last published day.
  * The sitemap lags the live site by ~1 day (Jailer 2 day-12 exists live
    but the sitemap lists only up to day-11), so the reader NEVER uses the
    sitemap to find the latest day. It computes the expected latest day
    from the Sacnilk-anchored Day 1 date and today (IST), then falls back
    up to 2 days on 404/no-table.
  * Dates: the table shows "Mon 26 Oct" (weekday + day + month, no year).
    The reader derives the full date as day1 + (day_no - 1) and cross-checks
    the table's month/day string against it (warns on mismatch, trusts
    the anchor — anchors are Sacnilk-verified).

Scope check (verified against live Sacnilk day-wise, 2026-10-26):
  * BollyBourse final-day figures are EXACTLY Sacnilk's day-wise figures
    for almost every movie/day (diff +0.00): Jailer 2 Days 1-11, Drishyam 3
    Days 1-24, Ranabaali Days 1-10, Nayyi Navelli Days 1-10, Tu Hai Meri
    Kiran Days 1-3, Udta Teer Days 1-2, Pehla Pyaar Day 1. Small diffs
    elsewhere are <= Rs0.11 Cr (Udta Teer Day 3 -0.11, Clayface Days 2-3
    +0.08, Pehla Pyaar Days 2-3 +0.03/+0.07). The two sources clearly track
    the same trade data.
  * The "Rs407 Cr in India" headline is BollyBourse's OWN 12-day total
    (Rs398.70 Days 1-11 + Rs8.29 live Day 12 = Rs406.99 Cr) — NOT a
    different scope. Sacnilk's total is Rs408.15 Cr (398.70 + 9.45 final
    Day 12). The Rs398.7 Cr figure cited elsewhere is the Day 1-11 sum.
    TrackTollywood's Rs436.94 Cr "running" is India GROSS, not net — not
    comparable. There is NO scope discrepancy in BollyBourse's day-wise.
  * Live (current-day) figures run LOW vs Sacnilk's final: Jailer 2 Day 12
    8.29 vs 9.45 (-1.16), Udta Teer Day 4 2.49 vs 3.15 (-0.66), Drishyam
    Day 25 0.81 vs 1.05 (-0.24). They rise through the day. The averaging
    engine MUST treat "estimate": true rows as partial (exclude or
    down-weight vs a final figure from another source).

Drishyam 3 WARNING: the site has TWO versions — drishyam-3-hindi (Oct 2026,
TMDB 1269325) and drishyam-3-malayalam (May 2026, tiny figures, a DIFFERENT
film). Only drishyam-3-hindi is mapped to TMDB 1269325. The Malayalam
version is NEVER mapped (no TMDB id in FA_PUBLISHED — never guess).

Usage:
    python3 bollybourse_boxoffice.py
    python3 bollybourse_boxoffice.py --movies jailer-2,udta-teer --out out.json
    python3 bollybourse_boxoffice.py --movies jailer-2 --today   # today only
    python3 bollybourse_boxoffice.py --config movies.json        # external config

Output JSON shape (exact):
    {"<tmdb_id>": [{"day": N, "date": "YYYY-MM-DD",
                    "collection_inr_cr": X.XX,
                    "source": "bollybourse",
                    "estimate": true}] }        # "estimate" only on live rows

Stdlib only. No API keys. Browser User-Agent. 1.5s sleep between requests.
"""

import argparse
import datetime as dt
import json
import re
import sys
import time
import urllib.error
import urllib.request

BASE_URL = "https://bollybourse.com"
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
SOURCE = "bollybourse"
SLEEP_SECONDS = 1.5
MAX_RETRIES = 2
FALLBACK_DAYS = 2  # how many days back to try when the latest page is missing

# ---------------------------------------------------------------------------
# Movie registry.
#   slug:    BollyBourse per-movie slug (the /movie/<slug>/day-N pages).
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
    "drishyam-3-hindi": {
        "slug": "drishyam-3-hindi",
        "tmdb_id": "1269325",
        "day1": "2026-10-02",
    },
    "udta-teer": {
        "slug": "udta-teer",
        "tmdb_id": "1375156",
        "day1": "2026-10-23",
    },
    "tu-hai-meri-kiran": {
        "slug": "tu-hai-meri-kiran",
        "tmdb_id": "1785611",
        "day1": "2026-10-23",
    },
    "pehla-pyaar-doosri-baar": {
        "slug": "pehla-pyaar-doosri-baar",
        "tmdb_id": "1772549",
        "day1": "2026-10-23",
    },
    "ranabaali": {
        "slug": "ranabaali",
        "tmdb_id": "1389379",
        "day1": "2026-10-16",
    },
    "clayface": {
        "slug": "clayface",
        "tmdb_id": "1400940",
        "day1": "2026-10-23",
    },
    "nayyi-navelli": {
        "slug": "nayyi-navelli",
        "tmdb_id": "1654581",
        "day1": "2026-10-16",
    },
    # NOTE: drishyam-3-malayalam is deliberately NOT here. It is a different
    # May-2026 film (tiny figures), not TMDB 1269325. Never map it.
}

MONTHS = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}


def today_ist():
    """Today's date in Asia/Kolkata (IST, UTC+5:30)."""
    return (dt.datetime.now(dt.timezone.utc)
            + dt.timedelta(hours=5, minutes=30)).date()


def fetch_url(url):
    """GET a URL. Returns (status, html) — status None on network failure.

    HTTP 404 means "page does not exist yet" (a future day page) — returned
    as (404, html), NOT retried. Other errors are retried.
    """
    last_err = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status, resp.read().decode("utf-8", errors="ignore")
        except urllib.error.HTTPError as e:
            try:
                body = e.read().decode("utf-8", errors="ignore")
            except Exception:
                body = ""
            return e.code, body
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
            if attempt < MAX_RETRIES:
                time.sleep(SLEEP_SECONDS * 2)
    print(f"  [warn] fetch failed after retries: {url}: {last_err}",
          file=sys.stderr)
    return None, ""


def parse_daywise_table(html):
    """Parse the <details class="all"> day-wise <table>.

    Returns a list of dicts: {"day": N, "date_str": "Mon 26 Oct",
    "collection_inr_cr": X.XX, "estimate": bool} sorted by day ascending,
    or [] if the table is absent (e.g. a 404 page).
    The current day's row carries "so far" in the India net cell.
    """
    m = re.search(r'<details class="all">.*?<tbody>(.*?)</tbody>',
                  html, re.S)
    if not m:
        return []
    rows = []
    for tr in re.findall(r'<tr[^>]*>(.*?)</tr>', m.group(1), re.S):
        cells = re.findall(r'<td[^>]*>(.*?)</td>', tr, re.S)
        if len(cells) < 3:
            continue
        clean = [re.sub(r"\s+", " ",
                        re.sub(r"<[^>]+>", "", c)).strip() for c in cells]
        day_m = re.search(r"Day\s*(\d+)", clean[0])
        fig_m = re.search(r"₹\s*([\d,]+\.?\d*)", clean[2])
        if not day_m or not fig_m:
            continue
        try:
            figure = float(fig_m.group(1).replace(",", ""))
        except ValueError:
            continue
        rows.append({
            "day": int(day_m.group(1)),
            "date_str": clean[1],
            "collection_inr_cr": round(figure, 2),
            "estimate": "so far" in clean[2],
        })
    rows.sort(key=lambda r: r["day"])
    return rows


def resolve_dates(rows, day1):
    """Attach full ISO dates to parsed table rows.

    Date for Day N = day1 + (N - 1) days. The table's "Mon 26 Oct" string
    is cross-checked (month/day must match); a mismatch is warned about
    but the anchor-derived date is trusted (anchors are Sacnilk-verified).
    """
    out = []
    for r in rows:
        d = day1 + dt.timedelta(days=r["day"] - 1)
        dm = re.search(r"(\d{1,2})\s+([A-Za-z]{3})", r["date_str"])
        if dm:
            tbl_day, tbl_mon = int(dm.group(1)), MONTHS.get(dm.group(2).title())
            if tbl_mon and (tbl_day != d.day or tbl_mon != d.month):
                print(f"  [warn] Day {r['day']}: table date "
                      f"'{r['date_str']}' != anchor-derived {d} "
                      f"(trusting anchor)", file=sys.stderr)
        row = {
            "day": r["day"],
            "date": d.isoformat(),
            "collection_inr_cr": r["collection_inr_cr"],
            "source": SOURCE,
        }
        if r["estimate"]:
            row["estimate"] = True
        out.append(row)
    return out


def fetch_latest_table(movie_key, movie, end_date):
    """Fetch the latest available day page for a movie and parse its table.

    Expected latest day = (end_date - day1) + 1. Tries that day, then falls
    back up to FALLBACK_DAYS days on 404 / missing table. Returns
    (rows, page_day) where page_day is the day number of the fetched page,
    or ([], None) if nothing could be fetched.
    """
    day1 = dt.date.fromisoformat(movie["day1"])
    expected = (end_date - day1).days + 1
    if expected < 1:
        print(f"  [warn] {movie_key}: end_date {end_date} is before day1 "
              f"{day1}", file=sys.stderr)
        return [], None
    failed_status = None
    for day_no in range(expected, max(0, expected - FALLBACK_DAYS - 1), -1):
        url = f"{BASE_URL}/movie/{movie['slug']}/day-{day_no}"
        status, html = fetch_url(url)
        time.sleep(SLEEP_SECONDS)
        if status is None:
            continue
        rows = parse_daywise_table(html)
        if rows:
            if day_no != expected:
                print(f"  [info] {movie_key}: day-{expected} not published "
                      f"yet (HTTP {failed_status}), fell back to "
                      f"day-{day_no}", file=sys.stderr)
            return rows, day_no
        failed_status = status
        print(f"  [info] {movie_key}: day-{day_no} has no day-wise table "
              f"(HTTP {status})", file=sys.stderr)
    print(f"  [warn] {movie_key}: no usable day page found "
          f"(tried day-{expected}..day-{expected - FALLBACK_DAYS})",
          file=sys.stderr)
    return [], None


def build_daywise(movie_key, movie, end_date):
    """Build the full day-wise series for one movie (one fetch)."""
    day1 = dt.date.fromisoformat(movie["day1"])
    rows, _page_day = fetch_latest_table(movie_key, movie, end_date)
    if not rows:
        return []
    # Only keep rows on/before end_date (a page fetched for a later day
    # could in theory include a future row — never emit future dates).
    resolved = [r for r in resolve_dates(rows, day1)
                if dt.date.fromisoformat(r["date"]) <= end_date]
    return resolved


def main(argv=None):
    global SLEEP_SECONDS
    ap = argparse.ArgumentParser(
        description="BollyBourse box-office reader (day-wise, India Net).")
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
                         "(<DIR>/bollybourse.json) for the multi-source "
                         "averaging engine; deterministic (only writes when "
                         "changed).")
    ap.add_argument("--sleep", type=float, default=SLEEP_SECONDS,
                    help="Seconds to sleep between requests (default 1.5).")
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
        print(f"[bb] {key} (TMDB {movie['tmdb_id']}) "
              f"day1={movie['day1']} .. {end_date}", file=sys.stderr)
        rows = build_daywise(key, movie, end_date)
        if args.today:
            rows = [r for r in rows if r["date"] == end_date.isoformat()]
        if rows:
            result[movie["tmdb_id"]] = rows
        print(f"[bb] {key}: {len(rows)} day-wise rows", file=sys.stderr)

    out = json.dumps(result, indent=2, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(out + "\n")
        print(f"[bb] wrote {args.out}", file=sys.stderr)
    else:
        print(out)
    if args.stage:
        # Staging file for the multi-source averaging engine: one file
        # per source, filename = source id. Deterministic (sorted keys,
        # no timestamps) so an unchanged file never triggers a spurious
        # pipeline commit.
        import os as _os
        _os.makedirs(args.stage, exist_ok=True)
        stage_path = _os.path.join(args.stage, "bollybourse.json")
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
            print(f"[bb] staging {stage_path} written "
                  f"({n} row(s), {len(result)} movie(s))", file=sys.stderr)
        else:
            print(f"[bb] staging {stage_path} unchanged", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
