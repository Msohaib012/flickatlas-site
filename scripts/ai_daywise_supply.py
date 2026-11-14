#!/usr/bin/env python3
"""AI day-wise supply for FlickAtlas (owner order 2026-11-14).

Why this exists: the box-office figures must come from AI
(Gemini + Tavily search, evidence-reviewed), not website scraping —
but the existing AI lanes cannot supply a figure for a title the
direct readers never covered, by design:

  * scripts/tavily_boxoffice.py only queries titles that ALREADY have
    day-wise rows (it refills/updates TODAY's figure).
  * scripts/gemini_boxoffice.py only VERIFIES Tavily candidates
    against reader data (baseline_day_matches) — Gemini never
    supplies a number for a missing day.
  * scripts/home_boxoffice_worldwide.py demands ONE worldwide total
    per window and explicitly rejects "India Net alone".

So a title with no Sacnilk page (no day-wise rows) stays blank on
the homepage even when trade sites DO report its Day 1 collection —
DNK Day 1 Rs 1.78 Cr (TrackTollywood) and Itllu Arjuna Day 1
Rs 0.15 Cr (Sacnilk live estimate) were both findable by AI on
2026-11-14 while their cards showed nothing.

This step supplies those missing days. It reuses the existing
validators wherever they exist and adds only the gates the
missing-day case needs:

  * Selection: published movies released in the last 14 days with NO
    day-wise rows at all (the empty cards). Streaming-first titles
    (OTT providers, no theatrical run) are skipped, never filled.
  * Search: Tavily, three queries per title (collection, day 1, live estimate).
  * Extract: Gemini reads the results and returns figures with a
    verbatim quote + source URL. Gemini never supplies a number —
    the quote must appear verbatim in the search result.
  * Validate (deterministic, per figure):
      - source host on the trade allowlist (no social/video/linked-in
        hosts — a Facebook post once claimed DNK Day 1 at Rs 102 Cr
        against TrackTollywood's Rs 1.78 Cr; the allowlist kills it);
      - quote is an exact substring of the result content;
      - the result mentions the film (tavily_boxoffice
        .result_mentions_film);
      - covers exactly one completed day's India Net collection
        ("Day N India Net"); advance / premiere / pre-sales /
        weekend-total / worldwide / overseas figures are rejected;
      - the day's date equals release_date + (N - 1) and is before
        today (completed days only);
      - 0 < amount <= 120 Rs Cr (same MAX_DAY_CR as the other lanes);
      - no scope-poison terms in the quote, except the film's own
        original language (a single-language film has no split);
      - the amount string appears in the quote.
  * Write: out/boxoffice-staging/tavily-supply.json in the
    multisource format, source "tavily-supply". The averaging engine
    merges it into js/daywise-data.js like any other source; the
    homepage tracked fallback then fills the cards, and the detail
    pages show the rows + boxes. A movie+day with no source data
    stays absent — never invented.

Pipeline wiring: run after the Gemini/Tavily steps, before
multisource_boxoffice.py. Any new file this step writes must be
added to scripts/commit_with_retry.sh stage_all().

Local use: import this module and call run() with injected
tavily_fn / gemini_fn (same pattern as run_local.py for the
worldwide collector) — the surrogates supply the keys.
"""

import argparse
import datetime as dt
import json
import os
import re
import sys
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import tavily_boxoffice as tv  # noqa: E402  (extract + title + poison)

MAX_DAY_CR = 120.0
SOURCE = "tavily-supply"
WINDOW_DAYS = 14  # homepage Bollywood window

# Trade / news hosts whose box-office reporting is admissible as
# evidence for a missing day. Social, video, aggregator and
# LinkedIn hosts are NOT here — they cannot originate a figure.
TRADE_HOSTS = (
    "sacnilk.com", "bollywoodhungama.com", "koimoi.com",
    "filmibeat.com", "bollymoviereviewz.com", "tracktollywood.com",
    "flickonclick.com", "filmynewsnetwork.com", "tenvow.com",
    "123telugu.com", "timesofindia.indiatimes.com",
    "indianexpress.com", "hindustantimes.com", "dnaindia.com",
    "news18.com", "pinkvilla.com", "bollywoodlife.com",
    "firstpost.com", "theweek.in", "ndtv.com",
    "deccanchronicle.com", "greatandhra.com", "telugu360.com",
    "andhrawatch.com", "mirchi9.com", "tupaki.com", "gulte.com",
    "teluguone.com", "andhrajyothy.com", "eenadu.net",
    "sakshi.com", "timesnownews.com", "zeenews.india.com",
    "abplive.com", "jagran.com", "amarujala.com",
)

LANG_NAMES = {
    "hi": "hindi", "ta": "tamil", "te": "telugu", "kn": "kannada",
    "ml": "malayalam", "bn": "bengali", "mr": "marathi",
    "pa": "punjabi", "gu": "gujarati", "en": "english",
}

AMOUNT_RE = re.compile(
    r"(?:rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)\s*(crore|cr\.?|lakh|lacs?)\b",
    re.IGNORECASE)
RANGE_RE = re.compile(r"[\d,.]+\s*(?:–|-|to)\s*[\d,.]+\s*(?:crore|cr\.?|lakh)",
                      re.IGNORECASE)
COVERS_RE = re.compile(r"day\s+(\d+)", re.IGNORECASE)
# Scope terms that disqualify a quote as a completed-day India Net
# figure. A "live estimate" for a completed day is NOT disqualifying
# — current-day figures arrive as live estimates and are revised by
# later reads, exactly like the direct readers handle them.
BAD_SCOPE = ("advance", "premiere", "pre-sale", "presale", "preview",
             "weekend total", "week 1 total", "week total",
             "worldwide", "overseas", "gross", "budget",
             "opening total")


def log(msg):
    print(f"ai-supply: {msg}", flush=True)


def host_of(url):
    try:
        return urlparse(url).netloc.lower().replace("www.", "")
    except Exception:
        return ""


def trade_host(url):
    host = host_of(url)
    return any(host == h or host.endswith("." + h) for h in TRADE_HOSTS)


def parse_amount_cr(figure):
    """'Rs 1.78 Cr' -> 1.78; '58.75 lakh' -> 0.59; ranges/USD -> None."""
    text = str(figure or "").strip()
    if not text or "$" in text or RANGE_RE.search(text):
        return None
    m = AMOUNT_RE.search(text)
    if not m:
        return None
    try:
        value = float(m.group(1).replace(",", ""))
    except ValueError:
        return None
    unit = m.group(2).lower()
    if unit.startswith("lakh") or unit.startswith("lac"):
        value = value / 100.0
    return round(value, 2)


def read_js_map(path):
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    start, end = raw.index("{"), raw.rindex("}")
    return json.loads(raw[start:end + 1])


def select_titles(published, daywise, today):
    """Published movies, released in the last WINDOW_DAYS, with no
    day-wise rows and no OTT providers (theatrical only)."""
    out = []
    for tid, ent in sorted(published.items(), key=lambda kv: kv[0]):
        if not str(tid).isdigit():
            continue
        if (ent or {}).get("type", "movie") != "movie":
            continue
        rel = str((ent or {}).get("release_date") or "")
        try:
            rel_d = dt.date.fromisoformat(rel)
        except ValueError:
            continue
        age = (today - rel_d).days
        if age < 0 or age >= WINDOW_DAYS:
            continue
        if daywise.get(str(tid)):
            continue
        if (ent or {}).get("providers"):
            continue  # streaming-first: no theatrical box office to fill
        title = str((ent or {}).get("title") or "").strip()
        if not title:
            continue
        out.append({"id": str(tid), "title": title,
                    "original_title": str((ent or {}).get("original_title") or ""),
                    "original_language": str((ent or {}).get("original_language") or ""),
                    "release_date": rel})
    return out


def build_prompt(title, release_date, snippets):
    return (
        f"Movie: {title} (released {release_date}). Below are web search results about its box office collection.\n"
        "Extract EVERY box office figure stated in these results — Day 1 / Day 2 / ... collections, totals, gross, net, "
        "advance booking, premiere, worldwide, overseas, everything. Do NOT filter by scope; report each figure as stated. "
        "For each figure give: the figure exactly as stated (e.g. 'Rs 1.78 Cr'), what it covers in plain words "
        "(e.g. 'Day 1 collection', 'Day 1 total gross', 'advance booking'), "
        "the source URL, and a short verbatim quote from the result proving it. "
        "If NO box office figure is stated anywhere, return an empty list. "
        "Do not guess, do not infer, do not use your own knowledge — only what these results state.\n"
        "Reply as JSON only: {\"figures\": [{\"figure\": \"...\", \"covers\": \"...\", \"source_url\": \"...\", \"quote\": \"...\"}]}.\n\n"
        + snippets)


def parse_gemini(text):
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
        if isinstance(data, dict) and isinstance(data.get("figures"), list):
            return data["figures"]
    except Exception:
        pass
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        try:
            data = json.loads(text[start:end + 1])
            if isinstance(data, dict) and isinstance(data.get("figures"), list):
                return data["figures"]
        except Exception:
            pass
    return []


def validate_figure(item, fig, by_url, today):
    """Returns (row, None) on accept, (None, reason) on reject."""
    title = item["title"]
    url = str(fig.get("source_url") or "").strip()
    quote = str(fig.get("quote") or "").strip()
    covers = str(fig.get("covers") or "").strip()
    if not url.startswith("https://"):
        return None, "source URL missing/invalid"
    if not trade_host(url):
        return None, f"non-trade host {host_of(url)}"
    if any(b in host_of(url) for b in tv.BLOCKED_DOMAINS):
        return None, "blocked source domain"
    src = by_url.get(url)
    if not src:
        return None, "source URL not in search results"
    content = str(src.get("content") or "")
    if not quote or quote not in content:
        return None, "quote not verbatim in source"
    # Title match. tv.result_mentions_film skips single-word titles
    # shorter than 4 chars, so a short acronym title (DNK) can never
    # match through it — fall back to a whole-word check on the result
    # title + quote for those. (The shared validator is left untouched;
    # this fallback lives only in the supply step.)
    title_ok = tv.result_mentions_film(
        title, str(src.get("title") or ""), quote)
    if not title_ok:
        norm = re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()
        if len(norm.split()) == 1 and 2 <= len(norm) <= 3:
            hay = " " + re.sub(
                r"[^a-z0-9]+", " ",
                (str(src.get("title") or "") + " " + quote).lower()).strip() + " "
            title_ok = (" " + norm + " ") in hay
    if not title_ok:
        return None, "quoted evidence/title mismatch"
    # The day is read from the QUOTE (the evidence), not from Gemini's
    # covers label — Gemini structures, the code decides. Scope is
    # judged on the quote PLUS the covers label, the result title and
    # the URL: a bare table row carries no scope words itself, so an
    # advance-booking row (Sacnilk quicknews "Advance_Booking_Report")
    # would otherwise pass as a Day 1 collection. A quote that states
    # an advance / premiere / weekend / worldwide figure is not a
    # completed-day India Net figure, whatever its label says.
    m = COVERS_RE.search(quote)
    if not m:
        m = COVERS_RE.search(covers)
    if not m:
        return None, "no Day N in evidence"
    day = int(m.group(1))
    if day < 1:
        return None, "day < 1"
    scope_text = " ".join([quote, covers, str(src.get("title") or ""), url])
    if any(b in scope_text.lower() for b in BAD_SCOPE):
        return None, "not a completed-day India Net figure (scope)"
    try:
        rel_d = dt.date.fromisoformat(item["release_date"])
    except ValueError:
        return None, "bad release date"
    target = rel_d + dt.timedelta(days=day - 1)
    if target >= today:
        return None, "day not completed yet"
    cr = parse_amount_cr(fig.get("figure"))
    if cr is None:
        return None, f"unparseable/range/USD figure ({fig.get('figure')!r})"
    if not (0 < cr <= MAX_DAY_CR):
        return None, f"amount {cr} outside 0..{MAX_DAY_CR} Cr"
    own_lang = LANG_NAMES.get(item.get("original_language") or "", "")
    poison = tuple(p for p in tv.SEGMENT_POISON if p != own_lang)
    if any(p in quote.lower() for p in poison):
        return None, "scope poison term in quoted evidence"
    amount_text = str(fig.get("figure") or "")
    num = re.search(r"[\d,]+(?:\.\d+)?", amount_text)
    if not num or num.group(0).replace(",", "") not in quote.replace(",", ""):
        return None, "amount string not in quote"
    row = {"day": day, "date": target.isoformat(),
           "collection_inr_cr": cr, "source": SOURCE,
           "source_url": url, "gemini_quote": quote}
    return row, None


def run(tavily_fn, gemini_fn, root, today=None, title_ids=None,
        dry_run=False, out_path=None):
    today = today or dt.date.today()
    pub = read_js_map(os.path.join(root, "js", "published-titles.js"))
    daywise = read_js_map(os.path.join(root, "js", "daywise-data.js"))
    selected = select_titles(pub, daywise, today)
    if title_ids:
        wanted = {str(t) for t in title_ids}
        selected = [s for s in selected if s["id"] in wanted]
    out = {}
    accepted, rejected, no_figure = 0, 0, 0
    for item in selected:
        queries = [f"\"{item['title']}\" box office collection",
                   f"\"{item['title']}\" box office collection day 1",
                   f"\"{item['title']}\" Day 1 collection live estimate"]
        results = []
        for q in queries:
            try:
                results.extend(tavily_fn(q) or [])
            except Exception as exc:
                log(f"{item['id']} {item['title']}: Tavily error "
                    f"({type(exc).__name__})")
        seen, uniq = set(), []
        for r in results:
            u = (r or {}).get("url") or ""
            if u and u not in seen:
                seen.add(u)
                uniq.append(r)
        if not uniq:
            log(f"{item['id']} {item['title']}: no search results")
            no_figure += 1
            continue
        snippets = "\n".join(
            f"[{i + 1}] {r.get('url', '')} | {r.get('title', '')}\n"
            f"{(r.get('content', '') or '')[:600]}"
            for i, r in enumerate(uniq[:8]))
        try:
            raw = gemini_fn(
                build_prompt(item["title"], item["release_date"], snippets))
            figures = (raw.get("figures", []) if isinstance(raw, dict)
                       else parse_gemini(raw))
        except Exception as exc:
            # One retry: the Gemini helper is transient-failure prone
            # (HTTPError/TimeoutError) and a title that fails here waits
            # an hour otherwise.
            try:
                raw = gemini_fn(
                    build_prompt(item["title"], item["release_date"], snippets))
                figures = (raw.get("figures", []) if isinstance(raw, dict)
                           else parse_gemini(raw))
            except Exception as exc2:
                log(f"{item['id']} {item['title']}: Gemini error "
                    f"({type(exc2).__name__})")
                continue
        if not figures:
            log(f"{item['id']} {item['title']}: AI found no figure")
            no_figure += 1
            continue
        by_url = {r.get("url"): r for r in uniq}
        rows = []
        for fig in figures:
            if not isinstance(fig, dict):
                continue
            row, reason = validate_figure(item, fig, by_url, today)
            if row is None:
                rejected += 1
                log(f"reject {item['id']} {item['title']}: {reason}")
                continue
            if any(r["day"] == row["day"] for r in rows):
                continue  # first accepted source wins a day; the
                # averaging engine merges across sources, not here
            rows.append(row)
            accepted += 1
        if rows:
            rows.sort(key=lambda r: (r["date"], r["day"]))
            out[item["id"]] = rows
            for r in rows:
                log(f"accept {item['id']} {item['title']}: Day {r['day']} "
                    f"{r['date']} Rs {r['collection_inr_cr']} Cr "
                    f"({host_of(r['source_url'])})")
    if dry_run:
        print(json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True))
        log(f"DRY-RUN — would write {accepted} accepted, "
            f"{rejected} rejected, {no_figure} title(s) with no figure")
        return {"accepted": accepted, "rejected": rejected,
                "no_figure": no_figure, "out": out}
    out_path = out_path or os.path.join(
        root, "out", "boxoffice-staging", "tavily-supply.json")
    existing = {}
    if os.path.exists(out_path):
        try:
            with open(out_path, encoding="utf-8") as f:
                existing = json.load(f) or {}
        except Exception:
            existing = {}
    merged = dict(existing)
    for tid, rows in out.items():
        merged[tid] = rows
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=2, sort_keys=True)
    log(f"wrote {out_path}: {accepted} accepted, {rejected} rejected, "
        f"{no_figure} title(s) with no figure")
    return {"accepted": accepted, "rejected": rejected,
            "no_figure": no_figure, "out": out}


def main():
    ap = argparse.ArgumentParser(
        description="AI day-wise supply: fill missing India Net days "
                    "for published movies with no day-wise rows.")
    ap.add_argument("--root", default=None)
    ap.add_argument("--today", default=None)
    ap.add_argument("--titles", default=None,
                    help="comma-separated TMDB ids (default: all empty)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    root = args.root or os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)))
    today = (dt.date.fromisoformat(args.today) if args.today
             else dt.date.today())
    title_ids = ([t.strip() for t in args.titles.split(",") if t.strip()]
                 if args.titles else None)
    # Pipeline mode: keys from the environment (GitHub secrets), the
    # same pattern as tavily_boxoffice.py / gemini_boxoffice.py.
    # (Local runs inject the surrogate helpers instead — see run().)
    import urllib.request  # noqa: E402
    import gemini_batch  # noqa: E402

    TAVILY_URL = "https://api.tavily.com/search"

    def tavily_fn(query):
        keys = [os.environ.get("TAVILY_API_KEY", "").strip(),
                os.environ.get("TAVILY_API_KEY_BACKUP", "").strip()]
        keys = [k for k in keys if k]
        last = None
        for key in keys:
            try:
                body = json.dumps(
                    {"api_key": key, "query": query,
                     "search_depth": "advanced", "max_results": 5,
                     "include_answer": False}).encode("utf-8")
                req = urllib.request.Request(
                    TAVILY_URL, data=body,
                    headers={"Content-Type": "application/json"},
                    method="POST")
                with urllib.request.urlopen(req, timeout=40) as resp:
                    data = json.load(resp)
                results = data.get("results", []) or []
                return results if isinstance(results, list) else []
            except Exception as exc:  # noqa: BLE001 - try backup key
                last = exc
                continue
        raise RuntimeError(f"Tavily search failed ({last})")

    FIGURES_SCHEMA = {
        "type": "OBJECT",
        "properties": {
            "figures": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "figure": {"type": "STRING"},
                        "covers": {"type": "STRING"},
                        "source_url": {"type": "STRING"},
                        "quote": {"type": "STRING"},
                    },
                    "required": ["figure", "covers", "source_url",
                                 "quote"],
                },
            },
        },
        "required": ["figures"],
    }
    keys = gemini_batch.gemini_keys()

    def gemini_fn(prompt):
        out = gemini_batch.call_gemini(keys, prompt, FIGURES_SCHEMA,
                                       max_tokens=4096)
        if not isinstance(out, dict):
            raise RuntimeError("Gemini returned no review")
        return out

    summary = run(tavily_fn, gemini_fn, root, today=today,
                  title_ids=title_ids, dry_run=args.dry_run,
                  out_path=args.out)
    return 0 if summary["accepted"] >= 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
