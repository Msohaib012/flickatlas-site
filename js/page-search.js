/* FlickAtlas — grouped search over PUBLISHED content only.
   Rewritten 2026-10-25 (published-only rebuild, §3): search reads
   window.FA_PUBLISHED titles (title/overview) and window.FA_ARTICLES
   headlines — never the live TMDB catalogue. TMDB.searchMulti is gone
   entirely. People come from cast data baked into published entries,
   if any; with no cast data the people group is omitted rather than
   calling TMDB. Episode search is gone (no published episode records
   exist to search). All matching is local and instant — no pagination,
   no loading states. */
(function () {
  UI.mountChrome("");
  const main = document.getElementById("app");
  const q = (UI.pageQuery().get("q") || "").trim();
  UI.setSEO({ title: q ? `Search results for “${q}” | FlickAtlas` : "Search FlickAtlas", desc: "Search published movies, TV series, people and news on FlickAtlas.", path: "/search" + (q ? `?q=${encodeURIComponent(q)}` : "") });
  main.innerHTML = `<div class="wrap"><div class="page-hero"><h1>Search FlickAtlas</h1><p>Find published movies, series, people and news.</p></div><form class="search-form" action="/search" method="get"><input type="search" name="q" value="${UI.esc(q)}" placeholder="Try a title, person or story" aria-label="Search query"><button class="btn btn-teal" type="submit">Search</button></form><div id="results" style="margin-top:26px" aria-live="polite"></div></div>`;
  const results = main.querySelector("#results");
  if (!q) { results.innerHTML = `<p style="color:var(--muted)">Type a title, name or story above to get started.</p>`; return; }

  const norm = v => String(v == null ? "" : v).toLocaleLowerCase();
  const textMatch = (x, fields) => fields.some(k => norm(Array.isArray(x[k]) ? x[k].join(" ") : x[k]).includes(norm(q)));
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
  /* Newest first — the homepage recency rule (published_at desc, then
     release/air date desc). */
  const newestFirst = (a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")) || titleDate(b).localeCompare(titleDate(a));
  const dateValue = (x, key) => key === "news" ? parseDate(x.published) : key === "person" ? "" : validDate(titleDate(x) || x.published_at || "");

  /* --- Published-only data sources (no live TMDB) --- */
  const PUB = Object.values(window.FA_PUBLISHED || {}).filter(x => x && x.id != null && x.title);
  const ARTICLES = Object.values(window.FA_ARTICLES || {}).filter(x => x && x.id != null && x.headline);
  /* People only from cast data baked into published entries. The
     published entry shape carries no cast today, so this is normally
     empty — and the people group is then omitted, never fetched. */
  const peopleById = new Map();
  for (const pub of PUB) {
    for (const c of (pub.cast || [])) {
      if (c && c.id != null && c.name && !peopleById.has(String(c.id))) peopleById.set(String(c.id), c);
    }
  }

  const groups = {
    movie: PUB.filter(x => x.type === "movie" && textMatch(x, ["title", "overview"])).sort(newestFirst),
    tv: PUB.filter(x => x.type === "tv" && textMatch(x, ["title", "overview"])).sort(newestFirst),
    person: [...peopleById.values()].filter(p => textMatch(p, ["name"])),
    news: ARTICLES.filter(x => textMatch(x, ["headline", "dek"])).sort((a, b) => parseDate(b.published).localeCompare(parseDate(a.published))),
  };

  /* The people group exists only when published cast data exists. */
  const categories = [["movie", "Movies"], ["tv", "TV / series"]];
  if (peopleById.size) categories.push(["person", "People / celebrities"]);
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
      } else {
        const person = key === "person";
        title = person ? x.name : UI.titleOf(x);
        href = `/${person ? "person" : key === "tv" ? "show" : "movie"}?id=${encodeURIComponent(x.id)}`;
        image = person ? x.profile_path : x.poster_path;
        date = dateValue(x, key);
        info = person ? ([x.known_for_department, (x.known_for || []).map(c => c.title || c.name).filter(Boolean).slice(0, 3).join(", ")].filter(Boolean).join(" · ") || "FlickAtlas profile") : (Number.isFinite(x.vote_average) && x.vote_average > 0 ? `TMDB rating ${x.vote_average.toFixed(1)}/10` : "");
      }
      return `<a class="search-result" href="${UI.esc(href)}"><img src="${UI.img(image || "", "w92")}" alt="" loading="lazy" onerror="this.remove()"><span><small>${date ? UI.esc(UI.fmtDate(date)) : "Date unavailable"}</small><b>${UI.esc(title)}</b><small>${UI.esc(info)}</small></span></a>`;
    }).join("");
    const empty = rows.length ? "" : `<p>No ${{ movie: "movie", tv: "TV or series", person: "people", news: "news" }[key] || label.toLowerCase()} matches in the records checked.</p>`;
    return `<section class="search-group" aria-labelledby="search-${key}"><h2 id="search-${key}">${label} <small>(${rows.length} loaded match${rows.length === 1 ? "" : "es"})</small></h2>${rows.length ? `<div class="search-results">${cards}</div>` : empty}</section>`;
  }

  results.innerHTML = `<nav class="search-category-nav" aria-label="Jump to search category">${categories.map(([key, label]) => `<a href="#search-${key}">${label}</a>`).join(" · ")}</nav><p class="search-date-note">Newest dated results first among loaded matches. Undated records follow dated results. Counts describe loaded matches, not all records.</p>${categories.map(c => section(c[0])).join("")}`;
})();
