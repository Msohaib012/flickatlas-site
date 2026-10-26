/* FlickAtlas — Pakistani Dramas hub (/dramas): poster grid of the
   published Pakistani TV dramas, newest first (by first_air_date).
   User order 2026-10-26: the Drama category is a POSTER-style list;
   clicking a drama poster opens its show page (/show?id=<id>), which
   lists that drama's episodes (each linking to its own episode page).
   PUBLISHED-ONLY: every drama comes from window.FA_PUBLISHED — TMDB is
   a data source, not a catalogue, so nothing is fetched live. Movies
   are NOT here — they live on /category?cat=lollywood. */
(async function () {
  UI.mountChrome("/dramas");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Pakistani Dramas — Latest Pakistani Drama Serials | FlickAtlas",
    desc: "Pakistani dramas on FlickAtlas — the latest Pakistani drama serials, newest first. Open a drama for its episode list.",
    path: "/dramas"
  });

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Pakistani Dramas</h1>
      <p>Pakistani drama serials, newest first; open a drama for its episode list.</p></div>
    <p class="fcount" id="fcount" aria-live="polite">Loading dramas…</p>
    <div class="grid" id="grid">${UI.skelCards(6)}</div>
    <div id="emptyHost"></div>
  </div>`;
  const grid = main.querySelector("#grid");
  const fcount = main.querySelector("#fcount");
  const emptyHost = main.querySelector("#emptyHost");

  const dateOf = (x) => (x && (x.first_air_date || "")) || "";
  const dramas = Object.values(window.FA_PUBLISHED || {})
    .filter(x => x && x.id && x.poster_path && (x.type || x.media_type) === "tv" && (x.industry || "") === "pakistani")
    .sort((a, b) => dateOf(b).localeCompare(dateOf(a)) || (b.published_at || "").localeCompare(a.published_at || ""));

  if (!dramas.length) {
    fcount.textContent = "No Pakistani dramas have been published yet.";
    grid.innerHTML = "";
    emptyHost.innerHTML = UI.stateMsg("No Pakistani dramas have been published yet.", false);
    return;
  }
  fcount.textContent = `${dramas.length} drama${dramas.length === 1 ? "" : "s"}`;
  grid.innerHTML = dramas.map(x =>
    `<div class="fcell" data-fitem>${UI.posterCard(x, "tv", "Pakistani Drama")}</div>`).join("");
})();
