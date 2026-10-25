/* FlickAtlas — Airing Today hub (/airing-today): exactly ONE TV show
   airing today. Created 2026-10-25: the page shipped referencing this
   script but the file was never committed, so the page stayed on
   "Loading FlickAtlas…". Site rule: one item per listing — the top
   result only, never a grid of many. No watch/download buttons. */
(async function () {
  UI.mountChrome("/airing-today");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Airing Today — TV Shows | FlickAtlas",
    desc: "One TV show airing today on FlickAtlas — the top reported episode date, with seasons, cast and episode details on its own page.",
    path: "/airing-today"
  });
  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Airing Today</h1>
      <p>Television episodes whose reported air date matches today.</p></div>
    <p class="fcount" id="fcount" aria-live="polite">Loading today's show…</p>
    <div id="showHost">${UI.skelCards(1)}</div>
  </div>`;

  try {
    let picked = null;
    /* Primary: TMDB's airing-today list, top result with a poster. */
    try {
      const list = await TMDB.airingToday(1);
      picked = (list.results || []).filter(x => x && x.poster_path)[0] || null;
    } catch (_) { picked = null; }
    /* Fallbacks: shows on the air this week, then the most popular TV. */
    if (!picked) {
      try {
        const list = await TMDB.onTheAir(1);
        picked = (list.results || []).filter(x => x && x.poster_path)[0] || null;
      } catch (_) { picked = null; }
    }
    if (!picked) {
      const list = await TMDB.popular("tv", 1);
      picked = ((list.results || []).filter(x => x && x.poster_path))[0] || null;
    }
    if (!picked) throw new Error("no airing show");

    const title = UI.titleOf(picked);
    const poster = UI.img(picked.poster_path, "w342");
    const rating = UI.ratingText(picked);
    const firstAir = picked.first_air_date ? UI.fmtDate(picked.first_air_date) : "";
    const overview = (picked.overview || "").trim();
    const meta = [
      firstAir ? `First aired ${firstAir}` : "",
      rating || "",
      picked.original_language ? picked.original_language.toUpperCase() : ""
    ].filter(Boolean).join(" · ");

    const host = main.querySelector("#showHost");
    const fcount = main.querySelector("#fcount");
    fcount.textContent = "1 show airing today";
    host.innerHTML = `<section class="detail-hero">
      <div class="detail-in">
        ${poster ? `<div class="detail-poster"><a href="/show?id=${picked.id}"><img src="${poster}" alt="${UI.esc(title)} poster" loading="lazy" decoding="async" onerror="this.remove()"></a></div>` : ""}
        <div class="detail-main">
          <h1><a href="/show?id=${picked.id}" style="color:#fff">${UI.esc(title)}</a></h1>
          ${meta ? `<p class="detail-sub">${UI.esc(meta)}</p>` : ""}
          ${overview ? `<p style="color:#D8EDE8;margin-top:12px;max-width:62ch">${UI.esc(overview)}</p>` : ""}
        </div>
      </div>
    </section>
    <p style="margin-top:16px"><a class="btn btn-teal" href="/show?id=${picked.id}">View Show</a> <a class="btn" href="/tv">Browse TV Shows</a></p>
    <p class="prov-note">One show, airing today — open it for seasons, cast and episode details.</p>`;
  } catch (e) {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("Could not load today's show. Please try again.")}</div>`;
  }
})();
