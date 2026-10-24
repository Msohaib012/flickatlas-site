/* FlickAtlas — Movies hub with §4 filter chips: Bollywood · International / Hollywood
   as the primary industries, with legacy scopes and ratings kept visible. */
(async function () {
  UI.mountChrome("/movies");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Movies — Popular, Top Rated & Upcoming Films with Cast and Box Office | FlickAtlas",
    desc: "Browse popular, top rated, in-cinemas and upcoming movies on FlickAtlas. Open any film for its full cast, story, budget vs box office earnings and release details.",
    path: "/movies"
  });

  const MAIN_FILTERS = [["bollywood", "Bollywood"], ["international", "International / Hollywood"]];
  const MORE_FILTERS = [["all", "All"], ["hollywood", "Hollywood"], ["lollywood", "Lollywood"], ["kdrama", "K-Drama"], ["year", "This Year"], ["top", "Top Rated"]];
  const FILTERS = [...MAIN_FILTERS, ...MORE_FILTERS];
  const seeAllEntry = UI.getParam("seeall", "") === "1";
  let f = UI.getParam("f", "bollywood");
  let sort = UI.getParam("s", "recent");
  if (!["popular", "recent"].includes(sort)) sort = "recent";
  if (!FILTERS.some(([k]) => k === f)) f = "bollywood";
  let g = UI.getParam("g", "");

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Movies</h1>
      <p>Filter films by industry, year, rating or genre; open a title for details.</p></div>
    <div id="chipHost"><div data-filter-scope="main">${UI.chipRow(MAIN_FILTERS, f, "bollywood")}</div>
      ${seeAllEntry
        ? `<div class="filter-select listing-custom-filter" role="group" aria-labelledby="moviesFilterLabel"><span class="filter-select-label" id="moviesFilterLabel">Filter by category</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="moreFilterTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="moreFilterOptions" aria-labelledby="moviesFilterLabel moreFilterValue"><span id="moreFilterValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="moreFilterOptions" role="listbox" aria-labelledby="moviesFilterLabel" hidden></div></div><select class="fsel" id="moreFilterSel" aria-label="Additional movie category filter" aria-hidden="true" tabindex="-1" hidden><option value="">Choose a filter</option>${MORE_FILTERS.map(([key, label]) => `<option value="${UI.esc(key)}">${UI.esc(label)}</option>`).join("")}</select></div>`
        : `<div class="listing-more-filters"><p class="filter-group-label">More categories</p><div data-filter-scope="more">${UI.chipRow(MORE_FILTERS, f, "bollywood")}</div></div>`}
      <div class="listing-select-row">
        <div class="filter-select" role="group" aria-labelledby="sortSelectLabel"><span class="filter-select-label" id="sortSelectLabel">Sort by</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="sortTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="sortOptions" aria-labelledby="sortSelectLabel sortValue"><span id="sortValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="sortOptions" role="listbox" aria-labelledby="sortSelectLabel" hidden></div></div><select class="fsel" id="sortSel" aria-label="Sort movies" aria-hidden="true" tabindex="-1" hidden><option value="recent">Newest first</option><option value="popular">Most Popular</option></select></div>
        <div class="filter-select" role="group" aria-labelledby="genreSelectLabel"><span class="filter-select-label" id="genreSelectLabel">Genre</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="genreTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="genreOptions" aria-labelledby="genreSelectLabel genreValue"><span id="genreValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="genreOptions" role="listbox" aria-labelledby="genreSelectLabel" hidden></div></div><select class="fsel" id="genreSel" aria-label="Filter by genre" aria-hidden="true" tabindex="-1" hidden><option value="">All Genres</option></select></div>
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
  const moreFilterMenu = moreFilterSel ? mountSelectMenu(moreFilterSel) : null;

  const indOf = x => {
    const countries = x.origin_country || x.production_countries?.map(c => c.iso_3166_1) || [];
    if (x.original_language === "hi" && countries.includes("IN")) return "bollywood";
    if (countries.includes("PK")) return "lollywood";
    if (x.original_language === "ko" && countries.includes("KR")) return "kdrama";
    if (x.original_language === "en" && countries.includes("US")) return "hollywood";
    return "international";
  };

  let pool = [];
  function render() {
    const year = String(new Date().getFullYear());
    const items = pool.filter(x => {
      if (sort === "recent" && (!/^\d{4}-\d{2}-\d{2}$/.test(x.release_date || "") || !Number.isFinite(Date.parse(x.release_date + 'T00:00:00Z')) || new Date(x.release_date + 'T00:00:00Z').toISOString().slice(0,10) !== x.release_date || x.release_date > TMDB.today())) return false;
      if (f === "bollywood" && x._ind !== "bollywood") return false;
      if (f === "hollywood" && x._ind !== "hollywood") return false;
      if (f === "international" && !["en","ko"].includes(x.original_language)) return false;
      if (f === "lollywood" && x._ind !== "lollywood") return false;
      if (f === "kdrama" && x._ind !== "kdrama") return false;
      if (f === "year" && (x.release_date || "").slice(0, 4) !== year) return false;
      if (f === "top" && !((x.vote_average || 0) >= 7.5 && (x.vote_count || 0) >= 300)) return false;
      if (g && !(x.genre_ids || []).includes(Number(g))) return false;
      return true;
    });
    items.sort((a, b) => f === "top"
      ? (b.vote_average || 0) - (a.vote_average || 0)
      : sort === "recent" ? (b.release_date || "").localeCompare(a.release_date || "")
      : (b.popularity || 0) - (a.popularity || 0));
    grid.innerHTML = items.map(x =>
      `<div class="fcell" data-fitem>${UI.posterCard(x, "movie", UI.industryTag(x))}</div>`).join("");
    fcount.textContent = `${items.length} movie${items.length === 1 ? "" : "s"}`;
    emptyHost.innerHTML = items.length ? "" : UI.stateMsg("No movies match this filter right now.", false);
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
  genreSel.addEventListener("change", () => {
    g = genreSel.value;
    UI.setParam("g", g);
    render();
  });
  window.addEventListener("popstate", () => {
    f = UI.getParam("f", "bollywood"); if (!FILTERS.some(([k]) => k === f)) f = "bollywood";
    g = UI.getParam("g", "");
    sort = UI.getParam("s", "recent"); if (!["popular", "recent"].includes(sort)) sort = "recent";
    sortSel.value = sort; genreSel.value = g;
    if (seeAllEntry) syncSeeAllFilters();
    sortMenu.sync(); genreMenu.sync();
    render();
  });

  try {
    const cutoff = UI.freshCutoff();
    const today = TMDB.today();
    const freshWin = { "primary_release_date.gte": cutoff, "primary_release_date.lte": today, sort_by: "popularity.desc" };
    const request = (params) => TMDB.discoverResults("movie", params);
    const [pop1, pop2, top, hi, pk, ko, us, fresh1, fresh2, genres] = await Promise.all([
      TMDB.popular("movie", 1), TMDB.popular("movie", 2), TMDB.topRated("movie", 1),
      request({ with_original_language: "hi", with_origin_country: "IN", ...freshWin }),
      request({ with_origin_country: "PK", ...freshWin }),
      request({ with_original_language: "ko", with_origin_country: "KR", ...freshWin }),
      request({ with_original_language: "en", with_origin_country: "US", ...freshWin }),
      request({ ...freshWin, page: 1 }), request({ ...freshWin, page: 2 }),
      TMDB.api("/genre/movie/list").catch(() => ({ genres: [] })),
    ]);
    const seen = new Map();
    const add = (arr, marker = "") => (arr || []).forEach(x => {
      if (!x.poster_path) return;
      if (!seen.has(x.id)) { x._countryQuery = marker; seen.set(x.id, x); }
      else if (marker) seen.get(x.id)._countryQuery = marker;
    });
    add(hi, "IN"); add(pk, "PK"); add(ko, "KR"); add(us, "US");
    add(fresh1); add(fresh2); add(pop1.results); add(pop2.results); add(top.results);
    pool = [...seen.values()].map(x => {
      const verified = indOf(x);
      x._ind = verified !== "international" ? verified : ({ IN: "bollywood", PK: "lollywood", KR: "kdrama", US: "hollywood" }[x._countryQuery] || "international");
      return x;
    }).filter(UI.isFresh);
    const present = new Set(pool.flatMap(x => x.genre_ids || []));
    (genres.genres || []).filter(gr => present.has(gr.id)).forEach(gr => {
      const o = document.createElement("option"); o.value = gr.id; o.textContent = gr.name; genreSel.appendChild(o);
    });
    if (g && !present.has(Number(g))) { g = ""; genreSel.value = ""; UI.setParam("g", ""); }
    if (g) genreSel.value = g;
    genreMenu.sync();
    render();
  } catch (e) {
    fcount.textContent = "Movies could not be loaded.";
    grid.innerHTML = UI.stateMsg("Could not load movies. Please try again.");
  }
})();
