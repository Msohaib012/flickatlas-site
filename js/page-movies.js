/* FlickAtlas — Movies hub with §4 filter chips: Bollywood · World Cinema
   as the primary industries, with legacy scopes and ratings kept visible.
   PUBLISHED-ONLY (2026-10-25 rebuild): every title comes from
   window.FA_PUBLISHED — TMDB is a data source, not a catalogue, so
   nothing is fetched live. K-Drama filter REMOVED (spec §6). Published
   entries carry a baked `industry` (bollywood | pakistani | world);
   "Hollywood" is the US-English slice of world, "Lollywood" is the
   Pakistani industry. No genre data exists in published entries, so the
   genre select stays at "All Genres". */
(async function () {
  UI.mountChrome("/movies");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Movies — Popular, Top Rated & Upcoming Films with Cast and Box Office | FlickAtlas",
    desc: "Browse popular, top rated, in-cinemas and upcoming movies on FlickAtlas. Open any film for its full cast, story, budget vs box office earnings and release details.",
    path: "/movies"
  });

  const MAIN_FILTERS = [["bollywood", "Bollywood"], ["international", "World Cinema"]];
  const MORE_FILTERS = [["all", "All"], ["hollywood", "Hollywood"], ["lollywood", "Lollywood"], ["year", "This Year"], ["top", "Top Rated"]];
  const FILTERS = [...MAIN_FILTERS, ...MORE_FILTERS];
  const seeAllEntry = UI.getParam("seeall", "") === "1";
  let f = UI.getParam("f", "bollywood");
  let sort = UI.getParam("s", "recent");
  if (!["popular", "recent"].includes(sort)) sort = "recent";
  if (!FILTERS.some(([k]) => k === f)) f = "bollywood";
  let g = UI.getParam("g", "");

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Movies</h1>
      <p>Filter films by industry, year or rating; open a title for details.</p></div>
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

  /* Published titles only: window.FA_PUBLISHED, keyed by TMDB id.
     Entries carry a baked `industry` (bollywood | pakistani | world)
     and `type` ("movie" | "tv"). No live TMDB calls anywhere. */
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const published = () => Object.values(window.FA_PUBLISHED || {});
  const dateOf = x => x.release_date || "";
  /* Homepage rule (correction 9): recency-sorted everywhere, newest first —
     published_at desc, then release date desc. "Popular" sorts by rating
     (published entries carry no TMDB popularity score). */
  const byNewest = (a, b) => (b.published_at || "").localeCompare(a.published_at || "")
    || dateOf(b).localeCompare(dateOf(a));
  const byPopular = (a, b) => (b.vote_average || 0) - (a.vote_average || 0)
    || (b.vote_count || 0) - (a.vote_count || 0);

  /* Hub shows released movies only (future-dated titles live on /upcoming).
     Freshness first (site rule: nothing older than 3 months on listings);
     fall back to the full published pool so the page is never empty while
     published movies exist. */
  const pool = (() => {
    const today = todayStr();
    const released = published().filter(x => x && x.id && x.type === "movie"
      && /^\d{4}-\d{2}-\d{2}$/.test(x.release_date || "") && x.release_date <= today);
    const fresh = released.filter(UI.isFresh);
    return fresh.length ? fresh : released;
  })();

  function render() {
    const year = String(new Date().getFullYear());
    const items = pool.filter(x => {
      if (f === "bollywood" && x.industry !== "bollywood") return false;
      if (f === "hollywood" && !(x.industry === "world" && x.original_language === "en" && (x.origin_country || []).includes("US"))) return false;
      if (f === "international" && x.industry !== "world") return false;
      if (f === "lollywood" && x.industry !== "pakistani") return false;
      if (f === "year" && (x.release_date || "").slice(0, 4) !== year) return false;
      if (f === "top" && !((x.vote_average || 0) >= 7.5 && (x.vote_count || 0) >= 300)) return false;
      /* No genre data in published entries — a ?g= param matches nothing. */
      if (g) return false;
      return true;
    });
    items.sort((a, b) => f === "top" ? byPopular(a, b)
      : sort === "recent" ? byNewest(a, b) : byPopular(a, b));
    const shown = items.slice(0, 1);
    grid.innerHTML = shown.map(x =>
      `<div class="fcell" data-fitem>${UI.posterCard(x, "movie", UI.industryTag(x))}</div>`).join("");
    fcount.textContent = `${shown.length} movie${shown.length === 1 ? "" : "s"}`;
    emptyHost.innerHTML = shown.length ? ""
      : UI.stateMsg(pool.length
        ? "No movies match this filter right now."
        : "No movies have been published yet.", false);
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
    /* Stale ?g= param: published entries carry no genres, so clear it. */
    if (g) { g = ""; genreSel.value = ""; UI.setParam("g", ""); }
    render();
  });

  /* Genre select stays at "All Genres": published entries carry no genres.
     A stale ?g= param matches nothing, so clear it. */
  if (g) { g = ""; genreSel.value = ""; UI.setParam("g", ""); }
  render();
})();
