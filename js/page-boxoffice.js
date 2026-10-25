/* FlickAtlas — Box Office hub (§5: Sacnilk records/day-wise + Koimoi verdicts
   + Mojo charts): year + all-time charts with §4 filter chips — All · This
   Year · All-Time · Bollywood · Worldwide · Verdicts · Clubs ($100M+ … $1B+).
   PUBLISHED-ONLY (audit fix, 2026-10-25): the old page built its charts from
   LIVE TMDB discover/details — the live catalogue, showing movies that were
   never published. Every figure now comes only from window.FA_PUBLISHED
   (baked budget/revenue) and window.FA_DAYWISE (recorded day-wise rows).
   No TMDB calls anywhere. A title without reported gross is ranked by its
   recorded day-wise sum; a title with neither shows no figure at all.
   Verdicts are estimates and labelled as such. */
(async function () {
  UI.mountChrome("/box-office");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Box Office — Latest Movies, Today, 7 Days & Lifetime | FlickAtlas",
    desc: "Latest released movies with today’s reported collections, seven-day reported sums and lifetime worldwide gross. Bollywood first, with clear industry filters.",
    path: "/box-office"
  });

  const year = new Date().getFullYear();
  const today = new Date().toISOString().slice(0, 10);
  /* Industry tag for cards: "World Cinema" for world-industry titles
     (UI.industryTag now returns "World Cinema" — fixed in ui.js; the local override is a harmless guard). */
  const tagFor = (x) => (x && x.industry === "world") ? "World Cinema" : UI.industryTag(x);
  const pub = () => Object.values(window.FA_PUBLISHED || {});
  const dw = window.FA_DAYWISE || {};
  const entryOf = (id) => (window.FA_PUBLISHED || {})[String(id)] || null;
  const recordedTotal = (id) => {
    const rows = dw[String(id)] || [];
    return rows.filter(r => r && typeof r.collection === "number" && Number.isFinite(r.collection))
      .reduce((s, r) => s + r.collection, 0);
  };
  /* Ranking amount: reported worldwide gross when it exists, otherwise the
     recorded day-wise sum. A title with neither has no figure (amount 0). */
  const amountOf = (d) => (d && (d.revenue || 0) > 0 ? d.revenue : recordedTotal(d && d.id));
  const dwKeysByLastDate = () => Object.keys(dw).sort((a, b) => {
    const lastOf = (k) => { const rows = dw[k]; return Array.isArray(rows) && rows.length ? (rows[rows.length - 1].date || "") : ""; };
    return lastOf(b).localeCompare(lastOf(a));
  });

  /* Latest card — the newest published title with real day-wise rows.
     Same card as the homepage (Today / 7 Days / Recorded, with the "2/7"
     partial badge). One card; nothing when no published title has data. */
  function latestCardHtml(entry, rows) {
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
    return `<a class="fa-box-latest-card" data-movie-id="${UI.esc(entry.id)}" data-release="${UI.esc(date)}" href="/movie?id=${entry.id}" aria-label="${UI.esc(UI.titleOf(entry))} — box office details"><div class="fa-box-card-head">${poster}<div class="fa-box-card-labels"><span class="fa-box-latest-title" title="${UI.esc(UI.titleOf(entry))}">${UI.esc(UI.titleOf(entry))}</span><p class="fa-box-latest-meta">Released ${UI.esc(UI.fmtDate(date))}</p></div><span class="fa-box-card-arrow" aria-hidden="true">›</span></div><dl aria-label="Reported box office summary"><div title="Today's reported collection · ${UI.esc(today)} UTC"><dt>Today</dt><dd>${todayRows.length ? UI.fmtMoney(todaySum) : missing}</dd></div><div title="${UI.esc(weekDays ? weekDays + " of 7 days reported" : "No daily records reported for this period")} · ${UI.esc(weekStart)} to ${UI.esc(today)} UTC"><dt>7 Days</dt><dd>${weekRows.length ? `${UI.fmtMoney(weekSum)}${weekDays < 7 ? `<abbr class="fa-box-partial" title="${UI.esc(weekDays + " of 7 days reported · partial")}">${weekDays}/7</abbr>` : ""}` : missing}</dd></div><div title="Sum of the reported day-wise collections tracked by FlickAtlas"><dt>Recorded</dt><dd>${UI.fmtMoney(totalSum)}</dd></div></dl></a>`;
  }
  function latestPick(industry) {
    for (const dwId of dwKeysByLastDate()) {
      const entry = entryOf(dwId);
      if (!entry || !entry.poster_path) continue;
      if (industry && entry.industry !== industry) continue;
      const rows = dw[dwId];
      if (Array.isArray(rows) && rows.length) return { entry, rows };
    }
    return null;
  }

  /* Periods (correction 8): Today / 7 Days / 30 Days come only from
     engine day-wise data; Lifetime = the all-time gross rankings below.
     Box-office periods are NOT bound by the 3-month posts window. */
  const PERIODS = [["lifetime", "Lifetime"], ["today", "Today"], ["d7", "7 Days"], ["d30", "30 Days"]];
  let period = UI.getParam("p", "lifetime");
  if (!PERIODS.some(([k]) => k === period)) period = "lifetime";
  const FILTERS = [["all", "All"], ["year", `This Year`], ["alltime", "All-Time"],
    ["bollywood", "Bollywood"], ["worldwide", "Worldwide"],
    ["hit", "Verdict: Hit"], ["average", "Verdict: Average"], ["flop", "Verdict: Flop"],
    ["club100", UI.fmtMoney(1e8) + " Club"], ["club300", UI.fmtMoney(3e8) + " Club"], ["club500", UI.fmtMoney(5e8) + " Club"], ["club1b", UI.fmtMoney(1e9) + " Club"]];
  let f = UI.getParam("f", "all");
  if (!FILTERS.some(([k]) => k === f)) f = "all";

  /* Lifetime entries: published movies ranked by amount (reported gross,
     else recorded day-wise sum). Titles with no figure at all are excluded. */
  function lifetimeEntries(industry) {
    return pub()
      .filter(x => x && x.id && x.type === "movie" && x.poster_path
        && /^\d{4}-\d{2}-\d{2}$/.test(x.release_date || "")
        && (!industry || x.industry === industry))
      .map(d => ({ ...d, _amount: amountOf(d) }))
      .filter(d => d._amount > 0)
      .sort((a, b) => b._amount - a._amount);
  }

  /* Lifetime chart table. Budget/revenue of 0 mean "not reported" — the old
     code rendered fmtMoney(0) as "$0" because the span is a truthy string.
     data-ind carries the baked industry (bollywood | pakistani | world);
     data-gross is the ranking amount, so the club filters work on it. */
  function table(rows) {
    return `<div class="table-scroll"><table class="data">
      <thead><tr><th>#</th><th></th><th>Movie</th><th>Budget</th><th>Worldwide Gross</th><th>Verdict*</th></tr></thead>
      <tbody>${rows.map((d, i) => { const v = UI.verdict(d.budget, d.revenue); return `<tr data-fitem data-ind="${UI.esc(d.industry || "")}" data-verdict="${v ? v.label.toLowerCase() : ""}" data-gross="${d._amount || 0}">
        <td class="rank">${i + 1}</td>
        <td><a href="/movie?id=${d.id}"><img src="${UI.img(d.poster_path, "w92")}" alt="" loading="lazy" onerror="this.remove()"></a></td>
        <td><a href="/movie?id=${d.id}"><b>${UI.esc(UI.titleOf(d))}</b></a>
          <div style="color:var(--muted);font-size:.82rem">${UI.yearOf(d)}${UI.rating(d) ? ` · ${UI.rating(d)}/10` : ""}${tagFor(d) ? ` · ${UI.esc(tagFor(d))}` : ""}</div>
          ${(() => { const max = Math.max(d.budget || 0, d._amount || 0, 1); const bar = (name, value, cls) => `<div class="bo-bar"><span>${name}</span><span class="track"><i class="fill ${cls}" style="width:${Math.max(0, Math.min(100, value / max * 100))}%"></i></span></div>`; return `<div class="bo-bars" aria-label="Budget compared with gross">${bar("Budget", d.budget || 0, "budget")}${bar("Gross", d._amount || 0, "gross")}</div>`; })()}</td>
        <td>${d.budget > 0 ? UI.fmtMoney(d.budget) : "Not reported"}</td>
        <td><b>${d._amount > 0 ? UI.fmtMoney(d._amount) : "—"}</b></td>
        <td>${v ? `<span class="verdict ${v.cls}">${v.label}</span>` : "—"}</td></tr>`; }).join("")}
      </tbody></table></div>
      <p class="bo-empty" style="display:none;color:var(--muted)">No titles in this chart match the selected filter.</p>`;
  }

  function chartCard(cardId, title, entries) {
    const top = entries.slice(0, 10);
    return `<div class="content-card" id="${cardId}" data-loaded="1"><h2>${UI.esc(title)}</h2>
      ${top.length ? table(top)
        : `<p style="color:var(--muted)">No reported box office data available right now.</p>`}
      <p style="color:var(--muted);font-size:.8rem;margin-top:10px">Gross is the reported worldwide gross where available; otherwise the sum of the recorded day-wise collections tracked by FlickAtlas.</p></div>`;
  }

  function applyFilter() {
    const clubs = { club100: 1e8, club300: 3e8, club500: 5e8, club1b: 1e9 };
    const scopeOf = (cardId) => f === "year" ? cardId === "yearCard" : f === "alltime" ? cardId === "allCard" : true;
    for (const cardId of ["yearCard", "allCard"]) {
      const card = document.getElementById(cardId);
      if (!card || !card.dataset.loaded) continue;
      const inScope = scopeOf(cardId);
      card.style.display = inScope ? "" : "none";
      if (!inScope) continue;
      let visible = 0;
      card.querySelectorAll("[data-fitem]").forEach(tr => {
        const ds = tr.dataset;
        let show = true;
        if (f === "hit" || f === "average" || f === "flop") show = ds.verdict === f;
        else if (f === "worldwide") show = ds.ind === "world";
        else if (clubs[f]) show = Number(ds.gross) >= clubs[f];
        tr.style.display = show ? "" : "none";
        if (show) visible++;
      });
      const shown = [...card.querySelectorAll("[data-fitem]")].filter(tr => tr.style.display !== "none");
      shown.forEach((tr, i) => { const rank = tr.querySelector(".rank"); if (rank) rank.textContent = String(i + 1); });
      const note = card.querySelector(".bo-empty");
      if (note) note.style.display = visible ? "none" : "";
    }
  }

  /* Day-wise tables for every published title that has day-wise rows. */
  function daywiseHtml() {
    return dwKeysByLastDate().map(id => {
      const entry = entryOf(id);
      if (!entry) return "";
      return UI.daywiseCard(dw[id], `Day-Wise Box Office — ${UI.titleOf(entry)}`, { titleId: String(id) });
    }).join("");
  }

  /* Period ranking details map — published entries only, never TMDB. */
  const periodMap = {};
  for (const id of Object.keys(dw)) {
    const e = entryOf(id);
    if (e) periodMap[String(id)] = e;
  }

  /* ---------- Bollywood branch ---------- */
  if (f === "bollywood") {
    const pick = latestPick("bollywood");
    /* Bollywood-only period map — the global periodMap would rank world
       titles in the Bollywood branch's period section. */
    const bollyMap = {};
    for (const id of Object.keys(dw)) {
      const e = entryOf(id);
      if (e && e.industry === "bollywood") bollyMap[String(id)] = e;
    }
    const periodHtml = period !== "lifetime"
      ? (UI.boPeriodHtml(period, bollyMap)
        ? `<div class="content-card"><h2>Box Office — ${PERIODS.find(([k]) => k === period)[1]}</h2><p class="bo-help">Ranked by recorded collection within this window. Lifetime gross rankings below use a separate measure.</p>${UI.boPeriodHtml(period, bollyMap)}</div>`
        : `<div class="content-card"><h2>Box Office — ${PERIODS.find(([k]) => k === period)[1]}</h2><p style="color:var(--muted)">No day-wise tracked titles yet for this period — period rankings appear here as the data engine tracks running films day by day. See the Lifetime charts meanwhile.</p></div>`)
      : "";
    const cuts = [["alltime", "All-Time"], ["year", "This Year"], ["hit", "Verdict: Hit"], ["average", "Verdict: Average"], ["flop", "Verdict: Flop"], ["club100", "$100M Club"], ["club300", "$300M Club"], ["club500", "$500M Club"], ["club1b", "$1B Club"]];
    let cut = UI.getParam("cut", "alltime");
    if (!cuts.some(([k]) => k === cut)) cut = "alltime";
    const href = (p, c) => `/box-office?f=bollywood&p=${encodeURIComponent(p)}&cut=${encodeURIComponent(c)}`;
    const controls = PERIODS.map(([k, name]) => `<a class="chip${k === period ? " on" : ""}"${k === period ? ' aria-current="page"' : ""} href="${href(k, cut)}" style="text-decoration:none">${name}</a>`).join("");
    const filters = cuts.map(([k, name]) => `<a class="chip${k === cut ? " on" : ""}" href="${href(period, k)}" style="text-decoration:none">${name}</a>`).join("");
    const label = (PERIODS.find(p => p[0] === period) || PERIODS[0])[1];
    const bollyEntries = lifetimeEntries("bollywood");
    const clubFloor = { club100: 1e8, club300: 3e8, club500: 5e8, club1b: 1e9 };
    const cutEntries = bollyEntries.filter(d => {
      const v = UI.verdict(d.budget, d.revenue);
      if (cut === "year") return String(d.release_date || "").startsWith(String(year));
      if (["hit", "average", "flop"].includes(cut)) return !!v && v.label.toLowerCase() === cut;
      return clubFloor[cut] ? d._amount >= clubFloor[cut] : true;
    });
    const yearEntries = cutEntries.filter(d => String(d.release_date || "").startsWith(String(year)));
    const lifetimeSection = period === "lifetime" ? `<section class="bo-summary"><h2>Lifetime gross sample</h2><p>Available Hindi-language Indian titles only; not comprehensive or independently reconciled.</p><div class="bo-periods" style="margin-top:10px">${filters}</div></section>${chartCard("yearCard", `Top Grossing Bollywood Movies — ${year}`, yearEntries)}${chartCard("allCard", "Top Grossing Bollywood Movies — Lifetime", cutEntries)}` : "";
    main.innerHTML = `<div class="wrap bo-dashboard">
      <header class="page-hero bo-intro"><p class="bo-key">Dated collections and reported grosses</p><h1>Bollywood Box Office — ${UI.esc(label)}</h1><p>Hindi-language Indian-film figures in the limited available sample. Period collections sum valid recorded dates; lifetime charts rank reported gross. Neither is a definitive industry ranking, and gross is not profit.</p></header>
      <details class="bo-help"><summary>Budget, gross &amp; verdict — what do they mean?</summary><p>Reported budget and gross are not profit. Estimated verdicts compare gross with budget: Hit at 2.5× or more, Average at 1× to under 2.5×, and Flop below budget. Missing budgets do not receive a verdict.</p></details>
      <nav class="bo-scope" aria-label="Box office industry"><a class="chip" href="/box-office">All industries</a><a class="chip on" href="${href(period, cut)}" aria-current="page">Bollywood</a></nav>
      <section class="section" data-sec="box-office"><div class="section-head"><h2>Latest</h2></div>${pick ? latestCardHtml(pick.entry, pick.rows) : `<p style="color:var(--muted)">No published Bollywood title has day-wise collection data yet.</p>`}</section>
      <section class="bo-summary"><h2>Recorded collections by period</h2><p>Only valid dated entries in the selected calendar window are summed; absent dates are excluded, not invented.</p><div class="bo-periods" style="margin-top:10px">${controls}</div></section>
      ${periodHtml}
      ${lifetimeSection}
      <div class="content-card"><h2>${UI.esc(label)} collections — dated sample</h2>${(() => {
        const rows = dwKeysByLastDate().map(id => ({ entry: entryOf(id), rows: dw[id] })).filter(x => x.entry && x.entry.industry === "bollywood" && Array.isArray(x.rows) && x.rows.length);
        if (!rows.length) return `<p style="color:var(--muted)">No eligible Hindi-film day-wise records are available for ${label.toLowerCase()} in the current sample. No missing dates or figures are estimated.</p>`;
        const set = period === "today" ? [today, today] : period === "d7" ? [new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10), today] : period === "d30" ? [new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10), today] : null;
        const body = rows.map(({ entry, rows: rws }) => {
          const inPeriod = set ? rws.filter(r => r.date >= set[0] && r.date <= set[1]) : rws;
          const amount = inPeriod.reduce((s, r) => s + (r.collection || 0), 0);
          if (set && !inPeriod.length) return "";
          return `<tr><td><a href="/movie?id=${entry.id}"><b>${UI.esc(UI.titleOf(entry))}</b></a></td><td>${inPeriod.map(r => { const n = UI.dayNumOf(r, rws.indexOf(r)); return `<a href="/box-office-day?title=${encodeURIComponent(entry.id)}&day=${n}">${UI.fmtDate(r.date)}</a>`; }).join(", ")}</td><td><b>${UI.fmtMoney(amount)}</b></td></tr>`;
        }).filter(Boolean).join("");
        return body ? `<div class="table-scroll"><table class="data"><thead><tr><th>Movie</th><th>Recorded dates</th><th>Recorded collection (USD)</th></tr></thead><tbody>${body}</tbody></table></div>` : `<p style="color:var(--muted)">No eligible Hindi-film day-wise records are available for ${label.toLowerCase()} in the current sample. No missing dates or figures are estimated.</p>`;
      })()}<p class="prov-note">Collection records have not been independently reconciled here.</p></div>
      ${UI.rateNote()}
      <p class="bo-help"><b>Method:</b> Today means the current UTC calendar date; 7 Days and 30 Days are inclusive calendar windows ending today. Lifetime sums valid dated records. Coverage is limited to available records; no dates or figures are invented.</p>
    </div>`;
    UI.setSEO({ title: "Box Office — Latest Movies, Today, 7 Days & Lifetime | FlickAtlas", desc: "Latest released films with reported daily collections, seven-day sums and lifetime worldwide gross. Missing figures remain clearly marked.", path: "/box-office?f=bollywood" });
    return;
  }

  /* ---------- All-industries view ---------- */
  const pick = latestPick(null);
  const allEntries = lifetimeEntries(null);
  const yearEntries = allEntries.filter(d => String(d.release_date || "").startsWith(String(year)));
  main.innerHTML = `<div class="wrap bo-dashboard">
    <header class="page-hero bo-intro"><p class="bo-key">Collections, comparisons and records</p><h1>Box Office</h1>
      <p>Period totals use recorded day-wise entries; lifetime charts use reported gross.</p></header>
    <details class="bo-help"><summary>Budget, gross &amp; verdict — what do they mean?</summary><p><b>Budget</b> is reported production spend; <b>gross</b> is revenue, not profit or the studio's share. Verdicts are estimates from reported gross-to-budget: Hit at 2.5× or more, Average from 1× to under 2.5×, Flop below budget. Missing budgets mean no verdict.</p></details>
    <nav class="bo-scope" aria-label="Box office industry"><a class="chip on" href="/box-office" aria-current="page">All industries</a><a class="chip" href="/box-office?f=bollywood">Bollywood</a></nav>
    <section class="section" data-sec="box-office"><div class="section-head"><h2>Latest</h2></div>${pick ? latestCardHtml(pick.entry, pick.rows) : `<p style="color:var(--muted)">No published title has day-wise collection data yet.</p>`}</section>
    <section class="bo-summary" aria-label="Choose a collection period"><h2>Recorded collections by period</h2><p>Only dated entries within the selected window count; missing days are excluded, not zero.</p>
    <div class="bo-periods" style="margin-top:18px">${PERIODS.map(([k, l]) =>
      `<a class="chip${k === period ? " on" : ""}"${k === period ? ' aria-current="page"' : ""} href="/box-office?p=${k}${f === "all" ? "" : `&amp;f=${encodeURIComponent(f)}`}" style="text-decoration:none">${l}</a>`).join("")}</div>
    <div id="periodWrap" aria-live="polite"></div></section>
    <div id="lifetimeWrap">
    <section class="bo-summary"><h2>Lifetime gross rankings</h2><p>Reported-gross ranking from an available sample, not a definitive global ranking.</p><div id="chipHost">${UI.chipRow(FILTERS, f)}</div></section>
    ${chartCard("yearCard", `Top Grossing Movies of ${year}`, yearEntries)}
    ${chartCard("allCard", "Top Grossing Movies of All Time", allEntries)}
    </div>
    <div id="daywiseWrap">${daywiseHtml()}</div>
    ${UI.rateNote()}
    <p class="bo-help"><b>Data note:</b> Lifetime figures are reported, not independently reconciled. This is a limited sample; budgets may be unreported, and verdicts are estimates from reported budget and gross.</p>
  </div>`;

  /* Period view (correction 8): when a period is selected, the period
     ranking replaces the Lifetime charts. Figures are day-wise sums
     only — a title without day-wise data cannot appear here. */
  if (period !== "lifetime") {
    const lw = document.getElementById("lifetimeWrap");
    if (lw) lw.style.display = "none";
    const html = UI.boPeriodHtml(period, periodMap);
    document.getElementById("periodWrap").innerHTML = html
      ? `<div class="content-card"><h2>Box Office — ${PERIODS.find(([k]) => k === period)[1]}</h2><p class="bo-help">Ranked by recorded collection within this window. Lifetime gross rankings below use a separate measure.</p>${html}</div>`
      : `<div class="content-card"><h2>Box Office — ${PERIODS.find(([k]) => k === period)[1]}</h2>
         <p style="color:var(--muted)">No day-wise tracked titles yet for this period — period rankings appear here as the data engine tracks running films day by day. See the Lifetime charts meanwhile.</p></div>`;
  } else {
    document.getElementById("periodWrap").innerHTML = `<p class="bo-help">Select a period above to see its recorded collections.</p>`;
  }

  applyFilter();
  UI.wireChips(main.querySelector("#chipHost"), (k) => {
    if (k === "bollywood") { location.assign("/box-office?f=bollywood"); return; }
    f = k;
    main.querySelectorAll(".bo-periods a").forEach(link => {
      const url = new URL(link.href);
      if (f === "all") url.searchParams.delete("f"); else url.searchParams.set("f", f);
      link.href = url.pathname + url.search;
    });
    applyFilter();
  });
})();
