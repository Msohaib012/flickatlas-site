/* FlickAtlas — TV & Web Series hub with §4 filter chips: All (mixed) ·
   Bollywood · Hollywood · Lollywood · This Year · Top Rated +
   a Genre select. Chips are ?f= URL-param filters over the loaded pool.
   PUBLISHED-ONLY (2026-10-25 rebuild): every show comes from
   window.FA_PUBLISHED — TMDB is a data source, not a catalogue, so
   nothing is fetched live. K-Drama filter REMOVED (spec §6). Published
   entries carry a baked `industry` (bollywood | pakistani | world);
   "Hollywood" is the US-English slice of world, "Lollywood" is the
   Pakistani industry. No genre data exists in published entries, so the
   genre select stays at "All Genres". */
(async function () {
  UI.mountChrome("/tv");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "TV Shows — Popular Series, Seasons, Cast & Episode Info | FlickAtlas",
    desc: "Browse popular and top rated TV shows on FlickAtlas. Open any series for its seasons, episode counts, full cast, story and ratings.",
    path: "/tv"
  });

  const FILTERS = [["all", "All"], ["bollywood", "Bollywood"], ["hollywood", "Hollywood"],
    ["lollywood", "Lollywood"], ["year", "This Year"], ["top", "Top Rated"]];
  let f = UI.getParam("f", "all");
  if (!FILTERS.some(([k]) => k === f)) f = "all";
  let g = UI.getParam("g", "");

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>TV Shows</h1>
      <p>Filter TV series by genre; open a show for cast and episode details.</p></div>
    <div id="chipHost">${UI.chipRow(FILTERS, f)}
      <div class="listing-select-row listing-select-row--single"><label class="filter-select"><span>Genre</span><select class="fsel" id="genreSel" aria-label="Filter by genre"><option value="">All Genres</option></select></label></div></div>
    <p class="fcount" id="fcount" aria-live="polite">Loading shows…</p>
    <div class="grid" id="grid">${UI.skelCards(12)}</div>
    <div id="emptyHost"></div>
  </div>`;
  const grid = main.querySelector("#grid");
  const fcount = main.querySelector("#fcount");
  const emptyHost = main.querySelector("#emptyHost");
  const genreSel = main.querySelector("#genreSel");
  if (g) genreSel.value = g;

  /* Published titles only: window.FA_PUBLISHED, keyed by TMDB id.
     Entries carry a baked `industry` (bollywood | pakistani | world)
     and `type` ("movie" | "tv"). No live TMDB calls anywhere. */
  const dateOf = x => x.first_air_date || "";
  /* Homepage rule (correction 9): recency-sorted everywhere, newest first —
     published_at desc, then first-air date desc. */
  const byNewest = (a, b) => (b.published_at || "").localeCompare(a.published_at || "")
    || dateOf(b).localeCompare(dateOf(a));
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

  function render() {
    const year = String(new Date().getFullYear());
    const items = pool.filter(x => {
      if (f === "bollywood" && x.industry !== "bollywood") return false;
      if (f === "hollywood" && !(x.industry === "world" && x.original_language === "en" && (x.origin_country || []).includes("US"))) return false;
      if (f === "lollywood" && x.industry !== "pakistani") return false;
      if (f === "year" && (x.first_air_date || "").slice(0, 4) !== year) return false;
      if (f === "top" && !((x.vote_average || 0) >= 7.5 && (x.vote_count || 0) >= 200)) return false;
      /* No genre data in published entries — a ?g= param matches nothing. */
      if (g) return false;
      return true;
    });
    items.sort((a, b) => f === "top" ? byPopular(a, b) : byNewest(a, b));
    const shown = items.slice(0, 1);
    grid.innerHTML = shown.map(x =>
      `<div class="fcell" data-fitem>${UI.posterCard(x, "tv", UI.industryTag(x))}</div>`).join("");
    fcount.textContent = `${shown.length} show${shown.length === 1 ? "" : "s"}`;
    emptyHost.innerHTML = shown.length ? ""
      : UI.stateMsg(pool.length
        ? "No shows match this filter right now."
        : "No shows have been published yet.", false);
  }

  UI.wireChips(main.querySelector("#chipHost"), (key) => { f = key; render(); });
  genreSel.addEventListener("change", () => {
    g = genreSel.value;
    UI.setParam("g", g);
    render();
  });
  /* Genre is independent of the category chips; browser history restores both. */
  window.addEventListener("popstate", () => {
    g = UI.getParam("g", "");
    genreSel.value = g;
    /* Stale ?g= param: published entries carry no genres, so clear it. */
    if (g) { g = ""; genreSel.value = ""; UI.setParam("g", ""); }
    render();
  });

  /* Genre select stays at "All Genres": published entries carry no genres.
     A stale ?g= param matches nothing, so clear it. */
  if (g) { g = ""; genreSel.value = ""; UI.setParam("g", ""); }
  render();
})();
