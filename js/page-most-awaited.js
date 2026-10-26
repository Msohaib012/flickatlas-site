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

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Coming Soon &amp; Most Awaited</h1>
      <p>All upcoming titles, most awaited first.</p></div>
    <div id="chipHost">${UI.chipRow([["all", "All"], ["bollywood", "Bollywood"], ["international", "World Cinema"]], f, "all")}</div>
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
  const inIndustry = x => f === "all" ? true
    : f === "international" ? x.industry === "world" : x.industry === f;
  /* Full pool, same order as the homepage rail (rating desc, then
     vote_count desc, then nearest date). The rail shows the first 6;
     this page shows ALL of them — that is what "See All" means. */
  const upcoming = Object.values(window.FA_PUBLISHED || {})
    .filter(x => x && x.id && x.poster_path && inIndustry(x) && dateOf(x) > today)
    .sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0)
      || (b.vote_count || 0) - (a.vote_count || 0)
      || dateOf(a).localeCompare(dateOf(b)));

  if (!upcoming.length) {
    fcount.textContent = "0 upcoming titles";
    grid.innerHTML = UI.stateMsg("No upcoming titles have been published yet.", false);
    return;
  }

  fcount.textContent = `${upcoming.length} upcoming title${upcoming.length === 1 ? "" : "s"}`;
  grid.innerHTML = upcoming.map(x => `<div class="fcell" data-fitem>${UI.posterCard(x, x.type || "movie", tagFor(x))}</div>`).join("");
})();



