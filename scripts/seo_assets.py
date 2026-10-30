#!/usr/bin/env python3
"""FlickAtlas SEO assets — regenerate sitemap.xml, robots.txt and
js/seo-meta.json from the LIVE site data (js/published-titles.js,
js/articles-data.js, js/daywise-data.js).

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
                     "daywise:<tmdb>", "cat:<industry>".

Meta rules (owner: accurate titles, never page-name + site-name):
  - Every title/description is built ONLY from the entry's own fields.
  - A fact is mentioned ONLY when the data has it (no box-office claim
    without day-wise rows, no budget claim without budget > 0, no
    rating claim without votes).
  - Descriptions are truncated to ~160 chars at a word boundary.
  - No invented titles, no keyword stuffing.
"""
import json
import math
import os
import re
import sys
from datetime import datetime
from email.utils import parsedate_to_datetime
from html import unescape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "https://flickatlas.co.uk"
IMG = "https://image.tmdb.org/t/p"

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


def append_meta(base, text, limit=160):
    """Append a complete or word-truncated fact without exceeding limit."""
    text = plain_text(text)
    room = limit - len(base) - 1
    if not text or room < 24:
        return base
    return base + " " + trunc(text, room)


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


def news_title(headline, limit=60):
    """Use a concise article title tag without changing its visible headline."""
    headline = plain_text(headline) or "Entertainment Update"
    brand = " | FlickAtlas"
    if len(headline) + len(brand) <= limit:
        return headline + brand
    if ":" in headline:
        base, tail = [part.strip() for part in headline.split(":", 1)]
        if "box office" in base.casefold():
            base = re.sub(r"\bcollection\b", "", base, flags=re.I)
            base = re.sub(r"\s+", " ", base).strip()
        words = tail.split()
        for count in range(min(6, len(words)), 0, -1):
            suffix = " ".join(words[-count:]).strip(" .,:;—–-")
            candidate = base + " — " + suffix + brand
            if suffix and len(candidate) <= limit:
                return candidate
        if base and len(base) + len(brand) <= limit:
            return base + brand
    room = max(1, limit - len(brand) - 1)
    lead = trunc(headline, room).rstrip(" .,:;—–-")
    return lead + "…" + brand


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


def title_meta(entry):
    """Per-title (movie/TV) meta. Only facts the entry actually has."""
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

    disp = title + ((" (%s)" % year) if year else "")
    if is_tv:
        suffix = "TV Series & Cast"
    else:
        if has_bo:
            suffix = "Box Office Collection & Cast"
        elif overview and budget > 0:
            suffix = "Story & Budget"
        elif overview:
            suffix = "Story & Cast"
        elif budget > 0:
            suffix = "Budget & Cast"
        else:
            suffix = "Cast & Details"
    t = compact_title(disp, suffix)

    subject = (genre_txt + " " if genre_txt else "") + ind + " " + kind
    article = "an" if subject[:1].lower() in "aeiou" else "a"
    d = "%s is %s %s." % (disp, article, subject)
    if has_bo:
        d = append_meta(d, "India Net box office collection: %s." %
                        fmt_money(total_in))
        if has_overseas:
            d = append_meta(d, "Overseas collection: %s." %
                            fmt_money(total_ov))
    elif overview:
        d = append_meta(d, overview)
    if budget > 0:
        d = append_meta(d, "Budget: %s." % fmt_money(budget))
    if rating and votes:
        d = append_meta(d, "TMDB rating: %.1f/10." % rating)
    if is_tv:
        seasons = int(_number(entry.get("number_of_seasons")))
        episodes = int(_number(entry.get("number_of_episodes")))
        if seasons:
            d = append_meta(d, "%d seasons listed." % seasons)
        if episodes:
            d = append_meta(d, "%d episodes listed." % episodes)
    elif release_date and not has_bo and not overview:
        d = append_meta(d, "Release date: %s." % release_date)

    kws = [title]
    if title:
        kws.append("%s cast" % title)
    if overview:
        kws.append("%s story" % title)
    if release_date:
        kws.append("%s release date" % title)
    if has_bo:
        kws.append("%s box office collection" % title)
    if budget > 0:
        kws.append("%s budget" % title)
    if rating and votes:
        kws.append("%s rating" % title)
    if entry.get("trailer"):
        kws.append("%s trailer" % title)
    if is_tv:
        kws.append("%s episodes" % title)
        if (entry.get("number_of_seasons") or 0) > 1:
            kws.append("%s season %d" % (title, int(_number(entry["number_of_seasons"]))))
        if entry.get("industry") == "pakistani":
            kws.append("Pakistani dramas")
        else:
            kws.append("%s TV series" % ind)
    else:
        kws.append({"bollywood": "Indian movies", "world": "international movies",
                    "pakistani": "Pakistani movies"}.get(
                        entry.get("industry"), "movies"))
    kws.append("FlickAtlas")
    kws = unique_keywords(kws, 9)

    ld = {
        "@context": "https://schema.org",
        "@type": "TVSeries" if is_tv else "Movie",
        "name": title,
        "url": "%s/%s?id=%s" % (BASE, "show" if is_tv else "movie",
                                entry.get("id")),
        "image": img_url(entry),
        "description": d,
    }
    if year:
        ld["datePublished"] = (entry.get("release_date")
                               or entry.get("first_air_date"))
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
        if entry.get("number_of_seasons"):
            ld["numberOfSeasons"] = entry["number_of_seasons"]
        if entry.get("number_of_episodes"):
            ld["numberOfEpisodes"] = entry["number_of_episodes"]
    else:
        if entry.get("runtime"):
            ld["duration"] = "PT%dM" % int(entry["runtime"])
    return {"t": t, "d": trunc(d, 160), "k": ", ".join(kws), "img": img_url(entry),
            "ld": ld, "year": year, "industry": entry.get("industry")}


_EP_RE = re.compile(
    r"^(.+?)\s+Episode\s+(\d+)\s*(?:\(Finale\))?\s*[—–-]\s*Watch on\s+(.+)$",
    re.I)
_EP_FIN_RE = re.compile(
    r"^(.+?)\s*[—–-]?\s*Last Episode\s*[—–-]\s*Watch on\s+(.+)$", re.I)


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


def news_meta(entry):
    headline = plain_text(entry.get("headline"))
    dek = plain_text(entry.get("dek"))
    d = trunc(dek, 160) if dek else trunc(headline, 160)
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
    pub = parse_date(entry.get("published"))
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
    if pub:
        ld["datePublished"] = pub
        ld["dateModified"] = pub
    return {"t": t, "d": d, "k": ", ".join(kws), "img": img, "ld": ld,
            "published": pub}


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
        daily.append({"day": day, "date": date, "d": trunc(desc, 160)})
    daily.sort(key=lambda item: item["day"])

    d = ("%s box office: daily rows cover Days 1\u201330; later days count "
         "in totals. India Net %s." % (disp, fmt_money(total_in)))
    if total_ov > 0:
        d += " Overseas total: %s." % fmt_money(total_ov)
    d = trunc(d, 160)
    kws = unique_keywords([
        title,
        "%s box office collection" % title,
        "%s box office collection day wise" % title,
        "%s day 1 collection" % title,
        "Bollywood box office collection" if entry.get("industry") == "bollywood"
        else "box office collection",
        "FlickAtlas",
    ], 8)
    return {"t": disp, "year": year, "days": len(rows),
            "total_in": total_in, "total_ov": total_ov,
            "latest_day": latest.get("day"), "latest_date": latest.get("date"),
            "day_rows": daily, "d": d, "k": ", ".join(kws), "img": img_url(entry),
            "ld": title_meta(entry)["ld"]}


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
        lm = e.get("published_at") or e.get("release_date") or e.get("first_air_date") or lastmods["max"]
        urls.append(("%s/%s?id=%s" % (BASE, page, tid), lm, "weekly",
                     "0.9" if str(tid) in DAYWISE else "0.8"))
    for slug in sorted(ARTICLES):
        e = ARTICLES[slug]
        lm = e.get("_pub") or lastmods["max"]
        urls.append(("%s/news-item?id=%s" % (BASE, slug), lm, "weekly", "0.7"))
    for tid in sorted(DAYWISE, key=lambda x: int(x)):
        # One URL per film per theatrical day, capped at Day 30. Later
        # daily rows stay in the data so the totals include every reported
        # day, but they are neither individual pages nor sitemap entries.
        # The bare ?title= URL is not listed because it duplicates the
        # latest day (or the totals-only fallback after Day 30).
        for n, r in _valid_day_rows(DAYWISE[tid]):
            lm = r.get("date") or lastmods["max"]
            urls.append(("%s/box-office-day?title=%s&day=%d"
                         % (BASE, tid, n), lm, "daily", "0.8"))
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    # SEO audit 2026-10-28 (claude-seo): Google ignores <changefreq>
    # and <priority> — emit loc + lastmod only.
    for loc, lm, _freq, _prio in urls:
        out.append("  <url><loc>%s</loc><lastmod>%s</lastmod></url>"
                   % (xml_esc(loc), lm))
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


def main():
    global PUBLISHED, ARTICLES, DAYWISE
    PUBLISHED = read_js_map(os.path.join(ROOT, "js", "published-titles.js"),
                            "FA_PUBLISHED")
    ARTICLES = read_js_map(os.path.join(ROOT, "js", "articles-data.js"),
                           "FA_ARTICLES")
    DAYWISE = read_js_map(os.path.join(ROOT, "js", "daywise-data.js"),
                          "FA_DAYWISE")
    for e in ARTICLES.values():
        e["_pub"] = parse_date(e.get("published"))

    # Deterministic lastmods (from the data, never "today").
    def _max(dates):
        ds = [d for d in dates if d]
        return max(ds) if ds else "2026-10-28"
    lastmods = {
        "max": _max([e.get("published_at") for e in PUBLISHED.values()]
                    + [e.get("_pub") for e in ARTICLES.values()]),
        "titles": _max([e.get("published_at") for e in PUBLISHED.values()]),
        "articles": _max([e.get("_pub") for e in ARTICLES.values()]),
        "daywise": _max([r.get("date") for rows in DAYWISE.values()
                         for r in rows]),
    }

    meta = {}
    for tid in sorted(PUBLISHED, key=lambda x: int(x)):
        e = PUBLISHED[tid]
        key = ("tv:" if e.get("type") == "tv" else "movie:") + str(tid)
        meta[key] = title_meta(e)
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
        }

    meta_path = os.path.join(ROOT, "js", "seo-meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")

    sitemap, n_urls = build_sitemap(lastmods)
    with open(os.path.join(ROOT, "sitemap.xml"), "w", encoding="utf-8") as f:
        f.write(sitemap)
    with open(os.path.join(ROOT, "robots.txt"), "w", encoding="utf-8") as f:
        f.write(build_robots())

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
