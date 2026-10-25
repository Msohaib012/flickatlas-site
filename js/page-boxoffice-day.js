/* FlickAtlas — Per-day box office page (/box-office-day?title=<tmdb_id>&day=<n>):
   that day's collection, the running total up to that day, and the full
   day-wise table. `day` defaults to the latest recorded day when it is
   missing/invalid, and `id` is accepted as an alias for `title` (so
   /box-office-day?id=<tmdb_id> shows the latest day instead of an empty
   page). Created 2026-10-25: the page shipped referencing this
   script but the file was never committed, so every per-day page stayed
   on "Loading FlickAtlas…". Money always goes through UI.fmtMoney*
   (USD data, auto-converts on currency change); no watch/download
   buttons, no external links except back to the movie / box office hub.
   PUBLISHED-ONLY (audit fix, 2026-10-25): the title used to come from
   LIVE TMDB (TMDB.details) — the live catalogue. It now comes from
   window.FA_PUBLISHED only; an unpublished title shows an honest
   "hasn't been published yet" state instead of a dead page. Industry
   context comes from the published entry (the old code set it only when
   the URL said so, and "international" otherwise). */
(async function () {
  UI.mountChrome("/box-office-day");
  const main = document.getElementById("app");
  const titleId = UI.getParam("title", "") || UI.getParam("id", "");
  const dayParam = UI.getParam("day", "");
  let day = /^\d+$/.test(dayParam) ? parseInt(dayParam, 10) : 0;
  if (!titleId || !/^\d+$/.test(titleId)) {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("No film was specified for this day-wise page.", false)}
      <p style="text-align:center"><a class="btn btn-teal" href="/box-office">Box Office</a></p></div>`;
    UI.setSEO({ title: "Day-Wise Box Office Collection | FlickAtlas", desc: "One day of a film's box office story on FlickAtlas: that day's collection, the running total and the full day-wise table.", path: "/box-office-day", noindex: true });
    return;
  }
  UI.setSEO({
    title: "Day-Wise Box Office Collection | FlickAtlas",
    desc: "One day of a film's box office story on FlickAtlas: that day's collection, the running total and the full day-wise table.",
    path: day ? `/box-office-day?title=${encodeURIComponent(titleId)}&day=${day}` : `/box-office-day?title=${encodeURIComponent(titleId)}`
  });
  main.innerHTML = `<div class="wrap"><div class="sk" style="height:280px;border-radius:22px;margin-top:22px"></div><div class="sk" style="height:180px;border-radius:14px;margin-top:18px"></div></div>`;

  /* Published-only lookup — no live TMDB. */
  const d = (window.FA_PUBLISHED || {})[String(titleId)] || null;
  if (!d || !d.title) {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("This film hasn't been published on FlickAtlas yet, so no day-wise collection record is available for it. Only published titles have day-wise pages.", false)}
      <p style="text-align:center"><a class="btn btn-teal" href="/box-office">Box Office</a> <a class="btn" href="/search">Search published titles</a></p></div>`;
    UI.setSEO({ title: "Day-Wise Box Office Collection | FlickAtlas", desc: "Day-wise reported box office collections on FlickAtlas.", path: "/box-office-day", noindex: true });
    return;
  }
  const title = UI.titleOf(d);

  /* Industry context from the published entry, so the day-wise table and
     currency behave the same as on the movie page. */
  if (d.industry === "bollywood") UI.setIndustryContext("bollywood");
  else UI.setIndustryContext("international");

  const rows = (window.FA_DAYWISE || {})[String(titleId)] || [];
  const valid = rows.filter(r => r && /^\d{4}-\d{2}-\d{2}$/.test(r.date || "") && typeof r.collection === "number" && Number.isFinite(r.collection) && r.collection >= 0);
  const seen = new Set();
  const clean = valid
    .map((r, i) => ({ ...r, _n: UI.dayNumOf(r, i) }))
    .filter(r => { if (seen.has(r._n)) return false; seen.add(r._n); return true; })
    .sort((a, b) => a._n - b._n);
  /* No (valid) day given — show the latest recorded day instead of an empty page. */
  if (!day) day = clean.length ? clean[clean.length - 1]._n : 0;
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
})();
