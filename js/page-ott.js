/* FlickAtlas — OTT hub (/ott): this week's streaming releases, one
   featured title. PUBLISHED-ONLY (2026-10-25 rebuild): the featured
   title is the newest published title in window.FA_PUBLISHED — TMDB is
   a data source, not a catalogue, so nothing is fetched live (no
   FlickAtlasOTT weekly rows, no TMDB streaming discover fallback).
   Exactly ONE featured title is shown (site rule: one item per listing).
   No watch/download buttons; availability is text only, never links.
   Provider info is baked into FA_PUBLISHED (scripts/title-seed.py
   enriches every entry with a providers list from the TMDB
   watch/providers API; scripts/backfill_providers.py filled the
   existing titles). The featured title names its streaming
   platforms below, when TMDB reports any. */
(async function () {
  UI.mountChrome("/ott");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "OTT — Streaming Movies & Shows | FlickAtlas",
    desc: "Films and series newly released on streaming — the featured published title, with details on FlickAtlas. Information only.",
    path: "/ott"
  });

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>OTT</h1>
      <p>The featured published title on FlickAtlas — platform availability is reported as information only.</p></div>
    <div id="ottHost"><p class="eb-note" role="status">Loading release information…</p></div>
  </div>`;
  const host = main.querySelector("#ottHost");

  /* Published titles only: window.FA_PUBLISHED, keyed by TMDB id.
     Featured = newest published title (published_at desc, then
     release/air date desc).
     Industry tag for cards: "World Cinema" for world-industry titles
     (UI.industryTag now returns "World Cinema" — fixed in ui.js; the local override is a harmless guard). */
  const tagFor = (x) => (x && x.industry === "world") ? "World Cinema" : UI.industryTag(x);
  const dateOf = x => x.type === "tv" ? (x.first_air_date || "") : (x.release_date || "");
  const byNewest = (a, b) => (b.published_at || "").localeCompare(a.published_at || "")
    || dateOf(b).localeCompare(dateOf(a));
  const featured = Object.values(window.FA_PUBLISHED || {})
    .filter(x => x && x.id && x.poster_path)
    .sort(byNewest)[0] || null;

  if (!featured) {
    host.innerHTML = UI.stateMsg("No streaming titles have been published yet.", false);
    return;
  }

  const type = featured.type || "movie";
  host.innerHTML = `<div class="grid">${UI.posterCard(featured, type, tagFor(featured))}</div>
    ${featured.overview ? `<div class="content-card"><h2>${UI.esc(UI.titleOf(featured))}</h2>
      <p class="article-summary">${UI.esc(featured.overview.slice(0, 240))}</p>
      ${(featured.providers && featured.providers.length) ? `<p class="prov-list">Streaming on: ${featured.providers.map(p => UI.esc(p.name)).join(" \u00b7 ")}</p>` : ""}
      <p><a class="btn btn-teal" href="/${type === "tv" ? "show" : "movie"}?id=${featured.id}">Open full details →</a></p></div>` : ""}
    <p class="prov-note">Featured title — the newest published title on FlickAtlas. Platform availability is reported as information only and may change. FlickAtlas does not stream video.</p>`;
})();

