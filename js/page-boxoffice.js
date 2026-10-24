/* FlickAtlas — Box Office hub (§5: Sacnilk records/day-wise + Koimoi verdicts
   + Mojo charts): year + all-time charts with §4 filter chips — All · This
   Year · All-Time · Bollywood · Worldwide · Verdicts · Clubs ($100M+ … $1B+).
   Figures come only from reported budget/revenue fields; verdicts are
   estimates and labelled as such. */
(async function () {
  UI.mountChrome("/box-office");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Box Office — Latest Movies, Today, 7 Days & Lifetime | FlickAtlas",
    desc: "Latest released movies with today’s reported collections, seven-day reported sums and lifetime worldwide gross. Bollywood first, with clear industry filters.",
    path: "/box-office"
  });

  const year = new Date().getFullYear();
  async function addLatestPrimary() {
    const wrap = main.querySelector(".wrap");
    if (!wrap) return;
    const host = document.createElement("div");
    host.id = "fa-box-latest-host";
    const history = document.createElement("details");
    history.className = "bo-history";
    history.open = ["p", "cut"].some(k => new URLSearchParams(location.search).has(k));
    history.innerHTML = `<summary>Historical charts &amp; day-wise records</summary>`;
    while (wrap.firstChild) history.appendChild(wrap.firstChild);
    history.querySelectorAll("h1").forEach(h => { const h2 = document.createElement("h2"); h2.textContent = h.textContent; h.replaceWith(h2); });
    wrap.append(host, history);
    let ready = window.FABoxOffice;
    if (!ready) ready = await new Promise(resolve => {
      const s = document.createElement("script"); s.src = "/js/boxoffice-latest.js?v=fa-currency-single-20261023T1350";
      s.onload = () => resolve(window.FABoxOffice); s.onerror = () => resolve(null); document.head.appendChild(s);
    });
    if (ready) ready.mount(host, { industry: new URLSearchParams(location.search).get("f") || "bollywood", title: "Box Office", heading: "h1" });
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

  /* Isolated Bollywood view: never filter worldwide top-10 results into a
     misleading chart. Only explicitly available, verified Hindi/India records
     are shown; broad rankings are withheld until the source pool is complete. */
  if (f === "bollywood") {
    main.innerHTML = `<div class="wrap bo-dashboard"></div>`;
    await addLatestPrimary();
    const archive = document.createElement("div");
    main.querySelector(".bo-history").appendChild(archive);
    try {
      await renderBollywoodBoxOffice({ main: archive, period, periods: PERIODS });
      archive.querySelectorAll("h1").forEach(h => { const h2 = document.createElement("h2"); h2.textContent = h.textContent; h.replaceWith(h2); });
    } catch (_) {
      archive.innerHTML = UI.stateMsg("Historical records could not load. The latest releases above remain available.");
    }
    return;
  }

  main.innerHTML = `<div class="wrap bo-dashboard">
    <header class="page-hero bo-intro"><p class="bo-key">Collections, comparisons and records</p><h1>Box Office</h1>
      <p>Period totals use recorded day-wise entries; lifetime charts use reported gross.</p></header>
    <details class="bo-help"><summary>Budget, gross &amp; verdict — what do they mean?</summary><p><b>Budget</b> is reported production spend; <b>gross</b> is revenue, not profit or the studio's share. Verdicts are estimates from reported gross-to-budget: Hit at 2.5× or more, Average from 1× to under 2.5×, Flop below budget. Missing budgets mean no verdict.</p></details>
    <nav class="bo-scope" aria-label="Box office industry"><a class="chip on" href="/box-office" aria-current="page">All industries</a><a class="chip" href="/box-office?f=bollywood">Bollywood</a></nav>
    <section class="bo-summary" aria-label="Choose a collection period"><h2>Recorded collections by period</h2><p>Only dated entries within the selected window count; missing days are excluded, not zero.</p>
    <div class="bo-periods" style="margin-top:18px">${PERIODS.map(([k, l]) =>
      `<a class="chip${k === period ? " on" : ""}"${k === period ? ' aria-current="page"' : ""} href="/box-office?p=${k}${f === "all" ? "" : `&amp;f=${encodeURIComponent(f)}`}" style="text-decoration:none">${l}</a>`).join("")}</div>
    <div id="periodWrap" aria-live="polite">${period === "lifetime" ? `<p class="bo-help">Select a period above to see its recorded collections.</p>` : `<p class="bo-help" role="status">Loading dated collection records…</p>`}</div></section>
    <div id="lifetimeWrap">
    <section class="bo-summary"><h2>Lifetime gross rankings</h2><p>Reported-gross ranking from an available sample, not a definitive global ranking.</p><div id="chipHost">${UI.chipRow(FILTERS, f)}</div></section>
    <div class="content-card" id="yearCard"><h2>Top Grossing Movies of ${year}</h2>
      <p style="color:var(--muted)">Loading reported figures…</p></div>
    <div class="content-card" id="allCard"><h2>Top Grossing Movies of All Time</h2>
      <p style="color:var(--muted)">Loading reported figures…</p></div>
    </div>
    <div id="daywiseWrap"></div>
    ${UI.rateNote()}
    <p class="bo-help"><b>Data note:</b> Lifetime figures are reported, not independently reconciled. This is a limited sample; budgets may be unreported, and verdicts are estimates from reported budget and gross.</p>
  </div>`;
  await addLatestPrimary();

  const indKey = (d) => {
    const t = UI.industryTag(d);
    return t === "Bollywood" ? "bollywood" : t === "Pakistani" ? "lollywood" : t === "Korean" ? "kdrama" : "international";
  };

  function table(rows) {
    return `<div class="table-scroll"><table class="data">
      <thead><tr><th>#</th><th></th><th>Movie</th><th>Budget</th><th>Worldwide Gross</th><th>Verdict*</th></tr></thead>
      <tbody>${rows.map((d, i) => { const v = UI.verdict(d.budget, d.revenue); return `<tr data-fitem data-ind="${indKey(d)}" data-verdict="${v ? v.label.toLowerCase() : ""}" data-gross="${d.revenue || 0}">
        <td class="rank">${i + 1}</td>
        <td><a href="/movie?id=${d.id}"><img src="${UI.img(d.poster_path, "w92")}" alt="" loading="lazy" onerror="this.remove()"></a></td>
        <td><a href="/movie?id=${d.id}"><b>${UI.esc(UI.titleOf(d))}</b></a>
          <div style="color:var(--muted);font-size:.82rem">${UI.yearOf(d)}${UI.rating(d) ? ` · ${UI.rating(d)}/10` : ""}</div>
          ${(() => { const max = Math.max(d.budget || 0, d.revenue || 0, 1); const bar = (name, value, cls) => `<div class="bo-bar"><span>${name}</span><span class="track"><i class="fill ${cls}" style="width:${Math.max(0, Math.min(100, value / max * 100))}%"></i></span></div>`; return `<div class="bo-bars" aria-label="Budget compared with gross">${bar("Budget", d.budget || 0, "budget")}${bar("Gross", d.revenue || 0, "gross")}</div>`; })()}</td>
        <td>${UI.fmtMoney(d.budget) || "Not reported"}</td>
        <td><b>${UI.fmtMoney(d.revenue) || "—"}</b></td>
        <td>${v ? `<span class="verdict ${v.cls}">${v.label}</span>` : "—"}</td></tr>`; }).join("")}
      </tbody></table></div>
      <p class="bo-empty" style="display:none;color:var(--muted)">No titles in this chart match the selected filter.</p>`;
  }

  const charted = [];
  async function fill(cardId, params) {
    const card = document.getElementById(cardId);
    const list = await TMDB.discoverResults("movie", params);
    const picked = [];
    for (const m of list) {
      if (picked.length >= 10) break;
      try {
        const d = await TMDB.details("movie", m.id);
        if (d && d.revenue > 0) picked.push(d);
      } catch (e) {}
    }
    charted.push(...picked);
    picked.sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
    const h2 = card.querySelector("h2").outerHTML;
    card.innerHTML = h2 + (picked.length ? table(picked)
      : `<p style="color:var(--muted)">No reported box office data available right now.</p>`);
    card.dataset.loaded = "1";
  }

  function applyFilter() {
    const clubs = { club100: 1e8, club300: 3e8, club500: 5e8, club1b: 1e9 };
    const scopeOf = (cardId) => f === "year" ? cardId === "yearCard" : f === "alltime" ? cardId === "allCard" : true;
    for (const cardId of ["yearCard", "allCard"]) {
      const card = document.getElementById(cardId);
      if (!card.dataset.loaded) continue;
      const inScope = scopeOf(cardId);
      card.style.display = inScope ? "" : "none";
      if (!inScope) continue;
      let visible = 0;
      card.querySelectorAll("[data-fitem]").forEach(tr => {
        const ds = tr.dataset;
        let show = true;
        if (f === "hit" || f === "average" || f === "flop") show = ds.verdict === f;
        else if (clubs[f]) show = Number(ds.gross) >= clubs[f];
        tr.style.display = show ? "" : "none";
        if (show) visible++;
      });
      const shown = [...card.querySelectorAll("[data-fitem]")].filter(tr => tr.style.display !== "none");
      shown.sort((a, b) => Number(b.dataset.gross || 0) - Number(a.dataset.gross || 0));
      shown.forEach((tr, i) => { const rank = tr.querySelector(".rank"); if (rank) rank.textContent = String(i + 1); });
      const note = card.querySelector(".bo-empty");
      if (note) note.style.display = visible ? "none" : "";
    }
  }
  UI.wireChips(main.querySelector("#chipHost"), (k) => {
    if (k === "bollywood") { location.assign(location.href); return; }
    f = k;
    main.querySelectorAll(".bo-periods a").forEach(link => {
      const url = new URL(link.href);
      if (f === "all") url.searchParams.delete("f"); else url.searchParams.set("f", f);
      link.href = url.pathname + url.search;
    });
    applyFilter();
  });

  try {
    const periodWrap = document.getElementById("periodWrap");
    if (periodWrap) periodWrap.innerHTML = `<p class="bo-help" role="status">Loading dated records and title details…</p>`;
    await fill("yearCard", { primary_release_year: year, sort_by: "revenue.desc", page: 1 });
    await fill("allCard", { sort_by: "revenue.desc", page: 1 });
    applyFilter();
    /* Day-Wise Box Office: renders only for titles the data engine has supplied
       day-wise rows for (window.FA_DAYWISE); completely absent otherwise.
       Every title with day-wise data gets its table here (with per-day page
       links, §6.5) — not only titles that also made the charts above. */
    const dw = window.FA_DAYWISE || {};
    const dwIds = Object.keys(dw).filter(k => Array.isArray(dw[k]) && dw[k].length);
    const dwTitles = (await Promise.all(dwIds.map(id =>
      TMDB.details("movie", id).catch(() => null)))).filter(Boolean);
    const dwHtml = dwTitles
      .map(d => UI.daywiseCard(dw[String(d.id)], `Day-Wise Box Office — ${UI.titleOf(d)}`, { titleId: String(d.id) })).join("");
    if (dwHtml) document.getElementById("daywiseWrap").innerHTML = dwHtml;
    /* Period view (correction 8): when a period is selected, the period
       ranking replaces the Lifetime charts. Figures are day-wise sums
       only — a title without day-wise data cannot appear here. */
    if (period !== "lifetime") {
      const lw = document.getElementById("lifetimeWrap");
      if (lw) lw.style.display = "none";
      const map = {};
      dwTitles.forEach(d => { map[String(d.id)] = d; });
      const html = UI.boPeriodHtml(period, map);
      document.getElementById("periodWrap").innerHTML = html
        ? `<div class="content-card"><h2>Box Office — ${PERIODS.find(([k]) => k === period)[1]}</h2><p class="bo-help">Ranked by recorded collection within this window. Lifetime gross rankings below use a separate measure.</p>${html}</div>`
        : `<div class="content-card"><h2>Box Office — ${PERIODS.find(([k]) => k === period)[1]}</h2>
           <p style="color:var(--muted)">No day-wise tracked titles yet for this period — period rankings appear here as the data engine tracks running films day by day. See the Lifetime charts meanwhile.</p></div>`;
    }
  } catch (e) {
    const archive = main.querySelector(".bo-history");
    if (archive) archive.insertAdjacentHTML("beforeend", UI.stateMsg("Historical charts could not load. The latest releases above remain available."));
  }

  async function renderBollywoodBoxOffice(ctx) {
    const today = new Date().toISOString().slice(0, 10);
    const windowStart = days => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - (days - 1)); return d.toISOString().slice(0, 10); };
    const cuts = [["alltime", "All-Time"], ["year", "This Year"], ["hit", "Verdict: Hit"], ["average", "Verdict: Average"], ["flop", "Verdict: Flop"], ["club100", "$100M Club"], ["club300", "$300M Club"], ["club500", "$500M Club"], ["club1b", "$1B Club"]];
    let cut = UI.getParam("cut", "alltime");
    if (!cuts.some(([k]) => k === cut)) cut = "alltime";
    const href = (p, c) => `/box-office?f=bollywood&p=${encodeURIComponent(p)}&cut=${encodeURIComponent(c)}`;
    const dw = window.FA_DAYWISE || {}, ids = Object.keys(dw).filter(id => Array.isArray(dw[id]) && dw[id].length);
    const details = await Promise.all(ids.map(id => TMDB.details("movie", id).catch(() => null)));
    const eligible = [];
    for (let i = 0; i < ids.length; i++) {
      const d = details[i];
      if (!d || d.original_language !== "hi" || !(d.production_countries || []).some(c => c.iso_3166_1 === "IN")) continue;
      const rows = dw[ids[i]].filter(r => {
        if (!r || typeof r.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || r.date > today || typeof r.collection !== "number" || !Number.isFinite(r.collection) || r.collection < 0) return false;
        const parsed = new Date(`${r.date}T00:00:00Z`);
        return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === r.date;
      }).map(r => ({ ...r })).sort((a, b) => a.date.localeCompare(b.date));
      if (!rows.length || (d.release_date && rows[0].date < d.release_date)) continue;
      eligible.push({ d, rows });
    }
    const label = (ctx.periods.find(p => p[0] === ctx.period) || ctx.periods[0])[1];
    const set = ctx.period === "today" ? [today, today] : ctx.period === "d7" ? [windowStart(7), today] : ctx.period === "d30" ? [windowStart(30), today] : null;
    const result = eligible.map(({ d, rows }) => {
      const inPeriod = set ? rows.filter(r => r.date >= set[0] && r.date <= set[1]) : rows;
      return { d, rows, amount: inPeriod.reduce((sum, r) => sum + r.collection, 0), count: inPeriod.length };
    }).filter(x => !set || x.count).sort((a, b) => b.amount - a.amount);
    const controls = ctx.periods.map(([k, name]) => `<a class="chip${k === ctx.period ? " on" : ""}"${k === ctx.period ? ' aria-current="page"' : ""} href="${href(k, cut)}" style="text-decoration:none">${name}</a>`).join("");
    const rowsHtml = result.map((x, i) => `<tr><td class="rank">${i + 1}</td><td><a href="/movie?id=${x.d.id}"><b>${UI.esc(UI.titleOf(x.d))}</b></a></td><td>${x.rows.filter(r => !set || (r.date >= set[0] && r.date <= set[1])).map(r => { const n = UI.dayNumOf(r, x.rows.indexOf(r)); return `<a href="/box-office-day?title=${encodeURIComponent(x.d.id)}&day=${n}">${UI.fmtDate(r.date)}</a>`; }).join(", ")}</td><td><b>${UI.fmtMoney(x.amount)}</b></td></tr>`).join("");
    const clubFloor = { club100: 1e8, club300: 3e8, club500: 5e8, club1b: 1e9 };
    const chart = async (title, yr) => {
      let candidates = [];
      for (const page of [1, 2]) {
        const q = { with_original_language: "hi", with_origin_country: "IN", sort_by: "revenue.desc", page };
        if (yr) q.primary_release_year = yr;
        candidates.push(...await TMDB.discoverResults("movie", q).catch(() => []));
      }
      const unique = [...new Map(candidates.map(m => [m.id, m])).values()].slice(0, 20);
      const records = (await Promise.all(unique.map(m => TMDB.details("movie", m.id).catch(() => null))))
        .filter(d => d && d.original_language === "hi" && (d.production_countries || []).some(c => c.iso_3166_1 === "IN") && Number.isFinite(d.revenue) && d.revenue > 0)
        .sort((a, b) => b.revenue - a.revenue);
      const filtered = records.filter(d => {
        const v = UI.verdict(d.budget, d.revenue);
        if (cut === "year") return String(d.release_date || "").startsWith(String(new Date().getFullYear()));
        if (["hit", "average", "flop"].includes(cut)) return !!v && v.label.toLowerCase() === cut;
        return clubFloor[cut] ? d.revenue >= clubFloor[cut] : true;
      });
      return `<div class="content-card"><h2>${title}</h2><p style="color:var(--muted)">Limited available Hindi/India sample; not comprehensive or independently reconciled.</p>${filtered.length ? `<div class="table-scroll"><table class="data"><thead><tr><th>#</th><th>Movie</th><th>Budget</th><th>Gross</th><th>Gross / Budget</th><th>Verdict*</th></tr></thead><tbody>${filtered.map((d, i) => {
        const v = UI.verdict(d.budget, d.revenue), ratio = d.budget > 0 ? d.revenue / d.budget : null, max = Math.max(d.budget || 0, d.revenue || 0, 1);
        const bar = (name, value, cls) => `<div class="bo-bar"><span>${name}</span><span class="track"><i class="fill ${cls}" style="width:${Math.max(0, Math.min(100, value / max * 100))}%"></i></span></div>`;
        return `<tr><td class="rank">${i + 1}</td><td><a href="/movie?id=${d.id}"><b>${UI.esc(UI.titleOf(d))}</b></a><div style="color:var(--muted);font-size:.82rem">${UI.yearOf(d)}</div><div class="bo-bars">${bar("Budget", d.budget || 0, "budget")}${bar("Gross", d.revenue, "gross")}</div></td><td>${d.budget > 0 ? UI.fmtMoney(d.budget) : "Not reported"}</td><td>${UI.fmtMoney(d.revenue)}</td><td>${ratio ? `${ratio.toFixed(1)}×` : "—"}</td><td>${v ? `<span class="verdict ${v.cls}">Estimated ${v.label}</span>` : "—"}</td></tr>`;
      }).join("")}</tbody></table></div>` : `<p style="color:var(--muted)">No available titles match this view.</p>`}</div>`;
    };
    const filters = cuts.map(([k, name]) => `<a class="chip${k === cut ? " on" : ""}" href="${href(ctx.period, k)}" style="text-decoration:none">${name}</a>`).join("");
    const chartParts = ctx.period === "lifetime" ? await Promise.all([chart("Top Grossing Bollywood Movies — Lifetime", null), chart(`Top Grossing Bollywood Movies — ${new Date().getFullYear()}`, new Date().getFullYear())]) : [];
    ctx.main.innerHTML = `<div class="wrap bo-dashboard"><header class="page-hero bo-intro"><p class="bo-key">Dated collections and reported grosses</p><h1>Bollywood Box Office — ${label}</h1><p>Hindi-language Indian-film figures in the limited available sample. Period collections sum valid recorded dates; lifetime charts rank reported gross. Neither is a definitive industry ranking, and gross is not profit.</p></header><details class="bo-help"><summary>Budget, gross &amp; verdict — what do they mean?</summary><p>Reported budget and gross are not profit. Estimated verdicts compare gross with budget: Hit at 2.5× or more, Average at 1× to under 2.5×, and Flop below budget. Missing budgets do not receive a verdict.</p></details><nav class="bo-scope" aria-label="Box office industry"><a class="chip" href="/box-office">All industries</a><a class="chip on" href="${href(ctx.period, cut)}" aria-current="page">Bollywood</a></nav><section class="bo-summary"><h2>Recorded collections by period</h2><p>Only valid dated entries in the selected calendar window are summed; absent dates are excluded, not invented.</p><div class="bo-periods" style="margin-top:10px">${controls}</div></section>${ctx.period === "lifetime" ? `<section class="bo-summary"><h2>Lifetime gross sample</h2><p>Available Hindi-language Indian titles only; not comprehensive or independently reconciled.</p><div class="bo-periods" style="margin-top:10px">${filters}</div></section>${chartParts.join("")}` : ""}<div class="content-card"><h2>${label} collections — dated sample</h2>${rowsHtml ? `<div class="table-scroll"><table class="data"><thead><tr><th>#</th><th>Movie</th><th>Recorded dates</th><th>Recorded collection (USD)</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>` : `<p style="color:var(--muted)">No eligible Hindi-film day-wise records are available for ${label.toLowerCase()} in the current sample. No missing dates or figures are estimated.</p>`}<p class="prov-note">Collection records have not been independently reconciled here.</p></div>${UI.rateNote()}<p class="bo-help"><b>Method:</b> Today means the current UTC calendar date; 7 Days and 30 Days are inclusive calendar windows ending today. Lifetime sums valid dated records. Coverage is limited to available records; no dates or figures are invented.</p></div>`;
    UI.setSEO({ title: "Box Office — Latest Movies, Today, 7 Days & Lifetime | FlickAtlas", desc: "Latest released films with reported daily collections, seven-day sums and lifetime worldwide gross. Missing figures remain clearly marked.", path: "/box-office?f=bollywood" });
  }
})();
