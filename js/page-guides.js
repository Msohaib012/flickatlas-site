/* FlickAtlas — Episode Guides hub (/episode-guides): the episode LIST.
   Drama episodes — every episode post, newest first, as a LIST (user
   order 2026-10-26): one row per episode (episode title + drama name +
   date), NOT poster cards. A drama filter (chips) at the top narrows the
   list to one drama. Each row links to its own detail page
   (/news-item?id=<article_id>). Episodes come from the YouTube episode
   tracker (scripts/episode-guides.py): each new episode gets an info
   post the same day, and the top episodes by views get an AI story
   summary added gradually.
   Identification: primary = /out/episodes.json (the tracker's state
   file — drama, episode, channel, views, article_id, summary, all
   structured); fallback = FA_ARTICLES headline pattern
   "<Drama> Episode <N> — Watch on <channel>". */
(async function () {
  UI.mountChrome("/episode-guides");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Drama Episode Guides — Latest Drama Episodes | FlickAtlas",
    desc: "Latest drama episodes on FlickAtlas — episode number, air date, channel, views and story summary, newest first.",
    path: "/episode-guides"
  });

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Drama — Episode Guides</h1>
      <p>Latest drama episodes from YouTube channels, newest first, with a story summary when one is ready.</p></div>
    <p class="fcount" id="fcount" aria-live="polite">Loading episodes…</p>
    <div id="dramaFilterHost"></div>
    <div id="guideHost"><div class="sk" style="height:280px;border-radius:22px"></div></div>
  </div>`;
  const fcount = main.querySelector("#fcount");
  const filterHost = main.querySelector("#dramaFilterHost");
  const host = main.querySelector("#guideHost");

  const fmtViews = (n) => (typeof n === "number" && n > 0) ? n.toLocaleString("en-US") : "";
  const MONTHS_S = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /* One episode ROW (list layout, user order 2026-10-26): date block +
     title (drama — episode) + meta (air date · channel · views). Links
     to the episode's own detail page. No poster, no summary in the row
     — the summary lives on the episode page. */
  function epRow(e) {
    const epLabel = (e.isFinale && !e.episode) ? "Final Episode"
      : `Episode ${e.episode}${e.isFinale ? " (Finale)" : ""}`;
    const title = `${e.drama} — ${epLabel}`;
    const href = `/news-item?id=${encodeURIComponent(e.articleId)}`;
    const d = (e.published || "").slice(0, 10);
    const parts = d ? d.split("-") : [];
    const dd = parts[2] ? parseInt(parts[2], 10) : null;
    const mm = parts[1] ? parseInt(parts[1], 10) : null;
    const air = e.published ? UI.fmtDate(e.published) : "";
    const views = fmtViews(e.views);
    const meta = [air, e.channel, views ? `${views} views` : ""].filter(Boolean).join(" · ");
    return `<a class="tl-row" href="${href}">
      <span class="tl-date"><b>${dd || "—"}</b><span>${mm ? MONTHS_S[mm - 1] : ""}</span></span>
      <span class="tl-info"><b>${UI.esc(title)}</b><span>${UI.esc(meta)}</span></span>
    </a>`;
  }

  /* Primary: /out/episodes.json — the tracker's state file. Each
     record carries drama, episode, channel, views, article_id and the
     summary; the thumbnail comes from the matching FA_ARTICLES entry. */
  async function episodesFromState() {
    try {
      const res = await fetch("/out/episodes.json", { cache: "no-store" });
      if (!res.ok) return null;
      const data = await res.json();
      const recs = Object.values((data && data.episodes) || {});
      if (!recs.length) return null;
      const arts = window.FA_ARTICLES || {};
      return recs.map(r => {
        const a = arts[r.article_id] || null;
        const thumb = (a && a.images && a.images[0] && a.images[0].url) || "";
        return {
          drama: r.drama || "", episode: r.episode, isFinale: !!r.is_finale,
          channel: r.channel || "", published: r.published || "",
          views: r.views || 0, summary: r.summary || "",
          articleId: r.article_id || "", thumb
        };
      }).filter(e => e.articleId && e.drama && e.episode != null);
    } catch (_) { return null; }
  }

  /* Fallback: FA_ARTICLES headline pattern
     "<Drama> Episode <N> — Watch on <channel>" (and the "<Drama> -
     Last Episode" finale form). Views come from the article facts,
     the summary from the "Story Summary" body section. */
  function episodesFromArticles() {
    const arts = Object.values(window.FA_ARTICLES || {});
    const out = [];
    for (const a of arts) {
      if (!a || a.type !== "news") continue;
      const h = String(a.headline || "");
      const wm = h.match(/^(.*?)\s+[—–-]\s+Watch on\s+(.+)$/i);
      if (!wm) continue;
      const left = wm[1].trim();
      const em = left.match(/^(.+?)\s+Episode\s+(\d+)$/i);
      const fm = !em && left.match(/^(.+?)\s+[—–-]?\s*Last Episode$/i);
      if (!em && !fm) continue;
      const drama = (a.entities && a.entities.titles && a.entities.titles[0]) || (em ? em[1].trim() : fm[1].trim());
      const channel = (a.images && a.images[0] && a.images[0].source) || wm[2].trim();
      const thumb = (a.images && a.images[0] && a.images[0].url) || "";
      let views = 0;
      const vf = (a.facts || []).find(f => /YouTube views:/i.test(String(f)));
      if (vf) { const vm = String(vf).match(/([\d,]+)/); if (vm) views = parseInt(vm[1].replace(/,/g, ""), 10) || 0; }
      let summary = "";
      const ss = (a.body || []).find(s => s && s.h === "Story Summary");
      if (ss && ss.p && ss.p.length) summary = ss.p.join("\n\n");
      out.push({
        drama, episode: em ? parseInt(em[2], 10) : 0, isFinale: !!fm,
        channel, published: a.published || "", views, summary,
        articleId: a.id || "", thumb
      });
    }
    return out.filter(e => e.articleId && e.drama);
  }

  try {
    let eps = await episodesFromState();
    if (!eps || !eps.length) eps = episodesFromArticles();
    eps.sort((a, b) =>
      String(b.published || "").localeCompare(String(a.published || "")) ||
      ((b.episode || 0) - (a.episode || 0)));
    if (!eps.length) {
      fcount.textContent = "No episode guides yet.";
      host.innerHTML = UI.stateMsg("No drama episodes have been published yet. New episodes appear here as they air on YouTube.", false);
      return;
    }
    /* Drama filter (user order 2026-10-26): chips for every drama in
       the list, newest-first order preserved; "All Dramas" is default. */
    let activeDrama = "";
    const dramas = [...new Set(eps.map(e => e.drama))].sort((a, b) => a.localeCompare(b));
    const renderList = () => {
      const list = activeDrama ? eps.filter(e => e.drama === activeDrama) : eps;
      fcount.textContent = `${list.length} episode${list.length === 1 ? "" : "s"}${activeDrama ? ` · ${activeDrama}` : ""}`;
      host.innerHTML = list.length
        ? `<div class="tl-list">${list.map(epRow).join("")}</div>`
        : UI.stateMsg("No episodes for this drama yet.", false);
    };
    if (dramas.length > 1) {
      filterHost.innerHTML = `<nav class="tabs" aria-label="Filter by drama">${["", ...dramas].map(d =>
        `<button type="button" data-drama="${UI.esc(d)}"${d === activeDrama ? ' class="on" aria-current="true"' : ""}>${d ? UI.esc(d) : "All Dramas"}</button>`).join("")}</nav>`;
      filterHost.addEventListener("click", (ev) => {
        const btn = ev.target.closest("button[data-drama]");
        if (!btn) return;
        activeDrama = btn.dataset.drama;
        filterHost.querySelectorAll("button[data-drama]").forEach(b => {
          const on = b.dataset.drama === activeDrama;
          b.classList.toggle("on", on);
          if (on) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
        });
        renderList();
      });
    }
    renderList();
  } catch (e) {
    fcount.textContent = "Episode guides could not be loaded.";
    host.innerHTML = UI.stateMsg("Could not load episode guides. Please try again.");
  }
})();
