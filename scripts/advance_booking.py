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
state files) and drives the Tavily cadence: a title within 21
days of release is searched every run; a further-out title at
most once a week, so far-out titles (which correctly yield
nothing for a long time) do not burn the search cap. The Sacnilk
live page costs one fetch regardless, so every candidate is
checked against it on every run. The per-run Tavily cap
(default 12) is spent nearest-release first, popularity as the
tiebreak.

Usage:
  advance_booking.py            dry-run (default): print the
                                watchlist, what it found and what
                                it WOULD write; write nothing.
  advance_booking.py --apply    merge findings into
                                js/advance-data.js and update
                                out/advance-booking-state.json.
  advance_booking.py --today YYYY-MM-DD   override the run date.
  advance_booking.py --max-searches N     Tavily cap (default 12).
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
MAX_SEARCHES = 12         # per-run Tavily cap
STATE_REL = os.path.join("out", "advance-booking-state.json")
MONTHS = sb.MONTHS


# --- watchlist ---------------------------------------------------------

def load_watchlist(root, today, window_days=WINDOW_DAYS):
    """Published movies releasing in (today, today + window_days].
    Returns entries {tmdb_id, title, release_date (date),
    days_to_release, popularity} sorted by popularity desc."""
    path = os.path.join(root, "js", "published-titles.js")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    data = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
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
        out.append({"tmdb_id": str(tid), "title": title,
                    "release_date": rel,
                    "days_to_release": (rel - today).days,
                    "popularity": pop})
    out.sort(key=lambda e: (-e["popularity"], e["days_to_release"]))
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
    """Per-title Tavily cadence: within NEAR_DAYS of release, every
    run; further out, at most once per FAR_CADENCE_DAYS."""
    if entry["days_to_release"] <= NEAR_DAYS:
        return True
    last = (rec or {}).get("last_tavily")
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
                    help="per-run Tavily cap (default 12)")
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
        print(f"  watch: {e['title']} ({e['tmdb_id']}) rel "
              f"{e['release_date'].isoformat()} "
              f"(+{e['days_to_release']}d, popularity "
              f"{e['popularity']:.1f})")
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

    # --- source 2: Tavily for the rest of the due watchlist ---
    keys = tavily_keys()
    due = [e for e in watchlist
           if e["tmdb_id"] not in matched_ids
           and tavily_due(titles_state.get(e["tmdb_id"]), e, today)]
    due.sort(key=lambda e: (e["days_to_release"], -e["popularity"]))
    searches = 0
    if not keys:
        print("advance: SKIP tavily — no TAVILY_API_KEY / "
              "TAVILY_API_KEY_BACKUP in env")
        due = []
    for entry in due:
        if searches >= args.max_searches:
            print(f"advance: tavily cap {args.max_searches} reached; "
                  f"{len(due) - searches} due title(s) deferred to "
                  f"the next run")
            break
        tid = entry["tmdb_id"]
        rec = titles_state.setdefault(tid, {})
        rec["last_tavily"] = today.isoformat()
        rec["tavily_attempts"] = int(rec.get("tavily_attempts") or 0) + 1
        searches += 1
        year = entry["release_date"].year
        query = f'"{entry["title"]}" advance booking collection {year}'
        try:
            data, _slot = tavily_search(query, keys)
        except Exception as e:
            print(f"  tavily failed for {entry['title']}: "
                  f"{type(e).__name__}")
            continue
        hit = extract_tavily_figure(data.get("results"), entry)
        if hit is None:
            print(f"  tavily: {entry['title']} ({tid}) — no accepted "
                  f"advance figure (stays on watchlist)")
            continue
        usd, day_label, src_url = hit
        found[tid] = {"date": entry["release_date"].isoformat(),
                      "day": day_label, "collection": usd,
                      "source": "tavily", "detail": src_url}
        print(f"  tavily match: {entry['title']} ({tid}) ${usd:,} "
              f"[tavily] {src_url}")

    # --- state bookkeeping (checked = judged against a source) ---
    for e in watchlist:
        rec = titles_state.setdefault(e["tmdb_id"], {})
        rec["last_checked"] = today.isoformat()
        if e["tmdb_id"] in found:
            rec["last_found"] = today.isoformat()
            rec["last_source"] = found[e["tmdb_id"]]["source"]
            rec["last_figure_usd"] = found[e["tmdb_id"]]["collection"]
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
        rows.append({"date": f["date"], "day": f["day"],
                     "collection": f["collection"]})
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
                  f"via {f['source']}")
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
