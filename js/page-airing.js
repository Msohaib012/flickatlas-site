/* FlickAtlas — Airing Today hub (/airing-today): exactly ONE TV show
   airing today. PUBLISHED-ONLY (2026-10-25 rebuild): the pick comes from
   window.FA_PUBLISHED tv entries — TMDB is a data source, not a
   catalogue, so nothing is fetched live (no TMDB airing-today / on-the-air
   / popular fallback). A show whose first-air date is today is the pick;
   otherwise the latest published TV show is shown. Site rule: one item
   per listing — the top result only, never a grid of many.
   No watch/download buttons. */
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

  /* Published titles only: window.FA_PUBLISHED, keyed by TMDB id.
     Published entries carry no per-episode air dates, so "airing today"
     means a published show whose first-air date is today; otherwise the
     latest published TV show is the pick. */
  const today = new Date().toISOString().slice(0, 10);
  const shows = Object.values(window.FA_PUBLISHED || {})
    .filter(x => x && x.id && x.type === "tv" && x.poster_path);
  const byNewest = (a, b) => (b.published_at || "").localeCompare(a.published_at || "")
    || (b.first_air_date || "").localeCompare(a.first_air_date || "");
  const premieringToday = shows.filter(x => (x.first_air_date || "") === today).sort(byNewest);
  const picked = premieringToday[0] || [...shows].sort(byNewest)[0] || null;

  if (!picked) {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("No shows have been published yet.", false)}</div>`;
    return;
  }

  const isAiringToday = (picked.first_air_date || "") === today;
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
  fcount.textContent = isAiringToday ? "1 show airing today" : "Latest published show";
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
})();
