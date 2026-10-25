/* FlickAtlas — Episode Guides hub (/episode-guides): the single featured
   Pakistani drama episode guide. Created 2026-10-25: the page shipped
   referencing this script but the file was never committed, so the hub
   stayed on "Loading FlickAtlas…" forever. Rewritten in the full bug
   sweep (2026-10-25): the guide now features a PUBLISHED drama only —
   the old version picked the first drama from the live PK discover
   pool, which could be (and usually was) an unpublished title. The
   latest/next episode comes from one single-title TMDB details call
   for that published drama (the same per-title shape as the credits
   call on detail pages). Site rule: exactly ONE featured guide
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
    return `/show?id=${showId}`;
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

  function renderGuide(pub, details) {
    const d = details || pub;
    const title = UI.titleOf(pub);
    const poster = UI.img(pub.poster_path, "w342");
    const backdrop = UI.img(pub.backdrop_path, "w1280");
    const rating = UI.ratingText(pub);
    const channel = (window.PK && details && typeof window.PK.channelOf === "function" && window.PK.channelOf(details)) || pub.channel || "";
    const showHref = `/show?id=${pub.id}`;
    const lastEp = (details && details.last_episode_to_air) || null;
    const nextEp = (details && details.next_episode_to_air) || null;
    const lastAir = (lastEp && lastEp.air_date) || (details && details.last_air_date) || "";

    const heroFacts = [];
    if (channel) heroFacts.push(`<div><span>Channel</span><b>${UI.esc(channel)}</b></div>`);
    if (rating) heroFacts.push(`<div><span>Rating</span><b>${UI.esc(rating)}</b></div>`);
    if (pub.number_of_seasons || (details && details.number_of_seasons)) heroFacts.push(`<div><span>Seasons</span><b>${pub.number_of_seasons || details.number_of_seasons}</b></div>`);
    if (pub.number_of_episodes || (details && details.number_of_episodes)) heroFacts.push(`<div><span>Episodes</span><b>${pub.number_of_episodes || details.number_of_episodes}</b></div>`);
    if (pub.status || (details && details.status)) heroFacts.push(`<div><span>Status</span><b>${UI.esc(pub.status || details.status)}</b></div>`);
    if (lastAir) heroFacts.push(`<div><span>Last Aired</span><b>${UI.esc(UI.fmtDate(lastAir))}</b></div>`);

    host.innerHTML = `
    <section class="detail-hero">
      ${backdrop ? `<div class="hero-bg"><img src="${backdrop}" alt="" loading="lazy" decoding="async"></div>` : ""}
      <div class="hero-shade"></div>
      <div class="detail-in">
        ${poster ? `<div class="detail-poster"><img src="${poster}" alt="${UI.esc(title)} poster" loading="lazy" decoding="async" onerror="this.remove()"></div>` : ""}
        <div class="detail-main">
          <h1><a href="${showHref}" style="color:inherit">${UI.esc(title)}</a></h1>
          ${pub.overview ? `<p class="detail-sub">${UI.esc(pub.overview.slice(0, 160))}</p>` : ""}
          ${heroFacts.length ? `<div class="detail-facts">${heroFacts.join("")}</div>` : ""}
        </div>
      </div>
    </section>
    ${epCard(pub.id, lastEp, "Latest Episode")}
    ${epCard(pub.id, nextEp, "Next Episode")}
    <p style="text-align:center"><a class="btn btn-teal" href="${showHref}">Open full guide →</a></p>`;
    fcount.textContent = "1 featured guide";
  }

  try {
    /* Published TV dramas only — Pakistani first, newest first. The
       guide is one published drama; its latest/next episode comes from
       a single details call for that drama alone. */
    const publishedTv = Object.values(window.FA_PUBLISHED || {})
      .filter(x => x && x.type === "tv" && x.id != null && x.poster_path)
      .sort((a, b) =>
        ((b.industry === "pakistani") - (a.industry === "pakistani")) ||
        String(b.published_at || "").localeCompare(String(a.published_at || "")) ||
        String(b.first_air_date || "").localeCompare(String(a.first_air_date || "")));
    if (!publishedTv.length) {
      fcount.textContent = "No published drama guides yet.";
      host.innerHTML = UI.stateMsg("No Pakistani drama has been published yet, so there is no episode guide to show. Guides appear here once a drama is published.", false);
      return;
    }
    const pub = publishedTv[0];
    let details = null;
    try { details = await TMDB.details("tv", pub.id); } catch (_) { details = null; }
    renderGuide(pub, details);
  } catch (e) {
    fcount.textContent = "Episode guides could not be loaded.";
    host.innerHTML = UI.stateMsg("Could not load episode guides. Please try again.");
  }
})();
