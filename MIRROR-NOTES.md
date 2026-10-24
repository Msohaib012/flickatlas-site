# FlickAtlas public site — mirror notes

- **Source:** https://flickatlas.vercel.app (live site, CLI-deployed, no git repo)
- **Mirrored:** 2026-10-25 ~02:50 PKT, via curl with a browser User-Agent, read-only download.
- **Purpose:** local copy for a future git repo so the panel's publish flow can commit
  `window.FA_ARTICLES` into it. Nothing here was deployed, pushed, or modified live.
- **Method:** fetched every top-level HTML page, extracted all local `src`/`href` refs,
  downloaded each preserving its path. External URLs were NOT downloaded.

## File inventory (61 site files, 579268 bytes total — excluding this notes file itself)

- `api-news-sample.json` — 47796 bytes
- `api-trends-sample.json` — 1033 bytes
- `apple-touch-icon.png` — 12653 bytes
- `favicon.ico` — 7709 bytes
- `favicon.svg` — 1465 bytes
- `icon-192.png` — 13170 bytes
- `icon-512.png` — 41665 bytes
- `index.html` — 2690 bytes
- `robots.txt` — 91 bytes
- `site.webmanifest` — 587 bytes
- `sitemap-pages.xml` — 3082 bytes
- `sitemap.xml` — 2230 bytes
- `about/index.html` — 4225 bytes
- `airing-today/index.html` — 2083 bytes
- `awards/index.html` — 1947 bytes
- `box-office/index.html` — 2143 bytes
- `box-office-day/index.html` — 1992 bytes
- `category/index.html` — 1972 bytes
- `celebrities/index.html` — 1971 bytes
- `celebrity-today/index.html` — 2070 bytes
- `contact/index.html` — 3274 bytes
- `css/style.css` — 102636 bytes
- `episode-guides/index.html` — 2131 bytes
- `js/articles-data.js` — 20441 bytes
- `js/boxoffice-latest.js` — 9866 bytes
- `js/celebrity-data.js` — 1621 bytes
- `js/config.js` — 1029 bytes
- `js/daywise-data.js` — 905 bytes
- `js/episode-browser.js` — 7373 bytes
- `js/most-awaited-data.js` — 3494 bytes
- `js/official-trailers.js` — 1935 bytes
- `js/ott-cards.js` — 4867 bytes
- `js/page-awards.js` — 4518 bytes
- `js/page-boxoffice.js` — 21724 bytes
- `js/page-celebrities.js` — 9462 bytes
- `js/page-index.js` — 44916 bytes
- `js/page-movies.js` — 15078 bytes
- `js/page-news-item.js` — 26069 bytes
- `js/page-news.js` — 6682 bytes
- `js/page-search.js` — 11387 bytes
- `js/page-tv.js` — 7343 bytes
- `js/page-upcoming.js` — 14689 bytes
- `js/pk-dramas.js` — 7183 bytes
- `js/rail-scroll.js` — 4835 bytes
- `js/tmdb.js` — 2326 bytes
- `js/trending-searches.js` — 10628 bytes
- `js/ui.js` — 49066 bytes
- `most-awaited/index.html` — 1975 bytes
- `movie/index.html` — 2094 bytes
- `movies/index.html` — 1997 bytes
- `news/index.html` — 2004 bytes
- `news-item/index.html` — 1972 bytes
- `ott/index.html` — 2022 bytes
- `person/index.html` — 1924 bytes
- `privacy/index.html` — 5173 bytes
- `search/index.html` — 1965 bytes
- `show/index.html` — 2069 bytes
- `trailers/index.html` — 2030 bytes
- `tv/index.html` — 1947 bytes
- `upcoming/index.html` — 2030 bytes
- `where-to-watch/index.html` — 2014 bytes

## Pages mirrored (HTTP 200)

`/`, `/news`, `/news-item`, `/movies`, `/tv`, `/box-office`, `/search`, `/celebrities`,
`/upcoming`, `/trailers`, `/awards`, `/about`, `/airing-today`, `/category`,
`/celebrity-today`, `/contact`, `/episode-guides`, `/most-awaited`, `/movie`, `/ott`,
`/person`, `/privacy`, `/show`, `/where-to-watch`, `/box-office-day`, `/sitemap.xml`,
`/sitemap-pages.xml`, `/robots.txt`.

All pages are the same JS-driven SPA shell (~2 KB each, except `/about` 4,225 B,
`/contact` 3,274 B and `/privacy` 5,173 B which carry real static copy). Content is
rendered client-side by `/js/page-*.js` + `/js/ui.js`.

## Routes that 404 (NOT real pages — the site's own "Page Not Found" HTML)

`/episodes`, `/music`, `/viral`, `/anime`, `/asian`, `/browse`, `/settings`, `/list`.
(Those categories exist in the panel pipeline, but the public site has no such pages;
they are reached via `/news`, `/category`, etc. instead.)

## Failed local-asset downloads

None. Every local asset referenced by the HTML returned HTTP 200 and is non-empty.
All 22 `.js` files pass `node --check` (0 failures). `/css/style.css` (102,636 B) is
non-empty. No `.js`/`.css` file failed validation.

## External asset hosts referenced (NOT downloaded)

- `fonts.googleapis.com` / `fonts.gstatic.com` — Inter font (400/600/700/800)
- `image.tmdb.org` — TMDB poster/still images (`https://image.tmdb.org/t/p`, see `js/config.js`)
- `api.themoviedb.org` — TMDB API (client key is in `js/config.js`, public by design)
- `www.youtube.com` — trailer embeds
- `www.hindustantimes.com`, `www.justjared.com` — linked in JS (feed/source references)
- `schema.org` — JSON-LD vocabulary only

## /api routes referenced by the site's JS

- `/api/news` — live entertainment feed. Used by `page-index.js`, `page-news.js`,
  `page-news-item.js`, `page-awards.js`, `page-search.js`.
- `/api/trends` — trending searches. Used by `trending-searches.js` (`const API = '/api/trends'`).
- `js/config.js` also mentions `api/sitemap.js` (server-side sitemap generator) — not
  referenced by page JS and not downloadable (serverless function code is not served).

Sample responses saved (NOT part of the site files, samples only):
- `api-news-sample.json` (47,796 B) — `{"generated": "<ISO time>", "count": 80, "items": [{id, title, link, source, cats[], ts, summary}]}`. Item `id` is a short hash; `cats` e.g. `["international"]`, `["celebrity","international"]`.
- `api-trends-sample.json` (1,033 B) — `{"generated": "<ISO time>", "items": [{q, traffic, geo, news}]}`.

## Sitemaps

- `sitemap.xml` (2,230 B) — index listing 19 generated sitemaps.
- `sitemap-pages.xml` (3,082 B) — mirrored (static pages list).
- The other 18 (`sitemap-movies-1..10.xml`, `sitemap-tv-1..5.xml`, `sitemap-people-1.xml`,
  `sitemap-episodes-1.xml` ~680 KB, `sitemap-daywise-1.xml`) are **generated at request
  time from TMDB data** — NOT mirrored, they are outputs, not source files. They will
  regenerate once the site is redeployed from a repo with the sitemap function.

## Publish-relevant findings (for the panel integration)

- `js/articles-data.js` (20,441 B) is `window.FA_ARTICLES = { "<id>": {id, type, headline, dek, body[], ...} }`.
  Header says it is GENERATED by the data engine (`pipeline/rewrite.py` via
  `export_articles.py`) — "do not edit by hand". This is the file the panel's
  `publishApprovedArticle` is designed to overwrite (its `FLICKATLAS_PUBLIC_ARTICLES_PATH`).
- `js/page-news-item.js` first looks the `?id=` up in the `/api/news` live feed
  (by `UI.newsId`, the FNV-1a hash of the story link). If the story is not in the
  feed it renders the "This story has moved on" fallback and returns. Only when
  the feed item IS found does it check `window.FA_ARTICLES[id]` for a full
  engine-written article (else BRIEF MODE). That is why a panel-approved draft
  that was never published shows "moved on" — and why a panel draft's id MUST
  be the FNV hash of its source URL, or the feed lookup fails first.
- `js/config.js` holds `BASE: "https://flickatlas.vercel.app"` plus a note: when the
  custom domain (`flickatlas.co.uk`) is attached, flip BASE here, in `api/sitemap.js`,
  and in `robots.txt`. The TMDB key in `config.js` is a public client-side key.

## What this mirror does NOT contain

- The Vercel serverless functions (`/api/news`, `/api/trends`, `api/sitemap.js`) — their
  code is not served by the site and cannot be downloaded. They must be recreated (or
  obtained from the original builder, cue) for the repo.
- `vercel.json` / build config / env vars — not served; unknown from the outside.
- Generated sitemap outputs (see above) and any runtime feed data.
