/* FlickAtlas — TV & Web Series hub with .fa-select in-page dropdowns:
   Category (All · Bollywood · World Cinema · US Films · Lollywood ·
   This Year · Top Rated) + Genre. Dropdowns are ?f= / ?g= URL-param
   filters over the loaded pool — never a native <select> (Android
   renders it as a modal popup).
   PUBLISHED-ONLY (2026-10-25 rebuild): every show comes from
   window.FA_PUBLISHED — TMDB is a data source, not a catalogue, so
   nothing is fetched live. K-Drama filter REMOVED (spec §6). Published
   entries carry a baked `industry` (bollywood | pakistani | world);
   "US Films" is the US-English slice of world, "Lollywood" is the
   Pakistani industry. Genres ARE baked into published entries (rich
   fields), so the genre select is populated from the pool. */
(async function () {
  UI.mountChrome("/tv");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "TV Shows & Series: Cast, Seasons & Episodes | FlickAtlas",
    desc: "Browse published television series by industry, with story, cast, season and episode information where available. Coverage varies by title.",
    path: "/tv"
  });

  const FILTERS = [["all", "All"], ["bollywood", "Bollywood"], ["international", "World Cinema"], ["hollywood", "US Films"],
    ["lollywood", "Lollywood"], ["year", "This Year"], ["top", "Top Rated"]];
  let f = UI.getParam("f", "all");
  if (!FILTERS.some(([k]) => k === f)) f = "all";
  let g = UI.getParam("g", "");

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>TV Shows</h1>
      </div>
    <div id="chipHost"><div class="listing-select-row">
      <div class="filter-select" role="group" aria-labelledby="catSelectLabel"><span class="filter-select-label" id="catSelectLabel">Category</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="catTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="catOptions" aria-labelledby="catSelectLabel catValue"><span class="fa-select-value" id="catValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="catOptions" role="listbox" aria-labelledby="catSelectLabel" hidden></div></div></div>
      <div class="filter-select" role="group" aria-labelledby="genreSelectLabel"><span class="filter-select-label" id="genreSelectLabel">Genre</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="genreTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="genreOptions" aria-labelledby="genreSelectLabel genreValue"><span class="fa-select-value" id="genreValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="genreOptions" role="listbox" aria-labelledby="genreSelectLabel" hidden></div></div></div>
    </div></div>
    <p class="fcount" id="fcount" aria-live="polite">Loading shows…</p>
    <div class="grid" id="grid">${UI.skelCards(12)}</div>
    <div id="emptyHost"></div>
  </div>`;
  const grid = main.querySelector("#grid");
  const fcount = main.querySelector("#fcount");
  const emptyHost = main.querySelector("#emptyHost");

  /* Published titles only: window.FA_PUBLISHED, keyed by TMDB id.
     Entries carry a baked `industry` (bollywood | pakistani | world)
     and `type` ("movie" | "tv"). No live TMDB calls anywhere.
     Industry tag for cards: "World Cinema" for world-industry titles
     (UI.industryTag now returns "World Cinema" — fixed in ui.js; the local override is a harmless guard). */
  const tagFor = (x) => UI.industryTag(x);
  const dateOf = x => x.first_air_date || "";
  /* Homepage rule (correction 9, as amended 2026-10-26 by user order):
     recency-sorted everywhere, newest first — FIRST-AIR DATE desc (the
     latest premiere leads, then going back); published_at only breaks
     ties. The old published_at-first sort scrambled the order whenever
     titles were published in batches. */
  const byNewest = (a, b) => dateOf(b).localeCompare(dateOf(a))
    || (b.published_at || "").localeCompare(a.published_at || "");
  const byPopular = (a, b) => (b.vote_average || 0) - (a.vote_average || 0)
    || (b.vote_count || 0) - (a.vote_count || 0);

  /* Freshness first (site rule: nothing older than 3 months on listings);
     fall back to the full published pool so the page is never empty while
     published shows exist. Near-future premieres (60 days, as before)
     stay in the pool; farther-out titles live on /upcoming. */
  const pool = (() => {
    const horizon = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
    const shows = Object.values(window.FA_PUBLISHED || {})
      .filter(x => x && x.id && x.type === "tv" && x.first_air_date && x.first_air_date <= horizon);
    const fresh = shows.filter(UI.isFresh);
    return fresh.length ? fresh : shows;
  })();

  /* Genres ARE baked into published entries (rich fields) — populate the
     genre select from the pool so the filter works (audit fix: the select
     used to stay at "All Genres" and any ?g= was cleared as stale). */
  const genreList = [...new Set(pool.flatMap(x => Array.isArray(x.genres) ? x.genres : []))].sort((a, b) => a.localeCompare(b));
  if (g && !genreList.includes(g)) g = ""; /* unknown genre param -> All */
  const chipHost = main.querySelector("#chipHost");
  const catDd = UI.mountFaSelect(chipHost.querySelectorAll(".filter-select")[0],
    FILTERS.map(([value, label]) => ({ value, label })),
    f, (v) => { f = v; UI.setParam("f", f === "all" ? "" : f); render(); });
  const genreDd = UI.mountFaSelect(chipHost.querySelectorAll(".filter-select")[1],
    [{ value: "", label: "All Genres" }, ...genreList.map(gName => ({ value: gName, label: gName }))],
    g, (v) => { g = v; UI.setParam("g", g); render(); });

  function render() {
    const year = String(new Date().getFullYear());
    const items = pool.filter(x => {
      /* Industry rule (owner order 2026-10-28): Bollywood = ALL Indian
         titles (canonical UI.industryOf), World Cinema = only
         international. */
      if (f === "bollywood" && UI.industryOf(x) !== "bollywood") return false;
      if (f === "international" && UI.industryOf(x) !== "world") return false;
      if (f === "hollywood" && !(UI.industryOf(x) === "world" && x.original_language === "en" && (x.origin_country || []).includes("US"))) return false;
      if (f === "lollywood" && UI.industryOf(x) !== "pakistani") return false;
      if (f === "year" && (x.first_air_date || "").slice(0, 4) !== year) return false;
      /* "Top Rated" is a sort-by-rating view, not a gate: the old gate
         (rating >= 7.5 AND vote_count >= 200) could never match published
         titles (vote_count 2-3), so the filter always showed empty. */
      if (g && !(Array.isArray(x.genres) && x.genres.includes(g))) return false;
      return true;
    });
    items.sort((a, b) => f === "top" ? byPopular(a, b) : byNewest(a, b));
    grid.innerHTML = items.map(x =>
      `<div class="fcell" data-fitem>${UI.posterCard(x, "tv", tagFor(x))}</div>`).join("");
    fcount.textContent = `${items.length} show${items.length === 1 ? "" : "s"}`;
    emptyHost.innerHTML = items.length ? ""
      : UI.stateMsg(pool.length
        ? "No shows match this filter right now."
        : "No shows have been published yet.", false);
  }

  /* Category and genre are independent dropdowns; browser history restores both. */
  window.addEventListener("popstate", () => {
    f = UI.getParam("f", "all");
    if (!FILTERS.some(([k]) => k === f)) f = "all";
    g = UI.getParam("g", "");
    if (g && !genreList.includes(g)) g = ""; /* unknown genre -> All */
    catDd.setValue(f);
    genreDd.setValue(g);
    render();
  });

  render();
})();





