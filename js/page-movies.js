/* FlickAtlas — Movies hub with .fa-select in-page dropdowns: Category
   (Bollywood · World Cinema · All · US Films · Lollywood · Top Rated),
   Year, Sort by, Genre and Type — never a native <select> popup.
   PUBLISHED-ONLY (2026-10-25 rebuild): every title comes from
   window.FA_PUBLISHED — TMDB is a data source, not a catalogue, so
   nothing is fetched live. K-Drama filter REMOVED (spec §6). Published
   entries carry a baked `industry` (bollywood | pakistani | world);
   "US Films" is the US-English slice of world, "Lollywood" is the
   Pakistani industry. Genres ARE baked into published entries (rich
   fields), so the genre select is populated from the pool. */
(async function () {
  UI.mountChrome("/movies");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Movies — Popular, Top Rated & Upcoming Films with Cast and Box Office | FlickAtlas",
    desc: "Browse popular, top rated, in-cinemas and upcoming movies on FlickAtlas. Open any film for its full cast, story, budget vs box office earnings and release details.",
    path: "/movies"
  });

  const MAIN_FILTERS = [["bollywood", "Bollywood"], ["international", "World Cinema"]];
  const MORE_FILTERS = [["all", "All"], ["hollywood", "US Films"], ["lollywood", "Lollywood"], ["top", "Top Rated"]];
  const FILTERS = [...MAIN_FILTERS, ...MORE_FILTERS];
  /* The Category dropdown covers every f value, so the old ?seeall=1
     entry split (chips vs dropdown) is gone — one control always. */
  let f = UI.getParam("f", "bollywood");
  let sort = UI.getParam("s", "recent");
  if (!["popular", "recent"].includes(sort)) sort = "recent";
  if (!FILTERS.some(([k]) => k === f)) f = "bollywood";
  let g = UI.getParam("g", "");
  /* TV order 2026-10-27: the hub lists movies AND TV series, with a
     Type dropdown (Movies / TV Series / All). Default is Movies, so
     the page's current view is unchanged on load and the 2026-10-27
     movies-only order is preserved by default; TV is one tap away
     (?t=tv, ?t=all). The homepage Spotlight See All link carries ?t=. */
  let t = UI.getParam("t", "movie");
  if (!["movie", "tv", "all"].includes(t)) t = "movie";

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Movies</h1>
      <p>Filter movies and TV series by industry, year or rating; open a title for details.</p></div>
    <div id="chipHost"><div class="listing-select-row">
        <div class="filter-select" role="group" aria-labelledby="catSelectLabel"><span class="filter-select-label" id="catSelectLabel">Filter by category</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="catTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="catOptions" aria-labelledby="catSelectLabel catValue"><span class="fa-select-value" id="catValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="catOptions" role="listbox" aria-labelledby="catSelectLabel" hidden></div></div></div>
        <div class="filter-select" role="group" aria-labelledby="yearSelectLabel"><span class="filter-select-label" id="yearSelectLabel">Year</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="yearTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="yearOptions" aria-labelledby="yearSelectLabel yearValue"><span class="fa-select-value" id="yearValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="yearOptions" role="listbox" aria-labelledby="yearSelectLabel" hidden></div></div></div>
        <div class="filter-select" role="group" aria-labelledby="sortSelectLabel"><span class="filter-select-label" id="sortSelectLabel">Sort by</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="sortTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="sortOptions" aria-labelledby="sortSelectLabel sortValue"><span class="fa-select-value" id="sortValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="sortOptions" role="listbox" aria-labelledby="sortSelectLabel" hidden></div></div></div>
        <div class="filter-select" role="group" aria-labelledby="genreSelectLabel"><span class="filter-select-label" id="genreSelectLabel">Genre</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="genreTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="genreOptions" aria-labelledby="genreSelectLabel genreValue"><span class="fa-select-value" id="genreValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="genreOptions" role="listbox" aria-labelledby="genreSelectLabel" hidden></div></div></div>
        <div class="filter-select" role="group" aria-labelledby="typeSelectLabel"><span class="filter-select-label" id="typeSelectLabel">Type</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="typeTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="typeOptions" aria-labelledby="typeSelectLabel typeValue"><span class="fa-select-value" id="typeValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="typeOptions" role="listbox" aria-labelledby="typeSelectLabel" hidden></div></div></div>
      </div></div>
    <p class="fcount" id="fcount" aria-live="polite">Loading movies…</p>
    <div class="grid" id="grid">${UI.skelCards(12)}</div>
    <div id="emptyHost"></div>
  </div>`;
  const grid = main.querySelector("#grid");
  const fcount = main.querySelector("#fcount");
  const emptyHost = main.querySelector("#emptyHost");
  /* All five filters are the shared UI.mountFaSelect component (options
     as JS objects — no native <select> anywhere on this page). Category,
     Sort and Type mount now (static options); Year and Genre mount below,
     once their option lists are built from the pool. */
  const filterHosts = main.querySelector("#chipHost").querySelectorAll(".filter-select");
  const catDd = UI.mountFaSelect(filterHosts[0],
    FILTERS.map(([value, label]) => ({ value, label })),
    f, (v) => setFilter(v));
  const sortDd = UI.mountFaSelect(filterHosts[2],
    [{ value: "recent", label: "Newest first" }, { value: "popular", label: "Most Popular" }],
    sort, (v) => { sort = v; UI.setParam("s", sort === "recent" ? "" : "popular"); render(); });
  const typeDd = UI.mountFaSelect(filterHosts[4],
    [{ value: "movie", label: "Movies" }, { value: "tv", label: "TV Series" }, { value: "all", label: "All" }],
    t, (v) => {
      t = ["movie", "tv", "all"].includes(v) ? v : "movie";
      UI.setParam("t", t === "movie" ? "" : t);
      render();
    });

  /* Published titles only: window.FA_PUBLISHED, keyed by TMDB id.
     Entries carry a baked `industry` (bollywood | pakistani | world)
     and `type` ("movie" | "tv"). No live TMDB calls anywhere.
     Industry tag for cards: "World Cinema" for world-industry titles
     (UI.industryTag now returns "World Cinema" — fixed in ui.js; the local override is a harmless guard). */
  const tagFor = (x) => (x && x.industry === "world") ? "World Cinema" : UI.industryTag(x);
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const published = () => Object.values(window.FA_PUBLISHED || {});
  const typeOf = (x) => (x && (x.type || x.media_type)) || "movie";
  const dateOf = x => typeOf(x) === "tv" ? (x.first_air_date || "") : (x.release_date || "");
  /* Homepage rule (correction 9, as amended 2026-10-26 by user order):
     recency-sorted everywhere, newest first — RELEASE DATE desc (the
     latest release leads, then going back); published_at only breaks
     ties. The old published_at-first sort scrambled the order whenever
     titles were published in batches. "Popular" sorts by rating
     (published entries carry no TMDB popularity score). */
  const byNewest = (a, b) => dateOf(b).localeCompare(dateOf(a))
    || (b.published_at || "").localeCompare(a.published_at || "");
  const byPopular = (a, b) => (b.vote_average || 0) - (a.vote_average || 0)
    || (b.vote_count || 0) - (a.vote_count || 0);

  /* Hub shows released movies AND TV series (future-dated titles live
     on /upcoming). YEARLY (user order 2026-10-27): the hub is organised
     by release year — the Year dropdown picks one year (default: the
     latest year present in the data) and the list shows that year's
     released titles, newest first. The 3-month freshness rule does NOT
     gate this hub: a year view is an explicit browse of that year's
     catalogue, so the pool is all released titles and render() applies
     the year gate. Streaming-first MOVIES stay out (the earlier
     exclusion order stands — this is the Spotlight See All); TV series
     are a different content type and are never excluded. */
  const released = published().filter(x => {
    if (!x || !x.id || !x.poster_path) return false;
    const d = dateOf(x);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > todayStr()) return false;
    if (typeOf(x) === "tv") return true;
    return typeOf(x) === "movie" && !UI.isStreamingOnly(x);
  });
  const years = [...new Set(released.map(x => dateOf(x).slice(0, 4)))].sort().reverse();
  let y = UI.getParam("y", "");
  if (!years.includes(y)) y = years[0] || "";
  const pool = released;

  /* Genres ARE baked into published entries (rich fields) — populate the
     genre select from the pool so the filter works (audit fix: the select
     used to stay at "All Genres" and any ?g= was cleared as stale). */
  const genreList = [...new Set(pool.flatMap(x => Array.isArray(x.genres) ? x.genres : []))].sort((a, b) => a.localeCompare(b));
  if (g && !genreList.includes(g)) g = ""; /* unknown genre param -> All */
  const genreDd = UI.mountFaSelect(filterHosts[3],
    [{ value: "", label: "All Genres" }, ...genreList.map(gName => ({ value: gName, label: gName }))],
    g, (v) => { g = v; UI.setParam("g", g); render(); });

  /* Year dropdown: one option per year present in the released pool,
     default = latest year. A custom .fa-select (in-page panel, never the
     Android popup a native <select> becomes) — the same component as
     Sort / Genre on this page. */
  const yearDd = UI.mountFaSelect(filterHosts[1],
    years.map(yr => ({ value: String(yr), label: String(yr) })),
    y, (v) => {
      y = v;
      if (!years.includes(y)) y = years[0] || "";
      UI.setParam("y", y === (years[0] || "") ? "" : y);
      render();
    });

  function render() {
    const items = pool.filter(x => {
      if (y && dateOf(x).slice(0, 4) !== y) return false;
      if (t === "movie" && typeOf(x) !== "movie") return false;
      if (t === "tv" && typeOf(x) !== "tv") return false;
      /* TV series are not split by industry (same rule as the
         homepage): the industry gates below apply to movies only. */
      if (typeOf(x) !== "tv") {
        if (f === "bollywood" && x.industry !== "bollywood") return false;
        if (f === "hollywood" && !(x.industry === "world" && x.original_language === "en" && (x.origin_country || []).includes("US"))) return false;
        if (f === "international" && x.industry !== "world") return false;
        if (f === "lollywood" && x.industry !== "pakistani") return false;
      }
      /* "Top Rated" is a sort-by-rating view, not a gate: the old gate
         (rating >= 7.5 AND vote_count >= 300) could never match published
         titles (vote_count 2-3), so the filter always showed empty. */
      if (g && !(Array.isArray(x.genres) && x.genres.includes(g))) return false;
      return true;
    });
    items.sort((a, b) => f === "top" ? byPopular(a, b)
      : sort === "recent" ? byNewest(a, b) : byPopular(a, b));
    grid.innerHTML = items.map(x =>
      `<div class="fcell" data-fitem>${UI.posterCard(x, typeOf(x), tagFor(x), undefined, undefined, true)}</div>`).join("");
    const noun = t === "movie" ? "movie" : t === "tv" ? "TV series" : "title";
    fcount.textContent = `${items.length} ${noun}${items.length === 1 ? "" : "s"}${y ? ` · ${y}` : ""}`;
    emptyHost.innerHTML = items.length ? ""
      : UI.stateMsg(pool.length
        ? "No titles match this filter right now."
        : "No titles have been published yet.", false);
  }

  /* setFilter: the single Category dropdown covers every f value
     (Bollywood / World Cinema / All / US Films / Lollywood / Top Rated),
     so no separate industry chips are needed any more. */
  function setFilter(key) {
    f = FILTERS.some(([candidate]) => candidate === key) ? key : "bollywood";
    UI.setParam("f", f === "bollywood" ? "" : f);
    render();
  }
  window.addEventListener("popstate", () => {
    f = FILTERS.some(([candidate]) => candidate === UI.getParam("f", "bollywood")) ? UI.getParam("f", "bollywood") : "bollywood";
    g = UI.getParam("g", "");
    if (g && !genreList.includes(g)) g = ""; /* unknown genre -> All */
    sort = UI.getParam("s", "recent"); if (!["popular", "recent"].includes(sort)) sort = "recent";
    t = UI.getParam("t", "movie"); if (!["movie", "tv", "all"].includes(t)) t = "movie";
    y = UI.getParam("y", "");
    if (!years.includes(y)) y = years[0] || "";
    catDd.setValue(f);
    sortDd.setValue(sort);
    typeDd.setValue(t);
    genreDd.setValue(g);
    yearDd.setValue(y);
    render();
  });

  render();
})();




