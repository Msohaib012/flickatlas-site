/* FlickAtlas — Coming Soon & Most Awaited hub (/most-awaited): the See All
   page for the homepage "Coming Soon & Most Awaited" rail. It lists the
   FULL upcoming pool in the EXACT order the rail shows (rating desc,
   then vote_count desc, then nearest date) — the rail shows the first 6,
   this page shows all of them. Industry dropdown (All · Bollywood ·
   World Cinema) mirrors the rail's switcher; the page reads ?f= on load.
   MOVIES ONLY (owner order 2026-10-27): the Movie/TV Type filter was
   removed — TV series live in OTT. The ?t= param is ignored.
   PUBLISHED-ONLY: from window.FA_PUBLISHED entries whose release date
   is in the future. Nothing is fetched live. */
(async function () {
  UI.mountChrome("/most-awaited");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Coming Soon & Most Awaited — Upcoming Movies | FlickAtlas",
    desc: "All upcoming movies on FlickAtlas, most awaited first — the full list behind the homepage Coming Soon & Most Awaited rail.",
    path: "/most-awaited"
  });

  /* Audit fix (2026-10-26): the ?f= filter MUST be read BEFORE the page
     HTML is built — the chip row below uses `f` as its active key, and a
     `let` read before its declaration throws a ReferenceError (temporal
     dead zone) that left this page stuck on "Loading FlickAtlas…". */
  let f = UI.getParam("f", "all");
  if (!["all", "bollywood", "international", "pakistani"].includes(f)) f = "all";
  /* Owner order 2026-10-27: movies only — the Movie/TV Type filter was
     removed (TV series live in OTT). The ?t= param is ignored; the page
     always shows movies. Industry is the only filter, a .fa-select
     in-page dropdown (never a native <select> popup). */

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Coming Soon &amp; Most Awaited</h1>
      <p>All upcoming titles, most awaited first.</p></div>
    <div id="chipHost"><div class="listing-select-row">
      <div class="filter-select" role="group" aria-labelledby="indSelectLabel"><span class="filter-select-label" id="indSelectLabel">Industry</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="indTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="indOptions" aria-labelledby="indSelectLabel indValue"><span class="fa-select-value" id="indValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="indOptions" role="listbox" aria-labelledby="indSelectLabel" hidden></div></div></div>
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
  const tagFor = (x) => (x && x.industry === "world") ? "World Cinema" : UI.industryTag(x);
  /* The pick respects the ?f= filter the homepage and footer links pass
     (?f=bollywood / ?f=international), so every industry link shows its
     own single title (the filter itself is read above, before the HTML). */
  const today = new Date().toISOString().slice(0, 10);
  const dateOf = x => x.type === "tv" ? (x.first_air_date || "") : (x.release_date || "");
  /* Movies only (owner order 2026-10-27): the old "TV ignores industry"
     branch is gone with the Type filter — TV can no longer leak in. */
  const inIndustry = x => f === "all" ? true
    : f === "international" ? x.industry === "world" : x.industry === f;
  /* Full pool, same order as the homepage rail (rating desc, then
     vote_count desc, then nearest date). The rail shows the first 6;
     this page shows ALL of them — that is what "See All" means.
     Movies only (owner order 2026-10-27) — TV series live in OTT. */
  /* Festival-only titles (date_kind="festival", owner decision
     2026-10-27) stay upcoming even when the festival date has
     passed — a festival premiere is not a release. */
  const upcomingAll = Object.values(window.FA_PUBLISHED || {})
    .filter(x => x && x.id && x.poster_path && (dateOf(x) > today || x.date_kind === "festival"))
    .sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0)
      || (b.vote_count || 0) - (a.vote_count || 0)
      || dateOf(a).localeCompare(dateOf(b)));
  function render() {
    const upcoming = upcomingAll.filter(x => inIndustry(x)
      && (x.type || "movie") === "movie");
    if (!upcoming.length) {
      fcount.textContent = "0 upcoming titles";
      grid.innerHTML = UI.stateMsg("No upcoming titles have been published yet.", false);
      return;
    }
    fcount.textContent = `${upcoming.length} upcoming title${upcoming.length === 1 ? "" : "s"}`;
    grid.innerHTML = upcoming.map(x => `<div class="fcell" data-fitem>${UI.posterCard(x, x.type || "movie", tagFor(x), undefined, undefined, true)}</div>`).join("");
  }
  const chipHost = main.querySelector("#chipHost");
  UI.mountFaSelect(chipHost.querySelectorAll(".filter-select")[0],
    [{ value: "all", label: "All" }, { value: "bollywood", label: "Bollywood" }, { value: "international", label: "World Cinema" }],
    f, (v) => { f = v; UI.setParam("f", f === "all" ? "" : f); render(); });
  /* No Type mount: the filter is removed with its dropdown (owner order
     2026-10-27). No `if (selects[1])` guard is needed here — unlike
     page-index.js, this mount is page-specific, not shared across
     sections with different dropdown counts. */
  render();
})();






