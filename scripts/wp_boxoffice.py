#!/usr/bin/env python3
"""
wp_boxoffice.py — WordPress RSS box-office reader for FlickAtlas.

Reads day-wise INDIA NET collection figures (Rs Cr) from three WordPress
sites' RSS feeds + article pages:

  * tracktollywood      (https://tracktollywood.com/feed/)
  * flickonclick        (https://www.flickonclick.com/feed/)
  * bollymoviereviewz   (https://www.bollymoviereviewz.com/feed/)

Stdlib only. Uses a browser User-Agent on every request (TrackTollywood
blocks bare urllib with 403). Sleeps 1-2s between requests.

Output (stdout JSON + optional --out file):
  {"<tmdb_id>": [{"day": N, "date": "YYYY-MM-DD",
                  "collection_inr_cr": X.XX, "source": "<site-id>",
                  "estimate": true|false}, ...], ...}

Rules:
  * Only India Net day-wise figures. Worldwide gross / territory gross
    totals are NEVER emitted as day-wise rows.
  * A movie not in TITLE_MAP is skipped — never guess a TMDB id.
  * Ranges ("2 to 3 Crore") are skipped — never invent a figure.
  * Estimate rows (FlickOnClick "Around Rs X crore (estimate)") are
    emitted with "estimate": true so the averager can exclude them.
  * TrackTollywood has NO day-wise table (milestone/total articles only);
    its parser returns no rows and logs why.

Spike-tested 2026-10-26. Parse patterns found:
  * FlickOnClick: <table> with header "Day | India Net Collection |
    Occupancy"; rows "Day N (Weekday, Month D) | Rs X crore | ...".
  * BollyMovieReviewz: text "Box Office Collection Daywise" then
    "Day N:" (colon optional, case varies) / "X Crore nett Trade Figure"
    / optional "Y Crore nett Producer Figure" (Producer preferred —
    more precise); plus a current-day line "<Title> Box Office
    Collection Day N" followed by "X Crore nett Trade Figure".
    "Day 0 (Paid Previews)" is skipped. WARNING: some articles
    (e.g. 418) report the daywise in WORLDWIDE GROSS, not India Net —
    those yield no rows (scope guard).
  * TrackTollywood: no day-wise rows — articles give territory GROSS
    splits + worldwide total only.

Day-1 anchors below are Sacnilk's live Day 1 dates (from
js/daywise-data.js, verified 2026-10-26) — NOT TMDB release_date, which
can be a day off (Jailer 2: TMDB 14 Oct, Sacnilk Day 1 15 Oct).
"""

import argparse
import datetime as dt
import html as htmlmod
import http.cookiejar
import json
import re
import sys
import time
import urllib.request
import urllib.error

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
HEADERS = {"User-Agent": UA,
           "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
           "Accept-Language": "en-US,en;q=0.9"}
SLEEP = 1.5

# One opener for the whole run, with a cookie jar: BollyMovieReviewz sits
# behind Sucuri/Cloudproxy, which intermittently 307-challenges cookieless
# clients. Persisting its clearance cookie across requests + retrying a
# challenged fetch avoids flaky 307 failures.
_OPENER = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

SITES = [
    {"id": "tracktollywood",
     "rss": "https://tracktollywood.com/feed/",
     "name": "TrackTollywood"},
    {"id": "flickonclick",
     "rss": "https://www.flickonclick.com/feed/",
     "name": "FlickOnClick"},
    {"id": "bollymoviereviewz",
     "rss": "https://www.bollymoviereviewz.com/feed/",
     "name": "BollyMovieReviewz"},
]

# title fragment (lowercase) -> (tmdb_id, day1_anchor_date)
# Day-1 anchors = Sacnilk live Day 1 date per movie (verified 2026-10-26).
# Prahaar is deliberately ABSENT: it is not a published FlickAtlas title
# (no TMDB id in FA_PUBLISHED) — never guess an id.
TITLE_MAP = [
    ("jailer 2", ("1234139", "2026-10-15")),
    ("udta teer", ("1375156", "2026-10-23")),
    ("tu hai meri kiran", ("1785611", "2026-10-23")),
    ("pehla pyaar doosri baar", ("1772549", "2026-10-23")),
    ("clayface", ("1400940", "2026-10-19")),
    ("nayyi navelli", ("1654581", "2026-10-16")),
    ("ranabaali", ("1389379", "2026-10-16")),
    ("drishyam", ("1269325", "2026-10-02")),
    ("street fighter", ("1153576", "2026-10-13")),
    ("resident evil", ("1423191", "2026-09-16")),
    ("418", ("1606527", "2026-10-23")),
]

MONTHS = {m: i + 1 for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july",
     "august", "september", "october", "november", "december"])}

# Categories that mark an item as off-topic even if it mentions a movie.
OFFTOPIC_CATS = {"tattoo", "fashion", "finance", "ipo", "net worth",
                 "biography", "lifestyle", "tech"}


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def fetch(url):
    """GET with a browser UA via the shared cookie-jar opener. Follows
    redirects manually (up to 5 hops) and retries transient failures
    (307 WAF challenge / 429 / 5xx) up to 3 times with backoff."""
    last_err = None
    for attempt in range(3):
        cur = url
        for _ in range(6):
            req = urllib.request.Request(cur, headers=HEADERS)
            try:
                with _OPENER.open(req, timeout=25) as r:
                    return r.read().decode("utf-8", errors="ignore")
            except urllib.error.HTTPError as e:
                if e.code in (301, 302, 303, 307, 308):
                    loc = e.headers.get("Location")
                    if not loc:
                        last_err = e
                        break
                    cur = urllib.request.urljoin(cur, loc)
                    continue
                last_err = e
                break
            except urllib.error.URLError as e:
                last_err = e
                break
        if isinstance(last_err, urllib.error.HTTPError) and last_err.code in (307, 429, 500, 502, 503):
            log("  retry %s (HTTP %s) in %ss" % (url[:60], last_err.code, 2 * (attempt + 1)))
            time.sleep(2 * (attempt + 1))
            continue
        break
    if last_err is not None:
        raise last_err
    raise urllib.error.HTTPError(url, 310, "too many redirects", None, None)


def unesc(s):
    s = htmlmod.unescape(s or "").strip()
    s = s.replace("<![CDATA[", "").replace("]]>", "")
    return s.strip()


def parse_rss(xml):
    """Return [{title, link, pubdate, categories}] from an RSS 2.0 feed."""
    items = []
    for chunk in re.findall(r"<item>(.*?)</item>", xml, re.S | re.I):
        title = unesc(re.search(r"<title>(.*?)</title>", chunk, re.S | re.I).group(1)
                      if re.search(r"<title>(.*?)</title>", chunk, re.S | re.I) else "")
        link = unesc(re.search(r"<link>(.*?)</link>", chunk, re.S | re.I).group(1)
                     if re.search(r"<link>(.*?)</link>", chunk, re.S | re.I) else "")
        pub = unesc(re.search(r"<pubDate>(.*?)</pubDate>", chunk, re.S | re.I).group(1)
                    if re.search(r"<pubDate>(.*?)</pubDate>", chunk, re.S | re.I) else "")
        cats = [unesc(c) for c in re.findall(r"<category[^>]*>(.*?)</category>",
                                             chunk, re.S | re.I)]
        items.append({"title": title, "link": link, "pubdate": pub,
                      "categories": cats})
    return items


def is_box_office(site_id, item):
    title = item["title"].lower()
    cats = [c.lower() for c in item["categories"]]
    if any(oc in c for c in cats for oc in OFFTOPIC_CATS):
        return False, "off-topic category (%s)" % ", ".join(item["categories"])
    if any("box office" in c or "collection" in c for c in cats):
        return True, ""
    if "box office" in title or "collection" in title:
        return True, ""
    return False, "not a box-office item"


def identify_movie(title):
    """Match an article title to (tmdb_id, day1_anchor) or None."""
    t = re.sub(r"[^a-z0-9]+", " ", title.lower())
    t = " %s " % t
    for frag, info in TITLE_MAP:
        if " %s " % frag in t or t.startswith(" %s " % frag):
            return info
    # "418" needs a word-boundary match (it is a bare number)
    if re.search(r"\b418\b", title):
        return ("1606527", "2026-10-23")
    return None


def textify(html_text):
    """Strip scripts/styles/tags to newline-separated plain text."""
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html_text, flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", "\n", s)
    s = htmlmod.unescape(s)
    s = re.sub(r"[ \t]+", " ", s)
    lines = [ln.strip() for ln in s.split("\n")]
    return [ln for ln in lines if ln]


def parse_foc(html_text, year):
    """FlickOnClick: day-wise <table> (Day | India Net Collection |
    Occupancy | [Shows]). Column count varies (3 or 4), so detect the
    header row and the Day / India Net column indices dynamically.
    Returns [(day, date_str, value_cr, is_estimate)]."""
    rows = []
    for table in re.findall(r"<table.*?</table>", html_text, flags=re.S | re.I):
        trs = []
        for tr in re.findall(r"<tr.*?</tr>", table, flags=re.S | re.I):
            cells = [re.sub(r"<[^>]+>", "", c).strip()
                     for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>",
                                         tr, flags=re.S | re.I)]
            if cells:
                trs.append(cells)
        if not trs:
            continue
        header = [c.lower() for c in trs[0]]
        if header[0] != "day":
            continue
        try:
            val_col = next(i for i, c in enumerate(header) if "india net" in c)
        except StopIteration:
            continue
        for cells in trs[1:]:
            if len(cells) <= val_col:
                continue
            day_cell, val_cell = cells[0], cells[val_col]
            m = re.match(r"Day\s+(\d+)\s*\((?:\w+,\s*)?(\w+)\s+(\d+)\)", day_cell)
            if not m:
                continue  # skips "Week 1 total", "Total", "Opening weekend"
            day = int(m.group(1))
            month = MONTHS.get(m.group(2).lower())
            if not month:
                continue
            date = "%04d-%02d-%02d" % (year, month, int(m.group(3)))
            est = bool(re.search(r"around|estimate|awaited", val_cell, re.I))
            vm = re.search(r"([\d.]+)\s*crore", val_cell, re.I)
            if not vm:
                continue
            rows.append((day, date, float(vm.group(1)), est))
        if rows:
            return rows
    return rows


def parse_bmr(html_text, day1_anchor):
    """BollyMovieReviewz: daywise text section + current-day line.
    Returns ([(day, date_str, value_cr, False)], reason). Ranges are
    skipped. If the daywise section reports WORLDWIDE GROSS
    ('Worldwide: X Crore gross', e.g. 418) it is NOT India Net — the
    article yields no rows at all."""
    lines = textify(html_text)
    text = "\n".join(lines)
    out = {}

    def add(day, value):
        if value is None or day == 0:
            return
        d0 = dt.date.fromisoformat(day1_anchor) + dt.timedelta(days=day - 1)
        out[day] = (day, d0.isoformat(), round(float(value), 2), False)

    # 0. Scope guard: daywise section in worldwide gross, not India net.
    m = re.search(r"Box Office Collection Daywise(.*)", text, re.S)
    section = m.group(1) if m else ""
    if re.search(r"Day\s+\d+\s*:?\s*\n\s*Worldwide:", section):
        return [], "daywise section is worldwide gross, not India net"

    # 1. Daywise section.
    for dm in re.finditer(
            r"Day\s+(\d+)\s*:?\s*\n\s*([\d.]+)\s*Crore nett [Tt]rade [Ff]igure"
            r"(?:\s*\n\s*([\d.]+)\s*Crore nett [Pp]roducer [Ff]igure)?",
            section, re.I):
        day = int(dm.group(1))
        value = dm.group(3) or dm.group(2)  # Producer Figure if present
        add(day, value)

    # 2. Current-day line: "<Title> Box Office Collection Day N" followed
    #    by "X Crore nett Trade Figure" on the next line.
    for cm in re.finditer(
            r"Box Office Collection Day\s+(\d+)\s*\n\s*"
            r"([\d.]+(?:\s*to\s*[\d.]+)?)\s*Crore nett [Tt]rade [Ff]igure",
            text, re.I):
        day = int(cm.group(1))
        raw = cm.group(2)
        if "to" in raw:
            continue  # range estimate — never invent a figure
        if day not in out:
            add(day, raw)

    rows = sorted(out.values())
    return rows, ("" if rows else "no day-wise section found")


def parse_tt(html_text):
    """TrackTollywood: no day-wise table exists — articles report territory
    GROSS splits + worldwide total only. Returns [] (with a reason)."""
    # Try the other sites' patterns first, in case a future article has one.
    if parse_foc(html_text, 2026):
        return parse_foc(html_text, 2026), "table"
    return [], "no day-wise rows (milestone/total article: territory gross + worldwide total only)"


def process_site(site, out, report):
    sid = site["id"]
    log("[%s] fetching RSS %s" % (sid, site["rss"]))
    try:
        xml = fetch(site["rss"])
    except Exception as e:
        report[sid]["error"] = "RSS fetch failed: %s" % e
        return
    items = parse_rss(xml)
    report[sid]["feed_items"] = len(items)
    for item in items:
        ok, why = is_box_office(sid, item)
        if not ok:
            report[sid]["skipped"].append(
                {"title": item["title"][:90], "reason": why})
            continue
        movie = identify_movie(item["title"])
        if not movie:
            report[sid]["skipped"].append(
                {"title": item["title"][:90],
                 "reason": "movie not in TITLE_MAP (no TMDB id — never guess)"})
            continue
        tmdb_id, day1 = movie
        report[sid]["box_office_items"] += 1
        log("[%s] %s -> %s (%s)" % (sid, item["title"][:80], tmdb_id, item["link"]))
        time.sleep(SLEEP)
        try:
            html_text = fetch(item["link"])
        except Exception as e:
            report[sid]["skipped"].append(
                {"title": item["title"][:90], "reason": "article fetch failed: %s" % e})
            continue
        year = 2026
        pm = re.search(r"(20\d\d)", item["pubdate"] or "")
        if pm:
            year = int(pm.group(1))
        if sid == "flickonclick":
            rows = parse_foc(html_text, year)
            reason = "" if rows else "no day-wise India Net table found"
        elif sid == "bollymoviereviewz":
            rows, reason = parse_bmr(html_text, day1)
        else:  # tracktollywood
            rows, reason = parse_tt(html_text)
        if not rows:
            report[sid]["skipped"].append(
                {"title": item["title"][:90], "reason": reason})
            continue
        for day, date, value, est in rows:
            out.setdefault(tmdb_id, []).append(
                {"day": day, "date": date, "collection_inr_cr": value,
                 "source": sid, "estimate": bool(est)})
        report[sid]["rows"] += len(rows)
        report[sid]["parsed"].append(
            {"title": item["title"][:90], "tmdb_id": tmdb_id,
             "days": sorted(r[0] for r in rows)})


def main():
    ap = argparse.ArgumentParser(description="WordPress RSS box-office reader")
    ap.add_argument("--out", default="wp-boxoffice-output.json",
                    help="output JSON path")
    ap.add_argument("--site", default=None,
                    help="only run one site id (default: all three)")
    ap.add_argument("--stage", default=None, metavar="DIR",
                    help="also write per-source staging JSON files "
                         "(<DIR>/<source-id>.json, one per site) for the "
                         "multi-source averaging engine; deterministic "
                         "(only writes when changed)")
    ap.add_argument("--no-sleep", action="store_true",
                    help="skip inter-request sleeps (testing only)")
    args = ap.parse_args()
    global SLEEP
    if args.no_sleep:
        SLEEP = 0

    out, report = {}, {}
    for site in SITES:
        if args.site and site["id"] != args.site:
            continue
        report[site["id"]] = {"feed_items": 0, "box_office_items": 0,
                              "rows": 0, "parsed": [], "skipped": []}
        process_site(site, out, report)

    for tid in out:
        out[tid] = sorted(out[tid], key=lambda r: r["day"])
    with open(args.out, "w") as f:
        json.dump(out, f, indent=2)

    if args.stage:
        # Staging files for the multi-source averaging engine: one file
        # per source (filename = source id, the authoritative id). Split
        # the combined output by each row's "source" field. Deterministic
        # (sorted keys, no timestamps) so an unchanged file never
        # triggers a spurious pipeline commit.
        import os as _os
        _os.makedirs(args.stage, exist_ok=True)
        by_source = {}
        for tid, rows in out.items():
            for r in rows:
                sid = r.get("source") or "wordpress"
                by_source.setdefault(sid, {}).setdefault(tid, []).append(r)
        for sid, data in by_source.items():
            for tid in data:
                data[tid] = sorted(data[tid], key=lambda x: x["day"])
            stage_path = _os.path.join(args.stage, sid + ".json")
            stage_content = json.dumps(data, ensure_ascii=False, indent=2,
                                       sort_keys=True) + "\n"
            existing = ""
            if _os.path.exists(stage_path):
                with open(stage_path, encoding="utf-8") as f:
                    existing = f.read()
            if existing != stage_content:
                with open(stage_path, "w", encoding="utf-8") as f:
                    f.write(stage_content)
                n = sum(len(v) for v in data.values())
                log("staging %s written (%d row(s), %d movie(s))"
                    % (stage_path, n, len(data)))
            else:
                log("staging %s unchanged" % stage_path)

    print(json.dumps({"data": out, "report": report}, indent=2))
    log("\nWrote %s" % args.out)


if __name__ == "__main__":
    main()
