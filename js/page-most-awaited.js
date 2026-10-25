/* FlickAtlas — Most Awaited hub (/most-awaited): the single most awaited
   upcoming title. Created 2026-10-25: the page shipped referencing this
   script but the file was never committed, so the hub stayed on
   "Loading FlickAtlas…". Data comes from most-awaited-data.js
   (window.FAMostAwaited.fetch — upcoming Bollywood + international
   movies and TV, popularity-ranked), with a direct TMDB upcoming /
   future-discover fallback. Site rule: exactly ONE title (slice(0,1))
   — never a grid of many. */
(async function () {
  UI.mountChrome("/most-awaited");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Most Awaited — Upcoming Movies & Shows | FlickAtlas",
    desc: "The most awaited upcoming movie or show on FlickAtlas — ranked by TMDB popularity, with release date and details.",
    path: "/most-awaited"
  });

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Most Awaited</h1>
      <p>The single most awaited upcoming title, ranked by popularity.</p></div>
    <p class="fcount" id="fcount" aria-live="polite">Loading the most awaited title…</p>
    <div class="grid" id="grid">${UI.skelCards(1)}</div>
    <div id="detailHost"></div>
  </div>`;
  const grid = main.querySelector("#grid");
  const fcount = main.querySelector("#fcount");
  const detailHost = main.querySelector("#detailHost");

  try {
    let items = [];
    if (window.FAMostAwaited && typeof window.FAMostAwaited.fetch === "function") {
      items = await window.FAMostAwaited.fetch();
    } else {
      const today = TMDB.today();
      const [movies, tv] = await Promise.all([
        TMDB.upcomingMovies(1).then(d => d.results || []).catch(() => []),
        TMDB.discoverResults("tv", { "first_air_date.gte": today, sort_by: "popularity.desc" }).catch(() => []),
      ]);
      items = [
        ...movies.map(m => ({ ...m, media_type: "movie", _date: m.release_date })),
        ...tv.map(t => ({ ...t, media_type: "tv", _date: t.first_air_date })),
      ].filter(x => x && x.poster_path && x._date && x._date >= today)
        .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    }
    const top = (items || []).slice(0, 1);
    if (!top.length) throw new Error("no upcoming titles");
    const x = top[0];
    const type = x.media_type || x._type || "movie";
    const date = x._date || (type === "tv" ? x.first_air_date : x.release_date) || "";
    const title = UI.titleOf(x);
    const detailHref = type === "tv" ? `/show?id=${x.id}` : `/movie?id=${x.id}`;

    grid.innerHTML = `<div class="fcell" data-fitem>${UI.posterCard(x, type, UI.industryTag(x))}</div>`;
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
      <p class="prov-note">Popularity is TMDB's recorded discovery signal, not a measured audience poll.</p></div>`;
  } catch (e) {
    fcount.textContent = "Most awaited titles could not be loaded.";
    grid.innerHTML = UI.stateMsg("Could not load upcoming titles. Please try again.");
  }
})();
