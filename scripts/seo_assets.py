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
                     day-wise box-office URL + category URLs.
  robots.txt       — Allow / (except /api/), Sitemap: flickatlas.co.uk.
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
import os
import re
import sys
from datetime import datetime
from email.utils import parsedate_to_datetime

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
        "Bollywood Movies & Shows \u2014 Cast, Box Office & Release Dates | FlickAtlas",
        "Bollywood movies and shows on FlickAtlas \u2014 latest releases, cast & crew, "
        "budgets vs box office collections, trailers and upcoming release dates.",
        "Bollywood movies, Bollywood movies 2026, Hindi movies, Bollywood box office collection, Bollywood cast, FlickAtlas",
    ),
    "world": (
        "World Cinema Movies & Shows \u2014 Hollywood & International Films | FlickAtlas",
        "World cinema on FlickAtlas \u2014 Hollywood and international movies and shows "
        "with cast, budgets, box office collections and release dates.",
        "World cinema, Hollywood movies, international movies, Hollywood movies 2026, world box office collection, FlickAtlas",
    ),
    "pakistani": (
        "Pakistani Movies & Dramas \u2014 Lollywood Films & Drama Serials | FlickAtlas",
        "Pakistani movies and dramas on FlickAtlas \u2014 Lollywood films, drama serials, "
        "episode guides, cast, box office and release dates.",
        "Pakistani dramas, Pakistani movies, Lollywood movies, Pakistani drama episodes, Pakistani drama serials, FlickAtlas",
    ),
}

# (path, changefreq, priority, lastmod-source)
STATIC_PAGES = [
    ("/", "daily", "1.0", "max"),
    ("/movies", "daily", "0.9", "titles"),
    ("/tv", "daily", "0.9", "titles"),
    ("/box-office", "daily", "0.9", "daywise"),
    ("/box-office/milestones", "weekly", "0.8", "daywise"),
    ("/box-office-day", "daily", "0.8", "daywise"),
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
        if "T" in s:
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
    title = (entry.get("title") or "").strip()
    year = year_of(entry)
    ind = INDUSTRY_LABEL.get(entry.get("industry"), "World Cinema")
    is_tv = entry.get("type") == "tv"
    kind = "series" if is_tv else "film"
    genres = [g for g in (entry.get("genres") or [])][:2]
    genre_txt = ", ".join(genres)
    rating = entry.get("vote_average") or 0
    votes = entry.get("vote_count") or 0
    rows = DAYWISE.get(str(entry.get("id")), [])
    total_in = sum((r.get("collection") or 0) for r in rows)
    total_ov = sum((r.get("overseas") or 0) for r in rows)
    has_bo = bool(rows)

    disp = title + ((" (%s)" % year) if year else "")
    if is_tv:
        t = "%s \u2014 Seasons, Episodes, Cast & Story | FlickAtlas" % disp
    elif has_bo:
        t = "%s \u2014 Cast, Box Office Collection & Budget | FlickAtlas" % disp
    else:
        t = "%s \u2014 Cast, Story, Budget & Review | FlickAtlas" % disp

    parts = []
    art = "an" if (genre_txt and genre_txt[0].lower() in "aeiou") else "a"
    head = "%s is %s %s%s %s" % (
        disp, art, (genre_txt + " " if genre_txt else ""), ind, kind)
    parts.append(head)
    if has_bo:
        parts.append("India Net %s across %d days%s" % (
            fmt_money(total_in), len(rows),
            (" + overseas %s" % fmt_money(total_ov)) if total_ov else ""))
    if (entry.get("budget") or 0) > 0:
        parts.append("budget %s" % fmt_money(entry["budget"]))
    if rating and votes:
        parts.append("rated %.1f/10" % rating)
    if entry.get("trailer"):
        parts.append("official trailer")
    core = ". ".join(parts) + "."
    tail = (" Full cast, seasons, episodes and story on FlickAtlas." if is_tv
            else " Full cast, story, budget vs box office and reviews on FlickAtlas.")
    d = core + tail if len(core) + len(tail) <= 160 else core
    d = trunc(d, 160)

    kws = [title]
    if has_bo:
        kws.append("%s box office collection" % title)
    kws.append("%s cast" % title)
    kws.append("%s %s" % (title, "review" if is_tv else "movie review"))
    if (entry.get("budget") or 0) > 0:
        kws.append("%s budget" % title)
    if is_tv:
        if entry.get("industry") == "pakistani":
            kws.append("Pakistani dramas 2026" if year == "2026" else "Pakistani dramas")
            kws.append("Pakistani dramas")
        else:
            kws.append("%s TV shows 2026" % ind if year == "2026" else "%s TV shows" % ind)
            kws.append("%s TV shows" % ind)
    else:
        if year == "2026":
            kws.append("%s movies 2026" % ind)
        kws.append("%s movies" % ind)
    kws.append("FlickAtlas")

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
        ld["aggregateRating"] = {
            "@type": "AggregateRating",
            "ratingValue": round(float(rating), 1),
            "ratingCount": int(votes),
        }
    if is_tv:
        if entry.get("number_of_seasons"):
            ld["numberOfSeasons"] = entry["number_of_seasons"]
        if entry.get("number_of_episodes"):
            ld["numberOfEpisodes"] = entry["number_of_episodes"]
    else:
        if entry.get("runtime"):
            ld["duration"] = "PT%dM" % int(entry["runtime"])
    return {"t": t, "d": d, "k": ", ".join(kws), "img": img_url(entry),
            "ld": ld, "year": year, "industry": entry.get("industry")}


def news_meta(entry):
    headline = (entry.get("headline") or "").strip()
    dek = (entry.get("dek") or "").strip()
    d = trunc(dek, 160) if dek else trunc(headline, 160)
    t = headline + " | FlickAtlas"
    ents = entry.get("entities") or {}
    kws = []
    for p in (ents.get("people") or [])[:3]:
        kws.append(p)
    for ti in (ents.get("titles") or [])[:2]:
        kws.append(ti)
    kws += ["entertainment news", "Bollywood news", "FlickAtlas"]
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
    if pub:
        ld["datePublished"] = pub
        ld["dateModified"] = pub
    return {"t": t, "d": d, "k": ", ".join(kws), "img": img, "ld": ld,
            "published": pub}


def daywise_meta(entry):
    """Day-wise box-office page meta for one title (Worker composes the
    day-specific <title> from the &day= param; the description uses the
    film's totals, which are true for every day page)."""
    title = (entry.get("title") or "").strip()
    year = year_of(entry)
    disp = title + ((" (%s)" % year) if year else "")
    rows = DAYWISE.get(str(entry.get("id")), [])
    total_in = sum((r.get("collection") or 0) for r in rows)
    total_ov = sum((r.get("overseas") or 0) for r in rows)
    latest = rows[-1] if rows else {}
    d = trunc("%s box office collection day-wise: India Net %s across %d days%s. "
              "Day-by-day collection, shows, occupancy and tickets." % (
                  disp, fmt_money(total_in), len(rows),
                  (", overseas %s" % fmt_money(total_ov)) if total_ov else ""),
              160)
    kws = ", ".join([title, "%s box office collection" % title,
                     "%s box office collection day wise" % title,
                     "%s day 1 collection" % title,
                     "Bollywood box office collection" if entry.get("industry") == "bollywood"
                     else "box office collection", "FlickAtlas"])
    return {"t": disp, "year": year, "days": len(rows),
            "total_in": total_in, "total_ov": total_ov,
            "latest_day": latest.get("day"), "latest_date": latest.get("date"),
            "d": d, "k": kws, "img": img_url(entry),
            "ld": title_meta(entry)["ld"]}


def xml_esc(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace('"', "&quot;"))


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
        rows = DAYWISE[tid]
        lm = (rows[-1].get("date") if rows else None) or lastmods["max"]
        urls.append(("%s/box-office-day?title=%s" % (BASE, tid), lm,
                     "daily", "0.8"))
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for loc, lm, freq, prio in urls:
        out.append("  <url><loc>%s</loc><lastmod>%s</lastmod>"
                   "<changefreq>%s</changefreq><priority>%s</priority></url>"
                   % (xml_esc(loc), lm, freq, prio))
    out.append("</urlset>")
    return "\n".join(out) + "\n", len(urls)


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
        f.write("User-agent: *\nAllow: /\nDisallow: /api/\n\n"
                "Sitemap: %s/sitemap.xml\n" % BASE)

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
