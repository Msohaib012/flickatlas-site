/* FlickAtlas — Movies hub with §4 filter chips: Bollywood · World Cinema
   as the primary industries, with legacy scopes and ratings kept visible.
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
  const seeAllEntry = UI.getParam("seeall", "") === "1";
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
    <div id="chipHost"><div data-filter-scope="main">${UI.chipRow(MAIN_FILTERS, f, "bollywood")}</div>
      ${seeAllEntry
        ? `<div class="filter-select listing-custom-filter" role="group" aria-labelledby="moviesFilterLabel"><span class="filter-select-label" id="moviesFilterLabel">Filter by category</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="moreFilterTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="moreFilterOptions" aria-labelledby="moviesFilterLabel moreFilterValue"><span id="moreFilterValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="moreFilterOptions" role="listbox" aria-labelledby="moviesFilterLabel" hidden></div></div><select class="fsel" id="moreFilterSel" aria-label="Additional movie category filter" aria-hidden="true" tabindex="-1" hidden><option value="">Choose a filter</option>${MORE_FILTERS.map(([key, label]) => `<option value="${UI.esc(key)}">${UI.esc(label)}</option>`).join("")}</select></div>`
        : `<div class="listing-more-filters"><p class="filter-group-label">More categories</p><div data-filter-scope="more">${UI.chipRow(MORE_FILTERS, f, "bollywood")}</div></div>`}
      <div class="listing-select-row">
        <div class="filter-select" role="group" aria-labelledby="yearSelectLabel"><span class="filter-select-label" id="yearSelectLabel">Year</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="yearTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="yearOptions" aria-labelledby="yearSelectLabel yearValue"><span id="yearValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="yearOptions" role="listbox" aria-labelledby="yearSelectLabel" hidden></div></div><select class="fsel" id="yearSel" aria-label="Filter by year" aria-hidden="true" tabindex="-1" hidden></select></div>
        <div class="filter-select" role="group" aria-labelledby="sortSelectLabel"><span class="filter-select-label" id="sortSelectLabel">Sort by</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="sortTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="sortOptions" aria-labelledby="sortSelectLabel sortValue"><span id="sortValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="sortOptions" role="listbox" aria-labelledby="sortSelectLabel" hidden></div></div><select class="fsel" id="sortSel" aria-label="Sort movies" aria-hidden="true" tabindex="-1" hidden><option value="recent">Newest first</option><option value="popular">Most Popular</option></select></div>
        <div class="filter-select" role="group" aria-labelledby="genreSelectLabel"><span class="filter-select-label" id="genreSelectLabel">Genre</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="genreTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="genreOptions" aria-labelledby="genreSelectLabel genreValue"><span id="genreValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="genreOptions" role="listbox" aria-labelledby="genreSelectLabel" hidden></div></div><select class="fsel" id="genreSel" aria-label="Filter by genre" aria-hidden="true" tabindex="-1" hidden><option value="">All Genres</option></select></div>
        <div class="filter-select" role="group" aria-labelledby="typeSelectLabel"><span class="filter-select-label" id="typeSelectLabel">Type</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="typeTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="typeOptions" aria-labelledby="typeSelectLabel typeValue"><span id="typeValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="typeOptions" role="listbox" aria-labelledby="typeSelectLabel" hidden></div></div><select class="fsel" id="typeSel" aria-label="Filter by type" aria-hidden="true" tabindex="-1" hidden><option value="movie">Movies</option><option value="tv">TV Series</option><option value="all">All</option></select></div>
      </div></div>
    <p class="fcount" id="fcount" aria-live="polite">Loading movies…</p>
    <div class="grid" id="grid">${UI.skelCards(12)}</div>
    <div id="emptyHost"></div>
  </div>`;
  const grid = main.querySelector("#grid");
  const fcount = main.querySelector("#fcount");
  const emptyHost = main.querySelector("#emptyHost");
  const genreSel = main.querySelector("#genreSel");
  const sortSel = main.querySelector("#sortSel"); sortSel.value = sort;
  const typeSel = main.querySelector("#typeSel"); typeSel.value = t;
  const moreFilterSel = main.querySelector("#moreFilterSel");
  if (moreFilterSel) moreFilterSel.value = MORE_FILTERS.some(([key]) => key === f) ? f : "";
  if (g) genreSel.value = g;

  function mountSelectMenu(select) {
    const host = select.closest(".filter-select");
    const trigger = host.querySelector(".fa-select-trigger");
    const label = host.querySelector("[id$='Value']");
    const listbox = host.querySelector('[role="listbox"]');
    let activeIndex = 0, opened = false, typeAhead = "", typeAheadTimer;
    function activate(index) {
      const options = [...listbox.querySelectorAll('[role="option"]')];
      if (!options.length) return;
      activeIndex = (index + options.length) % options.length;
      const active = options[activeIndex];
      trigger.setAttribute("aria-activedescendant", active.id);
      options.forEach((option, i) => option.classList.toggle("is-active", i === activeIndex));
      active.scrollIntoView?.({ block: "nearest" });
    }
    function sync() {
      const options = [...select.options];
      const selectedIndex = options.findIndex(option => option.value === select.value);
      activeIndex = selectedIndex >= 0 ? selectedIndex : 0;
      label.textContent = options[activeIndex]?.textContent || "Choose an option";
      listbox.innerHTML = options.map((option, index) => `<div class="fa-select-option" id="${listbox.id}-option-${index}" role="option" aria-selected="${index === activeIndex}" data-index="${index}"><span>${UI.esc(option.textContent)}</span><span class="fa-select-check" aria-hidden="true">✓</span></div>`).join("");
      if (opened) activate(activeIndex);
    }
    function close(restoreFocus = false) {
      if (!opened) return;
      opened = false; listbox.hidden = true; trigger.setAttribute("aria-expanded", "false");
      trigger.removeAttribute("aria-activedescendant");
      if (restoreFocus) trigger.focus();
    }
    function open() {
      sync(); if (!select.options.length) return;
      opened = true; listbox.hidden = false; trigger.setAttribute("aria-expanded", "true");
      activate(activeIndex);
    }
    function choose() {
      const option = select.options[activeIndex]; if (!option) return;
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      close(true);
    }
    trigger.addEventListener("click", () => opened ? close() : open());
    trigger.addEventListener("keydown", event => {
      if (event.key === "Escape" && opened) { event.preventDefault(); close(); return; }
      if (event.key === "Tab" && opened) { close(); return; }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        if (!opened) open();
        else if (event.key === "ArrowDown") activate(activeIndex + 1);
        else if (event.key === "ArrowUp") activate(activeIndex - 1);
        else if (event.key === "Home") activate(0);
        else activate(select.options.length - 1);
        return;
      }
      if ((event.key === "Enter" || event.key === " ") && opened) { event.preventDefault(); choose(); return; }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        typeAhead += event.key.toLocaleLowerCase();
        const match = [...select.options].findIndex(option => option.textContent.trim().toLocaleLowerCase().startsWith(typeAhead));
        if (match >= 0) { if (!opened) open(); activate(match); event.preventDefault(); }
        clearTimeout(typeAheadTimer); typeAheadTimer = setTimeout(() => { typeAhead = ""; }, 700);
      }
    });
    listbox.addEventListener("click", event => {
      const option = event.target.closest('[role="option"]'); if (!option) return;
      activeIndex = Number(option.dataset.index); choose();
    });
    select.addEventListener("change", sync);
    document.addEventListener("pointerdown", event => { if (opened && !host.contains(event.target)) close(); });
    sync();
    return { sync };
  }
  const sortMenu = mountSelectMenu(sortSel);
  const genreMenu = mountSelectMenu(genreSel);
  const typeMenu = mountSelectMenu(typeSel);
  const moreFilterMenu = moreFilterSel ? mountSelectMenu(moreFilterSel) : null;

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
  genreList.forEach(gName => {
    const opt = document.createElement("option");
    opt.value = gName; opt.textContent = gName;
    genreSel.appendChild(opt);
  });
  if (g && !genreList.includes(g)) g = ""; /* unknown genre param -> All */
  genreSel.value = g;
  genreMenu.sync();

  /* Year dropdown: one option per year present in the released pool,
     default = latest year. A custom .fa-select (in-page panel, never the
     Android popup a native <select> becomes) — the same component as
     Sort / Genre on this page. */
  const yearSel = main.querySelector("#yearSel");
  years.forEach(yr => {
    const opt = document.createElement("option");
    opt.value = yr; opt.textContent = yr;
    yearSel.appendChild(opt);
  });
  yearSel.value = y;
  const yearMenu = mountSelectMenu(yearSel);
  yearMenu.sync();

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

  const chipHost = main.querySelector("#chipHost");
  const mainFilterHost = main.querySelector('[data-filter-scope="main"]');
  function syncSeeAllFilters() {
    if (!seeAllEntry) return;
    moreFilterSel.value = MORE_FILTERS.some(([key]) => key === f) ? f : "";
    moreFilterMenu.sync();
    mainFilterHost.querySelectorAll("[data-f]").forEach(link => {
      const active = link.dataset.f === f;
      link.classList.toggle("on", active);
      if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    });
  }
  function setSeeAllFilter(key) {
    f = FILTERS.some(([candidate]) => candidate === key) ? key : "bollywood";
    UI.setParam("f", f === "bollywood" ? "" : f);
    syncSeeAllFilters();
    render();
  }
  if (seeAllEntry) {
    mainFilterHost.querySelectorAll("a[data-f]").forEach(link => link.addEventListener("click", event => {
      if (event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      setSeeAllFilter(link.dataset.f);
    }));
    moreFilterSel.addEventListener("change", () => setSeeAllFilter(moreFilterSel.value || "bollywood"));
    syncSeeAllFilters();
  } else {
    UI.wireChips(chipHost, (key) => { f = key; render(); }, "bollywood");
  }
  sortSel.addEventListener("change", () => { sort = sortSel.value; UI.setParam("s", sort === "recent" ? "" : "popular"); render(); });
  typeSel.addEventListener("change", () => {
    t = ["movie", "tv", "all"].includes(typeSel.value) ? typeSel.value : "movie";
    UI.setParam("t", t === "movie" ? "" : t);
    render();
  });
  genreSel.addEventListener("change", () => {
    g = genreSel.value;
    UI.setParam("g", g);
    render();
  });
  yearSel.addEventListener("change", () => {
    y = yearSel.value;
    if (!years.includes(y)) y = years[0] || "";
    UI.setParam("y", y === (years[0] || "") ? "" : y);
    render();
  });
  window.addEventListener("popstate", () => {
    f = UI.getParam("f", "bollywood"); if (!FILTERS.some(([k]) => k === f)) f = "bollywood";
    g = UI.getParam("g", "");
    if (g && !genreList.includes(g)) g = ""; /* unknown genre -> All */
    sort = UI.getParam("s", "recent"); if (!["popular", "recent"].includes(sort)) sort = "recent";
    y = UI.getParam("y", "");
    if (!years.includes(y)) y = years[0] || "";
    t = UI.getParam("t", "movie"); if (!["movie", "tv", "all"].includes(t)) t = "movie";
    sortSel.value = sort; genreSel.value = g; yearSel.value = y; typeSel.value = t;
    if (seeAllEntry) syncSeeAllFilters();
    sortMenu.sync(); genreMenu.sync(); yearMenu.sync(); typeMenu.sync();
    render();
  });

  render();
})();



