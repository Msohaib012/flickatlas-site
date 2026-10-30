#!/usr/bin/env python3
"""Offline checks for FlickAtlas route metadata, sitemap and crawler policy."""
from html.parser import HTMLParser
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import scripts.seo_assets as seo  # noqa: E402
seo.PUBLISHED = {}
seo.ARTICLES = {}
seo.DAYWISE = {}
seo.REVIEWS = seo.read_js_map(ROOT / "js/reviews-data.js", "FA_REVIEWS")
seo.EPISODE_TRACKER = json.loads((ROOT / "out/episodes.json").read_text(encoding="utf-8"))


class HeadMetadata(HTMLParser):
    def __init__(self):
        super().__init__()
        self.title = ""
        self.in_title = False
        self.values = {}
        self.schema = []
        self.schema_buffer = None
        self.social = {}
        self.social_count = {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "title":
            self.in_title = True
        if tag == "meta" and attrs.get("name") in ("description", "keywords"):
            self.values[attrs["name"]] = attrs.get("content", "")
        if tag == "meta":
            for key, selector, value in (
                ("og:title", "property", "og:title"),
                ("og:description", "property", "og:description"),
                ("twitter:title", "name", "twitter:title"),
                ("twitter:description", "name", "twitter:description"),
            ):
                if attrs.get(selector) == value:
                    self.social[key] = attrs.get("content", "")
                    self.social_count[key] = self.social_count.get(key, 0) + 1
        if tag == "script" and attrs.get("type") == "application/ld+json":
            self.schema_buffer = []

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        if tag == "script" and self.schema_buffer is not None:
            self.schema.append(json.loads("".join(self.schema_buffer)))
            self.schema_buffer = None

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        if self.schema_buffer is not None:
            self.schema_buffer.append(data)


shells = []
for path in sorted(ROOT.rglob("index.html")):
    if ".git" in path.parts or "node_modules" in path.parts:
        continue
    parser = HeadMetadata()
    parser.feed(path.read_text(encoding="utf-8"))
    if not parser.title and not parser.values:
        continue
    shells.append((path.relative_to(ROOT).as_posix(), parser))
    assert parser.title.strip(), f"{path}: missing title"
    assert len(parser.title.strip()) <= 60, f"{path}: title exceeds 60 characters"
    description = parser.values.get("description", "").strip()
    assert description, f"{path}: missing meta description"
    assert len(description) <= 160, f"{path}: description exceeds 160 characters"
    for key in ("og:title", "twitter:title"):
        assert parser.social_count.get(key) == 1, f"{path}: expected one {key} tag"
        assert parser.social[key] == parser.title.strip(), f"{path}: {key} mismatch"
    for key in ("og:description", "twitter:description"):
        assert parser.social_count.get(key) == 1, f"{path}: expected one {key} tag"
        assert parser.social[key] == description, f"{path}: {key} mismatch"
    keywords = [part.strip() for part in parser.values.get("keywords", "").split(",")
                if part.strip()]
    assert keywords, f"{path}: missing custom keyword phrases"
    assert len(keywords) == len({word.casefold() for word in keywords}), (
        f"{path}: duplicate keyword phrase")
    assert not any(term in " ".join(keywords).casefold()
                   for term in ("free download", "watch online free")), (
        f"{path}: misleading service claim in keyword metadata")

assert len(shells) >= 20, f"expected all public route shells, found {len(shells)}"
titles = [parser.title.strip().casefold() for _, parser in shells]
assert len(titles) == len(set(titles)), "route-shell titles must be distinct"

by_path = {path: parser for path, parser in shells}
assert "Bollywood" in by_path["index.html"].title
assert "World Cinema" in by_path["index.html"].title
assert "India Net" in by_path["box-office-day/index.html"].values["description"]
assert "Days 1–30" in by_path["box-office-day/index.html"].values["description"]
assert "totals only" in by_path["box-office-day/index.html"].values["description"]
assert "confirmed future streaming dates" in by_path["ott/index.html"].values["description"]
assert "recorded streaming providers" in by_path["where-to-watch/index.html"].values["description"]

def graph_nodes(value):
    if isinstance(value, list):
        for item in value:
            yield from graph_nodes(item)
    elif isinstance(value, dict):
        yield value
        if isinstance(value.get("@graph"), list):
            yield from graph_nodes(value["@graph"])

home_description = by_path["index.html"].values["description"]
for path, parser in shells:
    page_description = parser.values["description"]
    for schema in parser.schema:
        for node in graph_nodes(schema):
            types = node.get("@type", [])
            if not isinstance(types, list):
                types = [types]
            if any(kind in ("WebPage", "CollectionPage") for kind in types):
                assert node.get("description") == page_description, (
                    f"{path}: page structured-data description differs from page metadata")
            if any(kind in ("WebSite", "Organization") for kind in types):
                assert node.get("description") == home_description, (
                    f"{path}: site structured-data description differs from homepage metadata")

generated_meta = json.loads((ROOT / "js/seo-meta.json").read_text(encoding="utf-8"))
assert generated_meta, "generated dynamic metadata must not be empty"
news_titles = [value["t"] for key, value in generated_meta.items()
               if key.startswith("news:")]
assert len(news_titles) == len(set(news_titles)), (
    "compacted article metadata titles must remain unique")
published_for_titles = seo.read_js_map(ROOT / "js/published-titles.js", "FA_PUBLISHED")
for key, value in generated_meta.items():
    assert all(isinstance(value.get(field), str) and value[field].strip()
               for field in ("t", "d", "k")), f"{key}: missing title/description/keywords"
    assert len(value["d"]) <= 160, f"{key}: dynamic description exceeds 160 characters"
    assert isinstance(value.get("ld"), dict), f"{key}: missing structured data"
    family, _, item_id = key.partition(":")
    if family in ("cat", "news"):
        assert len(value["t"]) <= 60, f"{key}: generated title exceeds 60 characters"
    if family in ("movie", "tv"):
        record = published_for_titles[item_id]
        core = seo.plain_text(record.get("title"))
        year = seo.year_of(record)
        if year:
            core += " (%s)" % year
        assert value["t"] == core or value["t"].startswith(core + " — "), (
            f"{key}: detailed title must preserve the exact film/show name")
        if value["t"] != core:
            assert value["t"].endswith(" | FlickAtlas") and len(value["t"]) <= 90, (
                f"{key}: detailed title must fit the limit and retain the brand")
    if key.startswith("daywise:"):
        days = [row.get("day") for row in value.get("day_rows", [])]
        assert all(isinstance(day, int) and 1 <= day <= 30 for day in days), (
            f"{key}: daily SEO rows extend beyond theatrical Day 30")
        assert "Days 1–30" in value["d"] and "later days count in totals" in value["d"], (
            f"{key}: Day-30/totals-only scope is missing from the description")

# Google ignores the meta-keywords tag as a ranking signal; these assertions
# protect the user's requested custom tags without claiming they affect rank.
movie = seo.title_meta({
    "id": "123", "title": "Glass Lantern", "type": "movie",
    "industry": "bollywood", "release_date": "2026-04-10",
    "overview": "A village accountant returns home to settle an old dispute.",
    "budget": 0, "vote_average": 0, "vote_count": 0,
})
assert movie["t"].startswith("Glass Lantern")
assert "Cast" in movie["t"] and "Story" in movie["t"]
assert not any(term in movie["t"] for term in ("Budget", "Box Office", "Review", "Rating"))
assert "Glass Lantern story" in movie["k"]
assert "Glass Lantern release date" in movie["k"]
assert "Glass Lantern review" not in movie["k"]
assert "cast and story" in movie["d"].casefold()
assert "budget" not in movie["d"].casefold() and "review" not in movie["d"].casefold()
assert "streaming" not in movie["d"].casefold()

seo.DAYWISE = {"999": [{"day": "Day 1", "collection": 1234567, "overseas": 0}]}
seo.REVIEWS["999"] = {
    "source": "FlickAtlas Review", "story_plot": "A village story.",
    "overall": 7.0, "verdict": "A strong and thoughtful film.",
}
rich_movie = seo.title_meta({
    "id": "999", "title": "X", "type": "movie", "industry": "world",
    "release_date": "2026-04-10", "overview": "A village accountant returns home.",
    "genres": ["Drama", "Comedy"], "budget": 40000000,
    "vote_average": 8.4, "vote_count": 100,
})
assert "Box Office Collection" in rich_movie["t"] and "Budget" in rich_movie["t"]
assert "Review" in rich_movie["t"] and "Rating" in rich_movie["t"]
for phrase in ("cast and story", "box office collection", "budget", "review 7/10",
               "tmdb rating 8.4/10"):
    assert phrase in rich_movie["d"].casefold(), f"rich movie description missing {phrase}"
for phrase in ("X box office collection", "X budget", "X review", "X rating"):
    assert phrase in rich_movie["k"], f"rich movie keywords missing {phrase}"

world_series = seo.title_meta({
    "id": "200", "title": "Ocean Signal", "type": "tv", "industry": "world",
    "first_air_date": "2024-02-01", "overview": "A rescue crew faces a mystery.",
    "number_of_seasons": 2, "number_of_episodes": 18,
})
assert world_series["t"] == (
    "Ocean Signal (2024) — Seasons, Episodes, Cast & Story | FlickAtlas")
assert "2 seasons" in world_series["d"] and "18 episodes" in world_series["d"]

saved_tracker = seo.EPISODE_TRACKER
seo.EPISODE_TRACKER = {"episodes": {"tracker-row": {"drama": "Dar", "episode": 25}}}
pakistani_series = seo.title_meta({
    "id": "201", "title": "Dar-E-Nijaat", "type": "tv", "industry": "pakistani",
    "first_air_date": "2026-01-01", "overview": "A family drama.",
    "number_of_seasons": 1, "number_of_episodes": 1,
})
seo.EPISODE_TRACKER = saved_tracker
assert "Seasons" not in pakistani_series["t"] and "Episodes" in pakistani_series["t"]
assert "25 episodes" in pakistani_series["d"], (
    "Pakistani show SEO must use the tracker count, not stale TMDB count")

long_name = "The Extraordinary Motion Picture with a Very Long Official Title"
long_movie = seo.title_meta({
    "id": "124", "title": long_name, "type": "movie", "industry": "world",
    "release_date": "2026-04-10", "overview": "A reported story.",
    "budget": 0, "vote_average": 0, "vote_count": 0,
})
assert (long_movie["t"] == long_name + " (2026)" or
        long_movie["t"].startswith(long_name + " (2026) — ")), (
    "long source film names must remain intact without truncation")

article = seo.news_meta({
    "id": "fixture-news", "headline": "Actor joins a new Hindi drama",
    "dek": "A short, factual announcement about the casting.",
    "published": "2026-10-30T12:00:00Z",
    "keywords": ["Actor Name", "New Hindi Drama"],
    "entities": {"people": ["Actor Name"], "titles": ["New Hindi Drama"]},
})
assert article["ld"]["@type"] == "NewsArticle"
assert article["ld"]["keywords"] == "Actor Name, New Hindi Drama"
assert article["ld"]["datePublished"] == "2026-10-30"
assert "Actor Name New Hindi Drama" in article["k"]

long_headline = ("Actor and filmmaker announce a major new Hindi cinema project "
                 "with several further details confirmed today")
long_article = seo.news_meta({"id": "fixture-long-news", "headline": long_headline})
assert len(long_article["t"]) <= 60
assert long_article["t"].endswith(" | FlickAtlas") and "…" in long_article["t"]
assert "……" not in long_article["t"], "title truncation must not add duplicate ellipses"

long_dek = ("This review covers the film's premise, cast and reported reception, "
            "then explains where its execution falls short. " * 5)
long_description = seo.news_meta({
    "id": "fixture-long-description", "headline": "A detailed film review",
    "dek": long_dek,
})["d"]
assert len(long_description) <= 160
assert long_description.endswith("…"), "truncated descriptions must show an ellipsis"
assert long_description[:-1].split()[-1] in long_dek.split(), (
    "description truncation must keep the final word intact")

robots = seo.build_robots()
assert "User-agent: OAI-SearchBot\nAllow: /" in robots
assert "User-agent: OAI-SearchBot\nAllow: /\nAllow: /api/news\nAllow: /api/trends\nAllow: /api/reviews\nDisallow: /api/" in robots
assert "User-agent: *\nAllow: /" in robots
assert "User-agent: GPTBot" not in robots and "User-agent: Google-Extended" not in robots
assert "Sitemap: https://flickatlas.co.uk/sitemap.xml" in robots
assert (ROOT / "robots.txt").read_text(encoding="utf-8") == robots

seo.PUBLISHED = seo.read_js_map(ROOT / "js/published-titles.js", "FA_PUBLISHED")
seo.ARTICLES = seo.read_js_map(ROOT / "js/articles-data.js", "FA_ARTICLES")
seo.DAYWISE = seo.read_js_map(ROOT / "js/daywise-data.js", "FA_DAYWISE")
for entry in seo.ARTICLES.values():
    entry["_pub"] = seo.parse_date(entry.get("published"))

you_me_us = seo.title_meta(seo.PUBLISHED["1541477"])
live_example = generated_meta["movie:1541477"]
assert live_example["t"] == you_me_us["t"]
assert live_example["d"] == you_me_us["d"]
assert live_example["k"] == you_me_us["k"]
assert live_example["t"] == (
    "You, Me, Us (2026) — Cast, Story, Review & Rating | FlickAtlas")
assert all(term in live_example["d"].casefold() for term in (
    "cast", "story", "review", "tmdb rating", "4.1/10"))
assert "budget" not in live_example["d"].casefold()
assert "You, Me, Us review" in live_example["k"]
assert "You, Me, Us budget" not in live_example["k"]

bano = next(entry for entry in seo.PUBLISHED.values()
            if entry.get("type") == "tv" and entry.get("industry") == "pakistani"
            and seo.plain_text(entry.get("title")).casefold() == "bano")
bano_meta = seo.title_meta(bano)
assert "Seasons" not in bano_meta["t"] and "Episodes" in bano_meta["t"]
assert "17 episodes" in bano_meta["d"]

def maximum(values):
    dates = [value for value in values if value]
    return max(dates) if dates else "2026-10-28"

lastmods = {
    "max": maximum([entry.get("published_at") for entry in seo.PUBLISHED.values()]
                    + [entry.get("_pub") for entry in seo.ARTICLES.values()]),
    "titles": maximum([entry.get("published_at") for entry in seo.PUBLISHED.values()]),
    "articles": maximum([entry.get("_pub") for entry in seo.ARTICLES.values()]),
    "daywise": maximum([row.get("date") for rows in seo.DAYWISE.values()
                        for row in rows]),
}
expected_sitemap, url_count = seo.build_sitemap(lastmods)
actual_sitemap = (ROOT / "sitemap.xml").read_text(encoding="utf-8")
assert actual_sitemap == expected_sitemap, "checked-in sitemap is not data-synchronized"
xml_root = ET.fromstring(actual_sitemap)
ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
assert len(xml_root.findall("s:url", ns)) == url_count
assert any(node.text == "2026-10-30" for node in xml_root.findall("s:url/s:lastmod", ns))

print(f"Sitewide SEO: {len(shells)} unique route shells; titles/descriptions/keywords valid; "
      "movie/news metadata data-driven; OAI SearchBot explicitly allowed; sitemap synchronized.")
