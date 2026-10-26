#!/usr/bin/env python3
"""Sacnilk box-office page reader for FlickAtlas.

Why this exists (2026-10-26): the box-office day-wise data in
js/daywise-data.js only had rows for 2 titles, because the pipeline
only extracts figures from ARTICLES (scripts/boxoffice_extract.py over
Gemini-written articles) — and articles are sparse: most days are never
reported as a single-day figure, and the two rows the pipeline did
produce were bogus (Ramayana Day 1 pre-sales; Drishyam Day 24 with
date "2026-00-00", fixed in commit f4b159f2).

The user pointed out the real gap: every movie's details and box
office collections ARE on Sacnilk's website — people write them
manually on web pages — but our RSS/sitemap sources only give
ARTICLES, and sometimes a site's RSS isn't even available. So this
reader goes to the web pages directly.

Spike-verified 2026-10-26 (parent): Sacnilk movie pages are fetchable
(HTTP 200, ~2s, no bot-block) at https://www.sacnilk.com/movie/
<Title>_<Year>. The day-wise figures live in "collection-cards"
<div>/<ol> containers as `Day N <date> Rs<figure> Cr <label>` (one
container per language version). Parsing is 100% accurate: for Jailer
2 the 44 extracted entries (4 versions x 11 days) sum per version to
exactly the page's own stated totals (Rs279.30 / Rs75.25 / Rs38.55 /
Rs5.60 Cr).

What it does (once a day, gated step in .github/workflows/
hourly-pipeline.yml):
  - Reads FA_PUBLISHED (js/published-titles.js), movies only.
  - Fetches the Sacnilk page for each title that NEEDS it (day-wise
    data missing or incomplete for its age, released within the last
    90 days) — never a title with complete data up to today, never an
    unreleased or very old title.
  - Sums the language versions per day (the total across languages is
    the film's day-wise net collection), converts Rs crore -> USD at
    94.65, and merges into js/daywise-data.js using the SAME rules as
    apply-auto.py section 2 (same film+day updates only when the value
    differs, otherwise append, days sorted, never zero/missing).
  - Every row passes boxoffice_extract.validate_box_row() at the
    merge (the last gate) — advance/pre-sales, invalid date, future
    date, unreleased film — and every rejection is logged.

Politeness / resilience: a browser User-Agent, 2.5s between requests,
30s timeout per fetch, max 30 titles per run. A 404 (no Sacnilk page
for the title) or a page with no day-wise cards is logged and skipped
— never a crash. A title is skipped, not retried, on any failure.

Usage:
  sacnilk_boxoffice.py            dry-run (default): print the rows it
                                  would write, write nothing.
  sacnilk_boxoffice.py --apply    write js/daywise-data.js.
  sacnilk_boxoffice.py --slug X_Y_2026
                                  fetch one Sacnilk slug (testing).
  sacnilk_boxoffice.py --limit N  max titles per run (default 30).
  sacnilk_boxoffice.py --today YYYY-MM-DD
                                  override the run date (testing).
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import date, timedelta

# Sibling module: the shared box-office row gate (validate_box_row) and
# the published-titles loader. Same pattern as gemini_batch.py /
# apply-auto.py.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import boxoffice_extract

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SACNILK_BASE = "https://www.sacnilk.com/movie/"
QUICKNEWS_BASE = "https://www.sacnilk.com/quicknews/"
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
              "AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/120.0 Safari/537.36")
POLITE_DELAY = 2.5      # seconds between requests
FETCH_TIMEOUT = 30      # seconds per fetch
MAX_TITLES = 30         # max titles fetched per run
RECENT_WINDOW_DAYS = 90  # only titles released within the last 90 days
EXPECTED_CAP_DAYS = 45   # a theatrical run rarely reports beyond 45 days
INR_PER_USD = 94.65      # site FA_RATES — same as boxoffice_extract

# Slug overrides (PERMANENT fix, 2026-10-26): Sacnilk's slug for a
# film is not always what slugify() builds from the TMDB title.
# Sacnilk names franchise films by their series number and language
# ("Drishyam 3" -> Drishyam_3_Hindi_2026), while TMDB titles them by
# their subtitle ("Drishyam: The Conclusion" -> slugify gives
# Drishyam_The_Conclusion_2026, which 404s). Keyed by TMDB id; the
# fetch path uses the override when present (both the /movie/ page
# and the quicknews page — the quicknews slug is the same base).
# A future wrong slug is a one-line addition here, not a code change.
# Verified 2026-10-26: Drishyam_3_Hindi_2026 returns HTTP 200 with
# day-wise cards on /movie/ and the Box Office Summary table on
# /quicknews/ Day 24.
SLUG_OVERRIDES = {
    "1269325": "Drishyam_3_Hindi_2026",  # Drishyam: The Conclusion
}

# The daywise header is byte-identical to apply-auto.py's ON PURPOSE:
# both writers must emit the same header, or the file flip-flops
# between two headers on every hourly run (a spurious diff + deploy).
DAYWISE_HEADER = (
    "/* FlickAtlas — day-wise box office data. GENERATED by the "
    "auto-pipeline (scripts/gemini_batch.py + scripts/apply-auto.py) "
    "from reconciled post data — do not edit by hand. Keyed by TMDB "
    "movie id; collection = India Net USD for the day; overseas = "
    "overseas gross USD for the day when reported; shows / occupancy "
    "/ tickets = India figures for the day when reported. */")

# --- Sacnilk page parsing ----------------------------------------------
# Day-wise cards live in <ol class="dw-days" id="collection-cards-N">
# (one container per language version). Inside a card the text reads
# "Day 1 15 Oct 2026 Rs43.35 Cr Excellent" — the date after Day 1
# carries no year, so the year is inferred from the Day 1 date (or the
# release year). Tags are stripped first: in the raw HTML the day, the
# date and the figure sit in separate spans, so a regex over raw HTML
# never matches.
CONTAINER_RE = re.compile(
    r'<ol[^>]*id="collection-cards-\d+"[^>]*>(.*?)</ol>', re.S)
DAY_PAT = re.compile(
    r"Day\s+(\d+)\s+(\d{1,2}\s+\w+(?:\s+\d{4})?)\s+"
    r"₹([\d,]+\.?\d*)\s*Cr")
STATED_TOTAL_RE = re.compile(r"Net Collection ₹([\d,]+\.?\d*)\s*Cr")
MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun",
     "jul", "aug", "sep", "oct", "nov", "dec"])}


def slugify(title, year):
    """Title + release year -> Sacnilk movie slug.
    'Jailer 2' (2026) -> 'Jailer_2_2026'.
    'Drishyam: The Conclusion' (2026) -> 'Drishyam_The_Conclusion_2026'.
    Runs of underscores (from stripped punctuation) collapse to one."""
    s = str(title or "").replace(" ", "_")
    s = re.sub(r"[^A-Za-z0-9_]", "", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return f"{s}_{year}" if s else ""


def fetch_page(slug):
    """Fetch a Sacnilk movie page. Returns the HTML text, or None on
    404 / any failure — logged, never raises."""
    url = SACNILK_BASE + slug
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            return resp.read().decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print(f"  sacnilk: {slug}: 404 (no Sacnilk page), skipping")
        else:
            print(f"  sacnilk: {slug}: HTTP {e.code}, skipping")
        return None
    except Exception as e:
        print(f"  sacnilk: {slug}: fetch failed ({e}), skipping")
        return None


def parse_daywise(html):
    """A Sacnilk movie page -> (per_day, versions, stated_totals).
    per_day: {day: (date_str, total_crore)} summed across the language
      versions (the total across languages is the film's day-wise net).
    versions: [(n_days, total_crore)] per language version, page order.
    stated_totals: [crore] the page's own per-version totals, in order.
    Returns (None, [], []) when the page has no day-wise cards."""
    containers = CONTAINER_RE.findall(html)
    if not containers:
        return None, [], []
    versions = []
    per_day = defaultdict(float)
    per_day_date = {}
    for c in containers:
        text = re.sub(r"<[^>]+>", " ", c)
        text = re.sub(r"\s+", " ", text)
        days = DAY_PAT.findall(text)
        if not days:
            continue
        total = 0.0
        for day_s, date_s, cr_s in days:
            day = int(day_s)
            cr = float(cr_s.replace(",", ""))
            total += cr
            per_day[day] += cr
            # first-seen date string for the day (all versions agree)
            per_day_date.setdefault(day, date_s)
        versions.append((len(days), total))
    if not versions:
        return None, [], []
    full_text = re.sub(r"<[^>]+>", " ", html)
    full_text = re.sub(r"\s+", " ", full_text)
    stated = [float(x.replace(",", ""))
              for x in STATED_TOTAL_RE.findall(full_text)]
    per_day_out = {d: (per_day_date[d], per_day[d])
                   for d in sorted(per_day)}
    return per_day_out, versions, stated


# --- Quicknews page (live current day + advance booking) --------------
# The /movie/ page's day-wise cards only list COMPLETED days — the
# current day's figure is a live running estimate that Sacnilk updates
# through the day, and it lives on the per-day quicknews page instead:
#   /quicknews/<slug>_Box_Office_Collection_Day_<N>
# That page carries a "Box Office Summary" table (Day 1..N, each with a
# figure and a "Live" marker on the current day) AND a sentence
# "Advance booking for Day <N+1> (<date>) of <Title> stands at
# Rs<X> Cr gross as of <time>" — the next day's advance figure.
# The quicknews table is the FRESHER source for the current day; the
# /movie/ cards remain the source for completed days. Advance figures
# are NEVER merged into day-wise rows — they go to js/advance-data.js.
SUMMARY_DAY_RE = re.compile(
    r"Day\s+(\d+)\s+(\d{1,2}\s+\w+(?:\s+\d{4})?)\s+\([^)]*\)\s+"
    r"₹([\d,]+\.?\d*)\s*Cr(?:\s+Live)?")
# Overseas-standing paragraph (data-sn-para="overseas-standing") on a
# quicknews day page. Day 2+ states the DAY figure; Day 1 states the
# cumulative total, which IS the Day 1 figure (no earlier day exists).
OVERSEAS_DAY_RE = re.compile(
    r"Overseas, the film collected ₹([\d,]+\.?\d*)\s*Cr on Day\s+(\d+), "
    r"taking its total overseas gross to ₹([\d,]+\.?\d*)\s*Cr")
OVERSEAS_DAY1_RE = re.compile(
    r"Overseas, the film has grossed a total of ₹([\d,]+\.?\d*)\s*Cr "
    r"in gross collections")
# Box Office Summary table, second rendering: Day N date (weekday)
# ₹XCr <shows> <occupancy>% — the first rendering has no shows
# number, so this pattern matches only the shows rendering.
SUMMARY_SHOWS_RE = re.compile(
    r"Day\s+(\d+)\s+(\d{1,2}\s+\w+(?:\s+\d{4})?)\s+\([^)]*\)\s+"
    r"₹([\d,]+\.?\d*)\s*Cr\s+([\d,]{4,})\s+([\d.]+)%")
ADVANCE_RE = re.compile(
    r"Advance booking for Day\s+(\d+)\s+\(([^)]+)\)[^₹]*?"
    r"₹([\d,]+\.?\d*)\s*Cr\s+gross", re.I)
ADVANCE_HEADER = (
    "/* FlickAtlas — advance booking data. GENERATED by the Sacnilk "
    "reader (scripts/sacnilk_boxoffice.py) from Sacnilk quicknews "
    "pages — do not edit by hand. Keyed by TMDB movie id; each entry "
    "is a future day's advance-booking gross in USD. Advance figures "
    "are NOT day-wise collections. */")


def fetch_quicknews(slug, day):
    """Fetch a Sacnilk quicknews day page. Returns HTML or None."""
    url = (QUICKNEWS_BASE + slug +
           f"_Box_Office_Collection_Day_{int(day)}")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            return resp.read().decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        if e.code != 404:
            print(f"  sacnilk: quicknews {slug} Day {day}: HTTP {e.code}")
        return None
    except Exception as e:
        print(f"  sacnilk: quicknews {slug} Day {day}: fetch failed ({e})")
        return None


def parse_quicknews(html):
    """A quicknews day page -> (per_day, advance, extras).
    per_day: {day: (date_str, total_crore)} from the Box Office Summary
      table (all days listed, current day marked Live).
    advance: (day, date_str, crore) from the 'Advance booking for
      Day N ... stands at RsX Cr gross' sentence, or None.
    extras: {day: {"overseas_inr_cr": X, "shows": N,
      "occupancy_pct": Y}} — overseas from the overseas-standing
      sentence (the page's day figure; the Day-1 phrasing carries the
      cumulative total, which IS the Day 1 figure, keyed to None for
      the caller to assign the page's day), shows + occupancy from
      the summary table's second rendering (all days listed).
    Returns ({}, None, {}) when the page has no summary table."""
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"\s+", " ", text)
    per_day = {}
    for day_s, date_s, cr_s in SUMMARY_DAY_RE.findall(text):
        day = int(day_s)
        if day not in per_day:
            per_day[day] = (date_s, float(cr_s.replace(",", "")))
    advance = None
    m = ADVANCE_RE.search(text)
    if m:
        advance = (int(m.group(1)), m.group(2).strip(),
                   float(m.group(3).replace(",", "")))
    extras = {}
    for day_s, _date_s, _cr_s, shows_s, occ_s in \
            SUMMARY_SHOWS_RE.findall(text):
        day = int(day_s)
        slot = extras.setdefault(day, {})
        try:
            slot["shows"] = int(shows_s.replace(",", ""))
        except ValueError:
            pass
        try:
            slot["occupancy_pct"] = round(float(occ_s), 1)
        except ValueError:
            pass
    m = OVERSEAS_DAY_RE.search(text)
    if m:
        day = int(m.group(2))
        extras.setdefault(day, {})["overseas_inr_cr"] = float(
            m.group(1).replace(",", ""))
    else:
        m1 = OVERSEAS_DAY1_RE.search(text)
        if m1:
            extras.setdefault(None, {})["overseas_inr_cr"] = float(
                m1.group(1).replace(",", ""))
    return per_day, advance, extras


def parse_advance_date(date_s, today):
    """'Tue 27 Oct' -> date. The year is today's year; if that lands in
    the past, it is next year (advance booking is always future)."""
    parts = str(date_s or "").replace(",", "").split()
    if len(parts) < 2:
        return None
    try:
        # drop a leading weekday token ("Tue")
        if parts[0].lower()[:3] in MONTHS or not parts[0][0].isdigit():
            parts = parts[1:]
        if len(parts) < 2:
            return None
        day = int(parts[0])
        mon = MONTHS.get(parts[1][:3].lower())
        if not mon:
            return None
        d = date(today.year, mon, day)
        if d < today:
            try:
                d = date(today.year + 1, mon, day)
            except ValueError:
                return None
        return d
    except (ValueError, IndexError):
        return None


def check_stated_totals(title, versions, stated):
    """Soft integrity check: each version's parsed sum should equal the
    page's own stated total for that version. A mismatch is a warning
    only (the rows are still used) — it means the page layout changed
    or a card was missed. Skipped when the counts differ (the page may
    carry extra 'Net Collection' mentions outside the day-wise cards)."""
    if len(stated) != len(versions):
        print(f"  sacnilk: {title}: stated totals ({len(stated)}) != "
              f"versions ({len(versions)}), skipping total check")
        return
    for i, ((n, total), st) in enumerate(zip(versions, stated)):
        if abs(total - st) > 0.01:
            print(f"  sacnilk: {title}: version {i + 1} sum "
                  f"Rs{total:.2f} Cr != stated Rs{st:.2f} Cr (WARNING)")


def parse_day_date(date_s, year_hint):
    """'15 Oct 2026' or '16 Oct' -> date. The year comes from year_hint
    (the Day 1 date's year, else the release year)."""
    parts = str(date_s or "").replace(",", "").split()
    if len(parts) < 2:
        return None
    try:
        day = int(parts[0])
        mon = MONTHS.get(parts[1][:3].lower())
        if not mon:
            return None
        year = int(parts[2]) if len(parts) > 2 else year_hint
        return date(year, mon, day)
    except (ValueError, IndexError):
        return None


def build_rows(entry, per_day, url, today, extras=None):
    """per_day {day: (date_str, total_crore)} -> box rows in the shape
    apply-auto.py merges: {tmdb_id, film, day, date, collection_usd,
    collection_inr_crore, sources, article_url}.
    extras: optional {day: {"overseas_inr_cr", "shows",
    "occupancy_pct"}} (staging keys) from the quicknews page — attached
    to the matching day's row, never invented for other days.
    Date = release_date + (day-1) (same rule as boxoffice_extract.py);
    the page's parsed date is used when it agrees (within 1 day) — when
    it disagrees by more, the computed date wins and a warning is
    logged. When Day 1's parsed date is more than 7 days from the
    release date, the page is probably a DIFFERENT film (slug
    collision) — the whole title is skipped, not guessed.
    Rows are NOT validated here; the merge is the single gate (same as
    apply-auto.py)."""
    rel_s = (entry.get("release_date") or "").strip()
    try:
        rel_date = date.fromisoformat(rel_s)
    except ValueError:
        return []
    # Year hint from the Day 1 date string when it carries one.
    year_hint = rel_date.year
    if 1 in per_day:
        m = re.search(r"\b(\d{4})\b", per_day[1][0])
        if m:
            year_hint = int(m.group(1))
    # Anchor check: Day 1's parsed date must be near the release date.
    anchor = parse_day_date(per_day[1][0], year_hint) if 1 in per_day else None
    if anchor is not None and abs((anchor - rel_date).days) > 7:
        print(f"  sacnilk: {entry['title']}: Day 1 on page is {anchor}, "
              f"release is {rel_date} — probably a different film, "
              f"skipping title")
        return []
    # The page's dates are usually offset from the release date by a
    # fixed few days (a Hollywood film's Indian release lags the global
    # one). That offset is consistent across days, so warn ONCE per
    # title instead of once per day.
    offset = (anchor - rel_date).days if anchor is not None else 0
    if abs(offset) > 1:
        print(f"  sacnilk: {entry['title']}: page Day 1 is {anchor}, "
              f"release is {rel_date} (offset {offset:+d}d) — using "
              f"release+day-1 dates")
    rows = []
    for day in sorted(per_day):
        date_s, crore = per_day[day]
        computed = rel_date + timedelta(days=day - 1)
        parsed = parse_day_date(date_s, year_hint)
        if (parsed is not None and anchor is not None
                and parsed < anchor and day > 1):
            # crossed New Year: the day falls in the following year
            try:
                parsed = date(parsed.year + 1, parsed.month, parsed.day)
            except ValueError:
                parsed = None
        use_date = computed
        if parsed is not None and abs(offset) <= 1:
            if abs((parsed - computed).days) <= 1:
                use_date = parsed
            else:
                print(f"  sacnilk: {entry['title']} Day {day}: parsed "
                      f"date {parsed} != release+{day - 1} {computed}, "
                      f"using computed")
        rows.append({
            "tmdb_id": entry["tmdb_id"],
            "film": entry["title"],
            "day": int(day),
            "date": use_date.isoformat(),
            "collection_usd": round(float(crore) * 1e7 / INR_PER_USD),
            "collection_inr_crore": round(float(crore), 2),
            "sources": ["Sacnilk"],
            "article_url": url,
        })
        if extras:
            ex = extras.get(day)
            if ex:
                for k in ("overseas_inr_cr", "shows", "occupancy_pct"):
                    if k in ex:
                        rows[-1][k] = ex[k]
    return rows


def needs_fetch(entry, existing_rows, today):
    """Does this title need a Sacnilk fetch? A title needs it when its
    day-wise data is missing or incomplete (fewer days than expected
    for its age), or it is recent and may have a new day. Titles with
    complete data up to today are skipped, as are unreleased titles and
    titles released more than RECENT_WINDOW_DAYS ago (theatrical run
    long over; the site's freshness rule is 3 months).
    LIVE-DAY REFRESH (2026-10-26): Sacnilk's figure for the CURRENT day
    is a running estimate that it updates through the day (Udta Teer
    Day 4 was captured at Rs96 lakh in the morning, Sacnilk later
    reported Rs2.13 Cr). So a title whose latest row is dated TODAY is
    always re-fetched — the merge only overwrites when the value
    differs, so a re-fetch is harmless when nothing changed."""
    rel_s = (entry.get("release_date") or "").strip()
    if not rel_s:
        return False, "no release date"
    try:
        rel = date.fromisoformat(rel_s)
    except ValueError:
        return False, "unparseable release date"
    if rel > today:
        return False, "unreleased"
    age = (today - rel).days
    if age > RECENT_WINDOW_DAYS:
        return False, f"released {age}d ago (outside {RECENT_WINDOW_DAYS}d window)"
    expected = min(age + 1, EXPECTED_CAP_DAYS)
    have_days = set()
    latest_date = None
    for r in (existing_rows or []):
        try:
            have_days.add(int(re.sub(r"\D", "", str(r.get("day", "0"))) or 0))
        except ValueError:
            pass
        d = (r.get("date") or "").strip()
        if d and (latest_date is None or d > latest_date):
            latest_date = d
    if latest_date == today.isoformat():
        return True, (f"today's figure is live (latest row "
                      f"{latest_date}) — refresh")
    missing = [d for d in range(1, expected + 1) if d not in have_days]
    if not missing:
        return False, f"complete ({len(have_days)}/{expected} days)"
    return True, (f"incomplete ({len(have_days)}/{expected} days, "
                  f"missing {len(missing)})")


# --- js map read/write (verbatim from apply-auto.py) --------------------
# Copied, not imported: apply-auto.py is a script (hyphenated name),
# and the merge below must emit byte-identical output to it.

def read_js_map(path, var):
    """Parse `window.VAR = {...};` into a dict. Returns {} if missing."""
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    start = raw.index("{")
    end = raw.rindex("}")
    return json.loads(raw[start:end + 1])


def write_js_map(path, var, data, header):
    content = (header + f"\nwindow.{var} = " +
               json.dumps(data, ensure_ascii=False, indent=2) + ";\n")
    existing = ""
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            existing = f.read()
    if existing == content:
        return False
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return True


# Staging-key extras -> daywise-data.js keys. Overseas is stored in
# staging as Rs Cr and converted to USD here (same rate as India Net).
EXTRA_DAYWISE = (("overseas_inr_cr", "overseas", "crore"),
                 ("shows", "shows", "int"),
                 ("occupancy_pct", "occupancy", "pct"),
                 ("tickets", "tickets", "int"))


def row_extras_daywise(row):
    """A build row's staging-key extras -> {daywise_key: value}."""
    out = {}
    for skey, dkey, kind in EXTRA_DAYWISE:
        if skey not in row:
            continue
        try:
            v = float(row[skey])
        except (TypeError, ValueError):
            continue
        if v <= 0:
            continue
        if kind == "crore":
            out[dkey] = round(v * 1e7 / INR_PER_USD)
        elif kind == "int":
            out[dkey] = int(round(v))
        else:
            out[dkey] = round(v, 1)
    return out


def merge_daywise(daywise, rows, by_tmdb, today):
    """Merge validated rows into the FA_DAYWISE map, using the SAME
    rules as apply-auto.py section 2: a row for an unpublished tmdb_id
    is rejected; every row passes validate_box_row() (the last gate);
    the same film+day UPDATES only when the value differs, otherwise
    the row is appended and the days are sorted; never zero/missing.
    Returns (added, updated, changes) where changes is a list of
    (tmdb_id, day, collection_usd, 'new'|'updated')."""
    added, updated = 0, 0
    changes = []
    for row in rows:
        tid = str(row.get("tmdb_id") or "").strip()
        day = row.get("day")
        if not tid or not day:
            continue
        pub = by_tmdb.get(tid)
        if pub is None:
            print(f"  sacnilk: row rejected ({tid} Day {day}): "
                  f"film not published")
            continue
        # The merge is the LAST gate — a bogus row must never be
        # written here even if the parser let it through.
        ok, reason = boxoffice_extract.validate_box_row(row, pub,
                                                        article=None,
                                                        today=today)
        if not ok:
            print(f"  sacnilk: row rejected ({pub['title']} "
                  f"Day {day}): {reason}")
            continue
        rows_list = daywise.setdefault(tid, [])
        ex = row_extras_daywise(row)
        entry = {"date": row.get("date") or "",
                 "day": f"Day {int(day)}",
                 "collection": int(row.get("collection_usd") or 0)}
        entry.update(ex)
        hit = None
        for r in rows_list:
            if r.get("day") == entry["day"]:
                hit = r
                break
        if hit is not None:
            changed = False
            if hit.get("collection") != entry["collection"]:
                hit["collection"] = entry["collection"]
                hit["date"] = entry["date"]
                changed = True
            for k, v in ex.items():
                if hit.get(k) != v:
                    hit[k] = v
                    changed = True
            if changed:
                updated += 1
                changes.append((tid, int(day), entry["collection"],
                                "updated"))
        else:
            rows_list.append(entry)
            rows_list.sort(key=lambda r: int(
                re.sub(r"\D", "", r.get("day", "0")) or 0))
            added += 1
            changes.append((tid, int(day), entry["collection"], "new"))
    return added, updated, changes


def write_stage(stage_dir, rows, by_tmdb, today):
    """Write the per-source staging JSON for the multi-source averaging
    engine (scripts/multisource_boxoffice.py):
        {tmdb_id: [{day, date, collection_inr_cr, source: "sacnilk"}]}
    Only rows that pass the SAME gates as merge_daywise (published +
    validate_box_row) are included, so the staging file never carries
    a figure the merge would have rejected. Deterministic (sorted,
    no timestamps) so an unchanged file never triggers a spurious
    pipeline commit. Returns True when the file was written."""
    staged = {}
    for row in rows:
        tid = str(row.get("tmdb_id") or "").strip()
        pub = by_tmdb.get(tid)
        if pub is None:
            continue
        ok, _reason = boxoffice_extract.validate_box_row(
            row, pub, article=None, today=today)
        if not ok:
            continue
        day = row.get("day")
        if not isinstance(day, int) or day < 1:
            continue
        entry = {"day": int(day),
                 "date": row.get("date") or "",
                 "collection_inr_cr": round(
                     float(row.get("collection_inr_crore") or 0), 2),
                 "source": "sacnilk"}
        for k in ("overseas_inr_cr", "shows", "occupancy_pct",
                  "tickets"):
            if k in row:
                entry[k] = row[k]
        staged.setdefault(tid, []).append(entry)
    for tid in staged:
        staged[tid].sort(key=lambda r: r["day"])
    os.makedirs(stage_dir, exist_ok=True)
    path = os.path.join(stage_dir, "sacnilk.json")
    content = json.dumps(staged, ensure_ascii=False, indent=2,
                         sort_keys=True) + "\n"
    existing = ""
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            existing = f.read()
    if existing == content:
        print(f"sacnilk: staging {path} unchanged")
        return False
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    n = sum(len(v) for v in staged.values())
    print(f"sacnilk: staging {path} written ({n} row(s), "
          f"{len(staged)} movie(s))")
    return True


def main():
    ap = argparse.ArgumentParser(
        description="Sacnilk box-office page reader: fetch each "
                    "published movie's Sacnilk page and merge its "
                    "day-wise collections into js/daywise-data.js.")
    ap.add_argument("--apply", action="store_true",
                    help="write js/daywise-data.js (default: dry-run)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the rows it would write, write nothing "
                         "(default)")
    ap.add_argument("--stage", default=None, metavar="DIR",
                    help="also write the per-source staging JSON "
                         "(<DIR>/sacnilk.json) for the multi-source "
                         "averaging engine; does not change the "
                         "--apply behaviour")
    ap.add_argument("--limit", type=int, default=MAX_TITLES,
                    help="max titles to fetch per run (default 30)")
    ap.add_argument("--root", default=ROOT, help="repo root")
    ap.add_argument("--today", default=None,
                    help="override run date YYYY-MM-DD (testing)")
    ap.add_argument("--slug", default=None,
                    help="fetch a single Sacnilk slug (testing); "
                         "ignores the needs-check")
    args = ap.parse_args()
    today = (date.fromisoformat(args.today) if args.today
             else date.today())
    root = args.root
    do_write = args.apply and not args.dry_run

    published = boxoffice_extract.load_published(root)
    by_tmdb = {e["tmdb_id"]: e for e in published.values()}
    day_path = os.path.join(root, "js", "daywise-data.js")
    daywise = read_js_map(day_path, "FA_DAYWISE")

    # Newest first: if the per-run cap binds, the newest titles
    # (the ones still in theatres) get fetched first.
    entries = sorted(published.values(),
                     key=lambda e: e.get("release_date") or "",
                     reverse=True)
    print(f"sacnilk: {len(entries)} published movies, "
          f"today {today.isoformat()}, limit {args.limit}")

    all_rows = []
    advance = {}
    fetched, skipped_404, skipped_nodata = 0, 0, 0
    for entry in entries:
        if fetched >= args.limit:
            print(f"sacnilk: limit {args.limit} reached, stopping")
            break
        tid = entry["tmdb_id"]
        title = entry["title"]
        rel = (entry.get("release_date") or "").strip()
        year = rel[:4] if len(rel) >= 4 else ""
        if args.slug:
            slug = args.slug
            url = SACNILK_BASE + slug
            print(f"sacnilk: --slug {slug} (testing, needs-check skipped)")
        else:
            need, why = needs_fetch(entry, daywise.get(tid), today)
            if not need:
                print(f"  skip {title} ({tid}): {why}")
                continue
            slug = SLUG_OVERRIDES.get(tid) or slugify(title, year)
            if not slug:
                print(f"  skip {title} ({tid}): empty slug")
                continue
            url = SACNILK_BASE + slug
            print(f"sacnilk: {title} ({tid}, {rel}): {why} -> {slug}")
        html = fetch_page(slug)
        time.sleep(POLITE_DELAY)
        if html is None:
            skipped_404 += 1
            if args.slug:
                break
            continue
        per_day, versions, stated = parse_daywise(html)
        if per_day is None:
            print(f"  sacnilk: {title}: no day-wise cards on page, "
                  f"skipping")
            skipped_nodata += 1
            if args.slug:
                break
            continue
        check_stated_totals(title, versions, stated)
        # Quicknews: the live current-day figure (and the next day's
        # advance booking). The /movie/ cards only list completed days;
        # the current day's live figure is on the quicknews Day_N page.
        # Only the current day is overlaid from quicknews (it is the
        # fresher source for that day); completed days keep the
        # verified /movie/ card values, and quicknews fills any gap.
        # LIVE-DAY FIX (2026-10-26): cur_day comes from Sacnilk's own
        # Day 1 date (the anchor), NOT from the TMDB release_date in
        # published-titles.js. TMDB's date can be the global/premiere
        # date while Sacnilk's Day 1 is the Indian theatrical release:
        # Jailer 2's TMDB date is 2026-10-14 but Sacnilk Day 1 is
        # 2026-10-15, so the old release-based cur_day was 13 (tomorrow,
        # 404) instead of 12 (today) and the live figure was missed.
        # Same off-by-N hits Clayface (+4d) and Street Fighter (+3d).
        # The anchor is the parsed Day 1 date from the /movie/ page we
        # just fetched; fall back to the release date only when the
        # page has no Day 1. (build_rows uses the same anchor rule.)
        anchor = None
        if 1 in per_day:
            year_hint = today.year
            m = re.search(r"\b(\d{4})\b", per_day[1][0])
            if m:
                year_hint = int(m.group(1))
            try:
                anchor = parse_day_date(per_day[1][0], year_hint)
            except Exception:
                anchor = None
        base = anchor
        if base is None:
            try:
                base = date.fromisoformat(rel)
            except ValueError:
                base = None
        cur_day = (today - base).days + 1 if base is not None else None
        qn_extras = {}
        if anchor is not None and rel and anchor != date.fromisoformat(rel):
            print(f"  sacnilk: {title}: Day 1 anchor {anchor} != "
                  f"release {rel} — quicknews day from anchor")
        if cur_day is not None and cur_day >= 1:
            qn_html = fetch_quicknews(slug, cur_day)
            time.sleep(POLITE_DELAY)
            if qn_html is not None:
                qn_per_day, qn_adv, qn_extras = parse_quicknews(qn_html)
                # The Day-1 overseas phrasing carries the cumulative
                # total (which IS the Day 1 figure) with no day in the
                # sentence — it belongs to this page's day.
                if None in qn_extras and cur_day is not None:
                    qn_extras.setdefault(cur_day, {}).update(
                        qn_extras.pop(None))
                for d, v in qn_per_day.items():
                    if d not in per_day or d == cur_day:
                        per_day[d] = v
                if qn_per_day:
                    print(f"  sacnilk: {title}: quicknews Day {cur_day} "
                          f"table has {len(qn_per_day)} day(s)")
                    if cur_day not in qn_per_day:
                        print(f"  sacnilk: {title}: quicknews Day "
                              f"{cur_day} table has NO row for today "
                              f"({today.isoformat()}) — figure not "
                              f"published yet")
                else:
                    print(f"  sacnilk: {title}: quicknews Day {cur_day} "
                          f"has no summary table — today "
                          f"({today.isoformat()}) not published yet")
                if qn_adv is not None:
                    adv_day, adv_date_s, adv_cr = qn_adv
                    adv_date = parse_advance_date(adv_date_s, today)
                    if adv_date is not None and adv_date > today:
                        adv_rows = advance.setdefault(tid, [])
                        adv_entry = {
                            "date": adv_date.isoformat(),
                            "day": f"Day {adv_day}",
                            "collection": round(float(adv_cr) * 1e7
                                              / INR_PER_USD),
                        }
                        if not any(r.get("day") == adv_entry["day"]
                                   for r in adv_rows):
                            adv_rows.append(adv_entry)
                            adv_rows.sort(key=lambda r: r.get("date", ""))
                            print(f"  sacnilk: {title}: advance "
                                  f"Day {adv_day} ({adv_date.isoformat()}) "
                                  f"Rs{adv_cr:.2f} Cr")
            else:
                # VISIBLE missing-today log (2026-10-26): a failed
                # quicknews fetch used to be silent, so a missing today
                # looked like "no data" instead of "not published yet".
                # fetch_quicknews already prints the HTTP status.
                print(f"  sacnilk: {title}: quicknews Day {cur_day} "
                      f"unavailable — today ({today.isoformat()}) not "
                      f"on quicknews; /movie/ cards only")
        rows = build_rows(entry, per_day, url, today, extras=qn_extras)
        print(f"  sacnilk: {title}: {len(rows)} rows from "
              f"{len(versions)} language version(s), "
              f"{len(per_day)} days")
        all_rows.extend(rows)
        fetched += 1
        if args.slug:
            break

    added, updated, changes = merge_daywise(daywise, all_rows, by_tmdb,
                                            today)
    print(f"sacnilk: fetched {fetched} page(s), {skipped_404} 404/failed, "
          f"{skipped_nodata} no day-wise cards; "
          f"merge: +{added} new, {updated} updated")
    for tid, day, coll, kind in changes:
        name = by_tmdb.get(tid, {}).get("title", tid)
        print(f"  {kind}: {name} ({tid}) Day {day} ${coll:,}")
    if args.stage and not args.dry_run:
        write_stage(args.stage, all_rows, by_tmdb, today)
    if not do_write:
        print("sacnilk: DRY-RUN — nothing written")
        return 0
    changed = write_js_map(day_path, "FA_DAYWISE", daywise, DAYWISE_HEADER)
    print(f"sacnilk: daywise-data.js written: {changed}")
    # Advance booking is a separate file (never mixed into day-wise).
    # Merge with any existing advance entries (keep days already stored
    # for other titles; replace this run's titles wholesale).
    adv_path = os.path.join(root, "js", "advance-data.js")
    existing_adv = read_js_map(adv_path, "FA_ADVANCE")
    for tid, rows in advance.items():
        existing_adv[tid] = rows
    # Drop advance entries whose date has passed (they are now a
    # day-wise collection, not an advance figure).
    for tid in list(existing_adv):
        kept = [r for r in existing_adv[tid]
                if (r.get("date") or "") > today.isoformat()]
        if kept:
            existing_adv[tid] = kept
        else:
            del existing_adv[tid]
    adv_changed = write_js_map(adv_path, "FA_ADVANCE", existing_adv,
                               ADVANCE_HEADER)
    print(f"sacnilk: advance-data.js written: {adv_changed} "
          f"({len(existing_adv)} title(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())





