/* FlickAtlas — Box Office Milestones (user order 2026-10-26, Sacnilk model):
   The 100 / 300 / 500 / 1000 Crore clubs plus the top Day 1, 1st Weekend,
   Week 1 and Month 1 collections — computed ONLY from reported day-wise
   rows in window.FA_DAYWISE (never invented). Each club list is cumulative
   (a 1000 Cr+ title also appears in the 500 / 300 / 100 lists, as on
   Sacnilk). A section renders only when it has at least one qualifying
   movie, so with sparse data the page shows just the top lists and the
   clubs appear automatically as day-wise coverage grows.
   1st Weekend = Day 1 + Day 2 + Day 3 (approximation: most Indian
   releases open Friday, so the first 3 days are the opening weekend).
   Totals are India-net sums of the reported day-wise rows. Figures are
   displayed with UI.fmtMoney (USD stored, converted at display time in
   the visitor's chosen currency); club membership is tested in ₹ crore
   (USD x 94.65 / 1e7), the same rate as FA_RATES. The page carries a
   .fa-select in-page Section dropdown (All / one club or top list) —
   never a native <select> popup. */
(async function () {
  UI.mountChrome("/box-office/milestones");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Box Office Milestones — 1000 Crore Club & Top Collections | FlickAtlas",
    desc: "Indian movies crossing 100, 300, 500 and 1000 crore, plus the top Day 1, first-weekend, Week 1 and Month 1 collections — from FlickAtlas day-wise box office records.",
    path: "/box-office/milestones"
  });

  const INR = 94.65; /* ₹ per USD — same rate as FA_RATES (js/config.js). */
  const inrCrore = (usd) => usd * INR / 1e7;
  const dw = window.FA_DAYWISE || {};
  const pub = window.FA_PUBLISHED || {};

  /* Clean one title's day-wise rows: valid date, numeric collection >= 0,
     one row per day number (first wins). Mirrors UI's bollywoodRows. */
  function cleanRows(rows) {
    const seen = new Set(), out = [];
    (rows || []).forEach((r, i) => {
      if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || "") || typeof r.collection !== "number" || !Number.isFinite(r.collection) || r.collection < 0) return;
      const n = UI.dayNumOf(r, i);
      if (seen.has(n)) return;
      seen.add(n);
      out.push({ day: n, collection: r.collection });
    });
    return out.sort((a, b) => a.day - b.day);
  }

  /* Per-title figures, from reported day-wise rows only. A title only
     qualifies for the opening-period top lists if it has a Day 1 row —
     without Day 1, a "1st Weekend / Week 1 / Month 1" sum would be a
     misleading partial. */
  const stats = Object.keys(dw).map((id) => {
    const entry = pub[id];
    if (!entry || entry.type !== "movie") return null;
    const rows = cleanRows(dw[id]);
    if (!rows.length) return null;
    const byDay = new Map(rows.map(r => [r.day, r.collection]));
    const sumDays = (a, b) => { let s = 0; for (let d = a; d <= b; d++) s += byDay.get(d) || 0; return s; };
    return {
      entry,
      total: rows.reduce((s, r) => s + r.collection, 0),
      day1: byDay.has(1) ? byDay.get(1) : null,
      weekend: sumDays(1, 3),
      week1: sumDays(1, 7),
      month1: sumDays(1, 30)
    };
  }).filter(Boolean);

  const CLUBS = [
    { crore: 1000, title: "1000 Cr+ Movies", sub: "Indian movies crossing 1000 crore." },
    { crore: 500, title: "500 Cr+ Movies", sub: "Indian movies crossing 500 crore." },
    { crore: 300, title: "300 Cr+ Movies", sub: "Indian movies crossing 300 crore." },
    { crore: 100, title: "100 Cr+ Movies", sub: "Indian movies crossing 100 crore." }
  ];
  const TOPS = [
    { key: "day1", title: "Top Day 1 Collection", sub: "Top Indian movies by Day 1." },
    { key: "weekend", title: "Top 1st Weekend Collection", sub: "Top Indian movies by 1st Weekend (Day 1–3)." },
    { key: "week1", title: "Top Week 1 Collection", sub: "Top Indian movies by Week 1 (Day 1–7)." },
    { key: "month1", title: "Top Month 1 Collection", sub: "Top Indian movies by Month 1 (Day 1–30)." }
  ];

  /* Row markup — reuses the site's .tl-list / .tl-row (poster + title +
     meta), with an optional rank badge and a right-aligned figure
     (milestones.css). Links to the movie detail page. */
  const rowHtml = (s, value, rank) => {
    const e = s.entry;
    const poster = e.poster_path
      ? `<img src="${UI.img(e.poster_path, "w92")}" alt="" loading="lazy" onerror="this.remove()">`
      : "";
    return `<a class="tl-row" href="/movie?id=${e.id}">
      ${rank ? `<span class="ms-rank" aria-hidden="true">${rank}</span>` : ""}
      ${poster}
      <span class="tl-info"><b>${UI.esc(UI.titleOf(e))}</b><span>${UI.esc(UI.fmtDate(e.release_date || ""))}</span></span>
      <b class="ms-amt">${UI.fmtMoney(value)}</b>
    </a>`;
  };

  const clubSection = (club) => {
    const list = stats.filter(s => inrCrore(s.total) >= club.crore).sort((a, b) => b.total - a.total);
    if (!list.length) return "";
    return `<div class="content-card"><h2>\uD83C\uDFC6 ${UI.esc(club.title)}</h2>
      <p>${UI.esc(club.sub)}</p>
      <div class="tl-list">${list.map(s => rowHtml(s, s.total, 0)).join("")}</div></div>`;
  };
  const topSection = (top) => {
    const list = stats.filter(s => s.day1 !== null).sort((a, b) => b[top.key] - a[top.key]).slice(0, 10);
    if (!list.length) return "";
    return `<div class="content-card"><h2>\u23F0 ${UI.esc(top.title)}</h2>
      <p>${UI.esc(top.sub)}</p>
      <div class="tl-list">${list.map((s, i) => rowHtml(s, s[top.key], i + 1)).join("")}</div></div>`;
  };

  /* One entry per rendered section (club or top list); the dropdown
     shows All, or one section at a time. */
  const sectionEntries = [
    ...CLUBS.map(c => ({ key: `club-${c.crore}`, label: c.title, html: clubSection(c) })),
    ...TOPS.map(t => ({ key: `top-${t.key}`, label: t.title, html: topSection(t) }))
  ].filter(x => x.html);
  let section = "all";
  main.innerHTML = `<div class="wrap bo-dashboard">
    <header class="page-hero bo-intro"><p class="bo-key">Box office records</p><h1>Box Office Milestones</h1>
      <p>Indian movies crossing 100, 300, 500 and 1000 crore, and the biggest Day 1, first-weekend, Week 1 and Month 1 collections — from FlickAtlas day-wise box office records. Tap a movie for its full day-wise detail.</p>
      <p><a href="/box-office">&larr; Back to Box Office</a></p></header>
    <div id="msFilterHost"><div class="listing-select-row listing-select-row--single">
      <div class="filter-select" role="group" aria-labelledby="msSectionLabel"><span class="filter-select-label" id="msSectionLabel">Section</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="msSectionTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="msSectionOptions" aria-labelledby="msSectionLabel msSectionValue"><span class="fa-select-value" id="msSectionValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="msSectionOptions" role="listbox" aria-labelledby="msSectionLabel" hidden></div></div></div>
    </div></div>
    <div id="msSections"></div>
    ${UI.rateNote()}
  </div>`;
  const sectionsHost = document.getElementById("msSections");
  function renderSections() {
    const list = section === "all" ? sectionEntries : sectionEntries.filter(x => x.key === section);
    sectionsHost.innerHTML = list.length ? list.map(x => x.html).join("")
      : `<p style="color:var(--muted)">No milestone data yet — day-wise collections are still being recorded. Check back soon.</p>`;
  }
  UI.mountFaSelect(document.querySelector("#msFilterHost .filter-select"),
    [{ value: "all", label: "All sections" }, ...sectionEntries.map(x => ({ value: x.key, label: x.label }))],
    section, (v) => { section = v; renderSections(); });
  renderSections();
})();

