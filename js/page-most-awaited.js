/* FlickAtlas — Coming Soon & Most Awaited hub (/most-awaited): the See All
   page for the homepage "Coming Soon & Most Awaited" rail. It lists the
   FULL future-dated movie pool in the EXACT order the rail shows — oldest
   upcoming release date first; titles whose only festival date has passed
   are excluded — the rail shows the first 12, this page shows all of them.
   Industry dropdown (All · Bollywood · World Cinema) mirrors the rail's
   switcher; the page reads ?f= on load.
   MOVIES ONLY (owner order 2026-10-27): the Movie/TV Type filter was
   removed — TV series live in OTT. The ?t= param is ignored.
   PUBLISHED-ONLY: from window.FA_PUBLISHED entries whose release date
   is in the future. Nothing is fetched live.
   Date sorting is explicit and switchable: oldest release date first by
   default, or newest release date first when selected. */
(async function () {
  UI.mountChrome("/most-awaited");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Coming Soon & Most Awaited — Upcoming Movies | FlickAtlas",
    desc: "All future-dated movies on FlickAtlas, sorted by release date. The full list behind the homepage Coming Soon & Most Awaited rail.",
    path: "/most-awaited"
  });

  /* Audit fix (2026-10-26): the ?f= filter MUST be read BEFORE the page
     HTML is built — the chip row below uses `f` as its active key, and a
     `let` read before its declaration throws a ReferenceError (temporal
     dead zone) that left this page stuck on "Loading FlickAtlas…". */
  let f = UI.getParam("f", "all");
  if (!["all", "bollywood", "international", "pakistani"].includes(f)) f = "all";
  let sort = UI.getParam("s", "oldest");
  if (!["oldest", "newest"].includes(sort)) sort = "oldest";
  /* Owner order 2026-10-27: movies only — the Movie/TV Type filter was
     removed (TV series live in OTT). The ?t= param is ignored; the page
     always shows movies. Industry is the only filter, a .fa-select
     in-page dropdown (never a native <select> popup). */

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Coming Soon &amp; Most Awaited</h1>
      </div>
    <div id="chipHost"><div class="listing-select-row">
      <div class="filter-select" role="group" aria-labelledby="indSelectLabel"><span class="filter-select-label" id="indSelectLabel">Industry</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="indTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="indOptions" aria-labelledby="indSelectLabel indValue"><span class="fa-select-value" id="indValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="indOptions" role="listbox" aria-labelledby="indSelectLabel" hidden></div></div></div>
      <div class="filter-select" role="group" aria-labelledby="sortSelectLabel"><span class="filter-select-label" id="sortSelectLabel">Sort by</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="sortTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="sortOptions" aria-labelledby="sortSelectLabel sortValue"><span class="fa-select-value" id="sortValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="sortOptions" role="listbox" aria-labelledby="sortSelectLabel" hidden></div></div></div>
    </div></div>
    <p class="fcount" id="fcount" aria-live="polite">Loading upcoming titles…</p>
    <div class="grid" id="grid">${UI.skelCards(6)}</div>
  </div>`;
  const grid = main.querySelector("#grid");
  const fcount = main.querySelector("#fcount");

  /* Published titles only: window.FA_PUBLISHED, keyed by TMDB id.
     Upcoming = entries whose release/air date is in the future.
     Industry tag for cards: "World Cinema" for world-industry titles
     (UI.industryTag now returns "World Cinema" — fixed in ui.js; the local override is a harmless guard). */
  const tagFor = (x) => UI.industryTag(x);
  /* The pick respects the ?f= filter the homepage and footer links pass
     (?f=bollywood / ?f=international), so every industry link shows its
     own single title (the filter itself is read above, before the HTML). */
  const today = UI.todayPKT();
  const dateOf = x => x.type === "tv" ? (x.first_air_date || "") : (x.release_date || "");
  /* Industry rule (owner order 2026-10-28): Bollywood = ALL Indian
     titles, World Cinema = only international — canonical
     UI.industryOf(). The coming-soon fix's local origin+language
     predicate is superseded by the shared classifier (same rule, plus
     spoken-language fallback and Indian-Urdu edge cases). */
  /* Movies only (owner order 2026-10-27): the old "TV ignores industry"
     branch is gone with the Type filter — TV can no longer leak in. */
  const inIndustry = x => f === "all" ? true
    : f === "international" ? UI.industryOf(x) === "world" : UI.industryOf(x) === f;
  /* Oldest release date = nearest upcoming date; newest release date =
     farthest future date. Ratings only break ties on the same date. */
  const byReleaseDate = (a, b) => (sort === "oldest"
      ? dateOf(a).localeCompare(dateOf(b))
      : dateOf(b).localeCompare(dateOf(a)))
      || (b.popularity || 0) - (a.popularity || 0)
      || (b.vote_count || 0) - (a.vote_count || 0)
      || (b.vote_average || 0) - (a.vote_average || 0)
      || String(a.title || "").localeCompare(String(b.title || ""));
  /* Full pool, same order as the homepage rail (byReleaseDate, above).
     The rail shows the first 12; this page shows ALL of them — that is
     what "See All" means. Movies only (owner order 2026-10-27) — TV
     series live in OTT. */
  /* Past festival premieres are not upcoming unless a current future
     commercial release date has been published. */
  const upcomingAll = Object.values(window.FA_PUBLISHED || {})
    .filter(x => x && x.id && x.poster_path && dateOf(x) > today && (x.type || "movie") === "movie");
  function render() {
    const upcoming = upcomingAll.filter(x => inIndustry(x)).sort(byReleaseDate);
    if (!upcoming.length) {
      fcount.textContent = "0 upcoming titles";
      grid.innerHTML = UI.stateMsg("No upcoming titles have been published yet.", false);
      return;
    }
    fcount.textContent = `${upcoming.length} upcoming title${upcoming.length === 1 ? "" : "s"}`;
    grid.innerHTML = upcoming.map(x => `<div class="fcell" data-fitem>${UI.posterCard(x, x.type || "movie", tagFor(x), undefined, undefined, true)}</div>`).join("");
  }
  const chipHost = main.querySelector("#chipHost");
  const industryDd = UI.mountFaSelect(chipHost.querySelectorAll(".filter-select")[0],
    [{ value: "all", label: "All" }, { value: "bollywood", label: "Bollywood" }, { value: "international", label: "World Cinema" }],
    f, (v) => { f = v; UI.setParam("f", f === "all" ? "" : f); render(); });
  const sortDd = UI.mountFaSelect(chipHost.querySelectorAll(".filter-select")[1],
    [{ value: "oldest", label: "Oldest release date" }, { value: "newest", label: "Newest release date" }],
    sort, (v) => { sort = v; UI.setParam("s", sort === "oldest" ? "" : sort); render(); });
  /* No Type mount: the filter is removed with its dropdown (owner order
     2026-10-27). No `if (selects[1])` guard is needed here — unlike
     page-index.js, this mount is page-specific, not shared across
     sections with different dropdown counts. */
  window.addEventListener("popstate", () => {
    f = UI.getParam("f", "all");
    if (!["all", "bollywood", "international", "pakistani"].includes(f)) f = "all";
    sort = UI.getParam("s", "oldest");
    if (!["oldest", "newest"].includes(sort)) sort = "oldest";
    industryDd.setValue(f);
    sortDd.setValue(sort);
    render();
  });
  render();
})();


