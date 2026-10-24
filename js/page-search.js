/* FlickAtlas — grouped universal search across supported content types */
(async function () {
  UI.mountChrome("");
  const main = document.getElementById("app");
  const q = (UI.pageQuery().get("q") || "").trim();
  UI.setSEO({ title: q ? `Search results for “${q}” | FlickAtlas` : "Search FlickAtlas", desc: "Search movies, TV series, people, news and available episode records.", path: "/search" + (q ? `?q=${encodeURIComponent(q)}` : "") });
  const categories = [["movie", "Movies"], ["tv", "TV / series"], ["person", "People / celebrities"], ["news", "News"], ["episode", "Episodes"]];
  main.innerHTML = `<div class="wrap"><div class="page-hero"><h1>Search FlickAtlas</h1><p>Find movies, series, people, news and available episode records.</p></div><form class="search-form" action="/search" method="get"><input type="search" name="q" value="${UI.esc(q)}" placeholder="Try a title, person or story" aria-label="Search query"><button class="btn btn-teal" type="submit">Search</button></form><div id="results" style="margin-top:26px" aria-live="polite"></div></div>`;
  const results = main.querySelector("#results");
  if (!q) { results.innerHTML = `<p style="color:var(--muted)">Type a title, name or story above to get started.</p>`; return; }
  const queryToken = `${q}:${Date.now()}`; window.__faSearchToken = queryToken;
  results.innerHTML = UI.stateMsg("Searching movies, series, people and news…", false);
  const norm = v => String(v == null ? "" : v).toLocaleLowerCase();
  const validDate = v => {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) { const date = new Date(v); return Number.isFinite(date.getTime()) ? date.toISOString() : ""; }
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}(?:[Tt ][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-][0-2]\d:?\d\d)?)?$/.test(v)) return "";
    const t = Date.parse(v); return Number.isFinite(t) && new Date(t).toISOString().slice(0,10) === v.slice(0,10) ? new Date(t).toISOString() : "";
  };
  const dateValue = (x, key) => key === "news" ? (validDate(x.ts) || validDate(x.published_at || x.date)) : key === "person" ? "" : validDate(x.release_date || x.first_air_date || x.air_date || x.published_at || x.date);
  const groups = { movie: [], tv: [], person: [], news: [], episode: [] };
  const loadedPages = { movie: 0, tv: 0, person: 0 }, totalPages = { movie: 0, tv: 0, person: 0 };
  let busy = false, newsStatus = "Loading news…", titleSearchError = "", pageErrors = { movie: "", tv: "", person: "" }, episodeStatus = "Loading episodes from matching series…";
  const textMatch = (x, fields) => fields.some(k => norm(Array.isArray(x[k]) ? x[k].join(" ") : x[k]).includes(norm(q)));
  function recordKey(item) { return item.id != null ? String(item.id) : `${item.title || item.headline || item.name || ""}:${item.ts || item.published_at || item.date || ""}`; }
  function appendUnique(key, items) { const have = new Set(groups[key].map(recordKey)); for (const item of items) if (item) { const id = recordKey(item); if (!have.has(id)) { groups[key].push(item); have.add(id); } } }
  const safeInternalHref = href => typeof href === "string" && /^\/(?!\/)[A-Za-z0-9_./?=&%-]*$/.test(href) ? href : "";
  function section(key) {
    const rows = groups[key].slice().sort((a,b) => (dateValue(b,key) ? 1 : 0) - (dateValue(a,key) ? 1 : 0) || dateValue(b,key).localeCompare(dateValue(a,key)));
    const label = categories.find(x => x[0] === key)[1];
    const cards = rows.map(x => {
      let title, href, image, info, date;
      if (key === "news") { title = x.title || x.headline || x.name || "News item"; href = safeInternalHref(x.href) || (x.id != null ? `/news-item?id=${encodeURIComponent(x.id)}` : "/news"); image = x.image || x.image_url || ""; date = dateValue(x,key); info = x.source || (Array.isArray(x.cats) ? x.cats.join(" · ") : "News"); }
      else if (key === "episode") { title = x.name || x.title || "Episode"; href = `/show?id=${encodeURIComponent(x.show_id)}&season=${encodeURIComponent(x.season_number)}&ep=${encodeURIComponent(x.episode_number)}`; image = x.still_path || ""; date = dateValue(x,key); info = x.show_name || "Episode"; }
      else { const person = key === "person"; title = person ? x.name : UI.titleOf(x); href = `/${person ? "person" : key === "tv" ? "show" : "movie"}?id=${encodeURIComponent(x.id)}`; image = person ? x.profile_path : x.poster_path; date = dateValue(x,key); info = person ? ([x.known_for_department, (x.known_for || []).map(c => c.title || c.name).filter(Boolean).slice(0,3).join(", ")].filter(Boolean).join(" · ") || "FlickAtlas profile") : (Number.isFinite(x.vote_average) && x.vote_average > 0 ? `TMDB rating ${x.vote_average.toFixed(1)}/10` : ""); }
      return `<a class="search-result" href="${UI.esc(href)}"><img src="${UI.img(image || "", "w92")}" alt="" loading="lazy" onerror="this.remove()"><span><small>${date ? UI.esc(UI.fmtDate(date)) : "Date unavailable"}</small><b>${UI.esc(title)}</b><small>${UI.esc(info)}</small></span></a>`;
    }).join("");
    let notice = key === "episode" ? `<p role="status">${UI.esc(episodeStatus)} Episodes from the latest listed season of up to 3 matching series. Other seasons are not searched.</p>` : "";
    if (key === "news" && newsStatus) notice = `<p role="status">${UI.esc(newsStatus)}</p>`;
    if (["movie","tv","person"].includes(key) && titleSearchError && !rows.length) notice = `<p role="alert">${UI.esc(titleSearchError)}</p>`;
    if (pageErrors[key]) notice += `<p role="alert">${UI.esc(pageErrors[key])}</p>`;
    const empty = key === "episode" ? (episodeStatus.startsWith("No ") || episodeStatus.startsWith("Could not") ? "" : "") : key === "news" && newsStatus === "Loading news…" ? "" : rows.length ? "" : `<p>No ${{movie:"movie",tv:"TV or series",person:"people",news:"news"}[key] || label.toLowerCase()} matches in the records checked.</p>`;
    const canMore = ["movie","tv","person"].includes(key) && loadedPages[key] >= 0 && loadedPages[key] < Math.min(totalPages[key] || loadedPages[key], 3);
    return `<section class="search-group" aria-labelledby="search-${key}"><h2 id="search-${key}">${label} <small>(${rows.length} loaded match${rows.length === 1 ? "" : "es"})</small></h2>${notice}${rows.length ? `<div class="search-results">${cards}</div>` : empty}${canMore ? `<button class="btn btn-secondary" data-more="${key}" ${busy ? "disabled" : ""}>${pageErrors[key] ? "Retry loading" : "Load more"} ${label.toLowerCase()}</button>` : ""}</section>`;
  }
  function render() {
    if (window.__faSearchToken !== queryToken) return;
    results.innerHTML = `<nav class="search-category-nav" aria-label="Jump to search category">${categories.map(([key,label])=>`<a href="#search-${key}">${label}</a>`).join(" · ")}</nav><p class="search-date-note">Newest dated results first among loaded matches. Undated records follow dated results. Counts describe loaded matches, not all records.</p>${categories.map(c => section(c[0])).join("")}`;
    results.querySelectorAll("[data-more]").forEach(b => b.addEventListener("click", () => loadPage(b.dataset.more)));
  }
  async function loadPage(key) {
    if (busy || loadedPages[key] >= Math.min(totalPages[key] || 0, 3) || window.__faSearchToken !== queryToken) return;
    busy = true; render(); const page = loadedPages[key] + 1;
    try { const d = await TMDB.searchMulti(q, page); if (window.__faSearchToken !== queryToken) return; appendUnique(key, (d.results || []).filter(x => x && x.media_type === key && textMatch(x,["title","name","original_title","original_name","overview"]))); loadedPages[key] = page; pageErrors[key] = ""; }
    catch (_) { if (window.__faSearchToken === queryToken) pageErrors[key] = `Could not load page ${page} of ${key} results. Use Load more to retry.`; }
    finally { busy = false; if (window.__faSearchToken === queryToken) render(); }
  }
  async function loadEpisodes(tvRows) {
    const matches = tvRows.slice(0, 3);
    if (!matches.length) { episodeStatus = "No matching series were available to check for episode records."; render(); return; }
    let checked = 0, failures = 0;
    for (const series of matches) {
      try {
        const detail = await TMDB.details("tv", series.id);
        const seasons = (detail.seasons || []).filter(s => Number(s.season_number) > 0).sort((a,b) => Number(b.season_number)-Number(a.season_number));
        const season = seasons[0]; if (!season) { checked++; continue; }
        const data = await TMDB.api(`/tv/${series.id}/season/${season.season_number}`);
        const eps = (data.episodes || []).filter(e => e && (textMatch(e,["name","overview"]) || textMatch(series,["name","original_name","overview"])));
        appendUnique("episode", eps.map(e => ({...e, show_id: series.id, show_name: UI.titleOf(series)}))); checked++;
      } catch (_) { failures++; }
    }
    episodeStatus = groups.episode.length ? "" : failures === matches.length ? "Could not load episode records for the matching series. Please retry the search." : "No matching episodes were found in the latest available seasons checked.";
    render();
  }
  // Start independent feed requests together; render title results without waiting for the news feed.
  const titlePromise = (async () => {
    const pages = await Promise.all([1,2].map(p => TMDB.searchMulti(q,p).then(d => ({ok:true,d})).catch(() => ({ok:false,d:{results:[],total_pages:0}}))));
    if (window.__faSearchToken !== queryToken) return;
    if (pages.every(x => !x.ok)) titleSearchError = "Movie, TV and people search is temporarily unavailable.";
    for (let i=0;i<pages.length;i++) { const {d}=pages[i]; for (const key of ["movie","tv","person"]) appendUnique(key,(d.results||[]).filter(x=>x && x.media_type===key && textMatch(x,["title","name","original_title","original_name","overview"]))); totalPages.movie=Math.max(totalPages.movie,d.total_pages||0); totalPages.tv=Math.max(totalPages.tv,d.total_pages||0); totalPages.person=Math.max(totalPages.person,d.total_pages||0); }
    for (const key of ["movie","tv","person"]) {
      loadedPages[key] = pages[0].ok ? (pages[1].ok ? 2 : 1) : 0;
      if (pages.some(p => !p.ok)) pageErrors[key] = `Some search pages could not load. ${totalPages[key] ? "Use Retry loading to check the missing page." : "Submit the search again to retry."}`;
    }
    render(); loadEpisodes(groups.tv.slice());
  })();
  const newsPromise = (async () => {
    try { const response = await fetch("/api/news"); if (!response.ok) throw new Error(); const payload = await response.json(); const items = Array.isArray(payload.items) ? payload.items : []; appendUnique("news",items.filter(x=>textMatch(x,["title","summary","source","cats"]))); newsStatus = items.length ? (groups.news.length ? "" : "No news matches in the loaded feed.") : "The news feed returned no searchable items."; }
    catch (_) { const items = Array.isArray(window.FA_NEWS_ITEMS) ? window.FA_NEWS_ITEMS : []; appendUnique("news",items.filter(x=>textMatch(x,["title","headline","summary","description","source","cats"]))); newsStatus = items.length ? (groups.news.length ? "" : "No news matches in the loaded feed.") : "News search is temporarily unavailable."; }
    render();
  })();
  await Promise.all([titlePromise.catch(()=>{if(window.__faSearchToken===queryToken){titleSearchError="Movie, TV and people search is temporarily unavailable.";render();}}),newsPromise]);
})();
