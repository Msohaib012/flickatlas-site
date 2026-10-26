/* FlickAtlas — Pakistani Dramas hub (/dramas): poster grid of the
   published Pakistani TV dramas, newest first (by first_air_date).
   User order 2026-10-26: the Drama category is a POSTER-style list;
   clicking a drama poster opens its show page (/show?id=<id>), which
   lists that drama's episodes (each linking to its own episode page).
   PUBLISHED-ONLY: every drama comes from window.FA_PUBLISHED — TMDB is
   a data source, not a catalogue, so nothing is fetched live. Movies
   are NOT here — they live on /category?cat=lollywood.
   Each card also shows the live episode count from the episode
   tracker (/out/episodes.json — "13 episodes · Still airing"), so
   the page reads as a live drama guide, not just a poster wall. A
   sort dropdown (Newest / Oldest / A–Z) orders the grid. */
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
      <p>Pakistani drama serials — open a drama for its episode list. Episode counts come from the live episode tracker and update as new episodes air.</p></div>
    <div id="chipHost">
      <div class="listing-select-row listing-select-row--single"><label class="filter-select"><span>Sort</span><select class="fsel" id="sortSel" aria-label="Sort dramas"><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="az">A – Z</option></select></label></div>
    </div>
    <p class="fcount" id="fcount" aria-live="polite">Loading dramas…</p>
    <div class="grid" id="grid">${UI.skelCards(6)}</div>
    <div id="emptyHost"></div>
  </div>`;
  const grid = main.querySelector("#grid");
  const fcount = main.querySelector("#fcount");
  const emptyHost = main.querySelector("#emptyHost");
  const sortSel = main.querySelector("#sortSel");

  /* Tracker episode counts (user order 2026-10-26): the highest
     tracked episode number per drama IS its episode count (episodes
     air sequentially from 1). Alias: tracker "Dar" = published
     "Dar-E-Nijaat", tracker "Zehar" = "Zehar-e-Mohabbat". A drama
     whose latest tracked episode aired within 7 days and whose
     status is still Returning Series is still airing. When the
     tracker has nothing for a drama, its card shows no episode line
     (the card still renders — the tracker is a live extra, not a
     gate). */
  const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const DRAMA_ALIASES = { "dar": "dar e nijaat", "zehar": "zehar e mohabbat" };
  const canonDrama = (d) => DRAMA_ALIASES[normName(d)] || normName(d);
  const trackerByDrama = {};
  try {
    const res = await fetch("/out/episodes.json", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      for (const r of Object.values((data && data.episodes) || {})) {
        if (!r || !r.drama) continue;
        const key = canonDrama(r.drama);
        const n = r.episode;
        if (!Number.isInteger(n) || n <= 0) continue;
        const cur = trackerByDrama[key];
        const pub = r.published || "";
        if (!cur || n > cur.count || (n === cur.count && pub > cur.latestPublished)) {
          trackerByDrama[key] = { count: n, latestPublished: pub };
        }
      }
    }
  } catch (_) { /* tracker unavailable — cards render without episode counts */ }
  const epMeta = (x) => {
    const t = trackerByDrama[canonDrama(UI.titleOf(x))];
    if (!t) return "";
    let airing = false;
    if (t.latestPublished) {
      const last = Date.parse(t.latestPublished);
      airing = Number.isFinite(last) && (Date.now() - last) / 86400000 <= 7
        && String(x.status || "").toLowerCase().indexOf("returning") !== -1;
    }
    return `${t.count} episode${t.count === 1 ? "" : "s"}${airing ? " · Still airing" : ""}`;
  };

  const dateOf = (x) => (x && (x.first_air_date || "")) || "";
  const allDramas = Object.values(window.FA_PUBLISHED || {})
    .filter(x => x && x.id && x.poster_path && (x.type || x.media_type) === "tv" && (x.industry || "") === "pakistani");

  if (!allDramas.length) {
    fcount.textContent = "No Pakistani dramas have been published yet.";
    grid.innerHTML = "";
    emptyHost.innerHTML = UI.stateMsg("No Pakistani dramas have been published yet.", false);
    return;
  }
  const renderGrid = () => {
    const sort = sortSel.value || "newest";
    const dramas = [...allDramas].sort((a, b) => {
      if (sort === "oldest") return dateOf(a).localeCompare(dateOf(b)) || (a.published_at || "").localeCompare(b.published_at || "");
      if (sort === "az") return UI.titleOf(a).localeCompare(UI.titleOf(b));
      return dateOf(b).localeCompare(dateOf(a)) || (b.published_at || "").localeCompare(a.published_at || "");
    });
    fcount.textContent = `${dramas.length} drama${dramas.length === 1 ? "" : "s"}`;
    grid.innerHTML = dramas.map(x =>
      `<div class="fcell" data-fitem>${UI.posterCard(x, "tv", "Pakistani Drama", null, epMeta(x))}</div>`).join("");
  };
  sortSel.addEventListener("change", renderGrid);
  renderGrid();
})();
