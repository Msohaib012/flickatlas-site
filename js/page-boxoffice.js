/* FlickAtlas — Box Office hub (user order 2026-10-26): a plain listing of
   the SAME cards as the homepage Box Office section — one card per
   recently-released published MOVIE, newest first (release date DESC).
   A title qualifies if it is released and (has real day-wise rows in
   FA_DAYWISE OR is fresh); titles with no rows yet show an honest "not
   yet recorded" state — they are NOT dropped. Each card links to
   /movie?id=<id>, where the full day-wise detail lives. No period
   pills, no ranking charts, no verdict/club filters — the old dashboard
   confused readers. The industry nav (All / Bollywood / World Cinema)
   remains, as a simple filter on the same cards list — same filter
   values as the Movies page (?f=bollywood, ?f=international).
   Lollywood was removed from this page (user order 2026-10-26);
   Pakistani titles show under All only. Bollywood means ALL Indian
   movies — Hindi, Tamil, Telugu and every other Indian-language film
   (industry "bollywood" OR origin_country includes "IN"). */
(async function () {
  UI.mountChrome("/box-office");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Box Office — Latest Movies, Today & 7 Days | FlickAtlas",
    desc: "Latest released movies with today's reported collections, seven-day reported sums and recorded totals. Tap a movie for its full day-wise box office detail.",
    path: "/box-office"
  });

  const today = new Date().toISOString().slice(0, 10);
  const dw = window.FA_DAYWISE || {};

  /* Card markup — copied verbatim from the homepage Box Office section
     (js/page-index.js boCardHtml), so a title looks identical here and
     on the homepage. Today / 7-day sums come only from the reported
     rows; "Recorded" is the sum of the tracked days. */
  const boCardHtml = (entry, rows) => {
    const clean = (rows || []).filter(r => r && r.date && typeof r.collection === "number");
    const weekStart = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
    const todayRows = clean.filter(r => r.date === today);
    const weekRows = clean.filter(r => r.date >= weekStart && r.date <= today);
    const todaySum = todayRows.reduce((s, r) => s + r.collection, 0);
    const weekSum = weekRows.reduce((s, r) => s + r.collection, 0);
    const weekDays = new Set(weekRows.map(r => r.date)).size;
    const totalSum = clean.reduce((s, r) => s + r.collection, 0);
    const date = entry.release_date || "";
    const missing = '<span class="fa-box-unavailable">Not reported</span>';
    const poster = `<span class="fa-box-poster${entry.poster_path ? "" : " is-missing"}" role="img" aria-label="${entry.poster_path ? UI.esc(UI.titleOf(entry)) + " poster" : "Poster unavailable"}">${entry.poster_path ? `<img src="${UI.img(entry.poster_path, "w92")}" alt="" loading="lazy" onerror="this.parentElement.classList.add('is-missing');this.parentElement.setAttribute('aria-label','Poster unavailable');this.remove()">` : ""}<span aria-hidden="true">No poster</span></span>`;
    return `<a class="fa-box-latest-card" data-movie-id="${UI.esc(entry.id)}" data-release="${UI.esc(date)}" href="/movie?id=${entry.id}" aria-label="${UI.esc(UI.titleOf(entry))} — box office details"><div class="fa-box-card-head">${poster}<div class="fa-box-card-labels"><span class="fa-box-latest-title" title="${UI.esc(UI.titleOf(entry))}">${UI.esc(UI.titleOf(entry))}</span><p class="fa-box-latest-meta">Released ${UI.esc(UI.fmtDate(date))}</p></div><span class="fa-box-card-arrow" aria-hidden="true">›</span></div><dl aria-label="Reported box office summary"><div title="Today's reported collection · ${UI.esc(today)} UTC"><dt>Today</dt><dd>${todayRows.length ? UI.fmtMoney(todaySum) : missing}</dd></div><div title="${UI.esc(weekDays ? weekDays + " of 7 days reported" : "No daily records reported for this period")} · ${UI.esc(weekStart)} to ${UI.esc(today)} UTC"><dt>7 Days</dt><dd>${weekRows.length ? `${UI.fmtMoney(weekSum)}${weekDays < 7 ? `<abbr class="fa-box-partial" title="${UI.esc(weekDays + " of 7 days reported · partial")}">${weekDays}/7</abbr>` : ""}` : missing}</dd></div><div title="Sum of the reported day-wise collections tracked by FlickAtlas"><dt>Recorded (India Net)</dt><dd>${clean.length ? UI.fmtMoney(totalSum) : missing}</dd></div></dl></a>`;
  };

  /* Industry filter (?f=): bollywood = ALL Indian movies (industry
     "bollywood" OR origin_country includes "IN" — Hindi, Tamil, Telugu
     and every other Indian-language film); international = World Cinema
     (industry "world", non-Indian, non-Pakistani); anything else shows
     all industries. Lollywood was removed (user order 2026-10-26), so
     ?f=lollywood falls back to All and Pakistani titles show under
     All only. */
  let f = UI.getParam("f", "all");
  if (!["bollywood", "international"].includes(f)) f = "all";
  const isIndian = (x) => (x.origin_country || []).includes("IN");
  /* Bollywood and World Cinema are mutually exclusive: an Indian film
     (Tamil/Telugu/Hindi/...) belongs in Bollywood even when the seeder
     filed it under industry "world", so World Cinema excludes Indian
     titles too. */
  const inFilter = (x) => f === "all" ? true
    : f === "bollywood" ? (x.industry === "bollywood" || isIndian(x))
    : (x.industry === "world" && !isIndian(x));

  /* Every recently-released published MOVIE, newest first (release date
     DESC) — the same pool and order the homepage Box Office section
     uses. A title qualifies if it is released and (has day-wise rows OR
     is fresh); titles with no rows yet are included with an honest
     "not yet recorded" state. No cap — this page IS the See All. */
  const hasRows = (x) => { const r = dw[String(x.id)]; return Array.isArray(r) && r.length > 0; };
  const picks = Object.values(window.FA_PUBLISHED || {})
    .filter(x => x && x.type === "movie" && x.poster_path && x.release_date && x.release_date <= today && (hasRows(x) || UI.isFresh(x)))
    .sort((a, b) => (b.release_date || "").localeCompare(a.release_date || ""))
    .filter(x => inFilter(x))
    .map(entry => ({ entry, rows: dw[String(entry.id)] || [] }));

  main.innerHTML = `<div class="wrap bo-dashboard">
    <header class="page-hero bo-intro"><p class="bo-key">Dated collections and reported grosses</p><h1>Box Office</h1>
      <p>Box office collections of the latest released movies — today's reported collection, the last 7 days and the recorded total. Tap a movie for its full day-wise detail.</p>
      <p><a href="/box-office/milestones">Box Office Milestones — 1000 Crore Club &amp; top collections →</a></p></header>
    <nav class="bo-scope" aria-label="Box office industry"><a class="chip${f === "all" ? " on" : ""}" href="/box-office"${f === "all" ? ' aria-current="page"' : ""}>All industries</a><a class="chip${f === "bollywood" ? " on" : ""}" href="/box-office?f=bollywood"${f === "bollywood" ? ' aria-current="page"' : ""}>Bollywood</a><a class="chip${f === "international" ? " on" : ""}" href="/box-office?f=international"${f === "international" ? ' aria-current="page"' : ""}>World Cinema</a></nav>
    <section class="section" data-sec="box-office">${picks.length ? picks.map(p => boCardHtml(p.entry, p.rows)).join("") : `<p style="color:var(--muted)">No box office data available yet.</p>`}</section>
    ${UI.rateNote()}
  </div>`;
})();





