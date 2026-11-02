#!/usr/bin/env python3
"""Bollywood Hungama box-office page reader for FlickAtlas.

Why this exists (2026-11-02): the day-wise series for "Tum Mere Ho"
(TMDB 1806232, released 2026-10-23) froze at Day 7 (2026-10-29) even
though the pipeline ran fine and other titles (Jailer 2, Udta Teer)
stayed current. Diagnosis:

  * The ONLY source that has ever reported this title is Sacnilk
    (out/boxoffice-staging/sacnilk.json is the sole staging file with
    rows for it), and Sacnilk's own /movie/Tum_Mere_Ho_2026 table
    ENDS at Day 7 (stated total Rs0.48 Cr = the parsed sum). Its
    quicknews pages for Days 8-11 return 404. The reader ingests the
    page faithfully every gated run; the source itself stopped
    updating this micro-release after week 1.
  * Bollywood Hungama KEPT publishing: its day-wise table for the
    film runs to Day 10 (01-Nov-2026, Rs0.005 Cr) with an internally
    consistent Week 1 (Rs0.54 Cr) and lifetime (Rs0.55 Cr).
  * The pipeline could not see those figures: there was no direct
    Bollywood Hungama reader, and at the time the Tavily+Gemini lane
    excluded bollywoodhungama.com entirely. When Sacnilk drops a
    small title, no lane covers it and the freeze is silent.

This reader closes that hole the same way sacnilk_boxoffice.py did
for Sacnilk: go to the movie's BH box-office page directly, parse its
DAY WISE table (server-rendered HTML, HTTP 200 with a browser UA),
and stage the rows for the multi-source averaging engine
(scripts/multisource_boxoffice.py), which means them per movie+day
with every other source that reports the day. BH is also admissible
in the Tavily+Gemini lane (owner order 2026-11-02: Tavily + Gemini
is the primary box-office updater); the same table is never counted
twice because gemini_boxoffice.py re-attributes BH-sourced
candidates to this reader when it already reported the day.

Rules (site standing orders, same as the Sacnilk reader):
  * Numbers only from the live page — never invented, never
    interpolated. A figure BH prints as a RANGE is skipped and
    logged, never converted to a guessed point value.
  * Year/identity guard: BH hosts several films with the same name
    across years (its slug for this film is "tum-mere-ho-3"). A
    candidate page is accepted only when its parsed Day 1 date is
    within +/-7 days of the published release_date — the same anchor
    rule sacnilk_boxoffice.build_rows uses against slug collisions.
    A future wrong slug is a one-line SLUG_OVERRIDES addition.
  * Sub-lakh days are real data: BH prints amounts to 3 decimals
    (Day 8 of Tum Mere Ho is Rs0.001 Cr = Rs10,000). Rows keep 3
    decimals in staging. NOTE: multisource_boxoffice.finalize() must
    also keep 3 decimals (see the patched copy shipped with this
    reader) or a Rs0.001 Cr day rounds to Rs0.00 Cr and is lost.
  * Politeness: browser User-Agent, 2.5s between requests, 30s
    timeout, max 30 titles per run, newest releases first (same
    selection as the Sacnilk reader: sacnilk_boxoffice.needs_fetch).

Usage:
  bollywoodhungama_boxoffice.py             dry-run: print rows, write nothing
  bollywoodhungama_boxoffice.py --stage DIR write <DIR>/bollywoodhungama.json
  bollywoodhungama_boxoffice.py --out PATH  also write the staging JSON to PATH
  bollywoodhungama_boxoffice.py --only 1806232[,ID...]  restrict to TMDB ids
  bollywoodhungama_boxoffice.py --limit N   max titles per run (default 30)
  bollywoodhungama_boxoffice.py --today YYYY-MM-DD      override run date
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date, timedelta

# Sibling modules: the shared published-titles loader / row gate, and
# the Sacnilk reader whose needs_fetch selection + constants this
# reader deliberately mirrors (one selection policy for all direct
# readers). Same import pattern as the other pipeline scripts.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import boxoffice_extract
import sacnilk_boxoffice as sac

ROOT = sac.ROOT
BH_BASE = "https://www.bollywoodhungama.com/movie/"
USER_AGENT = sac.USER_AGENT
POLITE_DELAY = sac.POLITE_DELAY
FETCH_TIMEOUT = sac.FETCH_TIMEOUT
MAX_TITLES = sac.MAX_TITLES
SOURCE = "bollywoodhungama"

# Slug overrides (PERMANENT fix pattern, same as sacnilk_boxoffice):
# BH appends a disambiguation counter to same-name films
# ("tum-mere-ho-3" is the 2026 film; the bare slug and -2 are older
# films with the same name). Keyed by TMDB id. When an override is
# absent the reader probes base, base-2 .. base-5 and accepts the
# first page whose Day 1 date anchors to the published release date.
SLUG_OVERRIDES = {
    "1806232": "tum-mere-ho-3",  # Tum Mere Ho (2026)
}

MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun",
     "jul", "aug", "sep", "oct", "nov", "dec"])}

ROW_RE = re.compile(
    r"Day\s*(\d+)\s*</td>\s*<td[^>]*>.*?(\d{1,2})-([A-Za-z]{3})-(\d{4})"
    r".*?</td>\s*<td[^>]*>(.*?)</td>", re.S | re.I)
AMOUNT_RE = re.compile(r"([\d,]+(?:\.\d+)?)\s*cr", re.I)


def _summary_amount(html, label):
    """The INDIA BOX OFFICE summary table: '<label></a></td><td>…
    X.XX cr.</td>'. The amount is the first 'cr' figure within a
    short window after the label (the table cells are tight)."""
    m = re.search(re.escape(label) + r".{0,300}?([\d.]+)\s*cr",
                  html, re.S | re.I)
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


def slug_base(title):
    """'Tum Mere Ho' -> 'tum-mere-ho' (BH movie slug, before any
    disambiguation suffix)."""
    s = str(title or "").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return re.sub(r"-+", "-", s).strip("-")


def fetch_url(url):
    """Fetch a URL. Returns HTML text, or None on any failure —
    logged, never raises (same contract as sac.fetch_page)."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            return resp.read().decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        if e.code != 404:
            print(f"  bh: {url}: HTTP {e.code}, skipping")
        return None
    except Exception as e:  # noqa: BLE001 - a failed page never crashes
        print(f"  bh: {url}: fetch failed ({e}), skipping")
        return None


def _amount_cr(cell_html):
    """One Amount cell -> Rs Cr float, or None.

    The cell normally holds one point figure ('₹0.20 cr.'). A RANGE
    ('₹0.10 - 0.12 cr.') is NOT a point figure: return None so the
    caller skips and logs the day — a range is never guessed into a
    point value (site rule)."""
    text = re.sub(r"<[^>]+>", " ", cell_html)
    text = text.replace("&#8377;", " ").replace("₹", " ")
    if re.search(r"\d\s*[-–]\s*\d", text):
        return None
    m = AMOUNT_RE.search(text)
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", ""))
    except ValueError:
        return None


def parse_daywise(html):
    """BH movie box-office page -> ({day: (iso_date, crore)},
    stated_total_cr_or_None, stated_week1_cr_or_None).

    Only the table under the 'DAY WISE BOX OFFICE COLLECTION' heading
    is read. Returns ({}, None, None) when the section/table is
    absent. Days whose amount is a range are omitted (and counted by
    the caller via the returned skipped list — see parse notes in
    main)."""
    if not html:
        return {}, None, None
    i = html.find("DAY WISE BOX OFFICE COLLECTION")
    if i < 0:
        return {}, None, None
    seg = html[i:]
    j = seg.find("</table>")
    if j >= 0:
        seg = seg[:j]
    per_day = {}
    for m in ROW_RE.finditer(seg):
        day = int(m.group(1))
        mon = MONTHS.get(m.group(3).lower()[:3])
        if mon is None:
            continue
        try:
            d = date(int(m.group(4)), mon, int(m.group(2)))
        except ValueError:
            continue
        cr = _amount_cr(m.group(5))
        if cr is None or cr <= 0:
            print(f"  bh: Day {day}: amount missing/range — skipped")
            continue
        per_day[day] = (d.isoformat(), round(cr, 3))
    return (per_day,
            _summary_amount(html, "Total Collection"),
            _summary_amount(html, "End of Week 1"))


def anchor_ok(per_day, rel_date):
    """Year/identity guard: the page's Day 1 must fall within +/-7
    days of the published release date (same rule as
    sacnilk_boxoffice.build_rows). BH's same-name older films fail
    this by years, so a wrong slug can never leak in."""
    if not per_day or 1 not in per_day:
        return False
    try:
        day1 = date.fromisoformat(per_day[1][0])
    except ValueError:
        return False
    return abs((day1 - rel_date).days) <= 7


def resolve_page(entry, rel_date):
    """Find this film's BH page. Returns (slug, per_day,
    stated_total, stated_week1) or (None, None, None, None).
    Override first; otherwise probe the bare slug and the -2..-5
    disambiguation suffixes, accepting the first page that passes
    the anchor guard."""
    tid = entry["tmdb_id"]
    override = SLUG_OVERRIDES.get(tid)
    candidates = [override] if override else []
    base = slug_base(entry["title"])
    if base:
        candidates += [base] + [f"{base}-{n}" for n in range(2, 6)]
    seen = set()
    for slug in candidates:
        if not slug or slug in seen:
            continue
        seen.add(slug)
        html = fetch_url(BH_BASE + slug + "/box-office/")
        time.sleep(POLITE_DELAY)
        if html is None:
            continue
        per_day, total, week1 = parse_daywise(html)
        if not per_day:
            continue
        if not anchor_ok(per_day, rel_date):
            print(f"  bh: {entry['title']}: {slug} Day 1 "
                  f"{per_day.get(1, ('?',))[0]} != release {rel_date} "
                  f"— different film, rejecting")
            continue
        return slug, per_day, total, week1
    return None, None, None, None


def build_staging_rows(entry, per_day):
    """per_day -> staging rows in the multi-source contract shape.
    The page's own date is used when it agrees with release+day-1
    (within 1 day); otherwise the computed date wins and the swap is
    logged (same rule as sacnilk_boxoffice.build_rows)."""
    rel = date.fromisoformat(entry["release_date"])
    rows = []
    for day in sorted(per_day):
        date_s, cr = per_day[day]
        computed = rel + timedelta(days=day - 1)
        use = date_s
        try:
            parsed = date.fromisoformat(date_s)
        except ValueError:
            parsed = None
        if parsed is None or abs((parsed - computed).days) > 1:
            if parsed is not None:
                print(f"  bh: {entry['title']} Day {day}: page date "
                      f"{date_s} != release+{day - 1} {computed}, "
                      f"using computed")
            use = computed.isoformat()
        rows.append({"day": int(day), "date": use,
                     "collection_inr_cr": round(float(cr), 3),
                     "source": SOURCE})
    return rows


def check_stated(per_day, total, week1, title):
    """Integrity warnings (never blocking — same posture as
    sacnilk_boxoffice.check_stated_totals). BH rounds to 2-3
    decimals, so allow Rs0.02 Cr of rounding slack."""
    if week1 is not None and all(d in per_day for d in range(1, 8)):
        s = round(sum(per_day[d][1] for d in range(1, 8)), 3)
        if abs(s - week1) > 0.02:
            print(f"  bh: {title}: days 1-7 sum Rs{s:.3f} Cr != "
                  f"stated Week 1 Rs{week1:.2f} Cr (WARNING)")
    if total is not None and per_day:
        s = round(sum(v[1] for v in per_day.values()), 3)
        # The stated total may include days BH has not itemised yet;
        # only warn when the itemised sum EXCEEDS it materially.
        if s - total > 0.02:
            print(f"  bh: {title}: itemised sum Rs{s:.3f} Cr exceeds "
                  f"stated total Rs{total:.2f} Cr (WARNING)")


def main():
    ap = argparse.ArgumentParser(
        description="Bollywood Hungama box-office page reader: "
                    "stage day-wise India Net rows for the "
                    "multi-source averaging engine.")
    ap.add_argument("--stage", default=None, metavar="DIR",
                    help="write the per-source staging JSON "
                         "(<DIR>/bollywoodhungama.json)")
    ap.add_argument("--out", default=None, metavar="PATH",
                    help="also write the staging JSON to this path")
    ap.add_argument("--only", default=None,
                    help="comma-separated TMDB ids to restrict to")
    ap.add_argument("--limit", type=int, default=MAX_TITLES,
                    help="max titles to fetch per run (default 30)")
    ap.add_argument("--root", default=ROOT, help="repo root")
    ap.add_argument("--today", default=None,
                    help="override run date YYYY-MM-DD (testing)")
    args = ap.parse_args()
    today = (date.fromisoformat(args.today) if args.today
             else date.today())
    root = args.root
    only = None
    if args.only:
        only = {x.strip() for x in args.only.split(",") if x.strip()}

    published = boxoffice_extract.load_published(root)
    daywise = sac.read_js_map(
        os.path.join(root, "js", "daywise-data.js"), "FA_DAYWISE")
    entries = sorted(published.values(),
                     key=lambda e: e.get("release_date") or "",
                     reverse=True)
    print(f"bh: {len(entries)} published movies, today "
          f"{today.isoformat()}, limit {args.limit}")

    staged = {}
    fetched = 0
    for entry in entries:
        if fetched >= args.limit:
            print(f"bh: limit {args.limit} reached, stopping")
            break
        tid = entry["tmdb_id"]
        if only is not None and tid not in only:
            continue
        # Same selection policy as the Sacnilk reader: only titles
        # whose day-wise data is missing/incomplete for their age.
        need, why = sac.needs_fetch(entry, daywise.get(tid), today)
        if not need:
            if only is not None:
                print(f"  skip {entry['title']} ({tid}): {why}")
            continue
        try:
            rel = date.fromisoformat(
                (entry.get("release_date") or "").strip())
        except ValueError:
            continue
        print(f"bh: {entry['title']} ({tid}, {rel}): {why}")
        slug, per_day, total, week1 = resolve_page(entry, rel)
        if slug is None:
            print(f"  bh: {entry['title']}: no BH page passed the "
                  f"anchor guard, skipping")
            continue
        check_stated(per_day, total, week1, entry["title"])
        rows = build_staging_rows(entry, per_day)
        print(f"  bh: {entry['title']}: {slug}: {len(rows)} day(s) "
              f"staged")
        if rows:
            staged[tid] = rows
        fetched += 1

    for tid in staged:
        staged[tid].sort(key=lambda r: r["day"])
    content = json.dumps(staged, ensure_ascii=False, indent=2,
                         sort_keys=True) + "\n"
    n = sum(len(v) for v in staged.values())
    wrote = []
    for path in ([os.path.join(args.stage, "bollywoodhungama.json")]
                 if args.stage else []) + ([args.out] if args.out
                                           else []):
        os.makedirs(os.path.dirname(os.path.abspath(path)),
                    exist_ok=True)
        existing = ""
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                existing = f.read()
        if existing == content:
            print(f"bh: staging {path} unchanged")
            continue
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        wrote.append(path)
    print(f"bh: {n} row(s), {len(staged)} movie(s); "
          f"written: {wrote if wrote else 'nothing (dry-run)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
