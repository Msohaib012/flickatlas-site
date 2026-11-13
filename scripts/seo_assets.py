#!/usr/bin/env python3
"""FlickAtlas SEO assets — regenerate sitemap.xml, robots.txt and
js/seo-meta.json from the LIVE site data (js/published-titles.js,
js/articles-data.js, js/daywise-data.js, js/reviews-data.js,
out/episodes.json).

Run hourly in the pipeline (step "SEO assets", after all data-writing
steps, before "Commit if changed"). Stdlib only, fully DETERMINISTIC:
sorted keys, no timestamps — the files only change when the DATA
changes, so the hourly run does not force a spurious commit.

Outputs:
  sitemap.xml      — one urlset: all listing pages + every movie/show
                     detail URL + every news article URL + every
                     day-wise box-office URLs through theatrical Day 30;
                     later records remain available only in aggregate totals.
  robots.txt       — explicit OAI-SearchBot allow plus wildcard Allow /
                     (except private /api/ paths), with public feeds allowed.
  js/seo-meta.json — compact per-URL meta map the Cloudflare Worker
                     reads to inject <title>/meta/OG/JSON-LD into the
                     client-rendered detail shells (one shell serves
                     ~250 URLs, so static meta cannot work there).
                     Keys: "movie:<tmdb>", "tv:<tmdb>", "news:<slug>",
                     "daywise:<tmdb>", "cat:<industry>". Each entry also
                     carries a pre-rendered semantic-HTML "ssr" facts
                     block; the Worker splices it into <main id="app">
                     so crawlers that never run JS still receive the
                     page's facts (every page script replaces #app
                     wholesale on boot, so visitors see no change).
  llms-full.txt    — llms.txt's sections/notes plus the top published
                     titles with one-line facts, for AI readers.

Meta rules (owner: accurate titles, never page-name + site-name):
  - Movie and series titles always include their complete fixed page-template
    labels; article titles remain the full published headline.
  - Descriptions include only page-backed story text and factual values;
    no unavailable budget, box-office total, rating or review score is claimed.
  - Descriptions are natural, useful snippets under 160 chars; keyword
    phrases are page-specific and never claim playback/download services.
  - No invented titles, no keyword stuffing.
"""
import json
import math
import os
import re
import sys
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html import escape as html_escape, unescape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "https://flickatlas.co.uk"
IMG = "https://image.tmdb.org/t/p"

# Import-safe defaults for pure metadata helpers and offline fixtures.
# main() replaces these with the checked-in published data before building.
PUBLISHED = {}
ARTICLES = {}
DAYWISE = {}
REVIEWS = {}
WORLDWIDE = {}
EPISODE_TRACKER = {"episodes": {}}
# Phase 2 SSR (2026-11-14): top cast + director per title, from the
# pipeline-only credits cache (out/credits.json, filled by
# scripts/fetch-credits.py). Missing file or missing title -> no cast
# section; the generator must never fail on absent credits.
CREDITS = {}

INDUSTRY_LABEL = {
    "bollywood": "Bollywood",
    "world": "World Cinema",
    "pakistani": "Pakistani",
}

CAT_META = {
    "bollywood": (
        "Bollywood Movies & TV Shows | FlickAtlas",
        "Browse Bollywood films and Indian-language cinema, plus related TV titles. "
        "Explore available cast, story and release details on FlickAtlas.",
        "Bollywood movies, Indian films, Hindi films, Bollywood TV shows",
    ),
    "world": (
        "World Cinema Movies & TV Shows | FlickAtlas",
        "Browse international films and television series on FlickAtlas, including "
        "Hollywood titles. Explore available cast, story and release information.",
        "World Cinema movies, Hollywood films, international TV series",
    ),
    "pakistani": (
        "Pakistani Movies & Dramas | FlickAtlas",
        "Browse Pakistani films and drama series on FlickAtlas. Explore available "
        "title, cast, episode and release information from the listed catalogue.",
        "Pakistani movies, Pakistani dramas, Pakistani TV serials, Lollywood films",
    ),
}

# (path, changefreq, priority, lastmod-source)
STATIC_PAGES = [
    ("/", "daily", "1.0", "max"),
    ("/movies", "daily", "0.9", "titles"),
    ("/tv", "daily", "0.9", "titles"),
    ("/box-office", "daily", "0.9", "daywise"),
    ("/box-office/milestones", "weekly", "0.8", "daywise"),
    ("/upcoming", "daily", "0.9", "titles"),
    ("/most-awaited", "daily", "0.8", "titles"),
    ("/ott", "daily", "0.8", "titles"),
    ("/trailers", "daily", "0.8", "titles"),
    ("/celebrities", "daily", "0.8", "titles"),
    ("/episode-guides", "daily", "0.8", "titles"),
    ("/airing-today", "daily", "0.8", "titles"),
    ("/dramas", "daily", "0.8", "titles"),
    ("/where-to-watch", "daily", "0.8", "titles"),
    ("/news", "daily", "0.9", "articles"),
    ("/category?cat=bollywood", "weekly", "0.8", "titles"),
    ("/category?cat=world", "weekly", "0.8", "titles"),
    ("/category?cat=pakistani", "weekly", "0.8", "titles"),
    ("/awards", "weekly", "0.7", "max"),
    ("/about", "monthly", "0.4", "max"),
    ("/contact", "monthly", "0.4", "max"),
    ("/privacy", "monthly", "0.3", "max"),
    ("/terms", "monthly", "0.3", "max"),
    ("/dmca", "monthly", "0.3", "max"),
]


def read_js_map(path, var):
    """Parse `window.<var> = {...};` into a dict (same shape as
    publish-titles.py's read_js_map)."""
    with open(path, encoding="utf-8") as f:
        s = f.read()
    i = s.index("{")
    j = s.rindex("}")
    return json.loads(s[i:j + 1])


def parse_date(s):
    """ISO or RFC822 date string -> 'YYYY-MM-DD' or None."""
    if not s or not isinstance(s, str):
        return None
    s = s.strip()
    try:
        # ISO dates start with YYYY-MM-DD. Do NOT test `"T" in s`: RFC822
        # dates contain a capital T in "GMT" and in Tue/Thu, which sent
        # them down the ISO branch, raised, and silently dropped
        # datePublished/dateModified for 49/159 articles (all the GMT- and
        # Tue/Thu-dated ones). Fixed 2026-10-28 (claude-seo audit).
        if re.match(r"^\d{4}-\d{2}-\d{2}", s):
            return datetime.fromisoformat(
                s.replace("Z", "+00:00")).date().isoformat()
        return parsedate_to_datetime(s).date().isoformat()
    except Exception:
        return None


def publication_stamp(value):
    """A genuine publication/edit date, preserving known precision.

    A date-only record stays date-only; timezone-aware ISO/RFC822 values
    become UTC ISO8601. Never infer a page date from a release/air date,
    a metadata refresh, a crawl, or the time this generator is run.
    """
    if not isinstance(value, str) or not value.strip():
        return ""
    value = value.strip()
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            return datetime.strptime(value, "%Y-%m-%d").date().isoformat()
        if re.match(r"^\d{4}-\d{2}-\d{2}", value):
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        else:
            parsed = parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            return parsed.date().isoformat()
        return parsed.astimezone(timezone.utc).isoformat(
            timespec="milliseconds").replace("+00:00", "Z")
    except (TypeError, ValueError, OverflowError):
        return ""


def publication_dates(entry):
    """First-published plus an explicitly recorded substantive edit only."""
    published = (publication_stamp(entry.get("published_at"))
                 or publication_stamp(entry.get("published")))
    modified = publication_stamp(entry.get("modified_at"))
    if published and modified:
        def instant(value):
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.replace(tzinfo=parsed.tzinfo or timezone.utc)
        if instant(modified) <= instant(published):
            modified = ""
    else:
        modified = ""
    return {"published": published, "modified": modified}


def page_lastmod(entry):
    dates = publication_dates(entry)
    return dates["modified"] or dates["published"]


def year_of(entry):
    d = entry.get("release_date") or entry.get("first_air_date") or ""
    return (d or "")[:4]


def fmt_money(n):
    """$2,667,723 -> $2.67M ; $45,300 -> $45.3k ; $800 -> $800."""
    try:
        n = float(n)
    except (TypeError, ValueError):
        return None
    if n >= 1_000_000:
        v = "%.2f" % (n / 1_000_000)
        v = v.rstrip("0").rstrip(".")
        return "$%sM" % v
    if n >= 1_000:
        return "$%.1fk" % (n / 1_000)
    return "$%d" % int(n)


def trunc(text, n=160):
    """Cut to <= n chars at a word boundary (no mid-word cut)."""
    text = re.sub(r"\s+", " ", (text or "").strip())
    if len(text) <= n:
        return text
    cut = text[:n].rsplit(" ", 1)[0]
    return cut if cut else text[:n]


def trunc_description(text, n=160):
    """Shorten a description at a word boundary and mark omitted text."""
    text = re.sub(r"\s+", " ", (text or "").strip())
    terminal = (".", "!", "?", "…", "。", "！", "？")
    if len(text) < n or (len(text) == n and text.endswith(terminal)):
        return text
    if n <= 0:
        return ""
    if n == 1:
        return "…"
    cut = text[:n - 1].rsplit(" ", 1)[0]
    if not cut:
        cut = text[:n - 1]
    cut = cut.rstrip(" ,;:-")
    return cut if cut.endswith(terminal) else cut + "…"


def plain_text(text):
    """Normalize a data field for safe, readable HTML metadata."""
    text = unescape(str(text or ""))
    text = re.sub(r"<[^>]*>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _number(value):
    """Return a finite numeric field, otherwise zero."""
    if isinstance(value, bool):
        return 0.0
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if math.isfinite(number) else 0.0


def normalized_drama_name(value):
    return re.sub(r"[^a-z0-9]+", " ", plain_text(value).lower()).strip()


def tv_episode_count(entry):
    """Match the TV page: tracker count first for Pakistani dramas."""
    fallback = int(_number(entry.get("number_of_episodes")))
    if entry.get("industry") != "pakistani":
        return fallback
    name = normalized_drama_name(entry.get("title"))
    aliases = {"dar": "dar e nijaat", "zehar": "zehar e mohabbat"}
    records = (EPISODE_TRACKER or {}).get("episodes", {})
    numbers = []
    for row in records.values():
        if not isinstance(row, dict):
            continue
        drama = normalized_drama_name(row.get("drama"))
        if aliases.get(drama, drama) != name:
            continue
        episode = row.get("episode")
        if type(episode) is int and episode > 0:
            numbers.append(episode)
    return max(numbers) if numbers else fallback


def append_meta(base, text, limit=160):
    """Append a complete or word-truncated fact without exceeding limit."""
    text = plain_text(text)
    room = limit - len(base) - 1
    if not text or room < 24:
        return base
    return base + " " + trunc_description(text, room)


def append_detail_list(base, details, limit=160):
    """Add complete search-relevant phrases, dropping lower-priority tails."""
    details = list(details)
    while details:
        addition = "Explore its " + natural_join(details) + "."
        if len(base) + 1 + len(addition) <= limit:
            return base + " " + addition
        details.pop()
    return base


def safe_keyword(value):
    """Keep relevant information queries; reject playback/download claims."""
    value = plain_text(value)
    if not value or len(value) > 100:
        return ""
    if re.search(r"\b(?:watch|stream|download|play)\s+(?:online|now|free)\b|"
                 r"\bonline\s+watch\b|\bfull\s+(?:movie|episode)\b",
                 value, re.I):
        return ""
    return value


def unique_keywords(values, limit=8):
    """Clean and case-insensitively deduplicate a short keyword list."""
    out, seen = [], set()
    for value in values:
        term = safe_keyword(value)
        key = term.lower()
        if term and key not in seen:
            out.append(term)
            seen.add(key)
            if len(out) >= limit:
                break
    return out


def compact_title(core, suffix="", limit=60):
    """Keep useful title detail when it fits; drop boilerplate before names."""
    core = plain_text(core) or "FlickAtlas"
    brand = " | FlickAtlas"
    detailed = core + ((" — " + suffix) if suffix else "") + brand
    if len(detailed) <= limit:
        return detailed
    descriptive = core + ((" — " + suffix) if suffix else "")
    if len(descriptive) <= limit:
        return descriptive
    branded = core + brand
    if len(branded) <= limit:
        return branded
    # A long source title is more valuable than a forced truncation or a
    # generic suffix. Google can display its site name separately.
    return core


def natural_join(values):
    """Join short search phrases in readable prose."""
    values = [plain_text(value) for value in values if plain_text(value)]
    if len(values) < 2:
        return values[0] if values else ""
    if len(values) == 2:
        return " and ".join(values)
    return ", ".join(values[:-1]) + ", and " + values[-1]


def title_join(values):
    """Join compact metadata labels in the owner's title style."""
    values = [plain_text(value) for value in values if plain_text(value)]
    if len(values) < 2:
        return values[0] if values else ""
    if len(values) == 2:
        return " & ".join(values)
    return ", ".join(values[:-1]) + " & " + values[-1]


def detail_title(core, labels):
    """Keep the full source title and every fixed page-template label."""
    core = plain_text(core) or "FlickAtlas"
    suffix = title_join(labels)
    return core + (" — " + suffix if suffix else "") + " | FlickAtlas"


def human_date(value):
    """Render an ISO title date as a short, readable English date."""
    value = plain_text(value)
    if not value:
        return ""
    try:
        parsed = datetime.fromisoformat(value[:10])
        return "%d %s %d" % (parsed.day, parsed.strftime("%B"), parsed.year)
    except ValueError:
        return value


def news_title(headline):
    """Use the full published article headline without adding page labels."""
    return plain_text(headline) or "Entertainment Update"


def img_url(entry, kind="backdrop"):
    """TMDB image: w780 backdrop preferred for OG, else w500 poster."""
    base = IMG
    if kind == "backdrop" and entry.get("backdrop_path"):
        return base + "/w780" + entry["backdrop_path"]
    if entry.get("poster_path"):
        return base + "/w500" + entry["poster_path"]
    if entry.get("backdrop_path"):
        return base + "/w780" + entry["backdrop_path"]
    return BASE + "/icon-512.png"


# ---------------------------------------------------------------------
# SSR facts blocks (phase 1, 2026-11-02): a per-URL, pre-rendered
# semantic-HTML summary stored in the entry's "ssr" field. The Worker
# splices it into <main id="app"> (see injectSsr in scripts/worker.mjs);
# every page script replaces #app wholesale on boot, so visitors see
# exactly what they see today while non-JS crawlers (GPTBot, ClaudeBot,
# PerplexityBot) receive the page's facts. Rules: real headings,
# paragraphs, lists and tables only — no hidden text, no links, no
# images, no scripts — and only facts the rendered page itself backs,
# under the same discipline as the meta descriptions. Builders return
# None when there is nothing substantive, and the entry then simply
# carries no "ssr" key (the Worker no-ops).

# Cap (in characters) for the plain-text article body used by the news
# facts block and the NewsArticle articleBody. 0 = no cap (the default);
# it is a lever if js/seo-meta.json growth ever becomes a problem (the
# sitewide test trips at 6 MB), not the default behaviour.
SSR_MAX_ARTICLE_CHARS = 0


def _esc(value):
    """Escape a plain-text value for interpolation into SSR HTML."""
    return html_escape(plain_text(value), quote=True)


def _fmt_score(value):
    """7.0 -> '7'; 6.5 -> '6.5' (the description score style)."""
    return ("%.1f" % _number(value)).rstrip("0").rstrip(".")


def _cap_article_text(text):
    if SSR_MAX_ARTICLE_CHARS and len(text) > SSR_MAX_ARTICLE_CHARS:
        return trunc(text, SSR_MAX_ARTICLE_CHARS)
    return text


def article_body_text(entry):
    """Flatten an article's stored body sections to plain text: each
    section heading followed by its paragraphs, blank-line separated."""
    parts = []
    for section in (entry.get("body") or []):
        if not isinstance(section, dict):
            continue
        heading = plain_text(section.get("h"))
        if heading:
            parts.append(heading)
        paragraphs = section.get("p") or []
        if not isinstance(paragraphs, list):
            paragraphs = [paragraphs]
        for paragraph in paragraphs:
            text = plain_text(paragraph)
            if text:
                parts.append(text)
    return _cap_article_text("\n\n".join(parts))


def title_ssr(entry, dw, review, worldwide, credits=None):
    """Facts block for a /movie or /show page, from the published entry
    plus its day-wise rows, FlickAtlas review and worldwide record.
    Phase 2 (2026-11-14): top cast + director from the credits cache
    (out/credits.json) — the same people the rendered page shows in its
    Top Cast card and Creators & Crew card. ``credits`` is None when the
    cache has no record for the title; the block then simply omits the
    cast section, exactly as phase 1 did."""
    title = plain_text(entry.get("title"))
    if not title:
        return None
    year = year_of(entry)
    is_tv = entry.get("type") == "tv"
    disp = title + ((" (%s)" % year) if year else "")
    out = ['<article class="ssr-facts">', "<h1>%s</h1>" % _esc(disp)]
    substantive = False
    overview = plain_text(entry.get("overview"))
    if overview:
        out.append('<p class="ssr-lead">%s</p>' % _esc(overview))
        substantive = True
    facts = []
    release_date = entry.get("release_date") or entry.get("first_air_date") or ""
    if release_date:
        label = "First air date" if is_tv else "Release date"
        facts.append("%s: %s" % (label, human_date(release_date)))
    if is_tv:
        seasons = (0 if entry.get("industry") == "pakistani" else
                   int(_number(entry.get("number_of_seasons"))))
        episodes = tv_episode_count(entry)
        bits = []
        if seasons:
            bits.append("Seasons: %d" % seasons)
        if episodes:
            bits.append("Episodes: %d" % episodes)
        if bits:
            facts.append(" · ".join(bits))
    else:
        runtime = int(_number(entry.get("runtime")))
        if runtime:
            facts.append("Runtime: %d minutes" % runtime)
    if is_tv:
        created_by = [plain_text(c) for c in (entry.get("created_by") or [])
                      if plain_text(c)]
        if created_by:
            facts.append("Created by: %s" % ", ".join(created_by))
    directors = []
    cast = []
    if isinstance(credits, dict):
        directors = [plain_text(d) for d in (credits.get("dir") or [])
                     if plain_text(d)]
        for person in (credits.get("cast") or []):
            if not isinstance(person, dict):
                continue
            name = plain_text(person.get("n"))
            if not name:
                continue
            cast.append((name, plain_text(person.get("c"))))
    if directors:
        facts.append("Director: %s" % ", ".join(directors))
    genres = [plain_text(g) for g in (entry.get("genres") or [])
              if plain_text(g)]
    if genres:
        facts.append("Genres: %s" % ", ".join(genres))
    budget = _number(entry.get("budget"))
    if budget > 0:
        facts.append("Budget: %s" % fmt_money(budget))
    rating = _number(entry.get("vote_average"))
    votes = _number(entry.get("vote_count"))
    if rating and votes:
        facts.append("TMDB rating: %.1f/10 (%d votes)" % (rating, int(votes)))
    status = plain_text(entry.get("status"))
    if status and (is_tv or status != "Released"):
        facts.append("Status: %s" % status)
    if facts:
        out.append("<h2>Key facts</h2>")
        out.append("<ul>" + "".join("<li>%s</li>" % _esc(f) for f in facts)
                   + "</ul>")
        substantive = True
    if cast:
        out.append("<h2>Top cast</h2>")
        items = []
        for name, character in cast:
            items.append("%s as %s" % (name, character) if character else name)
        out.append("<ul>" + "".join("<li>%s</li>" % _esc(i) for i in items)
                   + "</ul>")
        substantive = True
    rows = [r for r in (dw or []) if isinstance(r, dict)]
    if rows:
        total_in = sum(_number(r.get("collection")) for r in rows)
        total_ov = sum(_number(r.get("overseas")) for r in rows)
        lines = []
        if fmt_money(total_in):
            lines.append("India Net total: %s" % fmt_money(total_in))
        if total_ov > 0:
            lines.append("Overseas total: %s" % fmt_money(total_ov))
        latest = rows[-1]
        latest_bits = []
        amount_in = fmt_money(_number(latest.get("collection")))
        if amount_in:
            latest_bits.append("India Net %s" % amount_in)
        amount_ov = _number(latest.get("overseas"))
        if amount_ov > 0:
            latest_bits.append("Overseas %s" % fmt_money(amount_ov))
        day_label = plain_text(latest.get("day"))
        date_label = plain_text(latest.get("date"))
        if day_label and latest_bits:
            lines.append("Latest: %s%s — %s" % (
                day_label, (" (%s)" % date_label) if date_label else "",
                ", ".join(latest_bits)))
        # Worldwide total, in the design's source priority: the day-wise
        # components, then the FA_WORLDWIDE record, then TMDB revenue.
        worldwide_total = None
        worldwide_note = ""
        if total_ov > 0:
            worldwide_total = total_in + total_ov
        elif (isinstance(worldwide, dict)
              and _number(worldwide.get("total_usd")) > 0):
            worldwide_total = _number(worldwide.get("total_usd"))
            as_of = plain_text(worldwide.get("as_of"))
            if as_of:
                worldwide_note = " (as of %s)" % human_date(as_of)
        elif _number(entry.get("revenue")) > 0:
            worldwide_total = _number(entry.get("revenue"))
        if worldwide_total and fmt_money(worldwide_total):
            lines.append("Worldwide total: %s%s" % (
                fmt_money(worldwide_total), worldwide_note))
        if lines:
            out.append("<h2>Box office</h2>")
            out.append("<ul>" + "".join("<li>%s</li>" % _esc(x) for x in lines)
                       + "</ul>")
            substantive = True
    if isinstance(review, dict) and review:
        overall = _number(review.get("overall"))
        verdict = plain_text(review.get("verdict"))
        cats = review.get("categories")
        cat_items = []
        if isinstance(cats, dict):
            cat_items = [(plain_text(k), _number(v))
                         for k, v in cats.items() if plain_text(k)]
        if overall > 0 or verdict or cat_items:
            out.append("<h2>FlickAtlas review</h2>")
            lead_bits = []
            if overall > 0:
                lead_bits.append("Overall: %s/10." % _fmt_score(overall))
            if verdict:
                lead_bits.append(verdict)
            if lead_bits:
                out.append("<p>%s</p>" % _esc(" ".join(lead_bits)))
            if cat_items:
                out.append("<ul>" + "".join(
                    "<li>%s: %s/10</li>" % (_esc(k), _fmt_score(v))
                    for k, v in cat_items) + "</ul>")
            substantive = True
    seen_providers = set()
    watch = []
    for provider in (entry.get("providers") or []):
        if not isinstance(provider, dict) or provider.get("type") != "flatrate":
            continue
        name = plain_text(provider.get("name"))
        region = plain_text(provider.get("region"))
        if not name or (name, region) in seen_providers:
            continue
        seen_providers.add((name, region))
        watch.append("Streaming on %s%s" % (
            name, (" (%s)" % region) if region else ""))
    if watch:
        out.append("<h2>Where to watch</h2>")
        out.append("<ul>" + "".join("<li>%s</li>" % _esc(w) for w in watch)
                   + "</ul>")
        substantive = True
    out.append("</article>")
    return "\n".join(out) if substantive else None


def news_ssr(entry):
    """Facts block for a /news-item page: the article's own headline,
    dek, stored body sections and key facts, reproduced in full (the
    same content js/page-news-item.js renders)."""
    headline = plain_text(entry.get("headline"))
    if not headline:
        return None
    out = ['<article class="ssr-facts">', "<h1>%s</h1>" % _esc(headline)]
    substantive = False
    dek = plain_text(entry.get("dek"))
    if dek:
        out.append('<p class="ssr-lead">%s</p>' % _esc(dek))
        substantive = True
    dates = publication_dates(entry)
    if dates["published"]:
        out.append('<p class="ssr-date">Published %s</p>'
                   % _esc(human_date(dates["published"])))
    budget = SSR_MAX_ARTICLE_CHARS or None
    used = 0
    exhausted = False
    for section in (entry.get("body") or []):
        if exhausted:
            break
        if not isinstance(section, dict):
            continue
        paragraphs = section.get("p") or []
        if not isinstance(paragraphs, list):
            paragraphs = [paragraphs]
        rendered = []
        for paragraph in paragraphs:
            text = plain_text(paragraph)
            if not text:
                continue
            if budget is not None:
                room = budget - used
                if room <= 0:
                    exhausted = True
                    break
                if len(text) > room:
                    text = trunc(text, room)
                    exhausted = True
                used += len(text)
            rendered.append("<p>%s</p>" % _esc(text))
        if rendered:
            heading = plain_text(section.get("h"))
            if heading:
                out.append("<h2>%s</h2>" % _esc(heading))
            out.extend(rendered)
            substantive = True
    facts = [plain_text(f) for f in (entry.get("facts") or []) if plain_text(f)]
    if facts:
        out.append("<h2>Key facts</h2>")
        out.append("<ul>" + "".join("<li>%s</li>" % _esc(f) for f in facts)
                   + "</ul>")
        substantive = True
    out.append("</article>")
    return "\n".join(out) if substantive else None


def daywise_ssr(entry, rows):
    """Facts block for a /box-office-day page: per-title totals plus the
    day-wise table through theatrical Day 30 (identical for every
    &day= variant; the Worker keeps composing the per-day head)."""
    title = plain_text(entry.get("title"))
    rows = [r for r in (rows or []) if isinstance(r, dict)]
    if not title or not rows:
        return None
    year = year_of(entry)
    disp = title + ((" (%s)" % year) if year else "")
    total_in = sum(_number(r.get("collection")) for r in rows)
    total_ov = sum(_number(r.get("overseas")) for r in rows)
    out = ['<article class="ssr-facts">',
           "<h1>%s — Day-wise Box Office Collection</h1>" % _esc(disp)]
    lines = []
    if fmt_money(total_in):
        lines.append("India Net total (all days): %s" % fmt_money(total_in))
    if total_ov > 0:
        lines.append("Overseas total: %s" % fmt_money(total_ov))
    latest = rows[-1]
    day_label = plain_text(latest.get("day"))
    date_label = plain_text(latest.get("date"))
    if day_label:
        line = "Latest reported day: %s" % day_label
        if date_label:
            line += " — %s" % human_date(date_label)
        lines.append(line)
    if lines:
        out.append("<ul>" + "".join("<li>%s</li>" % _esc(x) for x in lines)
                   + "</ul>")
    valid = _valid_day_rows(rows)
    if valid:
        out.append("<h2>Day-wise collection (India Net, USD)</h2>")
        trs = ["<tr><th>Day</th><th>Date</th><th>India Net</th>"
               "<th>Overseas</th></tr>"]
        for n, row in valid:
            ov = _number(row.get("overseas"))
            trs.append(
                "<tr><td>Day %d</td><td>%s</td><td>%s</td><td>%s</td></tr>" % (
                    n, _esc(row.get("date")),
                    _esc(fmt_money(_number(row.get("collection"))) or "—"),
                    _esc(fmt_money(ov)) if ov > 0 else "—"))
        out.append("<table>" + "".join(trs) + "</table>")
    out.append("</article>")
    return "\n".join(out)


def _pop_score(e):
    """TMDB popularity first, vote count as fallback (same ranking as
    build_llms_full's Top titles list)."""
    pop = e.get("popularity")
    if isinstance(pop, (int, float)) and math.isfinite(pop):
        return float(pop)
    return _number(e.get("vote_count")) * 0.01


def home_ssr(published, articles):
    """Facts block for the homepage (phase 2, 2026-11-14): the site's own
    description plus the freshest content the rendered homepage shows —
    the latest news headlines and the trending titles. Only facts the
    homepage data backs; no links, no images. Returns None when there
    is nothing substantive (the Worker then no-ops)."""
    out = ['<article class="ssr-facts">', "<h1>FlickAtlas</h1>",
           "<p>%s</p>" % _esc(
               "Explore Bollywood and Indian cinema, World Cinema, "
               "Pakistani dramas, reported box office, OTT availability, "
               "release dates and entertainment news.")]
    substantive = True
    news = [e for e in (articles or {}).values()
            if isinstance(e, dict) and plain_text(e.get("headline"))]
    news.sort(key=lambda e: (publication_dates(e)["published"]
                             or e.get("published") or ""), reverse=True)
    headlines = [plain_text(e.get("headline")) for e in news[:5]]
    if headlines:
        out.append("<h2>Latest news</h2>")
        out.append("<ul>" + "".join("<li>%s</li>" % _esc(h) for h in headlines)
                   + "</ul>")
    ranked = sorted(
        (e for e in (published or {}).values()
         if isinstance(e, dict) and plain_text(e.get("title"))),
        key=lambda e: (-_pop_score(e), -_number(e.get("vote_count")),
                       plain_text(e.get("title")), str(e.get("id"))))
    items = []
    for e in ranked[:5]:
        title = plain_text(e.get("title"))
        year = year_of(e)
        disp = title + ((" (%s)" % year) if year else "")
        rating = _number(e.get("vote_average"))
        if rating:
            disp += " — TMDB rating %.1f/10" % rating
        items.append(disp)
    if items:
        out.append("<h2>Trending titles</h2>")
        out.append("<ul>" + "".join("<li>%s</li>" % _esc(i) for i in items)
                   + "</ul>")
    out.append("</article>")
    return "\n".join(out) if substantive else None


def home_meta():
    """Homepage entry: t/d/k/img match index.html's static head exactly,
    so the Worker's injection changes nothing Google already sees — it
    only ADDS the WebPage schema node and the SSR facts block. No page
    dates: the homepage has no publication date."""
    t = "Bollywood, World Cinema & Box Office | FlickAtlas"
    d = ("Explore Bollywood and Indian cinema, World Cinema, Pakistani "
         "dramas, reported box office, OTT availability, release dates "
         "and entertainment news.")
    k = ("Bollywood movies, Indian cinema, World Cinema, box office "
         "collection, OTT releases, upcoming Bollywood movies, Pakistani "
         "dramas, entertainment news")
    out = {"t": t, "d": d, "k": k, "img": BASE + "/icon-512.png",
           "ld": {"@context": "https://schema.org", "@type": "WebPage",
                  "name": t, "description": d, "url": BASE + "/"}}
    ssr = home_ssr(PUBLISHED, ARTICLES)
    if ssr:
        out["ssr"] = ssr
    return out


def cat_ssr(cat, published):
    """Facts block for a /category page: the category's own description
    plus its most recent covered titles (plain text, no links)."""
    t, d, _k = CAT_META[cat]
    out = ['<article class="ssr-facts">',
           "<h1>%s</h1>" % _esc(t.split(" | ")[0]),
           "<p>%s</p>" % _esc(d)]
    titles = [e for e in (published or {}).values()
              if isinstance(e, dict) and e.get("industry") == cat
              and plain_text(e.get("title"))]

    def _recency(e):
        return (e.get("release_date") or e.get("first_air_date") or "",
                plain_text(e.get("title")))
    titles.sort(key=_recency, reverse=True)
    items = []
    for e in titles[:10]:
        name = plain_text(e.get("title"))
        y = year_of(e)
        items.append("%s (%s)" % (name, y) if y else name)
    if items:
        out.append("<h2>Latest covered titles</h2>")
        out.append("<ul>" + "".join("<li>%s</li>" % _esc(i) for i in items)
                   + "</ul>")
    out.append("</article>")
    return "\n".join(out)


def title_meta(entry, credits=None):
    """Use fixed page-template labels; describe only facts the page supports."""
    title = plain_text(entry.get("title"))
    year = year_of(entry)
    ind = INDUSTRY_LABEL.get(entry.get("industry"), "World Cinema")
    is_tv = entry.get("type") == "tv"
    kind = "TV series" if is_tv else "film"
    genres = [plain_text(g) for g in (entry.get("genres") or [])[:2]
              if plain_text(g)]
    genre_txt = ", ".join(genres)
    rating = _number(entry.get("vote_average"))
    votes = _number(entry.get("vote_count"))
    budget = _number(entry.get("budget"))
    rows = [r for r in (DAYWISE.get(str(entry.get("id")), []) or [])
            if isinstance(r, dict)]
    total_in = sum(_number(r.get("collection")) for r in rows)
    total_ov = sum(_number(r.get("overseas")) for r in rows)
    has_bo = any(type(r.get("collection")) in (int, float)
                 and math.isfinite(r.get("collection"))
                 and r.get("collection") >= 0 for r in rows)
    has_overseas = total_ov > 0
    overview = plain_text(entry.get("overview"))
    release_date = entry.get("release_date") or entry.get("first_air_date") or ""

    review = REVIEWS.get(str(entry.get("id")), {})
    if not isinstance(review, dict):
        review = {}
    has_review = bool(review)
    review_story = plain_text(review.get("story_plot"))
    story_source = overview or review_story
    review_score = _number(review.get("overall"))
    if is_tv:
        # Pakistani dramas have an episode list, not a Seasons table. Their
        # visible episode count comes from the same tracker used by the page.
        seasons = (0 if entry.get("industry") == "pakistani" else
                   int(_number(entry.get("number_of_seasons"))))
        episodes = tv_episode_count(entry)
    else:
        seasons = episodes = 0

    disp = title + ((" (%s)" % year) if year else "")
    if is_tv:
        # Pakistani dramas use the episode tracker rather than a Seasons
        # table; all other series use the Seasons + Episodes format.
        labels = (["Episodes", "Cast", "Story"]
                  if entry.get("industry") == "pakistani" else
                  ["Seasons", "Episodes", "Cast", "Story"])
    else:
        labels = ["Cast", "Box Office Collection", "Budget", "Story",
                  "Review", "Rating"]
    t = detail_title(disp, labels)

    story_snippet = (trunc_description(story_source, 55).rstrip(" .")
                     if story_source else "")
    if is_tv:
        subject = (natural_join(genres) + " " if genre_txt else "") + kind
        article = "an" if subject[:1].lower() in "aeiou" else "a"
        d = "%s is %s %s." % (disp, article, subject)
        details = []
        if story_snippet:
            details.append("story: " + story_snippet)
        details.append("cast")
        if seasons:
            details.append("%d season%s" % (seasons, "s" if seasons != 1 else ""))
        if episodes:
            details.append("%d episodes" % episodes)
        if rating and votes:
            details.append("TMDB rating %.1f/10" % rating)
        if release_date:
            details.append("first air date %s" % human_date(release_date))
        d = append_detail_list(d, details)
    else:
        genre_label = "/".join(genres)
        d = ("%s: %s film." % (disp, genre_label) if genre_label else
             "%s is a film." % disp)
        story_part = ""
        if story_snippet:
            end = "" if story_snippet.endswith("…") else "."
            story_part = " Story: " + story_snippet + end
        details = []
        details.append("cast")
        if has_bo:
            detail = "box office collection %s" % fmt_money(total_in)
            if has_overseas:
                detail += ", overseas " + fmt_money(total_ov)
            details.append(detail)
        if budget > 0:
            details.append("budget %s" % fmt_money(budget))
        if has_review:
            review_label = "review"
            if review_score > 0:
                review_label += " %s/10" % ("%.1f" % review_score).rstrip("0").rstrip(".")
            details.append(review_label)
        if rating and votes:
            details.append("TMDB rating %.1f/10" % rating)
        if release_date:
            details.append("release date " + human_date(release_date))
        while details:
            candidate = d + story_part + " See " + natural_join(details) + "."
            if len(candidate) <= 160:
                d = candidate
                break
            details.pop()

    kws = [title]
    if title:
        kws.append("%s TV series" % title if is_tv else "%s movie" % title)
        kws.append("%s cast" % title)
        kws.append("%s story" % title)
        if is_tv:
            if entry.get("industry") != "pakistani":
                kws.append("%s seasons" % title)
            kws.append("%s episodes" % title)
            if seasons:
                kws.append("%s season %d" % (title, seasons))
            if episodes:
                kws.append("%s %d episodes" % (title, episodes))
        else:
            kws.extend(["%s box office collection" % title,
                        "%s budget" % title, "%s review" % title,
                        "%s rating" % title])
        if release_date:
            kws.append("%s %s" % (title, "first air date" if is_tv else "release date"))
        if entry.get("trailer"):
            kws.append("%s trailer" % title)
    kws.extend("%s %s" % (title, genre) for genre in genres)
    if is_tv:
        if entry.get("industry") == "pakistani":
            kws.append("Pakistani dramas")
        else:
            kws.append("%s TV series" % ind)
    else:
        kws.append({"bollywood": "Indian movies", "world": "international movies",
                    "pakistani": "Pakistani movies"}.get(
                        entry.get("industry"), "movies"))
    kws.append("FlickAtlas")
    kws = unique_keywords(kws, 14)

    ld = {
        "@context": "https://schema.org",
        "@type": "TVSeries" if is_tv else "Movie",
        "name": title,
        "url": "%s/%s?id=%s" % (BASE, "show" if is_tv else "movie",
                                entry.get("id")),
        "image": img_url(entry),
        "description": d,
    }
    # The entity is the film/series, not the page. Its release/first-air
    # date must not masquerade as FlickAtlas's page publication date.
    release = parse_date(entry.get("first_air_date") if is_tv
                         else entry.get("release_date"))
    if release:
        if is_tv:
            ld["startDate"] = release
        else:
            ld["releasedEvent"] = {"@type": "PublicationEvent", "startDate": release}
    ld["mainEntityOfPage"] = ld["url"]
    if genres:
        ld["genre"] = genres
    if rating and votes:
        # TMDB ratings are a 0-10 scale: bestRating/worstRating MUST be
        # declared or Google validates ratingValue against its default
        # 1-5 range and flags every rating above 5 ("Rating is outside
        # the specified or default range", first detected 2026-10-30).
        ld["aggregateRating"] = {
            "@type": "AggregateRating",
            "ratingValue": round(rating, 1),
            "ratingCount": int(votes),
            "bestRating": 10,
            "worstRating": 0,
        }
    if is_tv:
        if seasons:
            ld["numberOfSeasons"] = seasons
        if episodes:
            ld["numberOfEpisodes"] = episodes
    else:
        if entry.get("runtime"):
            ld["duration"] = "PT%dM" % int(entry["runtime"])
    # Phase 2 (2026-11-14): director + actor in the schema, mirroring
    # what js/page-movie.js adds to its own runtime JSON-LD (all
    # directors, top 5 cast). No credits record -> both omitted.
    if isinstance(credits, dict):
        directors = [plain_text(d) for d in (credits.get("dir") or [])
                     if plain_text(d)]
        if directors:
            ld["director"] = [{"@type": "Person", "name": d}
                              for d in directors]
        actors = []
        for person in (credits.get("cast") or [])[:5]:
            if isinstance(person, dict) and plain_text(person.get("n")):
                actors.append(plain_text(person.get("n")))
        if actors:
            ld["actor"] = [{"@type": "Person", "name": a} for a in actors]
    if has_review and review_score > 0:
        # The FlickAtlas editorial review, as a schema.org Review node on
        # the film/series entity (aggregateRating above is TMDB's).
        review_node = {
            "@type": "Review",
            "author": {"@type": "Organization", "name": "FlickAtlas"},
            "reviewRating": {"@type": "Rating",
                             "ratingValue": review_score,
                             "bestRating": 10},
        }
        verdict = plain_text(review.get("verdict"))
        if verdict:
            review_node["reviewBody"] = verdict
        ld["review"] = review_node
    out = {"t": t, "d": trunc_description(d, 160), "k": ", ".join(kws),
           "img": img_url(entry), "ld": ld, "year": year,
           "industry": entry.get("industry"), **publication_dates(entry)}
    ssr = title_ssr(entry, rows, review,
                    (WORLDWIDE or {}).get(str(entry.get("id"))), credits)
    if ssr:
        out["ssr"] = ssr
    return out


_EP_RE = re.compile(
    r"^(.+?)\s+Episode\s+(\d+)\s*(?:\(Finale\))?\s*[—–-]\s*Watch (?:Online )?on\s+(.+)$",
    re.I)
_EP_FIN_RE = re.compile(
    r"^(.+?)\s*[—–-]?\s*Last Episode\s*[—–-]\s*Watch (?:Online )?on\s+(.+)$", re.I)


def parse_episode_headline(headline):
    """Mirror of js/page-news-item.js parseEpisodeHeadline: returns
    (drama, label, channel) for episode posts, else None."""
    s = re.sub(r"\s+", " ", str(headline or "")).strip()
    m = _EP_RE.match(s)
    if m:
        return (m.group(1).strip(), "Episode %d" % int(m.group(2)),
                (m.group(3) or "").strip())
    m = _EP_FIN_RE.match(s)
    if m:
        return (m.group(1).strip(), "Last Episode",
                (m.group(2) or "").strip())
    return None


def news_topic_phrases(entry):
    """News-specific search phrases for one article, built ONLY from the
    article's own entities — the SAME phrases the article page shows in
    its Top Searches dropdown (js/page-news-item.js), so the visible
    keywords and the metadata match (owner rule). The main person is
    entities.people[0] of THIS article, never a TMDB resolution.
    Episode posts use the episode phrase set (same as the page's
    episode branch) instead."""
    headline = (entry.get("headline") or "").strip()
    ep = parse_episode_headline(headline)
    if ep:
        drama, label, channel = ep
        out = ["%s %s" % (drama, label),
               "%s %s update" % (drama, label),
               "%s latest episode" % drama]
        if channel:
            out.append("%s %s %s" % (drama, label, channel))
        return unique_keywords(out, 5)
    ents = entry.get("entities") or {}
    people = [str(p).strip() for p in (ents.get("people") or [])
              if str(p).strip()]
    titles = [str(t).strip() for t in (ents.get("titles") or [])
              if str(t).strip()]
    p0 = people[0] if people else ""
    p1 = people[1] if len(people) > 1 else ""
    t0 = titles[0] if titles else ""
    out = []
    if p0 and t0:
        out.append("%s %s" % (p0, t0))
    if t0:
        out.append(t0)
    if p0:
        out.append(p0)
    if p1 and t0:
        out.append("%s %s" % (p1, t0))
    if not t0 and p0 and p1:
        out.append("%s %s" % (p0, p1))
    return unique_keywords(out, 5)


def news_description(entry):
    """Use the article dek or first published paragraph for a factual snippet.

    If a dek uses a generic reference such as "the actor", prefix its primary
    headline entity when the article record identifies it. This adds a real
    search term without inventing facts or inserting unrelated keywords.
    """
    headline = plain_text(entry.get("headline"))
    source = plain_text(entry.get("dek"))
    if not source:
        for section in (entry.get("body") or []):
            if not isinstance(section, dict):
                continue
            paragraphs = section.get("p") or []
            if not isinstance(paragraphs, list):
                paragraphs = [paragraphs]
            source = next((plain_text(p) for p in paragraphs if plain_text(p)), "")
            if source:
                break
    source = source or headline

    entities = entry.get("entities") or {}
    people = [plain_text(p) for p in (entities.get("people") or []) if plain_text(p)]
    titles = [plain_text(t) for t in (entities.get("titles") or []) if plain_text(t)]
    candidates = titles[:1] + people[:1]
    headline_cf = headline.casefold()
    source_cf = source.casefold()
    primary = next((item for item in candidates
                    if item.casefold() in headline_cf
                    and item.casefold() not in source_cf), "")
    if primary:
        source = primary + ": " + source
    return trunc_description(source, 160)


def news_meta(entry):
    headline = plain_text(entry.get("headline"))
    d = news_description(entry)
    t = news_title(headline)
    ents = entry.get("entities") or {}
    stored = list((entry.get("keywords") or [])[:5])
    if not stored:
        stored = list((ents.get("people") or [])[:3])
        stored += list((ents.get("titles") or [])[:2])
    kws = unique_keywords(stored + news_topic_phrases(entry) +
                          ["entertainment news", "FlickAtlas"], 10)
    imgs = entry.get("images") or []
    img = imgs[0].get("url") if imgs and imgs[0].get("url") else (
        BASE + "/icon-512.png")
    dates = publication_dates(entry)
    ld = {
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        "headline": headline,
        "description": d,
        "image": img,
        "url": "%s/news-item?id=%s" % (BASE, entry.get("id")),
        "author": {"@type": "Organization", "name": "FlickAtlas"},
        "publisher": {"@type": "Organization", "name": "FlickAtlas",
                      "logo": {"@type": "ImageObject",
                               "url": BASE + "/icon-512.png"}},
        "mainEntityOfPage": "%s/news-item?id=%s" % (BASE, entry.get("id")),
    }
    article_kws = unique_keywords((entry.get("keywords") or [])[:12], 12)
    if article_kws:
        ld["keywords"] = ", ".join(article_kws)
    if dates["published"]:
        ld["datePublished"] = dates["published"]
    if dates["modified"]:
        ld["dateModified"] = dates["modified"]
    body_text = article_body_text(entry)
    if body_text:
        ld["articleBody"] = body_text
    out = {"t": t, "d": d, "k": ", ".join(kws), "img": img, "ld": ld,
           **dates}
    ssr = news_ssr(entry)
    if ssr:
        out["ssr"] = ssr
    return out


def daywise_meta(entry):
    """Day-wise box-office page meta for one title (Worker composes the
    day-specific <title> from the &day= param; the description uses the
    film's totals, which are true for every day page)."""
    title = plain_text(entry.get("title"))
    year = year_of(entry)
    disp = title + ((" (%s)" % year) if year else "")
    rows = [r for r in (DAYWISE.get(str(entry.get("id")), []) or [])
            if isinstance(r, dict)]
    total_in = sum(_number(r.get("collection")) for r in rows)
    total_ov = sum(_number(r.get("overseas")) for r in rows)
    latest = rows[-1] if rows else {}
    daily = []
    for row in rows:
        match = re.search(r"\d+", str(row.get("day") or ""))
        day = int(match.group(0)) if match else 0
        if not 1 <= day <= 30:
            continue
        amount_in = _number(row.get("collection"))
        amount_ov = _number(row.get("overseas"))
        date = plain_text(row.get("date"))
        desc = "%s box office Day %d%s: India Net %s." % (
            disp, day, (" (" + date + ")") if date else "",
            fmt_money(amount_in))
        if amount_ov > 0:
            desc += " Overseas: %s." % fmt_money(amount_ov)
        daily.append({"day": day, "date": date, "d": trunc_description(desc, 160)})
    daily.sort(key=lambda item: item["day"])

    d = ("%s box office: daily rows cover Days 1\u201330; later days count "
         "in totals. India Net %s." % (disp, fmt_money(total_in)))
    if total_ov > 0:
        d += " Overseas total: %s." % fmt_money(total_ov)
    d = trunc_description(d, 160)
    kws = unique_keywords([
        title,
        "%s box office collection" % title,
        "%s box office collection day wise" % title,
        "%s day 1 collection" % title,
        "Bollywood box office collection" if entry.get("industry") == "bollywood"
        else "box office collection",
        "FlickAtlas",
    ], 8)
    out = {"t": disp, "year": year, "days": len(rows),
           "total_in": total_in, "total_ov": total_ov,
           "latest_day": latest.get("day"), "latest_date": latest.get("date"),
           "day_rows": daily, "d": d, "k": ", ".join(kws),
           "img": img_url(entry),
           "ld": title_meta(entry,
                            CREDITS.get(str(entry.get("id"))))["ld"]}
    ssr = daywise_ssr(entry, rows)
    if ssr:
        out["ssr"] = ssr
    return out


def xml_esc(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace('"', "&quot;"))


def _day_num(row, idx):
    """Mirror of js/ui.js UI.dayNumOf: first integer in the row's `day`
    label ("Day 12" -> 12), else the row's position (1-based)."""
    m = re.search(r"(\d+)", str((row or {}).get("day") or ""))
    return int(m.group(1)) if m else idx + 1


def _valid_day_rows(rows):
    """Sitemap-eligible day rows through theatrical Day 30, in page order:
    valid YYYY-MM-DD date, finite collection >= 0, one entry per day,
    sorted by day number. Later rows remain in the source for totals only."""
    seen = set()
    out = []
    for i, r in enumerate(rows or []):
        if not isinstance(r, dict):
            continue
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(r.get("date") or "")):
            continue
        c = r.get("collection")
        if (type(c) not in (int, float) or not math.isfinite(c)
                or c < 0):
            continue
        n = _day_num(r, i)
        if n < 1 or n > 30:
            continue
        if n in seen:
            continue
        seen.add(n)
        out.append((n, r))
    out.sort(key=lambda t: t[0])
    return out


def build_sitemap(lastmods):
    urls = []
    for path, freq, prio, src in STATIC_PAGES:
        urls.append((BASE + path, lastmods.get(src, lastmods["max"]),
                     freq, prio))
    for tid in sorted(PUBLISHED, key=lambda x: int(x)):
        e = PUBLISHED[tid]
        page = "show" if e.get("type") == "tv" else "movie"
        lm = page_lastmod(e)
        urls.append(("%s/%s?id=%s" % (BASE, page, tid), lm, "weekly",
                     "0.9" if str(tid) in DAYWISE else "0.8"))
    for slug in sorted(ARTICLES):
        e = ARTICLES[slug]
        lm = page_lastmod(e)
        urls.append(("%s/news-item?id=%s" % (BASE, slug), lm, "weekly", "0.7"))
    for tid in sorted(DAYWISE, key=lambda x: int(x)):
        # One URL per film per theatrical day, capped at Day 30. Later
        # daily rows stay in the data so the totals include every reported
        # day, but they are neither individual pages nor sitemap entries.
        # The bare ?title= URL is not listed because it duplicates the
        # latest day (or the totals-only fallback after Day 30).
        for n, r in _valid_day_rows(DAYWISE[tid]):
            # A collection's theatrical date is not evidence of when its
            # report page was published/edited. lastmod is optional.
            lm = page_lastmod(r)
            urls.append(("%s/box-office-day?title=%s&day=%d"
                         % (BASE, tid, n), lm, "daily", "0.8"))
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    # SEO audit 2026-10-28 (claude-seo): Google ignores <changefreq>
    # and <priority> — emit loc + lastmod only.
    for loc, lm, _freq, _prio in urls:
        lastmod = "<lastmod>%s</lastmod>" % xml_esc(lm) if lm else ""
        out.append("  <url><loc>%s</loc>%s</url>" % (xml_esc(loc), lastmod))
    out.append("</urlset>")
    return "\n".join(out) + "\n", len(urls)


def build_robots():
    """Allow search crawlers while keeping non-public API paths excluded."""
    # OAI-SearchBot is explicitly allowed for ChatGPT Search discovery. Its
    # specific group repeats the three public read-only feeds because robots
    # groups do not inherit wildcard exceptions. GPTBot and Google-Extended
    # remain governed by the existing wildcard policy; do not change training
    # preferences implicitly.
    return ("User-agent: OAI-SearchBot\nAllow: /\n"
            "Allow: /api/news\nAllow: /api/trends\n"
            "Allow: /api/reviews\nDisallow: /api/\n\n"
            "User-agent: *\nAllow: /\nAllow: /api/news\n"
            "Allow: /api/trends\nAllow: /api/reviews\n"
            "Disallow: /api/\n\n"
            "Sitemap: %s/sitemap.xml\n" % BASE)


def build_llms_full():
    """llms-full.txt: llms.txt's own header/sections/notes (read from the
    checked-in file, so the two can never drift apart) plus the top
    published titles with one-line facts for AI readers. Deterministic:
    popularity first (TMDB's own field where the metadata refresh has
    populated it), vote count as the fallback signal, title as the
    final tiebreak."""
    try:
        with open(os.path.join(ROOT, "llms.txt"), encoding="utf-8") as f:
            base = f.read().strip()
    except OSError:
        base = "# FlickAtlas"
    lines = [base, "", "## Top titles", ""]

    ranked = sorted(
        (e for e in PUBLISHED.values()
         if isinstance(e, dict) and plain_text(e.get("title"))),
        key=lambda e: (-_pop_score(e), -_number(e.get("vote_count")),
                       plain_text(e.get("title")), str(e.get("id"))))
    for e in ranked[:150]:
        title = plain_text(e.get("title"))
        year = year_of(e)
        disp = title + ((" (%s)" % year) if year else "")
        page = "show" if e.get("type") == "tv" else "movie"
        url = "%s/%s?id=%s" % (BASE, page, e.get("id"))
        bits = []
        ind = INDUSTRY_LABEL.get(e.get("industry"))
        if ind:
            bits.append(ind)
        genres = [plain_text(g) for g in (e.get("genres") or [])[:3]
                  if plain_text(g)]
        if genres:
            bits.append(", ".join(genres))
        rating = _number(e.get("vote_average"))
        votes = _number(e.get("vote_count"))
        if rating and votes:
            bits.append("TMDB rating %.1f/10" % rating)
        overview = trunc(plain_text(e.get("overview")), 160)
        if overview:
            bits.append(overview)
        lines.append("- [%s](%s) — %s" % (disp, url, "; ".join(bits)))
    return "\n".join(lines) + "\n"


def main():
    global PUBLISHED, ARTICLES, DAYWISE, REVIEWS, WORLDWIDE, EPISODE_TRACKER, CREDITS
    PUBLISHED = read_js_map(os.path.join(ROOT, "js", "published-titles.js"),
                            "FA_PUBLISHED")
    ARTICLES = read_js_map(os.path.join(ROOT, "js", "articles-data.js"),
                           "FA_ARTICLES")
    DAYWISE = read_js_map(os.path.join(ROOT, "js", "daywise-data.js"),
                          "FA_DAYWISE")
    REVIEWS = read_js_map(os.path.join(ROOT, "js", "reviews-data.js"),
                          "FA_REVIEWS")
    try:
        WORLDWIDE = read_js_map(os.path.join(ROOT, "js", "worldwide-data.js"),
                                "FA_WORLDWIDE")
    except (OSError, ValueError, KeyError):
        WORLDWIDE = {}
    try:
        with open(os.path.join(ROOT, "out", "episodes.json"),
                  encoding="utf-8") as f:
            EPISODE_TRACKER = json.load(f)
    except (OSError, ValueError):
        EPISODE_TRACKER = {"episodes": {}}
    # Phase 2 credits cache (scripts/fetch-credits.py). Missing file or
    # bad JSON -> empty cache; entries without credits simply omit the
    # cast section, exactly as phase 1 did.
    try:
        with open(os.path.join(ROOT, "out", "credits.json"),
                  encoding="utf-8") as f:
            CREDITS = json.load(f)
        if not isinstance(CREDITS, dict):
            CREDITS = {}
    except (OSError, ValueError):
        CREDITS = {}
    for e in ARTICLES.values():
        e["_pub"] = parse_date(e.get("published"))

    # Deterministic lastmods (from the data, never "today").
    def _max(dates):
        ds = [d for d in dates if d]
        return max(ds) if ds else ""
    title_dates = [parse_date(page_lastmod(e)) for e in PUBLISHED.values()]
    article_dates = [parse_date(page_lastmod(e)) for e in ARTICLES.values()]
    lastmods = {
        "max": _max(title_dates + article_dates),
        "titles": _max(title_dates),
        "articles": _max(article_dates),
        "daywise": _max([parse_date(page_lastmod(r)) for rows in DAYWISE.values()
                         for r in rows if isinstance(r, dict)]),
    }

    meta = {}
    for tid in sorted(PUBLISHED, key=lambda x: int(x)):
        e = PUBLISHED[tid]
        key = ("tv:" if e.get("type") == "tv" else "movie:") + str(tid)
        meta[key] = title_meta(e, CREDITS.get(str(tid)))
    for slug in sorted(ARTICLES):
        meta["news:" + slug] = news_meta(ARTICLES[slug])
    for tid in sorted(DAYWISE, key=lambda x: int(x)):
        e = PUBLISHED.get(str(tid))
        if e:
            meta["daywise:" + str(tid)] = daywise_meta(e)
    for cat, (t, d, k) in CAT_META.items():
        meta["cat:" + cat] = {
            "t": t, "d": d, "k": k, "img": BASE + "/icon-512.png",
            "ld": {"@context": "https://schema.org", "@type": "CollectionPage",
                   "name": t.split(" | ")[0],
                   "url": "%s/category?cat=%s" % (BASE, cat),
                   "description": d},
            "ssr": cat_ssr(cat, PUBLISHED),
        }
    # Phase 2 (2026-11-14): homepage entry — the Worker injects it on
    # "/" (see scripts/worker.mjs). Title/description/keywords match
    # index.html's static head exactly.
    meta["home"] = home_meta()

    meta_path = os.path.join(ROOT, "js", "seo-meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")

    sitemap, n_urls = build_sitemap(lastmods)
    with open(os.path.join(ROOT, "sitemap.xml"), "w", encoding="utf-8") as f:
        f.write(sitemap)
    with open(os.path.join(ROOT, "robots.txt"), "w", encoding="utf-8") as f:
        f.write(build_robots())
    with open(os.path.join(ROOT, "llms-full.txt"), "w", encoding="utf-8") as f:
        f.write(build_llms_full())

    print("seo_assets: %d titles (%d movies, %d tv), %d articles, "
          "%d daywise titles" % (
              len(PUBLISHED),
              sum(1 for v in PUBLISHED.values() if v.get("type") == "movie"),
              sum(1 for v in PUBLISHED.values() if v.get("type") == "tv"),
              len(ARTICLES), len(DAYWISE)))
    print("seo_assets: seo-meta.json %d entries, sitemap.xml %d urls, "
          "robots.txt -> %s" % (len(meta), n_urls, BASE))
    return 0


if __name__ == "__main__":
    sys.exit(main())
