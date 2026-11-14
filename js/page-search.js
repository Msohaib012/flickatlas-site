/* FlickAtlas — grouped search over PUBLISHED content first, with a live
   TMDB fallback for every query (stage 1a, 2026-11-14; always-on
   since 2026-11-14 — catalogue titles must surface even when
   published titles also match).
   Rewritten 2026-10-25 (published-only rebuild, §3): search reads
   window.FA_PUBLISHED titles (title/overview) and window.FA_ARTICLES
   headlines — never the live TMDB catalogue. People come from cast
   data baked into published entries, if any; with no cast data the
   people group is omitted rather than calling TMDB. Episode posts ARE
   searchable — they live in FA_ARTICLES (headlines like "Bano Episode
   13 — Watch on Geo TV") and appear under the News group. All
   matching is local and instant — no pagination, no loading states.
   The TMDB fallback below runs for every non-empty query (one call,
   deduped against local results, fail-open) — it is how catalogue
   titles are found, since no local catalogue search index exists yet.
   Results carry a .fa-select in-page dropdown (All / Movies / TV /
   People / News) that shows only one result group at a time — never
   a native <select> popup. */
(function () {
  UI.mountChrome("");
  const main = document.getElementById("app");
  const q = (UI.pageQuery().get("q") || "").trim();
  UI.setSEO({ title: q ? `Search results for “${q}” | FlickAtlas` : "Search FlickAtlas", desc: "Search published movies, TV series, people and news on FlickAtlas.", path: "/search" + (q ? `?q=${encodeURIComponent(q)}` : "") });
  main.innerHTML = `<div class="wrap"><div class="page-hero"><h1>Search FlickAtlas</h1></div><form class="search-form" action="/search" method="get"><input type="search" name="q" value="${UI.esc(q)}" placeholder="Try a title, person or story" aria-label="Search query"><button class="btn btn-teal" type="submit">Search</button></form><div id="results" style="margin-top:26px" aria-live="polite"></div></div>`;
  const results = main.querySelector("#results");
  if (!q) { results.innerHTML = `<p style="color:var(--muted)">Type a title, name or story above to get started.</p>`; return; }

  const norm = v => String(v == null ? "" : v).toLocaleLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
  const qNorm = norm(q);
  const qWords = qNorm.split(" ").filter(w => w.length >= 2 || /^\d+$/.test(w));
  /* Generic industry words carry no identity: they may complete a
     phrase, but they cannot by themselves trigger the title-word rule
     or the one-word-short rule — otherwise every box-office article
     matches every "<title> box office" query. */
  const GENERIC = new Set(["box", "office", "collection", "collections", "day", "daily", "wise", "movie", "movies", "film", "films", "trailer", "teaser", "review", "reviews", "news", "song", "songs", "episode", "episodes", "watch", "online"]);
  /* Word-based matching (fix 2026-11-02): the old matcher required the
     WHOLE query as one substring of title/overview, so any multi-word
     query ("nayyi navelli box office") failed unless the exact phrase
     was printed verbatim on the site. Now a record matches when every
     query word appears somewhere in its searchable text (title,
     overview, tagline, genres, cast, keywords, mentioned people); an
     exact-phrase hit ranks first, and for 3+ word queries a record one
     word short still counts, ranked last. */
  const scoreText = (t, tt) => {
    if (!t || qNorm.length < 2) return 0;
    if (t.includes(qNorm)) return 3;
    if (!qWords.length) return 0;
    let hits = 0, dHits = 0;
    for (const w of qWords) if (t.includes(w)) { hits++; if (!GENERIC.has(w) && /[a-z]/.test(w)) dHits++; }
    if (hits === qWords.length) return 2;
    /* Title-word rule: 2+ distinctive query words inside the
       title/headline itself is a real match even when the remaining
       words ("box office") are only implied — "nayyi navelli box
       office" must find the Nayyi Navelli film and its box-office
       page. */
    if (tt) {
      let th = 0;
      for (const w of qWords) if (!GENERIC.has(w) && tt.includes(w)) th++;
      if (th >= 2) return 1.5;
    }
    if (qWords.length >= 3 && hits === qWords.length - 1 && dHits >= 1) return 1;
    return 0;
  };
  const textOfTitle = x => norm([x.title, x.overview, x.tagline,
    ...(Array.isArray(x.genres) ? x.genres : []),
    ...((x.cast || []).map(c => c && c.name))].filter(Boolean).join(" "));
  const textOfArticle = a => norm([a.headline, a.dek,
    ...(Array.isArray(a.keywords) ? a.keywords : []),
    ...((a.entities && Array.isArray(a.entities.people)) ? a.entities.people : [])].filter(Boolean).join(" "));
  const scored = (rows, textFn, titleFn, cmp) => rows
    .map(x => ({ x, s: scoreText(textFn(x), titleFn ? titleFn(x) : "") }))
    .filter(r => r.s > 0)
    .sort((a, b) => b.s - a.s || cmp(a.x, b.x))
    .map(r => r.x);
  const validDate = v => {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) { const date = new Date(v); return Number.isFinite(date.getTime()) ? date.toISOString() : ""; }
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}(?:[Tt ][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-][0-2]\d:?\d\d)?)?$/.test(v)) return "";
    const t = Date.parse(v); return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v.slice(0, 10) ? new Date(t).toISOString() : "";
  };
  const parseDate = v => {
    const d = validDate(v);
    if (d) return d;
    const t = Date.parse(String(v || ""));
    return Number.isFinite(t) ? new Date(t).toISOString() : "";
  };
  const titleDate = x => x.type === "tv" ? (x.first_air_date || "") : (x.release_date || "");
  /* Newest first — the site-wide recency rule (user order 2026-10-26):
     RELEASE/AIR DATE desc first (the latest release leads, then going
     back); published_at only breaks ties. The old published_at-first
     order scrambled results whenever titles were published in batches. */
  const newestFirst = (a, b) => titleDate(b).localeCompare(titleDate(a)) || String(b.published_at || "").localeCompare(String(a.published_at || ""));
  const dateValue = (x, key) => key === "news" ? parseDate(x.published) : key === "person" ? "" : validDate(titleDate(x) || x.published_at || "");

  /* --- Published-only data sources (no live TMDB) --- */
  const PUB = Object.values(window.FA_PUBLISHED || {}).filter(x => x && x.id != null && x.title);
  const ARTICLES = Object.values(window.FA_ARTICLES || {}).filter(x => x && x.id != null && x.headline);
  /* People: published entries carry no cast, so the people group used to
     be empty and the header's promise of people search was never kept.
     Articles DO carry entities.people (names mentioned in each story), so
     the people index is built from those — each person links to the
     newest published story that mentions them (there is no person profile
     without a TMDB person id, and inventing one would be a live lookup). */
  const peopleByName = new Map();
  for (const a of ARTICLES) {
    const names = (a.entities && Array.isArray(a.entities.people)) ? a.entities.people : [];
    for (const name of names) {
      const n = String(name || "").trim();
      if (!n) continue;
      if (!peopleByName.has(n)) peopleByName.set(n, { name: n, articles: [] });
      peopleByName.get(n).articles.push(a);
    }
  }
  for (const p of peopleByName.values()) {
    p.articles.sort((a, b) => parseDate(b.published).localeCompare(parseDate(a.published)));
  }
  const peopleById = new Map([...peopleByName.values()].map(p => [p.name, p]));
  const knownNames = new Set(peopleById.keys());
  for (const pub of PUB) {
    for (const c of (pub.cast || [])) {
      if (c && c.id != null && c.name && !knownNames.has(c.name) && !peopleById.has(String(c.id))) {
        peopleById.set(String(c.id), c);
        knownNames.add(c.name);
      }
    }
  }

  /* Box Office group: titles with day-wise collection data (FA_DAYWISE
     keys joined to their published entries). Their searchable text
     carries "box office collection" so "<title> box office" queries
     land here — box office is this site's core, and it was invisible
     to search before (fix 2026-11-02). */
  const BO = Object.keys(window.FA_DAYWISE || {}).map(id => (window.FA_PUBLISHED || {})[id]).filter(x => x && x.title);
  const textOfBO = x => textOfTitle(x) + " box office collection day wise";
  const groups = {
    movie: scored(PUB.filter(x => x.type === "movie"), textOfTitle, x => norm(x.title), newestFirst),
    tv: scored(PUB.filter(x => x.type === "tv"), textOfTitle, x => norm(x.title), newestFirst),
    person: scored([...peopleById.values()], p => norm(p.name), null, () => 0),
    boxoffice: scored(BO, textOfBO, x => norm(x.title), newestFirst),
    news: scored(ARTICLES, textOfArticle, a => norm(a.headline), (a, b) => parseDate(b.published).localeCompare(parseDate(a.published))),
  };

  /* The people group exists only when published cast data exists. */
  const categories = [["movie", "Movies"], ["tv", "TV / series"]];
  if (peopleById.size) categories.push(["person", "People / celebrities"]);
  categories.push(["boxoffice", "Box Office"]);
  categories.push(["news", "News"]);

  function section(key) {
    const rows = groups[key] || [];
    const label = categories.find(x => x[0] === key)[1];
    const cards = rows.map(x => {
      let title, href, image, info, date;
      if (key === "news") {
        title = x.headline || "News item";
        href = `/news-item?id=${encodeURIComponent(x.id)}`;
        image = (x.images && x.images[0] && x.images[0].url) || "";
        date = dateValue(x, key);
        info = "News";
      } else if (key === "person") {
        /* Entity people (from article entities) have no profile id, so
           they link to the newest published story that mentions them —
           never to a /person?id=undefined dead link. Cast people (when
           baked cast exists) link to their profile as before. */
        const fromEntity = Array.isArray(x.articles);
        title = x.name;
        if (fromEntity) {
          const newest = x.articles[0];
          href = newest ? `/news-item?id=${encodeURIComponent(newest.id)}` : "#";
          image = "";
          date = newest ? parseDate(newest.published) : "";
          info = `Mentioned in ${x.articles.length} published stor${x.articles.length === 1 ? "y" : "ies"}`;
        } else {
          href = `/person?id=${encodeURIComponent(x.id)}`;
          image = x.profile_path || "";
          date = dateValue(x, key);
          info = ([x.known_for_department, (x.known_for || []).map(c => c.title || c.name).filter(Boolean).slice(0, 3).join(", ")].filter(Boolean).join(" · ") || "FlickAtlas profile");
        }
      } else if (key === "boxoffice") {
        title = UI.titleOf(x);
        href = `/box-office-day?title=${encodeURIComponent(x.id)}`;
        image = x.poster_path || "";
        date = dateValue(x, key);
        info = "Day-wise box office";
      } else {
        title = UI.titleOf(x);
        href = `/${key === "tv" ? "show" : "movie"}?id=${encodeURIComponent(x.id)}`;
        image = x.poster_path || "";
        date = dateValue(x, key);
        info = (Number.isFinite(x.vote_average) && x.vote_average > 0 ? `TMDB rating ${x.vote_average.toFixed(1)}/10` : "");
      }
      /* Audit fix: an <img src=""> was rendered for results without an
         image (empty src). Render the img only when an image exists. */
      /* News results carry an EXTERNAL image URL (not a TMDB path), so
         UI.img() would build a broken TMDB-prefixed URL — downscale it
         through UI.newsImg instead, with a fallback to the original. */
      const isExtImg = /^https?:\/\//i.test(image || "");
      const imgSrc = image ? (isExtImg ? UI.newsImg(image, 300) : UI.img(image, "w92")) : "";
      const imgErr = isExtImg ? "this.onerror=null;this.src='" + UI.esc(image) + "'" : "this.remove()";
      const imgHtml = imgSrc ? `<img src="${UI.esc(imgSrc)}" alt="" loading="lazy" onerror="${imgErr}">` : "";
      return `<a class="search-result" href="${UI.esc(href)}">${imgHtml}<span><small>${date ? UI.esc(UI.fmtDate(date)) : "Date unavailable"}</small><b>${UI.esc(title)}</b><small>${UI.esc(info)}</small></span></a>`;
    }).join("");
    const empty = rows.length ? "" : `<p>No ${{ movie: "movie", tv: "TV or series", person: "people", boxoffice: "box office", news: "news" }[key] || label.toLowerCase()} matches in the records checked.</p>`;
    return `<section class="search-group" aria-labelledby="search-${key}"><h2 id="search-${key}">${label} <small>(${rows.length} loaded match${rows.length === 1 ? "" : "es"})</small></h2>${rows.length ? `<div class="search-results">${cards}</div>` : empty}</section>`;
  }

  /* Result-type dropdown: All results, or one group (Movies / TV /
     People / News). The jump nav and the sections below follow it. */
  let show = "all";
  results.innerHTML = `<div id="searchFilterHost"><div class="listing-select-row listing-select-row--single">
      <div class="filter-select" role="group" aria-labelledby="searchSelectLabel"><span class="filter-select-label" id="searchSelectLabel">Show</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="searchTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="searchOptions" aria-labelledby="searchSelectLabel searchValue"><span class="fa-select-value" id="searchValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="searchOptions" role="listbox" aria-labelledby="searchSelectLabel" hidden></div></div></div>
    </div></div><div id="searchGroups"></div>`;
  const groupsHost = results.querySelector("#searchGroups");

  /* TMDB fallback (stage 1a, 2026-11-14; always-on since 2026-11-14):
     ONE live TMDB multi-search runs for every non-empty query and its
     movie/tv results render as a "More results from TMDB" section —
     catalogue titles must surface even when published titles also
     match (the old total-miss trigger hid them). Rows already in the
     local groups are deduped out. Clicking a result goes to the
     detail page, which renders from its catalogue chunk if the title
     is catalogued, else the existing "not published" state.
     Cached per query so filter changes re-render without a second
     call; fail-open — a TMDB failure (or an empty TMDB answer) leaves
     the normal results state. */
  let tmdbFallback = null; // { done, rows: [{ media_type, id, title/name, poster_path, release_date/first_air_date, vote_average }] }
  function tmdbSectionHtml() {
    if (!tmdbFallback || !tmdbFallback.done || !tmdbFallback.rows.length) return "";
    const rows = show === "all" ? tmdbFallback.rows
      : show === "movie" ? tmdbFallback.rows.filter(r => r.media_type === "movie")
      : show === "tv" ? tmdbFallback.rows.filter(r => r.media_type === "tv")
      : [];
    if (!rows.length) return "";
    const cards = rows.map(r => {
      const isMovie = r.media_type === "movie";
      const title = r.title || r.name || "Untitled";
      const href = `/${isMovie ? "movie" : "show"}?id=${encodeURIComponent(r.id)}`;
      const image = r.poster_path || "";
      const date = r.release_date || r.first_air_date || "";
      const info = (Number.isFinite(r.vote_average) && r.vote_average > 0 ? `TMDB rating ${r.vote_average.toFixed(1)}/10` : "");
      const imgSrc = image ? UI.img(image, "w92") : "";
      const imgHtml = imgSrc ? `<img src="${UI.esc(imgSrc)}" alt="" loading="lazy" onerror="this.remove()">` : "";
      return `<a class="search-result" href="${UI.esc(href)}">${imgHtml}<span><small>${date ? UI.esc(UI.fmtDate(date)) : "Date unavailable"}</small><b>${UI.esc(title)}</b><small>${UI.esc(info)}</small></span></a>`;
    }).join("");
    return `<section class="search-group" aria-labelledby="search-tmdb"><h2 id="search-tmdb">More results from TMDB <small>(${rows.length} match${rows.length === 1 ? "" : "es"})</small></h2><p class="search-date-note">These titles come from TMDB, not from FlickAtlas's published catalogue — opening one shows its detail page if it has been catalogued, otherwise the usual not-published state.</p><div class="search-results">${cards}</div></section>`;
  }
  function renderResults() {
    const shown = show === "all" ? categories : categories.filter(([key]) => key === show);
    groupsHost.innerHTML = `<nav class="search-category-nav" aria-label="Jump to search category">${shown.map(([key, label]) => `<a href="#search-${key}">${label}</a>`).join(" · ")}</nav><p class="search-date-note">Newest dated results first among loaded matches. Undated records follow dated results. Counts describe loaded matches, not all records.</p>${shown.map(c => section(c[0])).join("")}${tmdbSectionHtml()}`;
  }
  UI.mountFaSelect(results.querySelector("#searchFilterHost .filter-select"),
    [{ value: "all", label: "All results" }, ...categories.map(([key, label]) => ({ value: key, label }))],
    show, (v) => { show = v; renderResults(); });
  renderResults();
  /* Kick off the TMDB fallback for every non-empty query (2026-11-14):
     catalogue titles must surface even when published titles also
     match. One call per query; rows already in the local groups are
     deduped out; fail-open. */
  if (q && qNorm.length >= 2) {
    tmdbFallback = { done: false, rows: [] };
    TMDB.searchMulti(q, 1).then((data) => {
      const localIds = new Set([
        ...groups.movie.map(x => "movie:" + x.id),
        ...groups.tv.map(x => "tv:" + x.id),
      ]);
      const rows = ((data && data.results) || [])
        .filter(r => r && (r.media_type === "movie" || r.media_type === "tv") && (r.title || r.name))
        .filter(r => !localIds.has(r.media_type + ":" + r.id))
        .slice(0, 20);
      tmdbFallback = { done: true, rows };
      renderResults();
    }).catch(() => { tmdbFallback = { done: true, rows: [] }; renderResults(); });
  }
})();



