/* FlickAtlas — Coming Soon & Most Awaited hub (/most-awaited): the See All
   page for the homepage "Coming Soon & Most Awaited" rail. It lists the
   FULL upcoming pool in the EXACT order the rail shows (rating desc,
   then vote_count desc, then nearest date) — the rail shows the first 6,
   this page shows all of them. Industry chips (All · Bollywood · World
   Cinema) mirror the rail's switcher; the page reads ?f= on load.
   PUBLISHED-ONLY: from window.FA_PUBLISHED entries whose release/air date
   is in the future. Nothing is fetched live. */
(async function () {
  UI.mountChrome("/most-awaited");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Coming Soon & Most Awaited — Upcoming Movies & Shows | FlickAtlas",
    desc: "All upcoming movies and shows on FlickAtlas, most awaited first — the full list behind the homepage Coming Soon & Most Awaited rail.",
    path: "/most-awaited"
  });

  /* Audit fix (2026-10-26): the ?f= filter MUST be read BEFORE the page
     HTML is built — the chip row below uses `f` as its active key, and a
     `let` read before its declaration throws a ReferenceError (temporal
     dead zone) that left this page stuck on "Loading FlickAtlas…". */
  let f = UI.getParam("f", "all");
  if (!["all", "bollywood", "international", "pakistani"].includes(f)) f = "all";
  /* TV order 2026-10-27: the hub lists upcoming movies AND TV series,
     with Industry + Type as .fa-select in-page dropdowns (the old
     industry chips are retired — See All filters are dropdowns, never
     a native <select> popup). Default type is Movies (?t=tv / ?t=all
     open the other views; the homepage Coming Soon See All link
     carries ?t=). */
  let t = UI.getParam("t", "movie");
  if (!["movie", "tv", "all"].includes(t)) t = "movie";

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Coming Soon &amp; Most Awaited</h1>
      <p>All upcoming titles, most awaited first.</p></div>
    <div id="chipHost"><div class="listing-select-row">
      <div class="filter-select" role="group" aria-labelledby="indSelectLabel"><span class="filter-select-label" id="indSelectLabel">Industry</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="indTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="indOptions" aria-labelledby="indSelectLabel indValue"><span class="fa-select-value" id="indValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="indOptions" role="listbox" aria-labelledby="indSelectLabel" hidden></div></div></div>
      <div class="filter-select" role="group" aria-labelledby="typeSelectLabel"><span class="filter-select-label" id="typeSelectLabel">Type</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="typeTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="typeOptions" aria-labelledby="typeSelectLabel typeValue"><span class="fa-select-value" id="typeValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="typeOptions" role="listbox" aria-labelledby="typeSelectLabel" hidden></div></div></div>
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
  const inIndustry = x => (x.type || "movie") === "tv" ? true /* TV ignores industry */
    : f === "all" ? true
    : f === "international" ? x.industry === "world" : x.industry === f;
  /* Full pool, same order as the homepage rail (rating desc, then
     vote_count desc, then nearest date). The rail shows the first 6;
     this page shows ALL of them — that is what "See All" means.
     The Type filter applies at render time (default Movies). */
  const upcomingAll = Object.values(window.FA_PUBLISHED || {})
    .filter(x => x && x.id && x.poster_path && dateOf(x) > today)
    .sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0)
      || (b.vote_count || 0) - (a.vote_count || 0)
      || dateOf(a).localeCompare(dateOf(b)));
  function render() {
    const upcoming = upcomingAll.filter(x => inIndustry(x)
      && (t === "all" ? true : (x.type || "movie") === t));
    if (!upcoming.length) {
      fcount.textContent = "0 upcoming titles";
      grid.innerHTML = UI.stateMsg(t === "tv"
        ? "No upcoming TV series have been published yet."
        : "No upcoming titles have been published yet.", false);
      return;
    }
    fcount.textContent = `${upcoming.length} upcoming title${upcoming.length === 1 ? "" : "s"}`;
    grid.innerHTML = upcoming.map(x => `<div class="fcell" data-fitem>${UI.posterCard(x, x.type || "movie", tagFor(x), undefined, undefined, true)}</div>`).join("");
  }
  const chipHost = main.querySelector("#chipHost");
  UI.mountFaSelect(chipHost.querySelectorAll(".filter-select")[0],
    [{ value: "all", label: "All" }, { value: "bollywood", label: "Bollywood" }, { value: "international", label: "World Cinema" }],
    f, (v) => { f = v; UI.setParam("f", f === "all" ? "" : f); render(); });
  UI.mountFaSelect(chipHost.querySelectorAll(".filter-select")[1],
    [{ value: "movie", label: "Movies" }, { value: "tv", label: "TV Series" }, { value: "all", label: "All" }],
    t, (v) => { t = v; UI.setParam("t", t === "movie" ? "" : t); render(); });
  render();
})();




