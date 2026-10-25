/* FlickAtlas — OTT hub (/ott): this week's streaming releases, one
   featured title. Created 2026-10-25: the /ott page shipped referencing
   this script but the file was never committed, so the page stayed on
   "Loading FlickAtlas…" forever. Uses window.FlickAtlasOTT (ott-cards.js)
   for the week's real TMDB streaming rows; exactly ONE featured title
   is shown (site rule: one item per listing). No watch/download buttons;
   availability is text only, never links. */
(async function () {
  UI.mountChrome("/ott");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "OTT — Streaming Movies & Shows | FlickAtlas",
    desc: "Films and series newly released on streaming this week — what arrived, when, and which platform carries it in India. Information only, on FlickAtlas.",
    path: "/ott"
  });

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>OTT</h1>
      <p>New on streaming this week — films and series, with the platform that carries each one in India.</p></div>
    <div id="ottHost"><p class="eb-note" role="status">Loading release information…</p></div>
  </div>`;
  const host = main.querySelector("#ottHost");

  try {
    /* Primary: the week's real streaming rows from ott-cards.js. */
    let row = null;
    if (window.FlickAtlasOTT && typeof window.FlickAtlasOTT.load === "function") {
      const data = await window.FlickAtlasOTT.load();
      if (data && Array.isArray(data.rows) && data.rows.length) row = data.rows[0];
    }
    if (row && window.FlickAtlasOTT && typeof window.FlickAtlasOTT.card === "function") {
      host.innerHTML = `<div class="release-list">${window.FlickAtlasOTT.card(row)}</div>
        <p class="prov-note">Featured release of the week — the newest streaming arrival in the catalogue. Platform availability is reported for India and may change. FlickAtlas does not stream video.</p>`;
      return;
    }
    /* Fallback: the most popular currently-streaming TV title from TMDB. */
    const list = await TMDB.discoverResults("tv", { watch_region: "IN", with_watch_monetization_types: "flatrate", sort_by: "popularity.desc" });
    const first = (list || []).find(x => x && x.poster_path);
    if (!first) throw new Error("no ott title");
    const d = await TMDB.details("tv", first.id);
    const lines = UI.providerLines(d["watch/providers"]);
    host.innerHTML = `<div class="grid">${UI.posterCard(first, "tv", UI.industryTag(first))}</div>
      ${lines.length ? `<div class="content-card"><h2>Where to Watch</h2>
        <dl class="facts-table">${lines.map(([region, text]) => `<div class="fact-row"><dt>${UI.esc(region)}</dt><dd>${UI.esc(text)}</dd></div>`).join("")}</dl>
        <p class="prov-note">Availability names only — listings change by region and over time.</p></div>` : ""}
      <p class="prov-note">Featured streaming title — the most popular currently-streaming series in the catalogue. FlickAtlas does not stream video.</p>`;
  } catch (e) {
    host.innerHTML = UI.stateMsg("OTT releases could not be loaded. Please try again.");
  }
})();
