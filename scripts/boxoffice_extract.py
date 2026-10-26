#!/usr/bin/env python3
"""Deterministic day-wise box-office extraction from Gemini-written articles.

Why this exists (verified 2026-10-26): the auto-pipeline already asks Gemini
for an optional `box_office` object (film/day/date/collection_inr_crore) and
apply-auto.py already merges `box_rows` into js/daywise-data.js — but in
production the pipeline has NEVER produced a row, because:
  1. TMDB_API_KEY is NOT a repo secret, so gemini_batch.py's
     resolve_tmdb_id() always returns "" and a row is silently dropped
     unless Gemini itself supplies the TMDB id (it almost never does).
  2. Gemini often omits the box_office object (most box-office articles
     lead with a TOTAL, and the prompt forbids putting a total in the
     single-day field).

This module fixes both WITHOUT another Gemini call:
  - tmdb_id is resolved from the site's own js/published-titles.js
    (FA_PUBLISHED, keyed by TMDB id) — free, offline, and it guarantees
    the row is for a title the site actually shows. Films that are not
    published get NO row (a row for an unpublished title can never display:
    the box-office page lists published titles only).
  - when Gemini's box_office is empty/incomplete, the day-wise figures are
    extracted deterministically from the article's own facts/body with
    regexes. Spike-verified 2026-10-26 against the 8 live box-office
    articles: the Indian (Rs crore) day-wise articles carry explicit
    "Day N ... X crore" facts; Hollywood ($ million) articles report
    WEEKEND totals, which correctly yield NO rows (a weekend total must
    never be split into days).

Rules (never violated):
  - Only a figure actually stated in the article, for a single day.
    Totals / cumulative / worldwide / weekend aggregates are never a day.
  - Net is preferred over gross for the same day.
  - A sentence naming a DIFFERENT film, or a language "version" split,
    is never attributed to the primary film.
  - Never write a zero/missing collection (the caller drops <= 0, same
    rule as apply-auto.py).
  - Date = the film's release_date + (day - 1) (verified: Udta Teer
    release 2026-10-23 -> Day 1 2026-10-23, Day 2 2026-10-24, Day 3
    2026-10-25 — matches the known FA_DAYWISE rows).
  - USD = crore * 1e7 / 94.65 (site FA_RATES); $ figures are used as-is.

Pure functions, stdlib only, no side effects. Used by gemini_batch.py
(fallback after the Gemini box_office check) and by
scripts/backfill_boxoffice.py (one-time backfill over existing articles).
"""
import json
import os
import re
from datetime import date, datetime, timedelta
from email.utils import parsedate_to_datetime

INR_TO_USD = 94.65  # site FA_RATES (config.js)

# --- patterns -------------------------------------------------------------
CR_RE = re.compile(
    r"(?:(?:rs\.?|inr|₹)\s*)?([\d,]+(?:\.\d+)?)\s*(crore|cr|lakh)\b",
    re.IGNORECASE)
USD_RE = re.compile(
    r"\$\s*([\d,]+(?:\.\d+)?)\s*(million|billion|k)?\b"
    r"|\b([\d,]+(?:\.\d+)?)\s*(million|billion)\s*dollars?\b",
    re.IGNORECASE)
DAY_RE = re.compile(r"\bday\s*(\d+)\b", re.IGNORECASE)
OPENING_DAY_RE = re.compile(r"\bopening day\b", re.IGNORECASE)
OPENING_WEEK_RE = re.compile(r"\bopening week\b", re.IGNORECASE)
COLLECTION_WORDS_RE = re.compile(
    r"collection|collected|earned|net\b|gross|haul|tally", re.IGNORECASE)
# Words that mark a figure as an aggregate, never a single day.
# Also advance-booking / pre-sales language: a pre-release figure
# (advance gross, prepaid previews) is NOT a day's collection — the
# Ramayana pre-sales article (jly4tm) proved this: "advance gross ...
# opening day commitments" must never become a Day 1 row.
TOTAL_WORDS_RE = re.compile(
    r"\btotal\b|cumulative|worldwide|overall|stands at|opening week"
    r"|second weekend|first weekend|opening weekend|advance|pre-?sales?"
    r"|prepaid|preview", re.IGNORECASE)
VERSION_RE = re.compile(r"\bversion\b", re.IGNORECASE)


def norm_title(s):
    return re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()


def title_matches(pub_title, ent):
    """Same matcher as the detail-page Related News (Part B audit):
    exact name, substring (min 6 chars), or a shared distinctive first
    word (5+ letters). Only the primary entity counts."""
    pn, en = norm_title(pub_title), norm_title(ent)
    if not pn or not en:
        return False
    if pn == en:
        return True
    if (pn in en or en in pn) and min(len(pn), len(en)) >= 6:
        return True
    pf, ef = pn.split(" ")[0], en.split(" ")[0]
    return bool(pf and pf == ef and len(pf) >= 5)


def load_published(root):
    """js/published-titles.js -> {norm_title: {tmdb_id, title,
    release_date, type}}. Movies only (TV has no box office)."""
    path = os.path.join(root, "js", "published-titles.js")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    data = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
    out = {}
    for tid, v in (data or {}).items():
        if not isinstance(v, dict) or v.get("type") != "movie":
            continue
        t = v.get("title") or v.get("name") or ""
        if not t:
            continue
        out[norm_title(t)] = {
            "tmdb_id": str(tid),
            "title": t,
            "release_date": (v.get("release_date") or "").strip(),
        }
    return out


def match_published(film, published):
    """Film name -> published entry (or None). Tries exact, substring,
    then distinctive-first-word, in that order."""
    nf = norm_title(film)
    if not nf:
        return None
    if nf in published:
        return published[nf]
    for nt, entry in published.items():
        if (nf in nt or nt in nf) and min(len(nf), len(nt)) >= 6:
            return entry
    pf = nf.split(" ")[0]
    if len(pf) >= 5:
        for nt, entry in published.items():
            if nt.split(" ")[0] == pf:
                return entry
    return None


def parse_pub_date(s):
    """Article published date (ISO or RFC2822) -> datetime for ordering.
    Returns epoch-minimum when unparseable."""
    if not s:
        return datetime(1970, 1, 1)
    s = str(s).strip()
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt.replace(tzinfo=None)
    except ValueError:
        pass
    try:
        dt = parsedate_to_datetime(s)
        return dt.replace(tzinfo=None) if dt else datetime(1970, 1, 1)
    except (TypeError, ValueError):
        return datetime(1970, 1, 1)


def _usd_from_crore(crore):
    return round(float(crore) * 1e7 / INR_TO_USD)


def _figure_usd(text):
    """First day-figure in a sentence -> (collection_usd, collection_inr_crore).
    Prefers a Rs-crore figure (Indian articles); else a $ figure.
    Skips a "lakh" figure when the sentence is about ticket counts
    ("2.25 lakh tickets" is a count, not money). Returns (None, None)
    when no figure is present."""
    for m in CR_RE.finditer(text):
        val = float(m.group(1).replace(",", ""))
        unit = m.group(2).lower()
        if unit == "lakh" and "ticket" in text.lower():
            continue
        cr = val / 100.0 if unit == "lakh" else val
        return _usd_from_crore(cr), cr
    m = USD_RE.search(text)
    if m:
        if m.group(1) is not None:
            val = float(m.group(1).replace(",", ""))
            mult = (m.group(2) or "").lower()
        else:
            val = float(m.group(3).replace(",", ""))
            mult = (m.group(4) or "").lower()
        if mult == "million":
            val *= 1e6
        elif mult == "billion":
            val *= 1e9
        elif mult == "k":
            val *= 1e3
        return round(val), None
    return None, None


def _sentence_ok(text, film, other_titles):
    """A candidate sentence must not name a different film and must not
    be a language-version split (a partial figure, not the day total)."""
    nt = norm_title(text)
    for ot in other_titles:
        if ot and ot in nt:
            return False
    if VERSION_RE.search(text):
        return False
    return True


def extract_box_rows(article, published):
    """One article (FA_ARTICLES shape) -> [box_row, ...] in the exact
    shape apply-auto.py merges: {tmdb_id, film, day, date,
    collection_usd, collection_inr_crore, sources, article_url}.
    Returns [] when the article yields no day-wise row."""
    headline = (article or {}).get("headline") or ""
    # An advance-booking / pre-sales article is not a day-wise report:
    # its figures are pre-release takings, never a day's collection.
    if re.search(r"advance booking|pre-?sales?|advance gross", headline,
                 re.IGNORECASE):
        return []
    entities = (article or {}).get("entities") or {}
    titles = [str(t).strip() for t in (entities.get("titles") or [])
              if str(t or "").strip()]
    if not titles:
        return []
    film = titles[0]
    entry = match_published(film, published)
    if not entry:
        return []  # film not published -> a row could never display
    release = entry.get("release_date") or ""
    try:
        rel_date = date.fromisoformat(release)
    except ValueError:
        return []  # cannot date the days reliably
    # Titles that must NOT appear in a candidate sentence (any other film
    # named in the article, plus every other published title).
    other_titles = {norm_title(t) for t in titles[1:]}
    other_titles |= {nt for nt in published if nt != norm_title(film)}

    def candidates(texts):
        """Yield (day, usd, inr_crore, is_net) from a list of sentences."""
        out = []
        for text in texts:
            if not isinstance(text, str) or not text.strip():
                continue
            if not _sentence_ok(text, film, other_titles):
                continue
            if TOTAL_WORDS_RE.search(text):
                continue
            if not COLLECTION_WORDS_RE.search(text):
                continue
            day = None
            dm = DAY_RE.search(text)
            if dm:
                day = int(dm.group(1))
            elif OPENING_DAY_RE.search(text) and not OPENING_WEEK_RE.search(text):
                day = 1
            if not day or day < 1 or day > 60:
                continue
            usd, cr = _figure_usd(text)
            if not usd or usd <= 0:
                continue
            is_net = "net" in text.lower()
            is_gross = "gross" in text.lower()
            out.append((day, usd, cr, is_net, is_gross))
        return out

    facts = [str(f) for f in (article.get("facts") or [])]
    rows = candidates(facts)
    if not rows:
        # Facts are the cleanest source; only fall back to body prose
        # when the facts carry no day-wise figure at all.
        body = []
        for s in (article.get("body") or []):
            if isinstance(s, dict):
                body.extend(str(p) for p in (s.get("p") or []))
        rows = candidates(body)
    if not rows:
        return []

    # One row per day: prefer net over gross, else the first candidate.
    best = {}
    for day, usd, cr, is_net, is_gross in rows:
        score = (2 if is_net else (0 if is_gross else 1))
        prev = best.get(day)
        if prev is None or score > prev[0]:
            best[day] = (score, usd, cr)
    source = (article.get("source") or "").strip()
    url = ""
    # FA_ARTICLES has no source_url; the backfill passes it through.
    url = (article.get("source_url") or "").strip()
    out = []
    for day in sorted(best):
        _, usd, cr = best[day]
        out.append({
            "tmdb_id": entry["tmdb_id"],
            "film": entry["title"],
            "day": int(day),
            "date": (rel_date + timedelta(days=int(day) - 1)).isoformat(),
            "collection_usd": int(usd),
            "collection_inr_crore": cr,
            "sources": [source] if source else [],
            "article_url": url,
        })
    return out


def extract_all(articles, published):
    """All articles (FA_ARTICLES dict) -> box_rows, oldest article first
    so that when two articles report the same film+day, the NEWEST figure
    wins in apply-auto.py's update rule (a later row overwrites)."""
    ordered = sorted(articles.values(),
                     key=lambda a: parse_pub_date(a.get("published")))
    rows = []
    for a in ordered:
        rows.extend(extract_box_rows(a, published))
    return rows
