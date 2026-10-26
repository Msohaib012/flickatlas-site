/* FlickAtlas — Most Awaited hub (/most-awaited): the single most awaited
   upcoming title. Industry chips (All · Bollywood · World Cinema) mirror
   the homepage "Coming Soon & Most Awaited" rail's industry switcher —
   the rail's two options plus All (the page default). Chips are plain
   links; the page reads ?f= on load, so no extra wiring is needed.
   PUBLISHED-ONLY (2026-10-25 rebuild): the pick comes
   from window.FA_PUBLISHED entries whose release/air date is in the
   future — TMDB is a data source, not a catalogue, so nothing is fetched
   live (no FAMostAwaited, no TMDB upcoming/discover fallback). Published
   entries carry no TMDB popularity score, so the pick ranks by rating
   (vote_average, then vote_count), then nearest date. Site rule: exactly
   ONE title (slice(0,1)) — never a grid of many. */
(async function () {
  UI.mountChrome("/most-awaited");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Most Awaited — Upcoming Movies & Shows | FlickAtlas",
    desc: "The most awaited upcoming movie or show on FlickAtlas — the highest-rated upcoming title among published titles, with release date and details.",
    path: "/most-awaited"
  });

  /* Audit fix (2026-10-26): the ?f= filter MUST be read BEFORE the page
     HTML is built — the chip row below uses `f` as its active key, and a
     `let` read before its declaration throws a ReferenceError (temporal
     dead zone) that left this page stuck on "Loading FlickAtlas…". */
  let f = UI.getParam("f", "all");
  if (!["all", "bollywood", "international", "pakistani"].includes(f)) f = "all";

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Most Awaited</h1>
      <p>The single most awaited upcoming title among published titles.</p></div>
    <div id="chipHost">${UI.chipRow([["all", "All"], ["bollywood", "Bollywood"], ["international", "World Cinema"]], f, "all")}</div>
    <p class="fcount" id="fcount" aria-live="polite">Loading the most awaited title…</p>
    <div class="grid" id="grid">${UI.skelCards(1)}</div>
    <div id="detailHost"></div>
  </div>`;
  const grid = main.querySelector("#grid");
  const fcount = main.querySelector("#fcount");
  const detailHost = main.querySelector("#detailHost");

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
  const upcoming = Object.values(window.FA_PUBLISHED || {})
    .filter(x => x && x.id && x.poster_path && inIndustry(x) && dateOf(x) > today)
    .sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0)
      || (b.vote_count || 0) - (a.vote_count || 0)
      || dateOf(a).localeCompare(dateOf(b)));
  const top = upcoming.slice(0, 1);

  if (!top.length) {
    /* Audit fix: the count line and the grid used to carry the SAME
       sentence ("No upcoming titles have been published yet." twice).
       The count line now carries the count; the grid carries the message. */
    fcount.textContent = "0 upcoming titles";
    grid.innerHTML = UI.stateMsg("No upcoming titles have been published yet.", false);
    return;
  }

  const x = top[0];
  const type = x.type || "movie";
  const date = dateOf(x);
  const title = UI.titleOf(x);
  const detailHref = type === "tv" ? `/show?id=${x.id}` : `/movie?id=${x.id}`;

  grid.innerHTML = `<div class="fcell" data-fitem>${UI.posterCard(x, type, tagFor(x))}</div>`;
  fcount.textContent = "1 most awaited title";
  detailHost.innerHTML = `<div class="content-card"><h2>${UI.esc(title)}</h2>
    <dl class="facts-table">
      <div class="fact-row"><dt>Type</dt><dd>${type === "tv" ? "TV Show" : "Movie"}</dd></div>
      ${date ? `<div class="fact-row"><dt>${type === "tv" ? "First Airs" : "Releases"}</dt><dd>${UI.esc(UI.fmtDate(date))}</dd></div>` : ""}
      ${x.vote_average ? `<div class="fact-row"><dt>Rating</dt><dd>${UI.esc(UI.ratingText(x))}</dd></div>` : ""}
      ${x.original_language ? `<div class="fact-row"><dt>Language</dt><dd>${UI.esc(String(x.original_language).toUpperCase())}</dd></div>` : ""}
    </dl>
    ${x.overview ? `<p class="article-summary">${UI.esc(x.overview.slice(0, 240))}</p>` : ""}
    <p><a class="btn btn-teal" href="${detailHref}">Open full details →</a></p>
    <p class="prov-note">The most awaited upcoming title among published titles on FlickAtlas.</p></div>`;
})();


