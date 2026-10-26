/* FlickAtlas — Episode Guides hub (/episode-guides): the episode LIST.
   Drama episodes — every episode post, newest first, as a LIST (user
   order 2026-10-26): one row per episode, homepage .ep-row style
   (thumbnail LEFT + title/date RIGHT, same as the homepage Drama
   Episodes rail), NOT poster cards and NOT the old date-block rows.
   A drama filter (a DOWNWARD <select> dropdown, page-tv.js pattern)
   at the top narrows the list to one drama. Each row links to its own
   detail page (/news-item?id=<article_id>). Episodes come from the
   YouTube episode tracker (scripts/episode-guides.py): each new episode
   gets an info post the same day, and the top episodes by views get an
   AI story summary added gradually.
   PAKISTANI DRAMAS ONLY (user order 2026-10-26): an episode appears
   here only when its drama is on the site's published Pakistani TV
   list (window.FA_PUBLISHED, type tv + industry pakistani). Tracker
   aliases: "Dar" = "Dar-E-Nijaat", "Zehar" = "Zehar-e-Mohabbat".
   Anything else (Bulbulay Season 2, an interview, an unlisted drama)
   is excluded from this list.
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
    <div id="chipHost"></div>
    <div id="guideHost"><div class="sk" style="height:280px;border-radius:22px"></div></div>
  </div>`;
  const fcount = main.querySelector("#fcount");
  const filterHost = main.querySelector("#chipHost");
  const host = main.querySelector("#guideHost");

  /* --- Pakistani Dramas only (user order 2026-10-26) -----------------
     The published list is window.FA_PUBLISHED (loaded on this page
     before this script). FALLBACK_PK_DRAMAS is the user-confirmed list
     of the 13 dramas, used only if that data file fails to load, so
     the filter never silently empties the page. */
  const DRAMA_ALIASES = { "dar": "Dar-E-Nijaat", "zehar": "Zehar-e-Mohabbat" };
  const FALLBACK_PK_DRAMAS = ["Aangan", "Bano", "Circle Story", "Dar-E-Nijaat",
    "Dastoor", "Izzat", "Khushi", "Mitti De Baway", "Mohabbat Mukhtasir",
    "Nashtar", "Rutba", "Uswah", "Zehar-e-Mohabbat"];
  const normName = (s) => String(s || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  function pkDramaMap() {
    const map = new Map();
    const pub = window.FA_PUBLISHED || {};
    for (const t of Object.values(pub)) {
      if (!t || t.type !== "tv" || (t.industry || "") !== "pakistani") continue;
      const name = String(t.title || "").trim();
      if (name) map.set(normName(name), name);
    }
    if (!map.size) for (const n of FALLBACK_PK_DRAMAS) map.set(normName(n), n);
    return map;
  }
  /* Canonical published drama name for a tracker/article drama name,
     or null when it is NOT a listed Pakistani drama (excluded). */
  function canonicalDrama(name, pkMap) {
    const n = normName(name);
    if (!n) return null;
    if (DRAMA_ALIASES[n]) {
      const target = DRAMA_ALIASES[n];
      return pkMap.has(normName(target)) ? target : null;
    }
    return pkMap.has(n) ? pkMap.get(n) : null;
  }
  const PK_MAP = pkDramaMap();

  /* One episode ROW — homepage Drama Episodes style (.ep-row):
     thumbnail LEFT + title/date RIGHT, side by side. Links to the
     episode's own detail page. The title is the episode headline
     ("<Drama> Episode <N> — Watch on <channel>"), exactly as the
     homepage rail shows it. */
  function epRow(e) {
    const epLabel = (e.isFinale && !e.episode) ? "Final Episode"
      : `Episode ${e.episode}${e.isFinale ? " (Finale)" : ""}`;
    const title = `${e.drama} ${epLabel} — Watch on ${e.channel}`;
    const href = `/news-item?id=${encodeURIComponent(e.articleId)}`;
    const air = e.published ? UI.fmtDate(e.published) : "";
    const meta = [air, e.channel].filter(Boolean).join(" · ");
    const thumb = e.thumb || "";
    return `<a class="ep-row" href="${href}">
      <span class="ep-thumb">${thumb ? `<img src="${UI.esc(thumb)}" alt="${UI.esc(title)}" loading="lazy" decoding="async" onerror="this.remove()">` : `<span class="noimg"><span>EP</span></span>`}</span>
      <span class="ep-info"><b>${UI.esc(title)}</b><span>${UI.esc(meta)}</span></span>
    </a>`;
  }

  /* Primary: /out/episodes.json — the tracker's state file. Each
     record carries drama, episode, channel, views, article_id and the
     summary; the thumbnail comes from the matching FA_ARTICLES entry
     (falling back to the YouTube thumbnail for the video id). Only
     listed Pakistani dramas survive (canonicalDrama). */
  async function episodesFromState() {
    try {
      const res = await fetch("/out/episodes.json", { cache: "no-store" });
      if (!res.ok) return null;
      const data = await res.json();
      const recs = Object.values((data && data.episodes) || {});
      if (!recs.length) return null;
      const arts = window.FA_ARTICLES || {};
      return recs.map(r => {
        const drama = canonicalDrama(r.drama || "", PK_MAP);
        if (!drama) return null;
        const a = arts[r.article_id] || null;
        const thumb = (a && a.images && a.images[0] && a.images[0].url)
          || (r.video_id ? `https://i.ytimg.com/vi/${r.video_id}/hqdefault.jpg` : "");
        return {
          drama, episode: r.episode, isFinale: !!r.is_finale,
          channel: r.channel || "", published: r.published || "",
          views: r.views || 0, summary: r.summary || "",
          articleId: r.article_id || "", thumb
        };
      }).filter(e => e && e.articleId && e.drama && e.episode != null);
    } catch (_) { return null; }
  }

  /* Fallback: FA_ARTICLES headline pattern
     "<Drama> Episode <N> — Watch on <channel>" (and the "<Drama> -
     Last Episode" finale form). Views come from the article facts,
     the summary from the "Story Summary" body section. Only listed
     Pakistani dramas survive (canonicalDrama). */
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
      const rawDrama = (a.entities && a.entities.titles && a.entities.titles[0]) || (em ? em[1].trim() : fm[1].trim());
      const drama = canonicalDrama(rawDrama, PK_MAP);
      if (!drama) continue;
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
    /* Drama filter (user order 2026-10-26): a DOWNWARD <select>
       dropdown (page-tv.js pattern — same .listing-select-row /
       .filter-select / select.fsel markup and #chipHost styling),
       NOT buttons and NOT a popup. Options are the listed Pakistani
       dramas that have episodes, sorted; "All Dramas" is default. */
    let activeDrama = "";
    const dramas = [...new Set(eps.map(e => e.drama))].sort((a, b) => a.localeCompare(b));
    const renderList = () => {
      const list = activeDrama ? eps.filter(e => e.drama === activeDrama) : eps;
      fcount.textContent = `${list.length} episode${list.length === 1 ? "" : "s"}${activeDrama ? ` · ${activeDrama}` : ""}`;
      host.innerHTML = list.length
        ? `<div class="tl-list">${list.map(epRow).join("")}</div>`
        : UI.stateMsg("No episodes for this drama yet.", false);
    };
    filterHost.innerHTML = `<div class="listing-select-row listing-select-row--single"><label class="filter-select"><span>Drama</span><select class="fsel" id="dramaSel" aria-label="Filter by drama"><option value="">All Dramas</option>${dramas.map(d => `<option value="${UI.esc(d)}">${UI.esc(d)}</option>`).join("")}</select></label></div>`;
    const sel = filterHost.querySelector("#dramaSel");
    sel.addEventListener("change", () => {
      activeDrama = sel.value;
      renderList();
    });
    renderList();
  } catch (e) {
    fcount.textContent = "Episode guides could not be loaded.";
    host.innerHTML = UI.stateMsg("Could not load episode guides. Please try again.");
  }
})();
