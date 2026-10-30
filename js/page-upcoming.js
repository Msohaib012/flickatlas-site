/* FlickAtlas — Release Calendar (§3 calendar-native): movies + TV
   premieres in ONE dated, month-grouped list, with a .fa-select in-page
   Category dropdown (All · Bollywood · World Cinema · Movies · TV ·
   This Month · Pakistani) — never a native <select> popup.
   PUBLISHED-ONLY (2026-10-25 rebuild): every release comes from
   window.FA_PUBLISHED entries whose release/air date is in the future —
   TMDB is a data source, not a catalogue, so nothing is fetched live.
   Trailer status comes from the baked-in `trailer` object (official
   trailer only), never from a live videos call. Freshness rule does not
   apply to upcoming (§7). */
(async function () {
  /* /trailers shares this script (trailers/index.html loads it): when the
     path is /trailers, render the official-trailers listing instead of
     the release calendar — published titles with a baked official
     trailer, newest first, each linking to its detail page's trailer
     anchor. (Audit-C fix 2026-10-26: /trailers was an orphan that
     rendered the Upcoming calendar with the wrong title.) */
  const isTrailers = location.pathname.replace(/\/+$/, "").endsWith("/trailers");
  if (isTrailers) {
    UI.mountChrome("/trailers");
    const main = document.getElementById("app");
    UI.setSEO({
      title: "Official Trailers — Movies & TV | FlickAtlas",
      desc: "Official trailers for published movies and TV shows on FlickAtlas, newest first. Open a title to watch its trailer.",
      path: "/trailers"
    });
    const dateOf = x => x.type === "tv" ? (x.first_air_date || "") : (x.release_date || "");
    const MONTHS_S = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const items = Object.values(window.FA_PUBLISHED || {})
      .filter(x => x && x.id && x.poster_path && x.trailer)
      .sort((a, b) => dateOf(b).localeCompare(dateOf(a))
        || (b.published_at || "").localeCompare(a.published_at || ""));
    main.innerHTML = `<div class="wrap">
      <div class="page-hero"><h1>Official Trailers</h1>
        </div>
      <div id="trFilterHost"><div class="listing-select-row listing-select-row--single">
      <div class="filter-select" role="group" aria-labelledby="trTypeLabel"><span class="filter-select-label" id="trTypeLabel">Type</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="trTypeTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="trTypeOptions" aria-labelledby="trTypeLabel trTypeValue"><span class="fa-select-value" id="trTypeValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="trTypeOptions" role="listbox" aria-labelledby="trTypeLabel" hidden></div></div></div>
    </div></div>
      <p class="fcount" id="trCount">${items.length ? `${items.length} trailer${items.length === 1 ? "" : "s"}` : ""}</p>
      <div id="trWrap"></div>
    </div>`;
    const wrap = main.querySelector("#trWrap");
    const trCount = main.querySelector("#trCount");
    let show = "all";
    function renderTrailers() {
      const list = show === "all" ? items : items.filter(x => x.type === show);
      trCount.textContent = list.length ? `${list.length} trailer${list.length === 1 ? "" : "s"}` : "";
      wrap.innerHTML = list.length ? `<div class="tl-list">${list.map(x => { const [, mm, dd] = (dateOf(x) || "").split("-"); const detailHref = `/${x.type === "tv" ? "show" : "movie"}?id=${x.id}#official-trailer`; return `
        <a class="tl-row" href="${detailHref}">
          <span class="tl-date"><b>${dd ? parseInt(dd, 10) : "—"}</b><span>${mm ? MONTHS_S[parseInt(mm, 10) - 1] : ""}</span></span>
          <img src="${UI.img(x.poster_path, "w92")}" alt="" loading="lazy" onerror="this.remove()">
          <span class="tl-info"><b>${UI.esc(UI.titleOf(x))}</b>
          <span>${UI.fmtDate(dateOf(x))}${UI.rating(x) ? ` · ${UI.rating(x)}/10` : ""} · Official trailer</span></span>
          <span class="tag-chip">${UI.esc(UI.industryTag(x))}</span>
        </a>`; }).join("")}</div>` : UI.stateMsg("No official trailers have been published yet.", false);
    }
    UI.mountFaSelect(main.querySelector("#trFilterHost .filter-select"),
      [{ value: "all", label: "All trailers" }, { value: "movie", label: "Movies" }, { value: "tv", label: "TV Series" }],
      show, (v) => { show = v; renderTrailers(); });
    renderTrailers();
    return;
  }
  UI.mountChrome("/upcoming");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Upcoming Movies & TV Shows — Release Date Calendar | FlickAtlas",
    desc: "The FlickAtlas release calendar: upcoming movies and TV premieres grouped by month, with exact release dates, ratings and cast shortcuts.",
    path: "/upcoming"
  });

  const MAIN_FILTERS = [["bollywood", "Bollywood"], ["international", "World Cinema"]];
  const MORE_FILTERS = [["all", "All"], ["movies", "Movies"], ["tv", "TV"], ["month", "This Month"], ["pakistani", "Pakistani"]];
  const FILTERS = [...MAIN_FILTERS, ...MORE_FILTERS];
  let f = UI.getParam("f", "bollywood");
  let sort = UI.getParam("s", "oldest"); if (!["oldest", "newest"].includes(sort)) sort = "oldest";
  if (!FILTERS.some(([k]) => k === f)) f = "bollywood";

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Upcoming Releases</h1>
      </div>
    <div id="chipHost"><div class="listing-select-row">
      <div class="filter-select" role="group" aria-labelledby="upFilterLabel"><span class="filter-select-label" id="upFilterLabel">Filter by category</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="upFilterTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="upFilterOptions" aria-labelledby="upFilterLabel upFilterValue"><span class="fa-select-value" id="upFilterValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="upFilterOptions" role="listbox" aria-labelledby="upFilterLabel" hidden></div></div></div>
      <div class="filter-select" role="group" aria-labelledby="upSortLabel"><span class="filter-select-label" id="upSortLabel">Sort by</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="upSortTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="upSortOptions" aria-labelledby="upSortLabel upSortValue"><span class="fa-select-value" id="upSortValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="upSortOptions" role="listbox" aria-labelledby="upSortLabel" hidden></div></div></div>
    </div></div>

    <p class="fcount" id="fcount"></p>
    <div id="upWrap">${UI.skelCards(8)}</div>
  </div>`;
  const wrap = main.querySelector("#upWrap");
  const fcount = main.querySelector("#fcount");
  /* The Category dropdown covers every f value (Bollywood / World
     Cinema / All / Movies / TV / This Month / Pakistani) via the shared
     UI.mountFaSelect component — no native <select>, no local menu copy. */
  const MONTHS_S = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const catDd = UI.mountFaSelect(main.querySelector("#chipHost .filter-select"),
    FILTERS.map(([value, label]) => ({ value, label })),
    f, (v) => setFilter(v));
  const sortDd = UI.mountFaSelect(main.querySelectorAll("#chipHost .filter-select")[1],
    [{ value: "oldest", label: "Oldest release date" }, { value: "newest", label: "Newest release date" }],
    sort, (v) => { sort = v; UI.setParam("s", sort === "oldest" ? "" : sort); render(); });

  /* Published titles only: window.FA_PUBLISHED, keyed by TMDB id.
     Upcoming = entries whose release/air date is in the future.
     `industry` is baked (bollywood | pakistani | world); `trailer` is
     the baked official trailer object (null when none exists).
     Industry tag for cards: "World Cinema" for world-industry titles
     (UI.industryTag now returns "World Cinema" — fixed in ui.js; the local override is a harmless guard). */
  const tagFor = (x) => UI.industryTag(x);
  const today = UI.todayPKT();
  const dateOf = x => x.type === "tv" ? (x.first_air_date || "") : (x.release_date || "");
  const items = Object.values(window.FA_PUBLISHED || {})
    .filter(x => x && x.id && x.poster_path && dateOf(x) > today)
    .map(x => ({ ...x, _date: dateOf(x) }));

  function render() {
    const ym = today.slice(0, 7);
    const filteredItems = items.filter(x => {
      if (f === "movies") return x.type === "movie";
      if (f === "tv") return x.type === "tv";
      /* Industry rule (owner order 2026-10-28): Bollywood = ALL Indian
         titles (canonical UI.industryOf), World Cinema = only
         international. */
      if (f === "bollywood") return UI.industryOf(x) === "bollywood";
      if (f === "pakistani") return UI.industryOf(x) === "pakistani";
      if (f === "international") return UI.industryOf(x) === "world";
      if (f === "month") return (x._date || "").slice(0, 7) === ym;
      return true;
    });
    const list = filteredItems.slice()
      .sort((a, b) => (sort === "oldest" ? a._date.localeCompare(b._date) : b._date.localeCompare(a._date))
        || (b.published_at || "").localeCompare(a.published_at || ""))
      .slice(0, 120);
    fcount.textContent = list.length ? `${list.length} upcoming release${list.length === 1 ? "" : "s"}` : "";
    if (!list.length) {
      wrap.innerHTML = UI.stateMsg(items.length
        ? "No upcoming releases match this filter right now."
        : "No upcoming releases have been published yet.", false);
      return;
    }
    const groups = new Map();
    for (const x of list) {
      const key = UI.monthLabel(x._date);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(x);
    }
    let html = "";
    for (const [label, group] of groups) {
      html += `<section class="section"><div class="section-head"><h2>${UI.esc(label)}</h2></div>
        <div class="tl-list">${group.map(x => { const [, mm, dd] = x._date.split("-"); const detailHref = `/${x.type === "tv" ? "show" : "movie"}?id=${x.id}${x.trailer ? "#official-trailer" : ""}`; return `
          <a class="tl-row" href="${detailHref}">
            <span class="tl-date"><b>${dd ? parseInt(dd, 10) : "—"}</b><span>${mm ? MONTHS_S[parseInt(mm, 10) - 1] : ""}</span></span>
            <img src="${UI.img(x.poster_path, "w92")}" alt="" loading="lazy" onerror="this.remove()">
            <span class="tl-info"><b>${UI.esc(UI.titleOf(x))}</b>
            <span>${x.type === "tv" ? "Premieres " : ""}${UI.fmtDate(x._date)}${UI.rating(x) ? ` · ${UI.rating(x)}/10` : ""} · ${x.trailer ? "Official trailer listed" : "No verified official trailer listed"}</span></span>
            <span class="tag-chip">${UI.esc(tagFor(x))}</span>
          </a>`; }).join("")}
        </div></section>`;
    }
    wrap.innerHTML = html || UI.stateMsg("No upcoming releases have been published yet.", false);
  }
  function setFilter(key) {
    f = FILTERS.some(([candidate]) => candidate === key) ? key : "bollywood";
    UI.setParam("f", f === "bollywood" ? "" : f);
    render();
  }
  window.addEventListener("popstate", () => {
    f = UI.getParam("f", "bollywood"); if (!FILTERS.some(([k]) => k === f)) f = "bollywood";
    sort = UI.getParam("s", "oldest"); if (!["oldest", "newest"].includes(sort)) sort = "oldest";
    catDd.setValue(f);
    sortDd.setValue(sort);
    render();
  });

  render();
})();
