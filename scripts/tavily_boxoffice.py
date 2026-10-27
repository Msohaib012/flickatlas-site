#!/usr/bin/env python3
"""Tavily box-office gap-filler for FlickAtlas (REFILL + UPDATE).

Tavily search is a GAP-FILLER only — the per-site readers stay primary.
Twice a day (08:00 and 18:00 UTC, gated in the hourly pipeline) this
script searches for TODAY's India Net figure for every ACTIVE movie
with day-wise rows, and writes them to out/boxoffice-staging/tavily.json
so the averaging engine (scripts/multisource_boxoffice.py) can mean
them with the readers' figures as usual. Two date rules keep the
target day honest: (1) before 06:00 IST the target is YESTERDAY —
the 18:00 UTC run executes at ~00:30 IST, when the new day's figures
do not exist yet; (2) when today's figure is not found and the
baseline genuinely lacks YESTERDAY's row, the same results are tried
for yesterday (same acceptance guards) — sources publish a day's
figure the next morning, so this is the only way a gap ever fills.

  * REFILL: a movie missing today's figure gets one when search finds
    a usable final-or-live figure for today; a movie missing
    yesterday's figure gets that one instead (gap-fill, same guards).
  * UPDATE: a movie that already has today's figure gets it REFRESHED
    with the latest search-backed value (live figures move during the
    day; the 2x/day runs track that).
  * ONLY the target day's figure is ever written (today; yesterday
    only as a gap-fill when its row is missing). Days older than
    yesterday are never rewritten from Tavily — history stays with
    the readers. The staging file is rewritten from scratch every run
    with only the accepted rows; when a run accepts nothing it writes
    {} so a stale live figure can never linger and drag a past day's
    mean down.

Acceptance rules (a figure is written ONLY when ALL hold):
  * the result is a day-wise block/table/prose for THIS movie;
  * the figure is tied to TODAY (a today date string in the result, or
    a Day-N tracker title) and carries an EXPLICIT day number;
  * the day number equals the expected day, computed from the baseline
    Day 1 date (today - Day 1 + 1);
  * scope is all-India NET: reject worldwide/overseas totals, gross
    figures, and language/version splits (Hindi/Tamil/Telugu/...).
    bollywoodhungama.com is excluded entirely — its day-wise table is
    Hindi-version-only figures presented as India totals.
  * value sanity: 0 < Rs Cr <= 120 (engine cap), within 0.05x-4x of
    yesterday's figure, and (when today already has a baseline figure)
    not more than 50% BELOW it (a big drop means a stale live figure
    or a scope error; live figures only rise during the day).
  * if uncertain, write NOTHING for that movie — never invent.

Keys: the script reads TAVILY_API_KEY, falling back to
TAVILY_API_KEY_BACKUP on any failure (429/401/5xx or transport error).
If neither is set it prints a skip message and exits 0 — the pipeline
step must never fail for lack of secrets. Key values are never printed
or logged (only which key slot served the call).

CLI: python3 scripts/tavily_boxoffice.py --stage out/boxoffice-staging
  --today YYYY-MM-DD  (testing override; default: today in IST)
  --fixture-dir DIR   (testing only: read saved Tavily responses from
                       DIR/<tmdb_id>.json instead of calling the API)
  --dry-run           (print what it would write, write nothing)

This file is stdlib only.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
TAVILY_URL = "https://api.tavily.com/search"
MAX_DAY_CR = 120.0
ACTIVE_WINDOW_DAYS = 7  # last baseline row within this many days

# A source whose day-wise table is a language split presented as India
# totals. Verified 2026-10-26/27: Bollywood Hungama's Jailer 2 table
# shows Day 1 Rs 2.56 Cr (Hindi version only) vs all-India ~Rs 59.70 Cr.
BLOCKED_DOMAINS = ("bollywoodhungama.com",)

# Poison words checked ONLY in a tight window around the figure
# (+/-100 chars), so a film's language in the article header, or a
# "Total India gross" line after the day-wise block, does not poison
# a clean day figure. "gross" is deliberately NOT here: totals sit
# adjacent to day blocks and would false-positive every TOI block.
SEGMENT_POISON = (
    "worldwide", "overseas", "version", "language",
    "hindi", "tamil", "telugu", "kannada", "malayalam",
    "opening", "weekend total", "week 1 total",
)

DAY_BLOCK_RE = re.compile(
    r"Day\s*(\d+)\s*(?:\[LIVE\]|\(LIVE\))?\s*[:|\-–]\s*"
    r"(?:Rs\.?|₹)\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr\.?)",
    re.IGNORECASE)
DAY_TABLE_RE = re.compile(
    r"Day\s*(\d+)\s*\|\s*(\d{1,2}-[A-Za-z]{3}-\d{4})[^|]*\|\s*"
    r"₹\s*([\d,]+(?:\.\d+)?)\s*cr",
    re.IGNORECASE)
DAY_PROSE_RE = re.compile(
    r"(?:Rs\.?|₹)\s*([\d,]+(?:\.\d+)?)\s*crore(?:\s+net)?"
    r"[^.;]{0,100}?\bDay\s*(\d+)\b",
    re.IGNORECASE)
DAY_PROSE_REV_RE = re.compile(
    r"\bDay\s*(\d+)\b[^.;]{0,100}?"
    r"(?:Rs\.?|₹)\s*([\d,]+(?:\.\d+)?)\s*crore",
    re.IGNORECASE)


def read_js_map(path):
    """Parse `window.VAR = {...};` into a dict. Returns {} if missing."""
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    start = raw.index("{")
    end = raw.rindex("}")
    return json.loads(raw[start:end + 1])


def write_json_if_changed(path, data):
    """Write deterministic JSON only when content differs."""
    content = json.dumps(data, ensure_ascii=False, indent=2,
                         sort_keys=True) + "\n"
    existing = ""
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            existing = f.read()
    if existing == content:
        return False
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return True


def today_strings(today):
    """Date spellings a result may use for today (IST)."""
    months_full = today.strftime("%B")
    months_abbr = today.strftime("%b")
    return {
        today.strftime("%d %B %Y"),          # 27 October 2026
        today.strftime("%d %b %Y"),           # 27 Oct 2026
        f"{today.day} {months_full} {today.year}",
        f"{today.day}th {months_full} {today.year}",
        f"{months_full} {today.day}, {today.year}",
        f"{months_abbr} {today.day}, {today.year}",
        today.strftime("%d-%b-%Y"),           # 27-Oct-2026
        today.strftime("%Y-%m-%d"),           # 2026-10-27
        today.strftime("%d %b"),              # 27 Oct
    }


def segment_of(text, start, end):
    """A tight +/-100 char window around a match, for scope checks."""
    return text[max(0, start - 100):min(len(text), end + 100)]


def extract_candidates(content):
    """Yield (day, crore, segment, row_date) candidates from one result's
    CONTENT only (never the title: headlines compress several figures —
    e.g. "earns Rs 3.15 crore ... worldwide gross nears Rs 34 crore" —
    and a day number in the title paired with a figure from the body is
    a cross-boundary misparse). row_date is set only for table rows,
    whose date is part of the row itself. Distinct occurrences of the
    same (day, figure) are separate candidates: a poisoned occurrence
    must not hide a clean one."""
    seen = set()

    def offer(day, cr, start, end, row_date):
        key = (day, cr, start)
        if key in seen:
            return None
        seen.add(key)
        return (day, cr, segment_of(content, start, end), row_date)

    out = []
    for m in DAY_BLOCK_RE.finditer(content):
        c = offer(int(m.group(1)), float(m.group(2).replace(",", "")),
                  m.start(), m.end(), None)
        if c:
            out.append(c)
    for m in DAY_TABLE_RE.finditer(content):
        row_date = None
        try:
            row_date = datetime.strptime(m.group(2), "%d-%b-%Y").date()
        except ValueError:
            row_date = None
        c = offer(int(m.group(1)), float(m.group(3).replace(",", "")),
                  m.start(), m.end(), row_date)
        if c:
            out.append(c)
    for m in DAY_PROSE_RE.finditer(content):
        c = offer(int(m.group(2)), float(m.group(1).replace(",", "")),
                  m.start(), m.end(), None)
        if c:
            out.append(c)
    for m in DAY_PROSE_REV_RE.finditer(content):
        c = offer(int(m.group(1)), float(m.group(2).replace(",", "")),
                  m.start(), m.end(), None)
        if c:
            out.append(c)
    return out


def tavily_search(query, keys):
    """POST one search to api.tavily.com. keys is a list of
    (slot, value) pairs tried in order; returns (data, slot_used).
    Raises the last error when every key fails."""
    last_err = None
    for slot, key in keys:
        body = json.dumps({
            "query": query,
            "search_depth": "basic",
            "max_results": 5,
            "include_answer": False,
        }).encode("utf-8")
        req = urllib.request.Request(
            TAVILY_URL, data=body, method="POST",
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer " + key})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read()), slot
        except Exception as e:  # 429/401/5xx/transport: try next key
            print(f"tavily: key slot {slot} failed "
                  f"({type(e).__name__}), trying next")
            last_err = e
    raise last_err


def pick_figure(results, expected_day, today, today_strs,
                yesterday_cr, existing_today_cr):
    """Pick today's India Net figure from Tavily results.

    Returns (crore, source_url, why) or (None, None, why)."""
    for res in results:
        url = res.get("url", "")
        title = res.get("title", "") or ""
        content = res.get("content", "") or ""
        host = url.lower()
        if any(b in host for b in BLOCKED_DOMAINS):
            continue
        # Date tie: the result must be about today. A day-tracker title
        # ("... Day 13 ...") counts; otherwise a today date string must
        # appear in the content.
        blob = title + "\n" + content
        blob_low = blob.lower()
        date_tied = any(s.lower() in blob_low for s in today_strs)
        title_tracker = bool(re.search(
            r"\bDay\s*" + str(expected_day) + r"\b", title))
        if not (date_tied or title_tracker):
            continue
        for day, cr, seg, row_date in extract_candidates(content):
            if day != expected_day:
                continue
            seg_low = seg.lower()
            if any(p in seg_low for p in SEGMENT_POISON):
                continue
            if not (0 < cr <= MAX_DAY_CR):
                continue
            # A table row carries its own date: it must be today.
            # (Block/prose candidates carry no per-figure date; a date
            # token in their window is usually the release date or the
            # article date, so it is NOT used to reject them.)
            if row_date is not None and row_date != today:
                continue
            # Sanity bands (gross-error guards only).
            if yesterday_cr and not (0.05 * yesterday_cr <= cr
                                     <= 4 * yesterday_cr):
                continue
            if existing_today_cr and cr < 0.5 * existing_today_cr:
                continue
            return cr, url, f"day {day} from {url}"
    return None, None, "no usable figure"


def main():
    ap = argparse.ArgumentParser(
        description="Tavily box-office gap-filler: refill + update "
                    "TODAY's India Net figure per movie (2x/day).")
    ap.add_argument("--stage", default=None,
                    help="staging dir (default: <root>/out/boxoffice-staging)")
    ap.add_argument("--root", default=None,
                    help="repo root (default: parent of this script's dir)")
    ap.add_argument("--today", default=None,
                    help="override run date YYYY-MM-DD (testing)")
    ap.add_argument("--fixture-dir", default=None,
                    help="testing only: read saved Tavily responses from "
                         "DIR/<tmdb_id>.json instead of calling the API")
    ap.add_argument("--dry-run", action="store_true",
                    help="print what it would write, write nothing")
    args = ap.parse_args()

    root = args.root or os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))
    staging_dir = args.stage or os.path.join(
        root, "out", "boxoffice-staging")
    if args.today:
        today = date.fromisoformat(args.today)
    else:
        now_ist = datetime.now(IST)
        today = now_ist.date()
        if now_ist.hour < 6:
            # Before 06:00 IST the box-office day is still yesterday:
            # figures for the new IST day do not exist yet, and the
            # 18:00 UTC run executes at ~00:30 IST. Target yesterday
            # so that run searches for the day that just ended (whose
            # evening trackers are published) instead of the day that
            # just began (whose figures exist nowhere).
            today = today - timedelta(days=1)
            print(f"tavily: early-morning IST run — targeting "
                  f"yesterday {today} (figures for {now_ist.date()} "
                  f"are not published yet)")
    today_strs = today_strings(today)

    pub = read_js_map(os.path.join(root, "js", "published-titles.js"))
    daywise = read_js_map(os.path.join(root, "js", "daywise-data.js"))
    print(f"tavily: today (IST) {today} ({today.strftime('%A')}), "
          f"{len(daywise)} movie(s) with day-wise rows")

    keys = []
    for slot, env in (("primary", "TAVILY_API_KEY"),
                      ("backup", "TAVILY_API_KEY_BACKUP")):
        val = os.environ.get(env, "").strip()
        if val:
            keys.append((slot, val))
    if not keys and not args.fixture_dir:
        print("tavily: SKIP — no TAVILY_API_KEY / TAVILY_API_KEY_BACKUP "
              "set (add the GitHub repo secrets); staging untouched")
        return 0

    staging = {}
    n_queried = n_written = 0
    for tid in sorted(daywise.keys(), key=lambda t: int(t)):
        rows = daywise.get(tid) or []
        if not rows:
            continue
        title = (pub.get(str(tid)) or {}).get("title")
        if not title:
            print(f"tavily: {tid}: SKIP — no published title")
            continue
        if (pub.get(str(tid)) or {}).get("type", "movie") != "movie":
            continue
        rows_sorted = sorted(
            rows, key=lambda r: int(re.sub(r"\D", "", str(r.get("day", "0"))) or 0))
        day1 = None
        for r in rows_sorted:
            try:
                day1 = date.fromisoformat(r["date"])
                break
            except (KeyError, ValueError):
                continue
        if day1 is None:
            print(f"tavily: {tid} {title}: SKIP — no Day 1 date")
            continue
        expected_day = (today - day1).days + 1
        if expected_day < 1:
            print(f"tavily: {tid} {title}: SKIP — not released yet")
            continue
        last_date = None
        for r in rows_sorted:
            try:
                last_date = date.fromisoformat(r["date"])
            except (KeyError, ValueError):
                continue
        if last_date and (today - last_date).days > ACTIVE_WINDOW_DAYS:
            print(f"tavily: {tid} {title}: SKIP — last row "
                  f"{last_date} is over {ACTIVE_WINDOW_DAYS}d old "
                  "(run ended)")
            continue
        # Yesterday's figure + today's existing figure (update guards).
        # day_before_cr guards the yesterday-gap fallback below.
        yesterday_cr = None
        existing_today_cr = None
        day_before_cr = None
        for r in rows_sorted:
            try:
                dnum = int(re.sub(r"\D", "", str(r.get("day", "0"))) or 0)
                cr = float(r.get("collection", 0)) * 94.65 / 1e7
            except (TypeError, ValueError):
                continue
            if dnum == expected_day - 2:
                day_before_cr = cr
            if dnum == expected_day - 1:
                yesterday_cr = cr
            if dnum == expected_day:
                existing_today_cr = cr
        # Query WITHOUT a date string (verified 2026-10-27): adding
        # "27 October 2026" to the query made results WORSE — Jailer 2
        # returned 2 results (Bollywood Hungama + a Facebook video)
        # instead of the 5-result TOI/Indian Express day-wise blocks
        # the dateless query returns. Day-wise articles are dated
        # yesterday, so a literal today-date in the query filters them
        # OUT. The date logic lives in pick_figure instead: a figure
        # must be tied to today (date string in the result, or a Day-N
        # tracker title) AND its day number must equal the expected day.
        query = f"{title} day-wise box office collection India net"
        n_queried += 1
        try:
            if args.fixture_dir:
                with open(os.path.join(args.fixture_dir,
                                       f"{tid}.json"),
                          encoding="utf-8") as f:
                    data = json.load(f)
                slot = "fixture"
            else:
                data, slot = tavily_search(query, keys)
                time.sleep(1)  # politeness between searches
        except FileNotFoundError:
            print(f"tavily: {tid} {title}: no fixture — skipped")
            continue
        except Exception as e:
            print(f"tavily: {tid} {title}: search failed "
                  f"({type(e).__name__}) — skipped")
            continue
        results = data.get("results", []) if isinstance(data, dict) else []
        cr, url, why = pick_figure(results, expected_day, today,
                                   today_strs, yesterday_cr,
                                   existing_today_cr)
        if cr is None and expected_day >= 2 and yesterday_cr is None:
            # Gap-fill: sources publish a day's figure the NEXT
            # morning, so today's tracker often does not exist yet at
            # run time. Fill a genuinely MISSING yesterday row from
            # the same results, with the same acceptance guards
            # (date-tied to yesterday, day must match, sanity bands).
            # Never fires when yesterday's row already exists.
            yday = today - timedelta(days=1)
            why_today = why
            cr, url, why = pick_figure(
                results, expected_day - 1, yday, today_strings(yday),
                day_before_cr, None)
            if cr is not None:
                staging[str(tid)] = [{
                    "day": expected_day - 1,
                    "date": yday.isoformat(),
                    "collection_inr_cr": round(cr, 2),
                    "source": "tavily",
                    "source_url": url,
                }]
                n_written += 1
                print(f"tavily: {tid} {title}: Day {expected_day - 1} "
                      f"(yesterday, gap-fill) Rs {cr:.2f} Cr "
                      f"(via {slot}) — {why}")
                continue
            why = f"today: {why_today}; yesterday: {why}"
        if cr is None:
            print(f"tavily: {tid} {title}: no usable figure "
                  f"(expected Day {expected_day}) — {why}")
            continue
        staging[str(tid)] = [{
            "day": expected_day,
            "date": today.isoformat(),
            "collection_inr_cr": round(cr, 2),
            "source": "tavily",
            "source_url": url,
        }]
        n_written += 1
        print(f"tavily: {tid} {title}: Day {expected_day} "
              f"Rs {cr:.2f} Cr (via {slot}) — {why}")

    print(f"tavily: queried {n_queried} movie(s), wrote "
          f"{n_written} figure(s) (today + yesterday gap-fills)")
    if args.dry_run:
        print("tavily: DRY-RUN — staging not written")
        print(json.dumps(staging, ensure_ascii=False, indent=2,
                         sort_keys=True))
        return 0
    path = os.path.join(staging_dir, "tavily.json")
    changed = write_json_if_changed(path, staging)
    print(f"tavily: staging {path} written: {changed} "
          f"({len(staging)} movie(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())

