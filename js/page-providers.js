/* FlickAtlas — Where to Watch hub (/where-to-watch): a reference page
   listing the streaming / rental providers the site tracks, grouped by
   region. Created 2026-10-25: the page shipped referencing this script
   but the file was never committed, so it stayed on "Loading
   FlickAtlas…" forever. Rewritten in the full bug sweep (2026-10-25):
   provider names now come ONLY from PUBLISHED titles — the old version
   built them from live TMDB popular-title lists, a catalogue leak that
   also featured an unpublished popular movie. Names only, never links,
   never "watch now" buttons, and no availability is claimed for a
   specific title. At most ONE featured title card. */
(async function () {
  UI.mountChrome("/where-to-watch");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Where to Watch — Streaming & Rental | FlickAtlas",
    desc: "Where to watch, as information: which streaming platform carries a movie or series in the United States, India, Pakistan and the United Kingdom — stream, rent and buy options in plain text.",
    path: "/where-to-watch"
  });

  const REGIONS = [["US", "United States"], ["IN", "India"], ["PK", "Pakistan"], ["GB", "United Kingdom"]];

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Where to Watch</h1>
      <p>Streaming and rental availability, as information only — which platforms carry movies and series in each country. Availability varies by title and changes over time; check the platform for the latest catalogue.</p></div>
    <div id="wtwHost"><p class="eb-note" role="status">Loading provider information…</p></div>
  </div>`;
  const host = main.querySelector("#wtwHost");

  try {
    /* Published titles only — newest first, capped at 10 detail
       lookups. Each lookup is a single title's own watch/providers
       record (the same per-title shape as the credits call on detail
       pages), never a popular/trending catalogue. */
    const published = Object.values(window.FA_PUBLISHED || {})
      .filter(x => x && x.id != null && x.poster_path)
      .sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")) ||
        String(b.release_date || b.first_air_date || "").localeCompare(String(a.release_date || a.first_air_date || "")))
      .slice(0, 10);
    if (!published.length) {
      host.innerHTML = UI.stateMsg("No published titles yet, so there is no provider information to show. Provider listings appear here once titles are published.", false);
      return;
    }
    const details = await Promise.all(
      published.map(p => TMDB.details(p.type === "tv" ? "tv" : "movie", p.id).catch(() => null))
    );
    const byRegion = new Map(REGIONS.map(([code]) => [code, new Set()]));
    for (const d of details) {
      const res = d && d["watch/providers"] && d["watch/providers"].results;
      if (!res) continue;
      for (const [code] of REGIONS) {
        const entry = res[code];
        if (!entry) continue;
        for (const key of ["flatrate", "rent", "buy", "free", "ads"]) {
          (entry[key] || []).forEach(p => { if (p && p.provider_name) byRegion.get(code).add(p.provider_name); });
        }
      }
    }
    /* One featured title: the newest published title, with its own
       provider lines (text only). Its type decides the detail page. */
    const featured = published[0];
    const featuredDetails = details[0] || null;
    const lines = featuredDetails ? UI.providerLines(featuredDetails["watch/providers"]) : [];
    const featuredHtml = `<div class="content-card"><h2>Featured Title</h2>
        <div class="grid">${UI.posterCard(featured, featured.type === "tv" ? "tv" : "movie", UI.industryTag(featured))}</div>
        ${lines.length ? `<dl class="facts-table">${lines.map(([region, text]) => `<div class="fact-row"><dt>${UI.esc(region)}</dt><dd>${UI.esc(text)}</dd></div>`).join("")}</dl>` : `<p class="prov-note">No provider listings reported for this title right now.</p>`}
      </div>`;
    const regionHtml = REGIONS.map(([code, label]) => {
      const names = [...(byRegion.get(code) || [])].sort();
      return `<div class="content-card"><h2>${UI.esc(label)}</h2>
        ${names.length ? `<p>${names.map(n => UI.esc(n)).join(" · ")}</p>
        <p class="prov-note">Providers seen across published titles in ${UI.esc(label)} — stream, rent and buy. A provider listed here does not mean every title is available on it.</p>`
        : `<p class="prov-note">No provider listings reported for ${UI.esc(label)} from the published titles.</p>`}
      </div>`;
    }).join("");
    host.innerHTML = featuredHtml + regionHtml +
      `<p class="prov-note">FlickAtlas does not stream video and does not link to any platform. Provider names come from TMDB watch/providers data for published titles only; availability is per-title and changes over time.</p>`;
  } catch (e) {
    host.innerHTML = UI.stateMsg("Provider information could not be loaded. Please try again.");
  }
})();
