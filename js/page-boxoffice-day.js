/* FlickAtlas — Per-day box office page (/box-office-day?title=<tmdb_id>&day=<n>):
   that day's collection, the running total up to that day, and the full
   day-wise table. Created 2026-10-25: the page shipped referencing this
   script but the file was never committed, so every per-day page stayed
   on "Loading FlickAtlas…". Money always goes through UI.fmtMoney*
   (USD data, auto-converts on currency change); no watch/download
   buttons, no external links except back to the movie / box office hub. */
(async function () {
  UI.mountChrome("/box-office-day");
  const main = document.getElementById("app");
  const titleId = UI.getParam("title", "");
  const dayParam = UI.getParam("day", "");
  const day = /^\d+$/.test(dayParam) ? parseInt(dayParam, 10) : 0;
  if (!titleId || !/^\d+$/.test(titleId) || !day) {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("No collection record for this day.", false)}
      <p style="text-align:center"><a class="btn btn-teal" href="/box-office">Box Office</a></p></div>`;
    UI.setSEO({ title: "Day-Wise Box Office Collection | FlickAtlas", desc: "One day of a film's box office story on FlickAtlas: that day's collection, the running total and the full day-wise table.", path: "/box-office-day", noindex: true });
    return;
  }
  UI.setSEO({
    title: "Day-Wise Box Office Collection | FlickAtlas",
    desc: "One day of a film's box office story on FlickAtlas: that day's collection, the running total and the full day-wise table.",
    path: `/box-office-day?title=${encodeURIComponent(titleId)}&day=${day}`
  });
  main.innerHTML = `<div class="wrap"><div class="sk" style="height:280px;border-radius:22px;margin-top:22px"></div><div class="sk" style="height:180px;border-radius:14px;margin-top:18px"></div></div>`;

  try {
    const d = await TMDB.details("movie", titleId);
    if (!d || !d.title) throw new Error("TMDB_HTTP_404");
    const title = UI.titleOf(d);

    /* Bollywood context (day-wise tables validate rows the Bollywood way). */
    const countries = d.origin_country || (d.production_countries || []).map(c => c.iso_3166_1);
    if (d.original_language === "hi" && countries.includes("IN")) UI.setIndustryContext("bollywood");

    const rows = (window.FA_DAYWISE || {})[String(titleId)] || [];
    const valid = rows.filter(r => r && /^\d{4}-\d{2}-\d{2}$/.test(r.date || "") && typeof r.collection === "number" && Number.isFinite(r.collection) && r.collection >= 0);
    const seen = new Set();
    const clean = valid
      .map((r, i) => ({ ...r, _n: UI.dayNumOf(r, i) }))
      .filter(r => { if (seen.has(r._n)) return false; seen.add(r._n); return true; })
      .sort((a, b) => a._n - b._n);
    const row = clean.find(r => r._n === day);

    if (!row) {
      main.innerHTML = `<div class="wrap">${UI.stateMsg("No collection record for this day.", false)}
        <p style="text-align:center"><a class="btn btn-teal" href="/movie?id=${encodeURIComponent(titleId)}">${UI.esc(title)}</a> <a class="btn" href="/box-office">Box Office</a></p></div>`;
      UI.setSEO({ title: `${title} — Day ${day} Box Office | FlickAtlas`, desc: `Day ${day} box office collection for ${title} on FlickAtlas.`, path: `/box-office-day?title=${encodeURIComponent(titleId)}&day=${day}` });
      return;
    }

    const running = clean.filter(r => r._n <= day).reduce((s, r) => s + r.collection, 0);
    const poster = UI.img(d.poster_path, "w342");

    main.innerHTML = `<div class="wrap">
    <p class="article-crumb"><a href="/movie?id=${encodeURIComponent(titleId)}">← ${UI.esc(title)}</a> · <a href="/box-office">Box Office</a></p>
    <section class="detail-hero">
      <div class="detail-in">
        ${poster ? `<div class="detail-poster"><img src="${poster}" alt="${UI.esc(title)} poster" loading="lazy" decoding="async" onerror="this.remove()"></div>` : ""}
        <div class="detail-main">
          <h1>${UI.esc(title)}</h1>
          <p class="detail-sub">Day ${day} · ${UI.esc(UI.fmtDate(row.date))}</p>
        </div>
      </div>
    </section>
    <div class="content-card"><h2>Day ${day} Collection</h2>
      <div class="bo-verdict-card"><div class="bo-nums">
        <div><span>Day ${day} (${UI.esc(UI.fmtDate(row.date))})</span><b>${UI.fmtMoney(row.collection)}</b></div>
        <div><span>Running Total (Day 1–${day})</span><b>${UI.fmtMoney(running)}</b></div>
      </div></div>
      <p class="prov-note">That day's reported collection and the running sum of the recorded days so far; missing days are excluded, not counted as zero.</p></div>
    ${UI.dailyCollectionCard(clean, String(titleId))}
  </div>`;

    UI.setSEO({
      title: `${title} — Day ${day} Box Office (${UI.fmtDate(row.date)}) | FlickAtlas`,
      desc: `Day ${day} box office collection for ${title} on ${UI.fmtDate(row.date)}, with the running total and the full day-wise table on FlickAtlas.`,
      path: `/box-office-day?title=${encodeURIComponent(titleId)}&day=${day}`,
      image: poster || ""
    });
  } catch (e) {
    const is404 = /404/.test(String((e && e.message) || e || ""));
    main.innerHTML = `<div class="wrap">${UI.stateMsg(is404 ? "Movie not found." : "Could not load this day's collection. Please try again.", !is404)}</div>`;
  }
})();
