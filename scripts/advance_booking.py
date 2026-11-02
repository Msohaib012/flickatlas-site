#!/usr/bin/env python3
"""Pre-release advance-booking collector for FlickAtlas.

Why this exists (2026-11-01): js/advance-data.js only ever held
NEXT-DAY advance for films already in their theatrical run — the
Sacnilk reader (scripts/sacnilk_boxoffice.py) lifts the "Advance
booking for Day N+1 ..." sentence off the current day's quicknews
page, and its needs_fetch() skips unreleased titles entirely. But
the advance figures readers care about most are PRE-RELEASE: a
heavily awaited film can collect crores in advance booking days
before it opens (Ramayana: Rs36.92 Cr gross on Sacnilk's live
tracker 4 days before its 2026-11-05 release). This collector is
the pre-release path; the two writers merge into the same
js/advance-data.js and never mix figures (a title is pre-release
for this collector exactly while it is unreleased for the reader).

Sources, in order:
  1. Sacnilk's Advance Booking Live page
     (https://www.sacnilk.com/advance-booking-live) — ONE fetch
     lists every film with booking open, ranked by advance gross
     so far, each card carrying the film's release date and its
     total advance gross (the headline figure, block seats
     included, exactly as Sacnilk headlines it). A card is used
     only when it is a pre-release card ("N days to release") AND
     its release date equals the published title's release date
     AND the titles are compatible (see match_card) — all three.
  2. Tavily search fallback for watchlist titles the live page
     does not carry (keys TAVILY_API_KEY / TAVILY_API_KEY_BACKUP,
     same pattern as tavily_boxoffice.py). A figure is accepted
     only when a result mentions the film AND one sentence ties
     the word "advance" to an explicit gross figure.
  3. WORLD lane (2026-11-02, owner question "why only Indian?"):
     titles whose published industry is "world" get their own
     Tavily lane, because neither existing source can ever carry
     them — Sacnilk's live page lists Indian films only, and US/UK
     trade coverage never says "advance booking collection": it
     reports "presales" / "pre-sales" / "advance ticket sales"
     (Forbes via trade reports: Avengers: Doomsday crossed
     $125M in WORLDWIDE presales ~7 weeks before release, while
     this collector had never even searched the title). The lane
     has its own per-run cap and a least-recently-searched
     rotation, and its own acceptance: one sentence must tie a
     presale keyword to an explicit $/£/€ figure, the figure's
     SCOPE is read off the same sentence (worldwide > domestic >
     national > single venue; widest scope wins), social-media
     posts can corroborate but never originate a figure, and the
     accepted row carries the scope label so a one-venue figure
     is never silently compared with a worldwide one.

Why the lanes are separate (the 2026-11-02 starvation bug): the
old single queue sorted ALL 107 watchlist titles by release date
and spent the whole 12-search cap on the 12 nearest — which,
after the world seeder flood, were mostly obscure micro-titles
re-searched identically every run (state showed
tavily_attempts=2 on the same 12 titles in one day), while
far-out titles (King, Dune: Part Three, Avengers: Doomsday)
were NEVER searched at all despite the weekly far cadence.
Lane-split budgets + "near titles at most once a day" + the
world lane's LRU rotation make every title reachable.

Acceptance is strict on purpose (the repo's provenance culture):
watchlist membership alone NEVER produces an entry. A figure is
written only when a source explicitly states an advance-booking
gross for that film. The entry is attributed to the film's
release date (the advance is for the upcoming run); the "day"
label stays "" unless a source explicitly ties the figure to a
specific day ("Day 1"), mirroring how the quicknews rows carry
their Day N label. Rs figures convert at INR_PER_USD = 94.65.

Watchlist (owner scope, 2026-11-01): every published MOVIE
releasing within the next 90 days — heavily awaited titles are
watched for 2-3 months, not days. The set is recomputed from
js/published-titles.js on every run (a standing set, not a
one-shot list). Per-title attempt state lives in
out/advance-booking-state.json (committed like the other out/
state files) and drives the Tavily cadences (per lane, see
tavily_due / world_due): near titles at most once a day,
further-out titles on a multi-day rotation, so no title burns
the cap twice in a day and no title starves. The Sacnilk
live page costs one fetch regardless, so every candidate is
checked against it on every run. Each lane's per-run Tavily
cap (India 12, world 6) is spent in TRENDING RANK order
within the lane (see trend_key below): the homepage Advance
Booking block is the top six high-trending upcoming films,
Bollywood + World Cinema mixed (owner order 2026-11-02), so
the collector hunts figures for the trending titles first —
a same-week micro-title flood must never again consume the
queue ahead of the tentpoles.

Usage:
  advance_booking.py            dry-run (default): print the
                                watchlist, what it found and what
                                it WOULD write; write nothing.
  advance_booking.py --apply    merge findings into
                                js/advance-data.js and update
                                out/advance-booking-state.json.
  advance_booking.py --today YYYY-MM-DD   override the run date.
  advance_booking.py --max-searches N     India-lane Tavily cap
                                          (default 12).
  advance_booking.py --max-world-searches N
                                          World-lane Tavily cap
                                          (default 6).
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import date, timedelta

# Sibling module: shared constants (rate, user agent, the
# byte-identical advance header, the js-map read/write helpers).
# Same pattern as backfill_overseas.py's `import sacnilk_boxoffice`.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sacnilk_boxoffice as sb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIVE_URL = "https://www.sacnilk.com/advance-booking-live"
TAVILY_URL = "https://api.tavily.com/search"
FETCH_TIMEOUT = 30
WINDOW_DAYS = 90          # watchlist horizon (owner scope 2026-11-01)
NEAR_DAYS = 21            # within this, Tavily runs every run
FAR_CADENCE_DAYS = 7      # beyond NEAR_DAYS, Tavily at most weekly
MAX_SEARCHES = 12         # per-run Tavily cap (India lane)
# World lane (2026-11-02): separate cap + rotation, see docstring.
WORLD_MAX_SEARCHES = 6    # per-run Tavily cap (world lane)
WORLD_MID_DAYS = 60       # world: <=60d cadence 3d, beyond weekly
WORLD_MID_CADENCE_DAYS = 3
# Approximate FX for converting a £/€ presale figure when the
# source gives no $ rendering of its own (the as-reported figure
# is always kept verbatim in the state detail). INR uses
# sb.INR_PER_USD like everything else on the site.
GBP_PER_USD = 1.27
EUR_PER_USD = 1.08
# Social posts can corroborate a figure but never originate one:
# fan/aggregator accounts routinely restate (and garble) trade
# numbers, so acceptance requires a non-social source.
SOCIAL_HOSTS = ("facebook.com", "x.com", "twitter.com",
                "instagram.com", "reddit.com", "youtube.com",
                "youtu.be")
STATE_REL = os.path.join("out", "advance-booking-state.json")
MONTHS = sb.MONTHS


# --- trending rank (SHARED DEFINITION — keep in sync) -----------
# Owner order 2026-11-02: the homepage Advance Booking block is
# the TOP SIX high-trending upcoming films, Bollywood + World
# Cinema mixed, selected by TRENDING — never by figure size.
# This collector hunts figures in the same order, so ONE rank is
# defined here and mirrored in js/page-index.js (the advEntries
# sort); the two MUST stay in sync:
#   1. membership in the TMDB trending set (js/trending-data.js,
#      window.FA_TRENDING): members first, in trending-list
#      order;
#   2. popularity desc (missing/None counts as 0) — popularity
#      alone mis-ranks: tentpoles like Avengers: Doomsday carry
#      popularity None in the published data, which is exactly
#      why membership comes first;
#   3. release date asc (soonest first) as the final tiebreak.

def load_trending(root):
    """js/trending-data.js -> {tmdb_id (str): trending position
    (0-based)}. {} when the file is missing or unparseable —
    popularity then carries the ordering alone."""
    path = os.path.join(root, "js", "trending-data.js")
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read()
    except OSError:
        return {}
    m = re.search(r"FA_TRENDING\s*=\s*\[([0-9,\s]*)\]", raw)
    if not m:
        return {}
    ids = [s.strip() for s in m.group(1).split(",") if s.strip()]
    return {tid: i for i, tid in enumerate(ids)}


def trend_key(entry):
    """The shared trending rank as a sort key (see the block
    comment above): trending members first in list order, then
    popularity desc, then release date asc (days_to_release is
    the same ordering). Lower sorts earlier = hunted/shown
    first."""
    idx = entry.get("trend_idx")
    return (0 if idx is not None else 1,
            idx if idx is not None else 0,
            -entry["popularity"],
            entry["days_to_release"])


# --- watchlist ---------------------------------------------------------

def load_watchlist(root, today, window_days=WINDOW_DAYS):
    """Published movies releasing in (today, today + window_days].
    Returns entries {tmdb_id, title, release_date (date),
    days_to_release, popularity, trend_idx (int or None)}
    sorted by the shared trending rank (trend_key)."""
    path = os.path.join(root, "js", "published-titles.js")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    data = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
    trending = load_trending(root)
    out = []
    horizon = today + timedelta(days=window_days)
    for tid, v in (data or {}).items():
        if not isinstance(v, dict) or v.get("type") != "movie":
            continue
        title = v.get("title") or v.get("name") or ""
        rel_s = (v.get("release_date") or "").strip()
        if not title or not rel_s:
            continue
        try:
            rel = date.fromisoformat(rel_s)
        except ValueError:
            continue
        if not (today < rel <= horizon):
            continue
        try:
            pop = float(v.get("popularity") or 0)
        except (TypeError, ValueError):
            pop = 0.0
        # Lane (2026-11-02): the published entry's industry field
        # is canonical (UI.industryOf); fall back to origin country
        # the same way the UI does when the field is missing.
        industry = str(v.get("industry") or "").strip().lower()
        if not industry:
            countries = (v.get("origin_country")
                         or v.get("production_countries") or [])
            industry = ("bollywood" if "IN" in countries
                        else "world")
        out.append({"tmdb_id": str(tid), "title": title,
                    "release_date": rel,
                    "days_to_release": (rel - today).days,
                    "popularity": pop,
                    "trend_idx": trending.get(str(tid)),
                    "industry": industry})
    out.sort(key=trend_key)
    return out


def norm_title(t):
    return re.sub(r"[^a-z0-9]+", " ", str(t or "").lower()).strip()


def titles_compatible(card_title, pub_title):
    """Strict-ish title gate, always combined with the release-date
    equality check in match_card: exact normalised match, one title
    a word-boundary prefix of the other ("Ramayana" vs "Ramayana
    Rise of a Legend"), or equality of the part before a colon
    (TMDB subtitles: "Ramayana: Rise of a Legend" -> "ramayana")."""
    a, b = norm_title(card_title), norm_title(pub_title)
    if not a or not b:
        return False
    if a == b:
        return True
    if b.startswith(a + " ") or a.startswith(b + " "):
        return True
    base_b = norm_title(str(pub_title).split(":")[0])
    return bool(base_b) and a == base_b


# --- source 1: Sacnilk Advance Booking Live ----------------------------

CARD_RE = re.compile(
    r'<div class="who">\s*<a href="(/livetracker/[^"]+)">(.*?)</a>'
    r'\s*<div class="meta">(.*?)</div>', re.S)
FIG_RE = re.compile(r'<span class="big">(.*?)</span>', re.S)
DAYS_TO_RELEASE_RE = re.compile(r"(\d+)\s+days?\s+to\s+release", re.I)
CARD_DATE_RE = re.compile(
    r"(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)")


def fetch_live_page():
    """GET the Advance Booking Live page. Returns HTML or None."""
    req = urllib.request.Request(LIVE_URL,
                                 headers={"User-Agent": sb.USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            return resp.read().decode("utf-8", errors="ignore")
    except Exception as e:
        print(f"advance: live page fetch failed ({e})")
        return None


def parse_live_cards(html, today):
    """Live page -> pre-release cards only:
    {title, slug_url, release_date, advance_cr, meta}.
    In-run cards ("Day N in cinemas") are skipped — next-day
    advance for in-run films is sacnilk_boxoffice.py's job.
    The release date comes from the card's own "N days to release"
    (today + N), cross-checked against the "Thu 5 Nov" date in the
    meta; a card whose two signals disagree is dropped, not
    guessed."""
    cards = []
    if not html:
        return cards
    # Cards are <li> siblings; split on the who/fig block pairs by
    # scanning for card anchors and the figure that follows each.
    anchors = list(CARD_RE.finditer(html))
    for i, m in enumerate(anchors):
        end = anchors[i + 1].start() if i + 1 < len(anchors) else len(html)
        block = html[m.start():end]
        fig_m = FIG_RE.search(block)
        if not fig_m:
            continue
        cr = sb._amount_cr(re.sub(r"<[^>]+>", " ", fig_m.group(1)))
        if cr is None:
            continue
        meta = re.sub(r"\s+", " ",
                      re.sub(r"<[^>]+>", " ", m.group(3))).strip()
        rel_m = DAYS_TO_RELEASE_RE.search(meta)
        if not rel_m:
            continue  # in-run card ("Day N in cinemas") or no signal
        rel = today + timedelta(days=int(rel_m.group(1)))
        dm = CARD_DATE_RE.search(meta)
        if dm:
            mon = MONTHS.get(dm.group(2)[:3].lower())
            if mon and (int(dm.group(1)) != rel.day or mon != rel.month):
                print(f"advance: card '{m.group(2)}': meta date "
                      f"{dm.group(1)} {dm.group(2)} disagrees with "
                      f"'{rel_m.group(1)} days to release' ({rel}) — "
                      f"card dropped")
                continue
        title = re.sub(r"<[^>]+>", " ", m.group(2))
        title = re.sub(r"\s+", " ", title).strip()
        cards.append({"title": title,
                      "slug_url": "https://www.sacnilk.com" + m.group(1),
                      "release_date": rel,
                      "advance_cr": cr,
                      "meta": meta})
    return cards


def match_card(card, watchlist):
    """A live-page card -> the watchlist entry it belongs to, or
    None. Requires release-date equality AND title compatibility;
    when several entries qualify, the highest popularity wins."""
    hits = [e for e in watchlist
            if e["release_date"] == card["release_date"]
            and titles_compatible(card["title"], e["title"])]
    if not hits:
        return None
    hits.sort(key=lambda e: -e["popularity"])
    return hits[0]


# --- source 2: Tavily fallback -----------------------------------------

FIGURE_PATTERNS = (
    # ₹36.92 Cr / ₹30.10 crore / ₹85 L / ₹85 lakh
    re.compile(r"₹\s*([\d,]+\.?\d*)\s*(Cr|crore|L|lakh)\b", re.I),
    re.compile(r"\bRs\.?\s*([\d,]+\.?\d*)\s*(Cr|crore|L|lakh)\b", re.I),
    # $4.2 million / $350K
    re.compile(r"\$\s*([\d,]+\.?\d*)\s*(million|billion|M|K)\b", re.I),
)


def figure_usd(text):
    """First explicit gross figure in a sentence -> USD, or None.
    The caller guarantees the sentence is about advance booking."""
    for pat in FIGURE_PATTERNS:
        m = pat.search(text)
        if not m:
            continue
        v = float(m.group(1).replace(",", ""))
        unit = m.group(2).lower()
        if unit in ("cr", "crore"):
            return round(v * 1e7 / sb.INR_PER_USD)
        if unit in ("l", "lakh"):
            return round(v * 1e5 / sb.INR_PER_USD)
        if unit == "million" or unit == "m":
            return round(v * 1e6)
        if unit == "billion":
            return round(v * 1e9)
        if unit == "k":
            return round(v * 1e3)
    return None


def extract_tavily_figure(results, entry):
    """Tavily results for one title -> (usd, day_label, source_url)
    or None. A result counts only when it mentions the film (title
    in the result title or opening content) AND a single sentence
    ties 'advance' to an explicit figure."""
    nt = norm_title(entry["title"])
    base = norm_title(entry["title"].split(":")[0])
    for res in results or []:
        url = res.get("url", "") or ""
        rtitle = res.get("title", "") or ""
        content = res.get("content", "") or ""
        blob = norm_title(rtitle + " " + content[:600])
        if nt not in blob and (not base or base not in blob):
            continue
        for sent in re.split(r"(?<=[.!?])\s+", content):
            if "advance" not in sent.lower():
                continue
            usd = figure_usd(sent)
            if usd is None or usd <= 0:
                continue
            day = ""
            if re.search(r"\bDay\s*1\b", sent) or "first day" in sent.lower():
                day = "Day 1"
            return usd, day, url
    return None


# --- source 3: world lane (Tavily, presale reporting) ------------------
#
# World presale news lives in trade coverage (Deadline, Variety,
# THR, Forbes, The Numbers) and uses different words and mostly
# USD figures. Acceptance mirrors the India lane's strictness:
# film mentioned + ONE sentence tying a presale keyword to an
# explicit figure + a real (non-social) source. The figure's
# scope is part of the fact and is stored with the row.

WORLD_FIGURE_PATTERNS = (
    (re.compile(r"(?:\$|USD\s*)\s*([\d,]+\.?\d*)\s*"
                r"(million|billion|M|K|thousand)?\b", re.I), "USD"),
    (re.compile(r"£\s*([\d,]+\.?\d*)\s*"
                r"(million|billion|M|K|thousand)?\b", re.I), "GBP"),
    (re.compile(r"€\s*([\d,]+\.?\d*)\s*"
                r"(million|billion|M|K|thousand)?\b", re.I), "EUR"),
)
PRESALE_WORDS = ("presale", "presales", "pre-sale", "pre-sales",
                 "advance ticket", "advance sales",
                 "advance booking")
_UNIT_MULT = {"million": 1e6, "m": 1e6, "billion": 1e9,
              "k": 1e3, "thousand": 1e3}


def world_figure_usd(sent):
    """One sentence -> (usd, as_reported_note, span) or None.
    A $ figure in the sentence wins over a £/€ one (the source's
    own conversion beats our approximate rate); a unit-less
    currency figure counts only at 10,000+ (below that it is a
    ticket price, not a gross). The span locates the winning
    figure in the sentence so the scope can be read off the
    figure's own clause, not the whole sentence."""
    hits = []
    for pat, cur in WORLD_FIGURE_PATTERNS:
        m = pat.search(sent)
        if not m:
            continue
        v = float(m.group(1).replace(",", ""))
        unit = (m.group(2) or "").lower()
        raw = v * _UNIT_MULT.get(unit, 1)
        if not unit and raw < 10000:
            continue
        usd = raw if cur == "USD" else raw * (
            GBP_PER_USD if cur == "GBP" else EUR_PER_USD)
        hits.append((cur, round(usd), m.group(0).strip(),
                     (m.start(), m.end())))
    if not hits:
        return None
    for cur, usd, note, span in hits:
        if cur == "USD":
            return usd, note, span
    return hits[0][1], hits[0][2], hits[0][3]


_CLAUSE_SEPS = (",", ";", " while ", " whereas ", " — ", " – ")


def world_scope(sent, span=None):
    """The figure's scope, read off the figure's own CLAUSE of
    the sentence — a sentence like "Global presales passed
    $125M, while domestic sales cleared $50M" carries two
    figures with two scopes, and each must be labelled by its
    own clause (falls back to the whole sentence when the
    clause states no scope). The NARROWEST explicitly stated
    scope is the precise truth for a figure (a BFI IMAX gross
    is a UK figure too, but calling it "UK pre-sales" would
    already overstate it). Rank orders scope width for
    choosing BETWEEN figures: worldwide 4 > domestic 3 >
    national 2 > single venue 1 > unstated 0."""
    if span:
        a, b = span
        start = 0
        for sep in _CLAUSE_SEPS:
            i = sent.rfind(sep, 0, a)
            if i >= 0:
                start = max(start, i + len(sep))
        end = len(sent)
        for sep in _CLAUSE_SEPS:
            i = sent.find(sep, b)
            if i >= 0:
                end = min(end, i)
        rank, label = world_scope(sent[start:end])
        if rank:
            return rank, label
    s = sent.lower()
    if re.search(r"\b(venue|bfi|single screen|one screen|"
                 r"largest screen)\b", s):
        return 1, "Single-venue pre-sales"
    if re.search(r"\b(uk|britain|british|london)\b", s):
        return 2, "UK pre-sales"
    if re.search(r"\b(domestic|domestically|north america|"
                 r"u\.s\.|united states|us theaters|us cinemas)\b",
                 s):
        return 3, "Domestic pre-sales"
    if re.search(r"\b(worldwide|global|international)\b", s):
        return 4, "Worldwide pre-sales"
    return 0, "Pre-sales"


def extract_world_figure(results, entry):
    """Tavily results for one world title -> (usd, scope_label,
    source_url, detail) or None. Opening-weekend PROJECTIONS are
    not presales and are rejected even when a presale word is
    nearby. Among accepted figures the widest scope wins; within
    a scope the largest wins (presale totals are cumulative, so
    the largest reported is the latest milestone)."""
    nt = norm_title(entry["title"])
    base = norm_title(entry["title"].split(":")[0])
    best = None  # (scope_rank, usd, scope_label, url, detail)
    for res in results or []:
        url = res.get("url", "") or ""
        host = re.sub(r"^https?://(www\.)?", "", url).split("/")[0]
        if any(host == h or host.endswith("." + h)
               for h in SOCIAL_HOSTS):
            continue
        rtitle = res.get("title", "") or ""
        content = res.get("content", "") or ""
        blob = norm_title(rtitle + " " + content[:600])
        if nt not in blob and (not base or base not in blob):
            continue
        for sent in re.split(r"(?<=[.!?])\s+",
                             rtitle + ". " + content):
            low = sent.lower()
            if not any(w in low for w in PRESALE_WORDS):
                continue
            if "opening" in low and ("project" in low
                                     or "estimat" in low
                                     or "forecast" in low
                                     or "track" in low):
                continue  # a forecast, not money already taken
            got = world_figure_usd(sent)
            if got is None:
                continue
            usd, note, span = got
            if usd <= 0:
                continue
            rank, label = world_scope(sent, span)
            cand = (rank, usd, label, url,
                    f"{note} — {sent.strip()[:220]}")
            if best is None or (cand[0], cand[1]) > (best[0],
                                                     best[1]):
                best = cand
    if best is None:
        return None
    return best[1], best[2], best[3], best[4]


def world_due(rec, entry, today):
    """World-lane cadence: never searched is always due; within
    NEAR_DAYS of release at most once a day; within
    WORLD_MID_DAYS every WORLD_MID_CADENCE_DAYS; beyond that
    weekly. Because a searched title drops out of the due set
    until its cadence elapses, the trending-rank sort in main()
    cannot starve the tail: the rotation keeps advancing and
    reaches every world title — presale milestones can land
    months before release (Doomsday was reported at ~3 months
    out), so far titles must rotate in, not wait behind the
    near queue."""
    last = (rec or {}).get("last_tavily")
    if not last:
        return True
    try:
        age = (today - date.fromisoformat(last)).days
    except ValueError:
        return True
    if entry["days_to_release"] <= NEAR_DAYS:
        return age >= 1
    if entry["days_to_release"] <= WORLD_MID_DAYS:
        return age >= WORLD_MID_CADENCE_DAYS
    return age >= FAR_CADENCE_DAYS


def tavily_search(query, keys):
    """POST one search to api.tavily.com (same contract as
    tavily_boxoffice.tavily_search): keys are (slot, value) pairs
    tried in order; returns (data, slot_used); raises the last
    error when every key fails."""
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
        except Exception as e:
            print(f"advance: tavily key slot {slot} failed "
                  f"({type(e).__name__}), trying next")
            last_err = e
    raise last_err


def tavily_keys():
    keys = []
    for slot, env in (("primary", "TAVILY_API_KEY"),
                      ("backup", "TAVILY_API_KEY_BACKUP")):
        v = (os.environ.get(env) or "").strip()
        if v:
            keys.append((slot, v))
    return keys


# --- state ---------------------------------------------------------------

def load_state(root):
    path = os.path.join(root, STATE_REL)
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(
                    data.get("titles"), dict):
                return data
        except (ValueError, OSError):
            pass
    return {"titles": {}}


def save_state(root, state):
    path = os.path.join(root, STATE_REL)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    content = json.dumps(state, ensure_ascii=False, indent=2,
                         sort_keys=True) + "\n"
    existing = ""
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            existing = f.read()
    if existing == content:
        return False
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return True


def tavily_due(rec, entry, today):
    """Per-title Tavily cadence (India lane): within NEAR_DAYS of
    release, at most once a DAY (2026-11-02 change — "every run"
    re-searched the identical nearest 12 titles twice a day and
    the queue behind them never advanced); further out, at most
    once per FAR_CADENCE_DAYS."""
    last = (rec or {}).get("last_tavily")
    if entry["days_to_release"] <= NEAR_DAYS:
        return last != today.isoformat()
    if not last:
        return True
    try:
        return (today - date.fromisoformat(last)).days >= FAR_CADENCE_DAYS
    except ValueError:
        return True


# --- main ------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Pre-release advance-booking collector: find "
                    "advance grosses for upcoming published movies "
                    "and merge them into js/advance-data.js.")
    ap.add_argument("--apply", action="store_true",
                    help="write js/advance-data.js + state "
                         "(default: dry-run)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print what would be written (default)")
    ap.add_argument("--root", default=ROOT, help="repo root")
    ap.add_argument("--today", default=None,
                    help="override run date YYYY-MM-DD (testing)")
    ap.add_argument("--max-searches", type=int, default=MAX_SEARCHES,
                    help="per-run Tavily cap, India lane (default 12)")
    ap.add_argument("--max-world-searches", type=int,
                    default=WORLD_MAX_SEARCHES,
                    help="per-run Tavily cap, world lane (default 6)")
    ap.add_argument("--window-days", type=int, default=WINDOW_DAYS,
                    help="watchlist horizon in days (default 90)")
    args = ap.parse_args()
    today = (date.fromisoformat(args.today) if args.today
             else date.today())
    root = args.root
    do_write = args.apply and not args.dry_run

    watchlist = load_watchlist(root, today, args.window_days)
    print(f"advance: {len(watchlist)} published movie(s) releasing "
          f"in the next {args.window_days} days, today "
          f"{today.isoformat()}")
    for e in watchlist[:15]:
        trend = (f", trending #{e['trend_idx'] + 1}"
                 if e.get("trend_idx") is not None else "")
        print(f"  watch: {e['title']} ({e['tmdb_id']}) rel "
              f"{e['release_date'].isoformat()} "
              f"(+{e['days_to_release']}d, popularity "
              f"{e['popularity']:.1f}{trend})")
    if len(watchlist) > 15:
        print(f"  watch: ... and {len(watchlist) - 15} more")

    state = load_state(root)
    titles_state = state.setdefault("titles", {})

    # --- source 1: Sacnilk live page (one fetch, all candidates) ---
    found = {}   # tmdb_id -> {date, day, collection, source, detail}
    html = fetch_live_page()
    cards = parse_live_cards(html, today) if html else []
    print(f"advance: sacnilk live page: {len(cards)} pre-release "
          f"card(s)")
    matched_ids = set()
    for card in cards:
        entry = match_card(card, watchlist)
        if entry is None:
            print(f"  live card unmatched: {card['title']} "
                  f"(rel {card['release_date'].isoformat()}, "
                  f"Rs{card['advance_cr']:.2f} Cr)")
            continue
        usd = round(card["advance_cr"] * 1e7 / sb.INR_PER_USD)
        found[entry["tmdb_id"]] = {
            "date": entry["release_date"].isoformat(), "day": "",
            "collection": usd, "source": "sacnilk-live",
            "detail": (f"{card['title']} Rs{card['advance_cr']:.2f} Cr "
                       f"advance gross so far ({card['meta']}) "
                       f"{card['slug_url']}")}
        matched_ids.add(entry["tmdb_id"])
        print(f"  live match: {entry['title']} ({entry['tmdb_id']}) "
              f"Rs{card['advance_cr']:.2f} Cr -> ${usd:,} "
              f"[sacnilk-live]")

    # --- sources 2+3: Tavily, in two lanes with separate caps ---
    # One shared queue is what starved everything (see docstring):
    # the India lane keeps its query/acceptance; the world lane
    # gets its own cap, rotation and presale acceptance.
    keys = tavily_keys()
    if not keys:
        print("advance: SKIP tavily — no TAVILY_API_KEY / "
              "TAVILY_API_KEY_BACKUP in env")

    def run_search(entry, query):
        """One Tavily search with state bookkeeping; returns the
        results list or None on failure."""
        tid = entry["tmdb_id"]
        rec = titles_state.setdefault(tid, {})
        rec["last_tavily"] = today.isoformat()
        rec["tavily_attempts"] = int(rec.get("tavily_attempts")
                                     or 0) + 1
        try:
            data, _slot = tavily_search(query, keys)
        except Exception as e:
            print(f"  tavily failed for {entry['title']}: "
                  f"{type(e).__name__}")
            return None
        return data.get("results")

    # --- source 2: India lane (unchanged query + acceptance) ---
    india_due = [e for e in watchlist
                 if e["industry"] != "world"
                 and e["tmdb_id"] not in matched_ids
                 and tavily_due(titles_state.get(e["tmdb_id"]),
                                e, today)]
    # Trending rank order (shared definition, see trend_key):
    # the cap is spent on the high-trending titles first, not on
    # whichever micro-title happens to release soonest.
    india_due.sort(key=trend_key)
    if keys:
        searches = 0
        for entry in india_due:
            if searches >= args.max_searches:
                print(f"advance: india tavily cap "
                      f"{args.max_searches} reached; "
                      f"{len(india_due) - searches} due title(s) "
                      f"deferred to the next run")
                break
            searches += 1
            year = entry["release_date"].year
            query = (f'"{entry["title"]}" advance booking '
                     f'collection {year}')
            results = run_search(entry, query)
            if results is None:
                continue
            hit = extract_tavily_figure(results, entry)
            if hit is None:
                print(f"  tavily: {entry['title']} "
                      f"({entry['tmdb_id']}) — no accepted "
                      f"advance figure (stays on watchlist)")
                continue
            usd, day_label, src_url = hit
            found[entry["tmdb_id"]] = {
                "date": entry["release_date"].isoformat(),
                "day": day_label, "collection": usd,
                "source": "tavily", "detail": src_url}
            print(f"  tavily match: {entry['title']} "
                  f"({entry['tmdb_id']}) ${usd:,} "
                  f"[tavily] {src_url}")

    # --- source 3: world lane (presale reporting) ---
    world_due_list = [e for e in watchlist
                      if e["industry"] == "world"
                      and e["tmdb_id"] not in matched_ids
                      and world_due(titles_state.get(e["tmdb_id"]),
                                    e, today)]
    # Trending rank first (shared definition, see trend_key) —
    # the rotation STARTS from the tentpoles, so a Doomsday or
    # Dune is never queued behind same-week micro-titles;
    # least-recently-searched breaks the remaining ties. The
    # cadence gate (world_due) still throttles every title, so
    # across runs the rotation keeps advancing and reaches
    # every world title.
    world_due_list.sort(
        key=lambda e: (trend_key(e),
                       titles_state.get(e["tmdb_id"], {})
                       .get("last_tavily") or ""))
    if keys:
        wsearches = 0
        for entry in world_due_list:
            if wsearches >= args.max_world_searches:
                print(f"advance: world tavily cap "
                      f"{args.max_world_searches} reached; "
                      f"{len(world_due_list) - wsearches} due "
                      f"title(s) rotate to the next run")
                break
            wsearches += 1
            year = entry["release_date"].year
            query = (f'"{entry["title"]}" presales pre-sales '
                     f'advance ticket sales {year}')
            results = run_search(entry, query)
            if results is None:
                continue
            hit = extract_world_figure(results, entry)
            if hit is None:
                print(f"  world: {entry['title']} "
                      f"({entry['tmdb_id']}) — no accepted "
                      f"presale figure (stays in rotation)")
                continue
            usd, scope_label, src_url, detail = hit
            found[entry["tmdb_id"]] = {
                "date": entry["release_date"].isoformat(),
                "day": "", "collection": usd,
                "source": "tavily-world", "scope": scope_label,
                "detail": f"{detail} [{src_url}]"}
            print(f"  world match: {entry['title']} "
                  f"({entry['tmdb_id']}) ${usd:,} "
                  f"[{scope_label}] {src_url}")

    # --- state bookkeeping (checked = judged against a source) ---
    for e in watchlist:
        rec = titles_state.setdefault(e["tmdb_id"], {})
        rec["last_checked"] = today.isoformat()
        if e["tmdb_id"] in found:
            rec["last_found"] = today.isoformat()
            rec["last_source"] = found[e["tmdb_id"]]["source"]
            rec["last_figure_usd"] = found[e["tmdb_id"]]["collection"]
            if found[e["tmdb_id"]].get("scope"):
                rec["last_scope"] = found[e["tmdb_id"]]["scope"]
                rec["last_detail"] = found[e["tmdb_id"]]["detail"]
    # Prune state for titles that left the watchlist horizon and
    # have already released (keeps the file bounded).
    for tid in list(titles_state):
        if tid not in {e["tmdb_id"] for e in watchlist}:
            del titles_state[tid]

    # --- merge into js/advance-data.js (same rules as the reader) ---
    adv_path = os.path.join(root, "js", "advance-data.js")
    merged = sb.read_js_map(adv_path, "FA_ADVANCE")
    for tid, f in found.items():
        rows = [r for r in merged.get(tid, [])
                if not (r.get("date") == f["date"]
                        and (r.get("day") or "") == f["day"])]
        old = [r for r in merged.get(tid, [])
               if r.get("date") == f["date"]
               and (r.get("day") or "") == f["day"]]
        row = {"date": f["date"], "day": f["day"],
               "collection": f["collection"]}
        if f.get("scope"):
            # World-lane rows carry their scope so a worldwide
            # presale total is never silently compared with a
            # single-venue one. The homepage renderer ignores
            # unknown keys; the scope is provenance until the
            # parent chooses to display it.
            row["scope"] = f["scope"]
        if old and isinstance(old[0].get("collection"),
                              (int, float)) \
                and old[0]["collection"] > row["collection"]:
            # Advance/presale totals are cumulative "so far"
            # figures: a smaller figure found later is stale
            # evidence (an older milestone still circulating),
            # never a correction — keep the larger row whole,
            # with its own scope.
            row = old[0]
        rows.append(row)
        rows.sort(key=lambda r: r.get("date", ""))
        merged[tid] = rows
    for tid in list(merged):
        kept = [r for r in merged[tid]
                if (r.get("date") or "") > today.isoformat()]
        if kept:
            merged[tid] = kept
        else:
            del merged[tid]

    print(f"advance: {len(found)} figure(s) accepted this run; "
          f"merged file would hold {len(merged)} title(s)")
    if not do_write:
        for tid, f in found.items():
            print(f"  would write: {tid} {f['date']} "
                  f"day={f['day']!r} ${f['collection']:,} "
                  f"via {f['source']}"
                  f"{' [' + f['scope'] + ']' if f.get('scope') else ''}")
        print("advance: DRY-RUN — nothing written")
        return 0
    changed = sb.write_js_map(adv_path, "FA_ADVANCE", merged,
                              sb.ADVANCE_HEADER)
    state_changed = save_state(root, state)
    print(f"advance: advance-data.js written: {changed} "
          f"({len(merged)} title(s)); state written: {state_changed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
