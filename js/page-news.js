/* FlickAtlas — Trending News (§3 newspaper-native, §5 Soompi mechanics):
   real entertainment headlines from live feeds via /api/news, presented as
   newspaper-style rows with relative timestamps and category labels. §4 chips: All · Bollywood · International · Pakistan · Korea ·
   Celebrity. If the feed service is unreachable, the page falls back to
   release-data updates, honestly framed as updates — never as reported news. */
(async function () {
  UI.mountChrome("/news");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Trending News — Entertainment Headlines from Bollywood, Hollywood, Pakistan & Korea | FlickAtlas",
    desc: "Browse entertainment headlines by Bollywood, international, Pakistan, Korea, celebrity or viral topic. Use the category filters to narrow the feed; timestamps appear when available.",
    path: "/news"
  });

  const FILTERS = [["all", "All"], ["bollywood", "Bollywood"], ["international", "International"],
    ["pakistan", "Pakistan"], ["korea", "Korea"], ["celebrity", "Celebrity"], ["viral", "Viral"]];
  let f = UI.getParam("f", "all");
  if (!FILTERS.some(([k]) => k === f)) f = "all";

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Trending News</h1>
      <p>Entertainment headlines across Bollywood, international, Pakistan, Korea and more; filter by category.</p></div>
    <div id="chipHost">${UI.chipRow(FILTERS, f)}</div>
    <p class="fcount" id="fcount"></p>
    <div id="newsWrap"><div class="sk" style="height:220px;border-radius:14px"></div></div>
  </div>`;
  const wrap = main.querySelector("#newsWrap");
  const fcount = main.querySelector("#fcount");

  const CATLABEL = { bollywood: "Bollywood", international: "International", pakistan: "Pakistan", korea: "Korea", celebrity: "Celebrity", viral: "Viral" };
  let items = null;

  function render() {
    const list = (items || []).filter(it => f === "all" || it.cats.includes(f)).slice(0, 48);
    fcount.textContent = list.length ? `${list.length} headline${list.length === 1 ? "" : "s"}` : "";
    if (!list.length) {
      wrap.innerHTML = UI.stateMsg("No headlines are listed in this category right now. Try another category.", false);
      return;
    }
    wrap.innerHTML = `<div class="editorial-grid">${list.map(it => {
      const categories = (Array.isArray(it.cats) ? it.cats : []).map(c => CATLABEL[c] || c);
      const meta = [categories.length ? categories.join(" · ") : "", Number.isFinite(it.ts) && it.ts > 0 ? UI.relTime(it.ts) : ""].filter(Boolean);
      return `<a class="editorial-card" href="${UI.newsItemPath(it)}">
        <span class="editorial-card__title">${UI.esc(it.title)}</span>
        ${meta.length ? `<span class="editorial-card__meta">${meta.map(UI.esc).join(" · ")}</span>` : ""}
      </a>`;
    }).join("")}</div>
      <p class="prov-note">Open any headline for its own FlickAtlas article page — with the
      story, relevant facts and related titles and people presented here.</p>`;
  }
  UI.wireChips(main.querySelector("#chipHost"), (k) => { f = k; render(); });

  /* ---------- fallback: release-data updates, honestly framed ---------- */
  async function fallback() {
    const today = TMDB.today();
    const year = new Date().getFullYear();
    const in30 = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    const item = (m, type, headline, sub) => `
      <a class="editorial-card" href="/${type === "tv" ? "show" : "movie"}?id=${m.id}">
        <span class="editorial-card__title">${headline}</span><span class="editorial-card__meta">${sub}</span>
      </a>`;
    const group = (title, arr) => arr.length ? `<section class="section">
      <div class="section-head"><h2>${title}</h2></div><div class="editorial-grid">${arr.join("")}</div></section>` : "";
    const [nowPlaying, boList, upcoming, premieres] = await Promise.all([
      TMDB.nowPlaying(1).then(d => d.results || []).catch(() => []),
      TMDB.discoverResults("movie", { primary_release_year: year, sort_by: "revenue.desc", page: 1 }).catch(() => []),
      TMDB.upcomingMovies(1).then(d => d.results || []).catch(() => []),
      TMDB.discoverResults("tv", { "first_air_date.gte": today, "first_air_date.lte": in30, sort_by: "first_air_date.asc" }).catch(() => []),
    ]);
    const cinema = nowPlaying.filter(m => m.poster_path).slice(0, 8).map(m =>
      item(m, "movie", `${UI.esc(UI.titleOf(m))} is now in cinemas`,
        `Released ${UI.fmtDate(m.release_date)} · ${UI.esc(UI.industryTag(m))}${UI.rating(m) ? ` · Rated ${UI.rating(m)}/10` : ""}`));
    const boDetails = (await Promise.all(boList.slice(0, 6).map(m =>
      TMDB.details("movie", m.id).catch(() => null)))).filter(d => d && d.revenue > 0);
    const milestones = boDetails.map(d => {
      const v = UI.verdict(d.budget, d.revenue);
      return item(d, "movie", `${UI.esc(UI.titleOf(d))} has collected ${UI.fmtMoneyWords(d.revenue)} worldwide`,
        `${d.budget > 0 ? `Budget ${UI.fmtMoneyWords(d.budget)} · ` : ""}${v ? `Estimated verdict: ${v.label} · ` : ""}Released ${UI.fmtDate(d.release_date)}`);
    });
    const soon = upcoming.filter(m => m.poster_path && m.release_date >= today).slice(0, 8).map(m =>
      item(m, "movie", `${UI.esc(UI.titleOf(m))} releases on ${UI.fmtDate(m.release_date)}`,
        `${UI.esc(UI.industryTag(m))} · Opens ${UI.fmtDate(m.release_date)}`));
    const newSeries = premieres.filter(s => s.poster_path).slice(0, 6).map(s =>
      item(s, "tv", `${UI.esc(UI.titleOf(s))} premieres on ${UI.fmtDate(s.first_air_date)}`,
        `New series · ${UI.esc(UI.industryTag(s))}`));
    main.querySelector(".page-hero h1").textContent = "Latest Updates";
    const chipHost = main.querySelector("#chipHost");
    if (chipHost) chipHost.style.display = "none"; /* chips filter feed items; hiding them in fallback mode */
    fcount.textContent = "";
    wrap.innerHTML =
      group("Now in Cinemas", cinema) +
      group("Box Office Milestones", milestones) +
      group("Coming Soon", soon) +
      group("New Series Premieres", newSeries) ||
      UI.stateMsg("No updates available right now.", false);
  }

  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 9000);
    const r = await fetch("/api/news", { signal: ctl.signal });
    clearTimeout(to);
    if (!r.ok) throw new Error("news http " + r.status);
    const j = await r.json();
    if (!j.items || !j.items.length) throw new Error("news empty");
    items = j.items;
    render();
  } catch (e) {
    try { await fallback(); }
    catch (e2) { wrap.innerHTML = UI.stateMsg("Could not load the news right now. Please try again."); }
  }
})();
