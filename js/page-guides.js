/* FlickAtlas — Episode Guides hub (/episode-guides): the episode list.
   Pakistani dramas — every episode post, newest first. Episodes come
   from the YouTube episode tracker (scripts/episode-guides.py): each
   new episode gets an info post the same day, and the top episodes by
   views get an AI story summary added gradually. This page lists the
   EPISODES directly — no drama cards, no seasons (Pakistani dramas
   have no seasons; seasons are an OTT thing). Each episode links to
   its own detail page (/news-item?id=<article_id>).
   Identification: primary = /out/episodes.json (the tracker's state
   file — drama, episode, channel, views, article_id, summary, all
   structured); fallback = FA_ARTICLES headline pattern
   "<Drama> Episode <N> — Watch on <channel>". */
(async function () {
  UI.mountChrome("/episode-guides");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Episode Guides — Pakistani Dramas | FlickAtlas",
    desc: "Latest Pakistani drama episodes on FlickAtlas — episode number, air date, channel, views and story summary, newest first.",
    path: "/episode-guides"
  });

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Episode Guides</h1>
      <p>Pakistani dramas — every new episode, newest first, with its story summary when one is ready.</p></div>
    <p class="fcount" id="fcount" aria-live="polite">Loading episodes…</p>
    <div id="guideHost"><div class="sk" style="height:280px;border-radius:22px"></div></div>
  </div>`;
  const fcount = main.querySelector("#fcount");
  const host = main.querySelector("#guideHost");

  const fmtViews = (n) => (typeof n === "number" && n > 0) ? n.toLocaleString("en-US") : "";
  const trunc = (s, n) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    if (t.length <= n) return t;
    return t.slice(0, n).replace(/\s+\S*$/, "") + "…";
  };

  /* One episode card: drama + episode, air date, channel, views,
     story summary when one exists, and a link to the episode's own
     detail page. No seasons — Pakistani dramas have none. */
  function epCard(e) {
    const epLabel = (e.isFinale && !e.episode) ? "Final Episode"
      : `Episode ${e.episode}${e.isFinale ? " (Finale)" : ""}`;
    const title = `${e.drama} — ${epLabel}`;
    const air = e.published ? UI.fmtDate(e.published) : "";
    const views = fmtViews(e.views);
    const sum = trunc(e.summary, 280);
    const href = `/news-item?id=${encodeURIComponent(e.articleId)}`;
    return `<div class="content-card"><div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start">
      ${e.thumb ? `<a href="${href}"><img src="${UI.esc(e.thumb)}" alt="" loading="lazy" style="width:140px;border-radius:12px" onerror="this.remove()"></a>` : ""}
      <div style="flex:1;min-width:200px">
        <h2 style="margin-top:0"><a href="${href}">${UI.esc(title)}</a></h2>
        <dl class="facts-table">
          ${air ? `<div class="fact-row"><dt>Air Date</dt><dd>${UI.esc(air)}</dd></div>` : ""}
          ${e.channel ? `<div class="fact-row"><dt>Channel</dt><dd>${UI.esc(e.channel)}</dd></div>` : ""}
          ${views ? `<div class="fact-row"><dt>Views</dt><dd>${UI.esc(views)}</dd></div>` : ""}
        </dl>
        ${sum ? `<p class="article-summary">${UI.esc(sum)}</p>` : ""}
        <p><a class="btn btn-teal" href="${href}">Open episode →</a></p>
      </div></div></div>`;
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
    fcount.textContent = `${eps.length} episode${eps.length === 1 ? "" : "s"}`;
    host.innerHTML = eps.map(epCard).join("");
  } catch (e) {
    fcount.textContent = "Episode guides could not be loaded.";
    host.innerHTML = UI.stateMsg("Could not load episode guides. Please try again.");
  }
})();
