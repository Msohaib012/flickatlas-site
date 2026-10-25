/* FlickAtlas — Episode Guides hub (/episode-guides): the single featured
   Pakistani drama episode guide. Created 2026-10-25: the page shipped
   referencing this script but the file was never committed, so the hub
   stayed on "Loading FlickAtlas…". Data comes from pk-dramas.js
   (window.PK.pool — current HUM/ARY/Geo/Green dramas with channel plus
   latest/next episode), with EpisodeBrowser.fetchRows("PK") as a
   lightweight fallback. Site rule: exactly ONE featured guide
   (slice(0,1)) — never a grid of many. */
(async function () {
  UI.mountChrome("/episode-guides");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Episode Guides — Pakistani Dramas | FlickAtlas",
    desc: "Episode guides on FlickAtlas: the featured Pakistani drama guide — latest episode, air date, channel and full season breakdown.",
    path: "/episode-guides"
  });

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Episode Guides</h1>
      <p>Pakistani dramas — the featured guide, with the latest episode and channel.</p></div>
    <p class="fcount" id="fcount" aria-live="polite">Loading the featured guide…</p>
    <div id="guideHost"><div class="sk" style="height:280px;border-radius:22px"></div></div>
  </div>`;
  const fcount = main.querySelector("#fcount");
  const host = main.querySelector("#guideHost");

  function epHref(showId, ep) {
    if (window.PK && typeof window.PK.epHref === "function") return window.PK.epHref(showId, ep);
    return `/show?id=${showId}&season=${ep.season_number}&ep=${ep.episode_number}`;
  }

  function epCard(showId, ep, label) {
    if (!ep) return "";
    const still = ep.still_path ? UI.img(ep.still_path, "w300") : "";
    return `<div class="content-card"><h2>${UI.esc(label)}</h2>
      ${still ? `<p><img src="${still}" alt="" loading="lazy" style="max-width:100%;border-radius:12px" onerror="this.remove()"></p>` : ""}
      <dl class="facts-table">
        <div class="fact-row"><dt>Episode</dt><dd>Season ${ep.season_number} · Episode ${ep.episode_number}${ep.name ? ` — ${UI.esc(ep.name)}` : ""}</dd></div>
        ${ep.air_date ? `<div class="fact-row"><dt>Air Date</dt><dd>${UI.esc(UI.fmtDate(ep.air_date))}</dd></div>` : ""}
      </dl>
      ${ep.overview ? `<p class="article-summary">${UI.esc(ep.overview)}</p>` : ""}
      <p><a class="btn btn-teal" href="${epHref(showId, ep)}">Open episode →</a></p></div>`;
  }

  function renderGuide(g) {
    const d = g.details || g.show || g.item;
    if (!d || !d.id) throw new Error("no guide");
    const title = UI.titleOf(d);
    const poster = UI.img(d.poster_path, "w342");
    const backdrop = UI.img(d.backdrop_path, "w1280");
    const rating = UI.ratingText(d);
    const channel = g.channel || "";
    const showHref = `/show?id=${d.id}`;
    const lastEp = g.lastEp || g.ep || null;
    const nextEp = g.nextEp || null;

    const heroFacts = [];
    if (channel) heroFacts.push(`<div><span>Channel</span><b>${UI.esc(channel)}</b></div>`);
    if (rating) heroFacts.push(`<div><span>Rating</span><b>${UI.esc(rating)}</b></div>`);
    if (d.number_of_seasons) heroFacts.push(`<div><span>Seasons</span><b>${d.number_of_seasons}</b></div>`);
    if (d.number_of_episodes) heroFacts.push(`<div><span>Episodes</span><b>${d.number_of_episodes}</b></div>`);
    if (d.status) heroFacts.push(`<div><span>Status</span><b>${UI.esc(d.status)}</b></div>`);
    if (g.lastAir) heroFacts.push(`<div><span>Last Aired</span><b>${UI.esc(UI.fmtDate(g.lastAir))}</b></div>`);

    host.innerHTML = `
    <section class="detail-hero">
      ${backdrop ? `<div class="hero-bg"><img src="${backdrop}" alt="" loading="lazy" decoding="async"></div>` : ""}
      <div class="hero-shade"></div>
      <div class="detail-in">
        ${poster ? `<div class="detail-poster"><img src="${poster}" alt="${UI.esc(title)} poster" loading="lazy" decoding="async" onerror="this.remove()"></div>` : ""}
        <div class="detail-main">
          <h1><a href="${showHref}" style="color:inherit">${UI.esc(title)}</a></h1>
          ${d.overview ? `<p class="detail-sub">${UI.esc(d.overview.slice(0, 160))}</p>` : ""}
          ${heroFacts.length ? `<div class="detail-facts">${heroFacts.join("")}</div>` : ""}
        </div>
      </div>
    </section>
    ${epCard(d.id, lastEp, "Latest Episode")}
    ${epCard(d.id, nextEp, "Next Episode")}
    <p style="text-align:center"><a class="btn btn-teal" href="${showHref}">Open full guide →</a></p>`;
    fcount.textContent = "1 featured guide";
  }

  try {
    let guide = null;
    if (window.PK && typeof window.PK.pool === "function") {
      const pool = await window.PK.pool();
      const first = (pool || []).slice(0, 1)[0];
      if (first) guide = first;
    }
    if (!guide && window.EpisodeBrowser && typeof window.EpisodeBrowser.fetchRows === "function") {
      const rows = await window.EpisodeBrowser.fetchRows("PK", 1, { mode: "latest" });
      const row = (rows || []).slice(0, 1)[0];
      if (row) {
        guide = {
          details: row.show, show: row.show,
          channel: (row.show.networks || []).map(n => n.name).filter(Boolean).join(", "),
          lastEp: row.ep, nextEp: null, lastAir: row.ep ? row.ep.air_date : "",
        };
      }
    }
    if (!guide) throw new Error("no guide");
    renderGuide(guide);
  } catch (e) {
    fcount.textContent = "Episode guides could not be loaded.";
    host.innerHTML = UI.stateMsg("Could not load episode guides. Please try again.");
  }
})();
