#!/usr/bin/env python3
"""
filmibeat_boxoffice.py — Filmibeat RSS box-office reader for FlickAtlas.

Reads day-wise INDIA NET collection figures (Rs Cr) from Filmibeat's
category RSS feeds (Bollywood, Tamil, Telugu) + article pages.

IMPORTANT SCOPE NOTE — Filmibeat re-reports Sacnilk's data ("According to
Sacnilk" in every article). Its day-wise India Net figures match Sacnilk
almost exactly (verified 2026-10-26 on 10 live articles: Jailer 2 D9/D10/
D11, Ranabaali D1-D10, Udta Teer D1-D3 all exact). It is a SECONDARY
source, NOT an independent measurement — averaging it with Sacnilk
double-counts the same underlying data. One real divergence found:
418 D2 2.40 / D3 1.85 vs Sacnilk 2.50 / 2.50 (Filmibeat likely used an
earlier Sacnilk snapshot). The reader emits what Filmibeat reports; the
averaging engine decides what to do with it.

Stdlib only. Browser User-Agent on every request. Sleeps 1.5s between
article fetches.

Parse model (spike-tested 2026-10-26 on 10 live articles):
  * No <table> day-wise tables — figures live in prose.
  * Recap articles ("Day N Box Office Collection", published the day
    after Day N) state the Day N figure in the lead paragraph:
      "earned an estimated Rs X crore net in India on Day N"
      "collected an estimated Rs X crore net on Day N"
      "Rs X crore earned on Day N"
      "moving up from Rs Y crore on Day N-1 to Rs X crore on Day N"
  * Recap articles also narrate earlier days as a weekday walk from the
    opening date ("opened with Rs X crore net on October 15. After
    collecting Rs Y crore on Friday, October 16, it registered Rs Z
    crore on Saturday ..."), which yields backfill rows.
  * Early-update articles ("Day N Early Update") give only PARTIAL
    current-day figures ("Rs 96 lakh by 4 PM", "Rs 5.13 cr net so far
    today") — those are NEVER emitted; only completed days' figures
    stated in recap sentences are used.
  * Language/territory articles ("(Hindi)", "Tamil Nadu", "Telugu
    States", "Karnataka") and "Prediction" / "Budget" / "Target" /
    "Hit or Flop" articles are skipped entirely.
  * "Rs Xcr" and "Rs X crore" formats both handled; "lakh" figures are
    partial/language-breakdown only and never match the patterns.

Output (stdout JSON + optional --out / --stage):
  {"<tmdb_id>": [{"day": N, "date": "YYYY-MM-DD",
                  "collection_inr_cr": X.XX, "source": "filmibeat",
                  "estimate": false}, ...], ...}

Rules (same as the other readers):
  * Only India Net day-wise figures. Worldwide gross / territory gross
    totals are NEVER emitted as day-wise rows.
  * A movie not in TITLE_MAP is skipped — never guess a TMDB id.
  * Ranges ("Rs 3-4cr") and predictions are skipped — never invent.
  * Early-update partial-day figures are skipped, never flagged as
    estimates (a partial is not an estimate of the full day).

Day-1 anchors below are Sacnilk's live Day 1 dates (from
js/daywise-data.js, verified 2026-10-26) — NOT TMDB release_date, which
can be a day off (Jailer 2: TMDB 14 Oct, Sacnilk Day 1 15 Oct).
"""

import argparse
import datetime as dt
import email.utils
import html as htmlmod
import json
import os
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
SOURCE = "filmibeat"

FEEDS = [
    {"id": "bollywood",
     "rss": "https://www.filmibeat.com/rss/feeds/bollywood-fb.xml"},
    {"id": "tamil",
     "rss": "https://www.filmibeat.com/rss/feeds/tamil-fb.xml"},
    {"id": "telugu",
     "rss": "https://www.filmibeat.com/rss/feeds/telugu-fb.xml"},
]

# title fragment (lowercase) -> (tmdb_id, day1_anchor_date)
# Day-1 anchors = Sacnilk live Day 1 date per movie (verified 2026-10-26).
# Ramayana is deliberately ABSENT: upcoming, no published day-wise rows.
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
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday",
            "saturday", "sunday"]
MONTH_RE = ("(January|February|March|April|May|June|July|August|September|"
            "October|November|December)")
WD_RE = "(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)"
# "Rs 8.1cr", "Rs 25.70 crore", "₹2.90 crore", "Rs. 4.10 cr"
AMT_RE = r"(?:₹|Rs\.?\s*)([\d.]+)\s*(?:crore|cr)\b"
# A single character that is NOT a sentence-ending period: a period
# followed by whitespace ends a sentence, but a decimal point (e.g. the
# "." in "76.8%" or "Rs 5.40") does not. Using [^.] here would break
# spans that cross a decimal point, so walk/P3 spans use SENT instead.
SENT = r"(?:(?!\.\s).)"

# Titles that are never day-wise box office, even if they mention a movie.
SKIP_TITLE_RES = [
    r"prediction", r"advance booking", r"\bbudget\b", r"\btarget\b",
    r"hit or flop", r"tamil nadu", r"\(hindi\)", r"telugu states",
    r"karnataka", r"trailer", r"review", r"ott release", r"\badvance\b",
    r"early prediction",
]


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def fetch(url):
    """GET with a browser UA. Retries transient failures up to 3 times."""
    last_err = None
    for attempt in range(3):
        req = urllib.request.Request(url, headers=HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                return r.read().decode("utf-8", errors="ignore")
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (429, 500, 502, 503):
                log("  retry %s (HTTP %s) in %ss"
                    % (url[:60], e.code, 2 * (attempt + 1)))
                time.sleep(2 * (attempt + 1))
                continue
            break
        except urllib.error.URLError as e:
            last_err = e
            break
    if last_err is not None:
        raise last_err
    raise urllib.error.URLError("fetch failed: %s" % url)


def unesc(s):
    s = htmlmod.unescape(s or "").strip()
    s = s.replace("<![CDATA[", "").replace("]]>", "")
    return s.strip()


def parse_rss(xml):
    """Return [{title, link, pubdate}] from an RSS 2.0 feed."""
    items = []
    for chunk in re.findall(r"<item>(.*?)</item>", xml, re.S | re.I):
        def _f(tag):
            m = re.search(r"<%s>(.*?)</%s>" % (tag, tag), chunk, re.S | re.I)
            return unesc(m.group(1)) if m else ""
        items.append({"title": _f("title"), "link": _f("link"),
                      "pubdate": _f("pubDate")})
    return items


def parse_pubdate(s):
    """RSS pubDate -> datetime.date (IST). Returns None on failure."""
    try:
        dtm = email.utils.parsedate_to_datetime(s)
        if dtm is None:
            return None
        if dtm.tzinfo is not None:
            dtm = dtm.astimezone(dt.timezone(dt.timedelta(hours=5, minutes=30)))
        return dtm.date()
    except Exception:
        return None


def is_box_office(title):
    t = title.lower()
    for pat in SKIP_TITLE_RES:
        if re.search(pat, t):
            return False, "skip-title (%s)" % pat
    if "box office" in t or "collection" in t:
        return True, ""
    return False, "not a box-office item"


def identify_movie(title):
    """Match an article title to (tmdb_id, day1_anchor) or None.
    When several movies match, the one named FIRST in the title is the
    subject -- comparison movies come later ("Udta Teer ... Beats
    Jailer 2 Hindi Figure" is about Udta Teer, not Jailer 2). Pick the
    earliest match position; TITLE_MAP order breaks ties."""
    t = re.sub(r"[^a-z0-9]+", " ", title.lower())
    t = " %s " % t
    best = None  # (position, TITLE_MAP order, info)
    for order, (frag, info) in enumerate(TITLE_MAP):
        pos = t.find(" %s " % frag)
        if pos == -1:
            continue
        if best is None or pos < best[0] or (pos == best[0] and order < best[1]):
            best = (pos, order, info)
    if best is not None:
        return best[2]
    if re.search(r"\b418\b", title):
        return ("1606527", "2026-10-23")
    return None


def title_day(title):
    m = re.search(r"\bDay\s+(\d+)\b", title, re.I)
    return int(m.group(1)) if m else None


def textify(html_text):
    """Strip scripts/styles/tags to newline-separated plain text."""
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html_text, flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", "\n", s)
    s = htmlmod.unescape(s)
    s = re.sub(r"[ \t]+", " ", s)
    lines = [ln.strip() for ln in s.split("\n")]
    return "\n".join(ln for ln in lines if ln)


def sentence_around(text, pos):
    """Rough sentence containing position pos. Sentence boundaries are a
    period followed by whitespace (or end of text) — NOT a decimal point
    (the "." in "Rs 5.40" or "76.8%" is followed by a digit). The
    textified body separates HTML blocks with newlines, so a sentence
    ends with ".\\n", not ". " — both are covered by \\.\\s."""
    start = 0
    for m in re.finditer(r"\.\s", text[:pos]):
        start = m.end()
    m = re.search(r"\.\s", text[pos:])
    end = pos + m.end() if m else len(text)
    return text[start:end]


def _day_for_date(date, anchor):
    """Calendar date -> day number (1-based) from the Day-1 anchor."""
    return (date - anchor).days + 1


def _nth_weekday(anchor, weekday, n):
    """The n-th occurrence (1-based) of weekday on/after the anchor date.
    weekday: 0=Mon..6=Sun."""
    d = anchor
    while d.weekday() != weekday:
        d += dt.timedelta(days=1)
    return d + dt.timedelta(days=7 * (n - 1))


def _recent_weekday_before(target_date, weekday):
    """Most recent occurrence of weekday strictly before target_date."""
    d = target_date - dt.timedelta(days=1)
    while d.weekday() != weekday:
        d -= dt.timedelta(days=1)
    return d


def _recent_weekday_on_or_before(target_date, weekday):
    """Most recent occurrence of weekday on or before target_date."""
    d = target_date
    while d.weekday() != weekday:
        d -= dt.timedelta(days=1)
    return d


def parse_article(html_text, title, pubdate, tmdb_id, day1_anchor):
    """Extract [(day, date_str, value_cr)] India Net day-wise rows from
    one Filmibeat article body. Returns (rows, reasons)."""
    anchor = dt.date.fromisoformat(day1_anchor)
    tday = title_day(title)
    if tday is not None:
        target_date = anchor + dt.timedelta(days=tday - 1)
    elif pubdate is not None:
        target_date = pubdate
        tday = _day_for_date(pubdate, anchor)
    else:
        target_date = anchor
        tday = 1
    if tday < 1:
        return [], "target day < 1 (article predates Day 1)"

    text = textify(html_text)
    # candidate day -> (value, priority, how); lower priority number wins
    found = {}

    def add(day, value, prio, how):
        if day is None or value is None:
            return
        if day < 1 or day > tday:
            return
        try:
            v = round(float(value), 2)
        except (TypeError, ValueError):
            return
        if v <= 0 or v > 120:
            return  # single-day India Net cap (engine backstop is 120 Cr)
        day = int(day)
        if day in found and found[day][1] <= prio:
            return
        found[day] = (v, prio, how)

    # ---- P1: explicit "on Day N" figures (highest priority) ----
    p1_res = [
        # "earned an estimated Rs 25.70 crore net in India on Day 11"
        re.compile(r"(?:earned|collected|recorded|made)\s+(?:an estimated\s+)?"
                   + AMT_RE + r"\s+crore net (?:in India )?on Day (\d+)", re.I),
        # "Rs 14.50 crore earned on Day 9"
        re.compile(AMT_RE + r"\s+earned on Day (\d+)", re.I),
        # "made a collection of Rs 3.15cr on day 11"
        re.compile(r"(?:made|earned|collected)" + SENT + r"{0,50}?"
                   + AMT_RE + SENT + r"{0,40}?on [Dd]ay (\d+)", re.I),
        # "(day 3) and earned Rs 8.1cr" (opening-weekend article)
        re.compile(r"\(day (\d+)\)" + SENT + r"{0,100}?(?:earned|collected|made|recorded)"
                   + SENT + r"{0,50}?" + AMT_RE, re.I),
    ]
    for rx in p1_res:
        for m in rx.finditer(text):
            sent = sentence_around(text, m.start())
            if re.search(r"likely|expected|prediction|forecast", sent, re.I):
                continue
            if rx is p1_res[3]:
                day, val = int(m.group(1)), m.group(2)
            elif rx is p1_res[1]:
                val, day = m.group(1), int(m.group(2))
            elif rx is p1_res[2]:
                val, day = m.group(1), int(m.group(2))
            else:
                val, day = m.group(1), int(m.group(2))
            add(day, val, 1, "p1-explicit-day")

    # ---- P2: rise pattern "from Rs Y crore on Day N-1 to Rs X on Day N" ----
    for m in re.finditer(
            r"from " + AMT_RE + r" on Day (\d+) to "
            + AMT_RE + r" on Day (\d+)", text, re.I):
        add(int(m.group(2)), m.group(1), 2, "p2-rise-prev")
        add(int(m.group(4)), m.group(3), 2, "p2-rise")

    # ---- P7: opening figures -> Day 1 ----
    open_res = [
        # "opened with Rs 59.70 crore net on October 15"
        re.compile(r"opened with " + AMT_RE + r" net on "
                   + MONTH_RE + r" (\d+)", re.I),
        # "opened in theatres on October 16 with an estimated India net
        #  collection of Rs 9.25 crore"
        re.compile(r"opened in theatres on " + MONTH_RE + r" (\d+) with "
                   r"(?:an estimated )?India net collection of "
                   + AMT_RE, re.I),
        # "began its theatrical run with Rs 9.25 crore net on October 16"
        re.compile(r"began (?:its )?theatrical run with " + AMT_RE
                   + r" net on " + MONTH_RE + r" (\d+)", re.I),
        # "made a collection of Rs 4.1cr on opening day"
        re.compile(r"made a collection of " + AMT_RE
                   + SENT + r"{0,30}?on opening day", re.I),
        # "opened its box office run with a decent Rs 4.10 cr" /
        # "began its theatrical run with a decent opening of Rs 4.10 cr"
        re.compile(r"(?:opened|began)" + SENT + r"{0,100}?" + AMT_RE, re.I),
    ]
    for rx in open_res:
        for m in rx.finditer(text):
            sent = sentence_around(text, m.start())
            if rx is open_res[4] and not re.search(
                    r"decent|net|collection", sent, re.I):
                continue
            if rx is open_res[0]:
                val = m.group(1)
            elif rx is open_res[1]:
                val = m.group(3)
            elif rx is open_res[2]:
                val = m.group(1)
            else:
                val = m.group(1)
            add(1, val, 3, "p7-opening")

    # ---- P5: possessive weekday figures ----
    # Possessive: "Sunday's Rs 2.90 crore collection" / "Friday's
    # collection of Rs 2.10 crore" -> most recent such weekday on/before
    # the target date.
    for m in re.finditer(
            WD_RE + r"'s\s+(?:collection of\s+)?" + AMT_RE, text, re.I):
        sent = sentence_around(text, m.start())
        if re.search(r"gross|worldwide|overseas|footfall", sent, re.I):
            continue
        wd = WEEKDAYS.index(m.group(1).lower())
        d = _recent_weekday_on_or_before(target_date, wd)
        add(_day_for_date(d, anchor), m.group(2), 4, "p5-possessive")

    # ---- Walk: weekday-only mentions, resolved in DOCUMENT order ----
    # Walk-A: amount ... "on <Weekday>" -- the amount is the NEAREST one
    # before the weekday in the SAME sentence ("Rs 14.50 crore on
    # Friday"; "Rs 2.80 crore on Saturday"). Looking back (rather than
    # matching the first amount in a span) matters when a sentence has
    # two amounts: "Rs 17.15 crore, followed by Rs 14.50 crore on
    # Friday" -- the Friday figure is 14.50, not 17.15.
    # Walk-B: "<Weekday> ... <verb> amount" -- ("on Sunday, collecting
    # Rs 8.20 cr net"; "The second Thursday brought in Rs 17.15 crore").
    # The verb+amount must follow the weekday within ~30 chars, so a
    # later weekday's figure can never be attributed to this one (that
    # is Walk-A's job: "on Monday and Rs 46.80 crore on Tuesday before
    # ... declined to Rs 28.15 crore on Wednesday" must NOT give Monday
    # the 28.15 -- Tuesday gets 46.80 and Wednesday gets 28.15).
    # All walk matches are collected first, sorted by position, then
    # resolved in order -- the "following" qualifier is relative to the
    # previously resolved walk date, so document order matters.
    _VERB = (r"(?:collecting|earning|earned|recorded|registering|"
             r"brought in|added|declined to|dropped to|fell to)")
    _AMT = r"(?:₹|Rs\.?\s*)(?P<amt>[\d.]+)\s*(?:crore|cr)\b"
    _WALK_GUARD = re.compile(
        r"gross|worldwide|overseas|footfall|version|screenings", re.I)

    def _sentence_span(pos):
        start = 0
        for mm in re.finditer(r"\.\s", text[:pos]):
            start = mm.end()
        mm = re.search(r"\.\s", text[pos:])
        end = pos + mm.end() if mm else len(text)
        return start, end

    walk_cands = []
    # Walk-A: "on <Weekday>" (+ optional qualifier / explicit date);
    # value = the last amount in the same sentence before the weekday.
    for m in re.finditer(
            r"on\s+(?:its\s+|the\s+)?"
            r"(?P<qual>first|second|third|following)?\s*(?P<wd>" + WD_RE + r")"
            r"(?:,?\s+(?P<mon>" + MONTH_RE + r") (?P<mday>\d+))?", text, re.I):
        s_start, s_end = _sentence_span(m.start())
        if _WALK_GUARD.search(text[s_start:s_end]):
            continue
        before = text[s_start:m.start()]
        amounts = list(re.finditer(_AMT, before))
        if not amounts:
            continue
        gd = m.groupdict()
        walk_cands.append((m.start(), amounts[-1].group(1), gd.get("qual"),
                           gd.get("wd"), gd.get("mon"), gd.get("mday")))
    # Walk-B: "<Weekday> ... <verb> amount" in the same sentence.
    # Take the FIRST verb+amount after the weekday -- the amount may
    # follow a later verb ("recorded a 76.8% jump in collections,
    # earning Rs 7.25 cr"). Reject if another amount or weekday comes
    # before that verb+amount, or if the amount is followed by
    # "on <Weekday>" before the next amount / sentence end (then it
    # belongs to that weekday -- Walk-A's job, e.g. "declined to
    # Rs 28.15 crore on Wednesday" must NOT give Tuesday the 28.15).
    _VERB_AMT = re.compile(
        _VERB + r"\s+(?:an estimated\s+|around\s+|approximately\s+|"
        r"another\s+)?" + _AMT, re.I)
    _WD_ANY = re.compile(
        r"(?:\bon\s+|\bthe\s+)?(?:its\s+|the\s+)?"
        r"(?P<qual>first|second|third|following)?\s*(?P<wd>" + WD_RE + r")\b",
        re.I)
    for m in _WD_ANY.finditer(text):
        gd = m.groupdict()
        if not gd.get("qual"):
            head = text[max(0, m.start() - 12):m.start() + 12].lower()
            if not re.search(r"\b(on|the)\b", head):
                continue
        s_start, s_end = _sentence_span(m.start())
        if _WALK_GUARD.search(text[s_start:s_end]):
            continue
        sent = text[s_start:s_end]
        wd_end = m.end() - s_start
        vm = _VERB_AMT.search(sent, wd_end)
        if vm is None:
            continue
        between = sent[wd_end:vm.start()]
        if re.search(r"₹|Rs\.?", between) or re.search(
                r"\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b",
                between, re.I):
            continue
        after = sent[vm.end():]
        nxt = re.search(r"₹|Rs\.?|\.\s", after)
        after_head = after[:nxt.start()] if nxt else after
        if re.search(r"\bon\s+(?:its\s+|the\s+)?(?:first|second|third|following)?\s*"
                     r"(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b",
                     after_head, re.I):
            continue
        walk_cands.append((m.start(), vm.group("amt"), gd.get("qual"),
                           gd.get("wd"), None, None))
    walk_cands.sort(key=lambda c: c[0])
    last_resolved = anchor
    for _pos, val, qual, wd_s, mon_s, day_s in walk_cands:
        wd = WEEKDAYS.index(wd_s.lower())
        if mon_s and day_s:
            try:
                d = dt.date(target_date.year, MONTHS[mon_s.lower()],
                            int(day_s))
            except ValueError:
                continue
            if d > target_date:
                try:
                    d = dt.date(target_date.year - 1,
                                MONTHS[mon_s.lower()], int(day_s))
                except ValueError:
                    continue
            prio = 3  # explicit date: as reliable as P3
        elif qual == "first":
            d = _nth_weekday(anchor, wd, 1)
            prio = 5
        elif qual == "second":
            d = _nth_weekday(anchor, wd, 2)
            prio = 5
        elif qual == "third":
            d = _nth_weekday(anchor, wd, 3)
            prio = 5
        elif qual == "following":
            d = last_resolved + dt.timedelta(days=1)
            while d.weekday() != wd:
                d += dt.timedelta(days=1)
            prio = 5
        else:
            d = _recent_weekday_before(target_date, wd)
            prio = 5
        day = _day_for_date(d, anchor)
        if prio == 5 and day >= tday:
            continue  # walk is backfill only; target day is P1/P3's job
        if day < 1 or day > tday:
            continue
        last_resolved = d
        add(day, val, prio, "walk")

    rows = sorted(
        ({"day": d, "date": (anchor + dt.timedelta(days=d - 1)).isoformat(),
          "collection_inr_cr": v, "source": SOURCE, "estimate": False}
         for d, (v, _p, _h) in found.items()),
        key=lambda r: r["day"])
    return rows, ("" if rows else "no day-wise India Net figures found")


def process_feed(feed, out, report):
    fid = feed["id"]
    log("[%s] fetching RSS %s" % (fid, feed["rss"]))
    try:
        xml = fetch(feed["rss"])
    except Exception as e:
        report[fid]["error"] = "RSS fetch failed: %s" % e
        return
    items = parse_rss(xml)
    report[fid]["feed_items"] = len(items)
    for item in items:
        ok, why = is_box_office(item["title"])
        if not ok:
            report[fid]["skipped"].append(
                {"title": item["title"][:90], "reason": why})
            continue
        movie = identify_movie(item["title"])
        if not movie:
            report[fid]["skipped"].append(
                {"title": item["title"][:90],
                 "reason": "movie not in TITLE_MAP (no TMDB id — never guess)"})
            continue
        tmdb_id, day1 = movie
        pubdate = parse_pubdate(item["pubdate"])
        report[fid]["box_office_items"] += 1
        log("[%s] %s -> %s (%s)"
            % (fid, item["title"][:80], tmdb_id, item["link"]))
        time.sleep(SLEEP)
        try:
            html_text = fetch(item["link"])
        except Exception as e:
            report[fid]["skipped"].append(
                {"title": item["title"][:90],
                 "reason": "article fetch failed: %s" % e})
            continue
        rows, reason = parse_article(html_text, item["title"], pubdate,
                                     tmdb_id, day1)
        if not rows:
            report[fid]["skipped"].append(
                {"title": item["title"][:90], "reason": reason})
            continue
        for row in rows:
            out.setdefault(tmdb_id, []).append(row)
        report[fid]["rows"] += len(rows)
        report[fid]["parsed"].append(
            {"title": item["title"][:90], "tmdb_id": tmdb_id,
             "days": sorted(r["day"] for r in rows)})


def dedupe(out):
    """One row per (tmdb, day): keep the first (highest priority already
    applied inside parse_article; across articles keep the first seen)."""
    for tid in out:
        seen = {}
        for row in sorted(out[tid], key=lambda r: r["day"]):
            seen.setdefault(row["day"], row)
        out[tid] = [seen[d] for d in sorted(seen)]


def write_stage(out, stage_dir):
    """Deterministic staging write: only writes when content changed."""
    os.makedirs(stage_dir, exist_ok=True)
    path = os.path.join(stage_dir, "%s.json" % SOURCE)
    payload = json.dumps(out, indent=2, sort_keys=True) + "\n"
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            if f.read() == payload:
                log("stage unchanged: %s" % path)
                return False
    with open(path, "w", encoding="utf-8") as f:
        f.write(payload)
    log("wrote stage: %s" % path)
    return True


def main():
    ap = argparse.ArgumentParser(description="Filmibeat RSS box-office reader")
    ap.add_argument("--out", default="filmibeat-boxoffice-output.json",
                    help="output JSON path")
    ap.add_argument("--feed", default=None,
                    help="only run one feed id: bollywood|tamil|telugu "
                         "(default: all three)")
    ap.add_argument("--stage", default=None, metavar="DIR",
                    help="also write deterministic staging JSON "
                         "(<DIR>/filmibeat.json) for the averaging engine")
    ap.add_argument("--no-sleep", action="store_true",
                    help="skip inter-request sleeps (testing only)")
    args = ap.parse_args()
    global SLEEP
    if args.no_sleep:
        SLEEP = 0

    out, report = {}, {}
    for feed in FEEDS:
        if args.feed and feed["id"] != args.feed:
            continue
        report[feed["id"]] = {"feed_items": 0, "box_office_items": 0,
                              "rows": 0, "parsed": [], "skipped": []}
        process_feed(feed, out, report)

    dedupe(out)
    for tid in out:
        out[tid] = sorted(out[tid], key=lambda r: r["day"])
    with open(args.out, "w") as f:
        json.dump(out, f, indent=2, sort_keys=True)

    if args.stage:
        write_stage(out, args.stage)

    print(json.dumps({"data": out, "report": report}, indent=2))
    log("\nWrote %s" % args.out)


if __name__ == "__main__":
    main()
