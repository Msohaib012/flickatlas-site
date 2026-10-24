/* FlickAtlas — homepage: featured story, Bollywood first, mixed trending feed,
   box office, big coming-soon calendar, news, spotlight, Lollywood latest, K-Drama */
(async function () {
  UI.mountChrome("");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "FlickAtlas — Movie & TV Guide: Cast, Box Office, Budgets & Upcoming Releases",
    desc: "FlickAtlas is your global guide to movies and TV shows — full cast & crew, budgets vs box office earnings, upcoming release dates and celebrity filmographies for Bollywood, Hollywood, Lollywood and K-Drama.",
    path: "/",
    jsonld: { "@context": "https://schema.org", "@type": "WebSite",
      "name": "FlickAtlas", "url": CONFIG.BASE + "/",
      "description": "Global movie & TV information: cast, budgets, box office, upcoming releases and celebrity filmographies." }
  });

  main.innerHTML = `<div class="wrap">
    <div class="sk" style="height:340px;border-radius:22px;margin:26px 0 8px"></div>
    <section class="section"><div class="section-head"><h2>Spotlight</h2></div>
      <div class="scroller">${UI.skelCards(6)}</div></section>
  </div>`;

  const year = new Date().getFullYear();
  const today = TMDB.today();
  const cutoff = UI.freshCutoff();
  try {
    const [trendDayRaw, trendAll, bollyRecent, bollyUpcoming, upPages, people, lollyM, lollyT, lollyUr, lollyMP, lollyTP, kdramaRaw, nowPlaying] = await Promise.all([
      TMDB.trending("movie", "day"),
      TMDB.api("/trending/all/day").then(d => d.results || []).catch(() => []),
      /* Recent Bollywood releases stay inside the freshness window and use
         IN-origin Hindi results. Upcoming popularity-ranked releases are
         fetched separately below through FAMostAwaited, shared with the
         full page so the homepage See All cannot drift to a narrower pool. */
      Promise.all([1, 2, 3].map(p => TMDB.discoverResults("movie", { with_original_language: "hi", with_origin_country: "IN",
        sort_by: "primary_release_date.desc", "primary_release_date.gte": cutoff, "primary_release_date.lte": today, page: p })
        .catch(() => []))).then(pgs => pgs.flat()),
      FAMostAwaited.fetch("bollywood", { pages: 3 }),
      Promise.all([1, 2, 3].map(p => TMDB.upcomingMovies(p).then(d => d.results || []).catch(() => []))),
      TMDB.popularPeople(1).then(d => d.results || []),
      TMDB.discoverResults("movie", { with_origin_country: "PK", sort_by: "primary_release_date.desc", "primary_release_date.lte": today }),
      TMDB.discoverResults("tv", { with_origin_country: "PK", sort_by: "first_air_date.desc", "first_air_date.lte": today }),
      TMDB.discoverResults("movie", { with_original_language: "ur", sort_by: "primary_release_date.desc", "primary_release_date.lte": today }),
      /* widened PK pools (fix round 2, Bug D): popularity order too —
         the date-desc pools alone surfaced only a couple of titles */
      TMDB.discoverResults("movie", { with_origin_country: "PK", sort_by: "popularity.desc" }),
      TMDB.discoverResults("tv", { with_origin_country: "PK", sort_by: "popularity.desc" }),
      TMDB.discoverResults("tv", { with_original_language: "ko", with_origin_country: "KR", sort_by: "popularity.desc" }),
      TMDB.nowPlaying(1).then(d => d.results || []).catch(() => []),
    ]);
    const trendDay = (trendDayRaw || []).filter(UI.isFresh);
    /* Homepage = RECENCY-SORTED everywhere (correction 9): rails order by
       release/air date, newest first — never all-time popularity. */
    const kdrama = (kdramaRaw || []).filter(UI.isFresh)
      .sort((a, b) => (b.first_air_date || "").localeCompare(a.first_air_date || ""));
    const bollySeen = new Set();
    const bollyPop = [...bollyRecent, ...bollyUpcoming]
      .filter(x => x && x.poster_path && !bollySeen.has(x.id) && bollySeen.add(x.id))
      .sort((a, b) => {
        const da = a.release_date || "", db = b.release_date || "";
        const aUp = da > today, bUp = db > today;
        if (aUp !== bUp) return aUp ? 1 : -1;      /* released first … */
        return aUp ? da.localeCompare(db)          /* … upcoming nearest-first */
                   : db.localeCompare(da);         /* … released newest-first */
      });

    /* ---------- HERO = LIVE BOX-OFFICE CAROUSEL (§2.1, correction 6 —
       Sacnilk model): 3–4 slides, auto-sliding, Bollywood first. Slides
       with engine day-wise data lead: latest day collection + running
       total + "collections through {date}" label. Remaining slots fill
       with the top fresh Bollywood releases (facts only — no collection
       figures invented). Info links only; no play/watch button. ------- */
    const heroSlides = [];
    const dwData = window.FA_DAYWISE || {};
    for (const [dwId, rows] of Object.entries(dwData)) {
      if (!Array.isArray(rows) || !rows.length || heroSlides.length >= 4) continue;
      try {
        const d = await TMDB.details("movie", dwId);
        if (!d || !d.backdrop_path) continue;
        const total = rows.reduce((s, r) => s + (r.collection || 0), 0);
        const last = rows[rows.length - 1];
        heroSlides.push({ d, live: true, total, last, dayN: UI.dayNumOf(last) });
      } catch (e) {}
    }
    for (const x of bollyPop) {
      if (heroSlides.length >= 4) break;
      if (!x.backdrop_path) continue;
      if (heroSlides.some(s => String(s.d.id) === String(x.id))) continue;
      heroSlides.push({ d: x, live: false });
    }
    if (!heroSlides.length && trendDay[0]) heroSlides.push({ d: trendDay[0], live: false });

    const heroSlideHtml = (s, idx) => {
      const hd = s.d;
      const isBolly = hd.original_language === "hi";
      /* One single meta line (hero cleanup + mobile organisation): rating ·
         year · shortened genres, inline on one line — the genre part
         truncates, never wraps. Sits directly under the title. */
      const year = (hd.release_date || hd.first_air_date || "").slice(0, 4);
      const metaHtml = (hd.vote_average || year || (hd.genres && hd.genres.length)) ? `<div class="hero-meta">
          ${hd.vote_average ? `<span class="chip">${UI.star}${UI.ratingText(hd)}</span>` : ""}
          ${year ? `<span class="hero-year">${year}</span>` : ""}
          ${hd.genres && hd.genres.length ? `<span class="chip hero-genres">${UI.esc(hd.genres.map(g => g.name).slice(0, 2).join(", "))}</span>` : ""}
        </div>` : "";
      const stats = [];
      if (s.live) {
        stats.push([`Day ${s.dayN} Collection`, UI.fmtMoney(s.last.collection)]);
        stats.push(["Total So Far", UI.fmtMoney(s.total)]);
        if (hd.budget) stats.push(["Budget", UI.fmtMoneyWords(hd.budget)]);
        if (hd.revenue) stats.push(["Worldwide Box Office", UI.fmtMoneyWords(hd.revenue)]);
      } else {
        if (hd.release_date) stats.push(["Release Date", UI.fmtDate(hd.release_date)]);
        stats.push(["Status", hd.release_date && hd.release_date <= TMDB.today() ? "Now in Cinemas" : "Coming Soon"]);
      }
      /* Inline display styles (fix round 2, Bug A): slide visibility must
         NOT depend on the stylesheet alone — a stale cached CSS file left
         every slide visible at once on the user's phone. The inline style
         is authoritative; the .active class stays as backup + animation. */
      return `<div class="hero-card hero-slide${idx === 0 ? " active" : ""}" style="display:${idx === 0 ? "block" : "none"}">
        ${hd.backdrop_path ? `<div class="hero-bg"><img src="${UI.img(hd.backdrop_path, "w1280")}" alt="" ${idx === 0 ? 'fetchpriority="high"' : 'loading="lazy"'}></div>` : ""}
        <div class="hero-shade"></div>
        <div class="hero-in">
          <div class="hero-title-row"><div class="hero-title-copy">
          <span class="hero-kicker">${s.live ? `<span class="live-dot"></span>Live Box Office · ${isBolly ? "Bollywood" : "International"}` : `Featured · ${isBolly ? "Bollywood" : "Trending Today"}`}</span>
          <h1>${UI.esc(UI.titleOf(hd))}</h1>
          ${metaHtml}
          </div>${hd.poster_path ? `<img class="hero-mini-poster" data-movie-id="${hd.id}" src="${UI.img(hd.poster_path, "w342")}" alt="${UI.esc(UI.titleOf(hd))} poster" width="228" height="342" loading="${idx === 0 ? "eager" : "lazy"}" decoding="async" onerror="this.remove()">` : ""}</div>
          <p class="hero-syn">${UI.esc((hd.overview || "").slice(0, 200))}${(hd.overview || "").length > 200 ? "…" : ""}</p>
          ${stats.length ? `<div class="hero-stats">${stats.slice(0, 2).map(([k, v]) =>
            `<div><span>${k}</span><b>${UI.escRich(v)}</b></div>`).join("")}</div>` : ""}
          ${s.live && s.last.date ? `<span class="hero-updated">Collections updated through ${UI.fmtDate(s.last.date)}</span>` : ""}
          <div class="hero-actions">
            <a class="btn btn-teal" href="/movie?id=${hd.id}">Full Details</a>
          </div>
        </div>
      </div>`;
    };
    const heroHtml = heroSlides.length ? `<section class="hero" data-sec="hero"><div class="hero-carousel" id="heroCarousel">
      ${heroSlides.map(heroSlideHtml).join("")}
      ${heroSlides.length > 1 ? `<div class="hero-dots">${heroSlides.map((_, i) =>
        `<button type="button" data-slide="${i}" class="${i === 0 ? "on" : ""}" aria-label="Show slide ${i + 1}"></button>`).join("")}</div>` : ""}
    </div></section>` : "";

    /* ---------- Bollywood block (leads the page; fix round 2, Bug F:
       Bollywood is FIRST and more than half the homepage — two full
       Bollywood rails + the Bollywood-led news and box office blocks
       below, before any international section appears) ---------- */
    const rowSection = (title, href, inner, sub, sec) => inner ? `
      <section class="section" data-sec="${sec || ""}"><div class="section-head"><h2>${title}</h2>
      <a class="see-all" href="${href}">See All →</a></div>
      ${sub ? `<p class="sec-sub">${sub}</p>` : ""}${inner}</section>` : "";
    const scrollerOf = (items, type, tagged, limit) => items && items.length
      ? `<div class="scroller">${items.slice(0, limit || 14).map(x => UI.posterCard(x, type, tagged ? UI.industryTag(x) : "")).join("")}</div>` : "";
    const bollyReleased = bollyPop.filter(x => (x.release_date || "") <= today && x.release_date);
    const bollySoon = bollyUpcoming.filter(x => x && x.poster_path && x.release_date > today);
    const switchButtons = (id) => `<div class="home-industry-switchers" role="group" aria-label="Choose industry" data-switcher="${id}">${[["bollywood","Bollywood"],["international","International / Hollywood"]].map(([v,l],i)=>`<button type="button" class="chip home-industry-switch${i===0?" active":""}" data-industry="${v}" aria-pressed="${i===0}">${l}</button>`).join("")}</div>`;
    const bollyHtml = `<section class="section" data-sec="bollywood-spotlight" id="homeSpotlight"><div class="section-head"><h2>Spotlight</h2><a class="see-all" href="/movies?f=bollywood&s=recent&seeall=1">See All →</a></div>${switchButtons("spotlight")}<p class="sec-sub">Newest released films first; filter by industry.</p><div class="scroller" data-results>${scrollerOf(bollyReleased, "movie", false, 20)?.replace(/^<div class="scroller">|<\/div>$/g,"") || ""}</div></section>`;
    const bollySoonHtml = `<section class="section" data-sec="bollywood-soon" id="homeSoon"><div class="section-head"><h2>Coming Soon &amp; Most Awaited</h2><a class="see-all" href="/most-awaited?f=bollywood">See All →</a></div>${switchButtons("soon")}<p class="sec-sub">Ranked by TMDB popularity, not release date or audience demand; dates may change.</p><div class="scroller" data-results>${bollySoon.slice(0,20).map((x,i)=>UI.posterCard(x,"movie","",i+1)).join("")}</div></section>`;

    /* ---------- Global daily trending — preserve TMDB API worldwide order. */
    const mixed = (trendDay || []).filter(x => x && x.poster_path).slice(0, 20);
    const mixedHtml = rowSection("Trending Worldwide", "/movies?f=all&seeall=1",
      mixed.length ? `<div class="scroller">${mixed.map((x, i) => UI.posterCard(x, "movie", UI.industryTag(x), i + 1)).join("")}</div>` : "",
      "Worldwide titles trending today; ordered by the feed.",
      "mixed-trending");
    /* Live source phrases are rendered independently; no hardcoded trend list. */
    const searchesHtml = `<section class="section" data-sec="trending-searches" id="homeTrendingSearches"><h2>Trending Searches</h2><p role="status">Loading trend feed…</p></section>`;

    /* ---------- Celebrities: engine-fed "Celebrity Today" when the data
       engine's v2-classified items are fresh (< 24h — enforced inside
       UI.celebTodaySection), otherwise the honest fallback below.
       Spotlight = TMDB popularity (the most popular names + their latest
       work) and is NEVER labelled "today" (§14 honesty rule). ---------- */
    const spotlight = people.slice(0, 8).map(p => {
      const kf = (p.known_for || []).slice()
        .sort((a, b) => (b.release_date || b.first_air_date || "").localeCompare(a.release_date || a.first_air_date || ""))[0];
      const line = kf
        ? `Latest: ${kf.title || kf.name}${(kf.release_date || kf.first_air_date) ? ` (${(kf.release_date || kf.first_air_date).slice(0, 4)})` : ""}`
        : (p.known_for_department || "");
      return { p, line };
    }).filter(x => x.p);
    const spotlightHtml = spotlight.length ? `<section class="section">
      <div class="section-head"><h2>Celebrities in Spotlight</h2>
      <a class="see-all" href="/celebrities">See All →</a></div>
      <p style="color:var(--muted);margin:-6px 0 14px;max-width:70ch">Popular celebrities and recent credits; profile details vary by available data.</p>
      <div class="people-row">${spotlight.map(({ p, line }) => UI.personCard(p, line)).join("")}</div></section>` : "";
    const celebTodayMarkup = UI.celebTodaySection(window.FA_CELEBRITY_TODAY);
    /* Keep the shared helper's filters, event URLs and factual labels; only switch its row wrappers to the scoped card treatment. */
    const celebTodayHtml = celebTodayMarkup
      ? celebTodayMarkup.replaceAll('class="news-list"', 'class="editorial-grid"').replaceAll('class="news-item"', 'class="editorial-card"')
      : spotlightHtml;

    /* Latest released films: dated reported collections stay separate from lifetime gross. */
    const boHtml = `<section class="section" data-sec="box-office">
      <div class="section-head"><h2>Box Office</h2>
      <a class="see-all" href="/box-office">See All →</a></div>
      <div id="homeLatestBoxOffice"><p class="bo-help" role="status">Loading the latest movie collections…</p></div>
    </section>`;

    /* ---------- coming soon: a DAILY release calendar (correction 8d).
       Root cause of the old date gaps: the rail used ONLY the theatrical
       "upcoming movies" list (popularity-clustered dates). Now the pool
       merges upcoming movies + Hindi-window movies + TV premieres over
       the next 45 days, grouped by date, up to 3 entries per day — so
       days fill the way real release days do. Nearest date first. ----- */
    const upWinEnd = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
    const W = { "primary_release_date.gte": today, "primary_release_date.lte": upWinEnd };
    const WT = { "first_air_date.gte": today, "first_air_date.lte": upWinEnd };
    const [upHindi, upIn, upMAsc, upTv1, upTv2, upTv3, upTvA1, upTvA2] = await Promise.all([
      TMDB.discoverResults("movie", { with_original_language: "hi", sort_by: "popularity.desc", ...W }).catch(() => []),
      TMDB.discoverResults("movie", { region: "IN", sort_by: "popularity.desc", ...W }).catch(() => []),
      TMDB.discoverResults("movie", { sort_by: "primary_release_date.asc", ...W }).catch(() => []),
      TMDB.discoverResults("tv", { sort_by: "popularity.desc", ...WT }).catch(() => []),
      TMDB.discoverResults("tv", { sort_by: "popularity.desc", page: 2, ...WT }).catch(() => []),
      TMDB.discoverResults("tv", { sort_by: "popularity.desc", page: 3, ...WT }).catch(() => []),
      TMDB.discoverResults("tv", { sort_by: "first_air_date.asc", ...WT }).catch(() => []),
      TMDB.discoverResults("tv", { sort_by: "first_air_date.asc", page: 2, ...WT }).catch(() => []),
    ]);
    const upSeen = new Set();
    const upPool = [];
    const pushUp = (arr, type) => (arr || []).forEach(x => {
      const date = type === "tv" ? x.first_air_date : x.release_date;
      const key = type + x.id;
      if (x.poster_path && date && date >= today && date <= upWinEnd && x.original_language === "hi" && !upSeen.has(key) && upSeen.add(key)) {
        upPool.push({ x, type, date });
      }
    });
    pushUp(upPages.flat(), "movie");
    pushUp(upHindi, "movie");
    pushUp(upIn, "movie");
    pushUp(upMAsc, "movie");
    pushUp(upTv1, "tv"); pushUp(upTv2, "tv"); pushUp(upTv3, "tv");
    pushUp(upTvA1, "tv"); pushUp(upTvA2, "tv");
    const upByDay = new Map();
    for (const e of upPool) {
      if (!upByDay.has(e.date)) upByDay.set(e.date, []);
      upByDay.get(e.date).push(e);
    }
    const upList = [];
    for (const date of [...upByDay.keys()].sort()) {
      if (upList.length >= 16) break;
      const dayItems = upByDay.get(date)
        .sort((a, b) => ((b.x.original_language === "hi") - (a.x.original_language === "hi"))
          || ((b.x.popularity || 0) - (a.x.popularity || 0))).slice(0, 3);
      upList.push(...dayItems);
    }
    const MONTHS_S = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const calendarRow = (x,type,date) => { const [, mm, dd] = date.split("-"); return `<a class="tl-row" href="/${type === "tv" ? "show" : "movie"}?id=${x.id}"><span class="tl-date"><b>${parseInt(dd,10)}</b><span>${MONTHS_S[parseInt(mm,10)-1]}</span></span><img src="${UI.img(x.poster_path,"w92")}" alt="" loading="lazy" onerror="this.remove()"><span class="tl-info"><b>${UI.esc(UI.titleOf(x))}</b><span>${type === "tv" ? "Premieres " : ""}${UI.fmtDate(date)}${UI.rating(x) ? ` · ${UI.rating(x)}/10` : ""}</span></span><span class="tag-chip">${UI.esc(UI.industryTag(x))}</span></a>`; };
    const upHtml = `<section class="section" data-sec="coming-soon" id="homeCalendar">
      <div class="section-head"><h2>Coming Soon — Release Calendar</h2>
      <a class="see-all" href="/upcoming?f=bollywood&s=nearest&seeall=1">See All →</a></div>
      ${switchButtons("calendar")}
      <p class="sec-sub">Announced film and series dates, nearest first; dates may change.</p>
      <div class="tl-list" data-results>
        ${upList.length ? upList.map(({x,type,date})=>calendarRow(x,type,date)).join("") : '<p role="status">No confirmed Bollywood releases found in this window.</p>'}
      </div></section>`;

    /* ---------- Trending News (§2.7): real headlines from the registry's
       live feeds via /api/news, newspaper-native rows. Filled in after first
       paint so feeds never block the page. If the feed service is down, the
       strip falls back to release-data briefs titled "Latest Updates" —
       updates are never dressed up as reported news (§3 honesty clause). */
    const newsHtml = `<section class="section" id="homeNews" data-sec="news">
      <div class="section-head"><h2>Trending News</h2>
      <a class="see-all" href="/news">See All →</a></div>
      <p class="sec-sub">Recent headlines, Bollywood first; release updates may appear if headlines are unavailable.</p>
      <div class="sk" style="height:120px;border-radius:14px"></div></section>`;
    const fillHomeNews = async () => {
      const host = document.getElementById("homeNews");
      if (!host) return;
      const briefsFallback = () => {
        const items = nowPlaying.filter(m => m.poster_path).slice(0, 3);
        if (!items.length) { host.remove(); return; }
        host.innerHTML = `<div class="section-head"><h2>Latest Updates</h2>
          <a class="see-all" href="/news">See All →</a></div>
          <p class="sec-sub">Recent headlines, Bollywood first; release updates may appear if headlines are unavailable.</p>
          <div class="editorial-grid">${items.map(m => `
          <a class="editorial-card" href="/movie?id=${m.id}">
            <span class="editorial-card__title">${UI.esc(UI.titleOf(m))} is now in cinemas</span>
            <span class="editorial-card__meta">Released ${UI.fmtDate(m.release_date)}${UI.rating(m) ? ` · Rated ${UI.rating(m)}/10` : ""} · ${UI.esc(UI.industryTag(m))}</span>
          </a>`).join("")}</div>`;
      };
      try {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 8000);
        const r = await fetch("/api/news", { signal: ctl.signal });
        clearTimeout(to);
        if (!r.ok) throw new Error("news http " + r.status);
        const j = await r.json();
        const allItems = j.items || [];
        /* Bollywood-led (fix round 2, Bug F): Bollywood headlines lead
           the homepage news block, then celebrity, then the rest — each
           group newest first. Ten rows: this block carries weight. */
        const rank = (x) => (x.cats || []).includes("bollywood") ? 0 : (x.cats || []).includes("celebrity") ? 1 : 2;
        const items = allItems.slice()
          .sort((a, b) => rank(a) - rank(b) || (b.ts || 0) - (a.ts || 0)).slice(0, 10);
        /* Viral stream mixes into Trending News (correction 7): if a
           viral item exists and none made the top rows, it takes the
           last slot — labelled by its Viral tag on the news hub. */
        const viralItem = allItems.find(x => (x.cats || []).includes("viral"));
        if (viralItem && items.length && !items.some(x => (x.cats || []).includes("viral"))) items[items.length - 1] = viralItem;
        if (!items.length) throw new Error("news empty");
        host.innerHTML = `<div class="section-head"><h2>Trending News</h2>
          <a class="see-all" href="/news">See All →</a></div>
          <p class="sec-sub">Recent headlines, Bollywood first; release updates may appear if headlines are unavailable.</p>
          <div class="editorial-grid">${items.map(it => {
            const cats = (Array.isArray(it.cats) ? it.cats : []).map(c => ({ bollywood: "Bollywood", international: "International", pakistan: "Pakistan", korea: "Korea", celebrity: "Celebrity", viral: "Viral" }[c] || c));
            const meta = [cats.length ? cats.join(" · ") : "", Number.isFinite(it.ts) && it.ts > 0 ? UI.relTime(it.ts) : ""].filter(Boolean);
            return `<a class="editorial-card" href="${UI.newsItemPath(it)}">
              <span class="editorial-card__title">${UI.esc(it.title)}</span>
              ${meta.length ? `<span class="editorial-card__meta">${meta.map(UI.esc).join(" · ")}</span>` : ""}
            </a>`;
          }).join("")}</div>`;
      } catch (e) { briefsFallback(); }
    };

    /* ---------- Lollywood: LATEST Pakistani releases only ---------- */
    const mergeLatest = (movies, tvs, extraMovies, extraTv) => {
      const pool = [];
      const push = (arr, type) => (arr || []).forEach(x => { if (x.poster_path) pool.push({ x, type, date: x.release_date || x.first_air_date || "" }); });
      push(movies, "movie"); push(tvs, "tv");
      push(extraMovies, "movie"); push(extraTv, "tv");
      const s = new Set();
      return pool.filter(p => !s.has(p.x.id + p.type) && s.add(p.x.id + p.type))
        .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14);
    };
    const lollyLatest = mergeLatest(
      (lollyM || []).filter(UI.isFresh), (lollyT || []).filter(UI.isFresh),
      [...(lollyUr || []), ...(lollyMP || [])].filter(UI.isFresh),
      (lollyTP || []).filter(UI.isFresh)).slice(0, 8);
    /* Note: the PK *drama* rail below is filled from the channel pool
       (PK.pool) after first paint — see fillPkSections. */
    const lollyHtml = lollyLatest.length ? `<section class="section" data-sec="lollywood">
      <div class="section-head"><h2>Lollywood — Latest Pakistani Releases</h2>
      <a class="see-all" href="/category?cat=lollywood">See All →</a></div>
      <p class="sec-sub">Recent Pakistani films and dramas with listed dates; newest first.</p>
      <div class="scroller">${lollyLatest.map(p => UI.posterCard(p.x, p.type, p.type === "tv" ? "Pakistani Drama" : "Pakistani Film")).join("")}</div></section>` : "";

    /* Pakistani dramas rail + episode strip (fix round 2, Bug D): filled
       after first paint from the channel-attributed pool (js/pk-dramas.js)
       — the dramas actually running on HUM TV, ARY Digital, Geo TV and
       Green TV right now, each card labelled with its channel and latest
       episode. Falls back to the plain latest-dramas rail if the pool is
       empty. */
    const pkRailHtml = `<section class="section" id="homePk" data-sec="pk-dramas">
      <div class="section-head"><h2>Pakistani YouTube Dramas — Latest</h2>
      <a class="see-all" href="/episode-guides">Episode Guides →</a></div>
      <p class="sec-sub">Listed dramas from HUM TV, ARY Digital, Geo TV and Green TV; details vary.</p>
      <div class="sk" style="height:180px;border-radius:14px"></div></section>`;
    const epStripHtml = `<section class="section" id="homeEpStrip" data-sec="episode-strip">
      <div class="section-head"><h2>Latest TV Episodes</h2>
      <a class="see-all" href="/episode-guides">All Guides →</a></div>
      <p class="sec-sub">Dated episodes across regions; coverage is not complete.</p>
      <div id="homeEpisodeBrowser"><div class="sk" style="height:140px;border-radius:14px"></div></div></section>`;
    const fillPkSections = async () => {
      const rail = document.getElementById("homePk");
      const strip = document.getElementById("homeEpStrip");
      if (strip && window.EpisodeBrowser) EpisodeBrowser.mount(strip.querySelector("#homeEpisodeBrowser"), {region:"all", limit:5, showFilters:false}).catch(() => {});
      try {
        if (!window.PK) throw new Error("pk pool unavailable");
        let pool = await PK.pool().catch(() => []);
        if (!pool.length) {
          /* one retry after the page's first burst settles — a transient
             failure must not cost the rail for the whole session */
          await new Promise(r => setTimeout(r, 5000));
          pool = await PK.pool(true).catch(() => []);
        }
        if (!pool.length) throw new Error("pk pool empty");
        if (rail) {
          rail.innerHTML = `<div class="section-head"><h2>Pakistani YouTube Dramas — Latest</h2>
            <a class="see-all" href="/episode-guides">Episode Guides →</a></div>
            <p class="sec-sub">Currently running dramas from HUM TV, ARY Digital, Geo TV and Green TV; open a card for details.</p>
            <div class="scroller">${pool.slice(0, 6).map(r => {
              const le = r.lastEp;
              const tag = le ? `${r.channel} · Episode ${le.episode_number}` : r.channel;
              return UI.posterCard(r.item, "tv", tag);
            }).join("")}</div>`;
        }
        if (false && strip) {
          const rows = pool.slice(0, 5).map(r => {
            const ep = (r.nextEp && r.nextEp.air_date === TMDB.today()) ? r.nextEp : r.lastEp;
            if (!ep) return "";
            return `<a class="ep-row" href="${PK.epHref(r.item.id, ep)}">
              <span class="ep-num">${ep.episode_number}</span>
              ${ep.still_path ? `<img src="${UI.img(ep.still_path, "w300")}" alt="" loading="lazy" onerror="this.remove()">` : ""}
              <span class="ep-info"><b>${UI.esc(UI.titleOf(r.item))} — Episode ${ep.episode_number}${ep.name ? `: ${UI.esc(ep.name)}` : ""}</b>
              <span>${r.channel}${ep.air_date ? ` · ${UI.fmtDate(ep.air_date)}` : ""}${r.airingToday ? " · Airs today" : ""}</span></span>
              <span class="tag-chip">${UI.esc(r.channel)}</span>
            </a>`;
          }).filter(Boolean).join("");
          if (rows) {
            strip.innerHTML = `<div class="section-head"><h2>Episode Guides — Latest Episodes & What's Airing</h2>
              <a class="see-all" href="/episode-guides">All Guides →</a></div>
              <p class="sec-sub">Recent Pakistani episodes, newest first; <a href="/airing-today"><b>see today's full line-up</b></a>.</p>
              <div class="ep-list">${rows}</div>`;
          } else strip.remove();
        }
      } catch (e) {
        /* fallback: the plain latest-dramas rail (date-desc pool) */
        const ytDramas = (lollyT || []).filter(s => s.poster_path && UI.isFresh(s)).slice(0, 8);
        if (rail) {
          if (ytDramas.length) {
            rail.innerHTML = `<div class="section-head"><h2>Pakistani YouTube Dramas — Latest</h2>
              <a class="see-all" href="/episode-guides">Episode Guides →</a></div>
              <p class="sec-sub">Newest Pakistani drama titles; open a card for cast and episode details.</p>
              <div class="scroller">${ytDramas.map(s => UI.posterCard(s, "tv", "Pakistani Drama")).join("")}</div>`;
          } else rail.remove();
        }
        /* Keep the all-region browser visible even when curated PK data is unavailable. */
      }
    };

    const kdramaHtml = rowSection("K-Drama Corner", "/category?cat=kdrama",
      scrollerOf(kdrama.slice(0, 6), "tv", false),
      "Recent Korean dramas; cast and episode details vary by available data.",
      "kdrama");

    /* ---------- Awards strip (fix round 2, Bug F): the next dated
       ceremonies — mirrors the verified SHOWS data in js/page-awards.js
       (dates checked against the organisers, 2026-10-23); undated shows
       stay on the Awards hub, where they are labelled TBA. ---------- */
    const awardsStripHtml = `<section class="section" data-sec="awards">
      <div class="section-head"><h2>Awards — Coming Up</h2>
      <a class="see-all" href="/awards">See All →</a></div>
      <p class="sec-sub">Organiser-confirmed dates only.</p>
      <div class="tl-list">${[
        ["2026-11-15", "Governors Awards", "Honorary Oscars · Ray Dolby Ballroom, Hollywood"],
        ["2027-01-10", "Golden Globe Awards", "84th edition · Host: Nikki Glaser · Beverly Hilton, Beverly Hills"],
        ["2027-03-14", "Academy Awards — The Oscars", "99th edition · Host: Conan O'Brien · Dolby Theatre, Hollywood"],
      ].map(([dt, nm, note]) => `
        <a class="tl-row" href="/awards">
          <span class="tl-date"><b>${parseInt(dt.slice(8, 10), 10)}</b><span>${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][parseInt(dt.slice(5, 7), 10) - 1]}</span></span>
          <span class="tl-info"><b>${nm}</b><span>${UI.fmtDate(dt)} · ${note}</span></span>
        </a>`).join("")}
      </div></section>`;

    /* ---------- async strips: birthdays / OTT / trailers / viral ----
       Filled after first paint (same pattern as the news block); each
       hides itself when its data genuinely has nothing today. -------- */
    const birthdaysHtml = `<section class="section" id="homeBirthdays" data-sec="birthdays" hidden></section>`;
    const fillBirthdays = async () => {
      const host = document.getElementById("homeBirthdays");
      if (!host) return;
      try {
        const md = new Date().toISOString().slice(5, 10);
        const yearNow = new Date().getFullYear();
        const found = [];
        await Promise.all((people || []).slice(0, 20).map(async (p) => {
          try {
            const d = await TMDB.person(p.id);
            if (d && d.birthday && d.birthday.slice(5) === md) {
              found.push({ p, born: d.birthday, age: yearNow - Number(d.birthday.slice(0, 4)) });
            }
          } catch (e) {}
        }));
        if (!found.length) { host.remove(); return; }
        host.hidden = false;
        host.innerHTML = `<div class="section-head"><h2>Celebrity Birthdays Today</h2>
          <a class="see-all" href="/celebrities">See All →</a></div>
          <p class="sec-sub">Today’s listed birthdays; open a profile for credits.</p>
          <div class="people-row">${found.map(({ p, age }) => UI.personCard(p, age ? `Turns ${age} today` : "Birthday today")).join("")}</div>`;
      } catch (e) { host.remove(); }
    };

    const ottHtml = `<section class="section" id="homeOtt" data-sec="ott">
      <div class="section-head"><h2>OTT Releases This Week</h2>
      <a class="see-all" href="/ott">See All →</a></div>
      <p class="sec-sub">India arrivals this week; platform data may be unavailable.</p>
      <div class="sk" style="height:120px;border-radius:14px"></div></section>`;
    const fillOtt = () => FlickAtlasOTT.mount(document.getElementById("homeOtt"), {heading:true,limit:4});
    /* ---------- explore tiles: every category, one clean grid ---------- */
    const TILES = [
      ["Movies", "Every film worth knowing — cast, story, budget and box office.", "/movies"],
      ["TV & Web Series", "Series with seasons, episode guides, cast and ratings.", "/tv"],
      ["Cast & Celebrities", "Biographies, photos and complete filmographies.", "/celebrities"],
      ["Box Office", "Budgets vs worldwide collections, ranked and analysed.", "/box-office"],
      ["Upcoming & Release Dates", "The release calendar — what is coming, and exactly when.", "/upcoming"],
      ["Coming Soon & Most Awaited", "Upcoming titles ranked by TMDB popularity, with listed release dates.", "/most-awaited?f=bollywood"],
      ["Episode Guides", "Episode-by-episode guides for the latest Pakistani dramas.", "/episode-guides"],
      ["Where to Watch", "Which platform carries a title in your country — information only.", "/where-to-watch"],
      ["OTT Releases This Week", "Films and series newly arrived on streaming, with their platforms.", "/ott"],
      ["Awards", "Upcoming award shows with verified dates, plus awards news.", "/awards"],
      ["Industry News", "Release and box-office updates from across the industries.", "/news"],
      ["Bollywood", "Hindi cinema — the biggest stars, openings and collections.", "/category?cat=bollywood"],
      ["Lollywood", "The latest Pakistani films and dramas, newest first.", "/category?cat=lollywood"],
      ["Pakistani YouTube Dramas", "Pakistan's YouTube drama scene — latest titles and full cast details.", "/category?cat=lollywood"],
      ["K-Drama", "Korean drama and film, with cast and episode guides.", "/category?cat=kdrama"],
    ];
    /* Homepage order (MASTER-STRUCTURE §2 as amended by fix round 2,
       Bug F — Bollywood FIRST and more than half the page):
       hero → Bollywood Spotlight → Bollywood Coming Soon → Celebrity
       Today → Box Office → mixed trending (2:1 Bollywood) →
       Coming Soon calendar → Trending Searches → International →
       Pakistani dramas → episode strip → Lollywood → K-Drama →
       Trending News (Bollywood-led) → birthdays → OTT → trailers →
       awards → viral → explore tiles. (Audit round, ORDER G: Celebrity
       Today and Trending News swapped slots at the owner's order.)
       ("Star Spotlight" stays removed by user order.) */
    main.innerHTML = `<div class="wrap">
      ${heroHtml}
      ${bollyHtml}
      ${bollySoonHtml}
      ${celebTodayHtml}
      ${boHtml}
      ${mixedHtml}
      ${upHtml}
      ${searchesHtml}
      ${newsHtml}
      ${birthdaysHtml}
      ${ottHtml}
      ${awardsStripHtml}
      ${epStripHtml}
      ${lollyHtml}
      ${pkRailHtml}
      ${kdramaHtml}
    </div>`;
    if (window.OfficialTrailers) OfficialTrailers.watchUpcoming(document.getElementById("homeSoon"));
    if (window.FARailScroll) window.FARailScroll.enhance(document.querySelectorAll("#homeSpotlight .scroller, #homeSoon .scroller"));

    // Shared, lazy industry switcher. Query only after a non-default tab is chosen.
    const industrySpecs = {
      international: [{lang:"en"},{lang:"ko"}],
      pakistan: [{country:"PK"}]
    };
    const industryItems = async (industry, kind, from, to) => {
      const types = kind === "spotlight" ? ["movie"] : ["movie","tv"];
      const jobs = [];
      for (const type of types) for (const spec of industrySpecs[industry]) {
        const dKey = type === "tv" ? "first_air_date" : "primary_release_date";
        const dates = kind === "spotlight" ? { [dKey+".gte"]: cutoff, [dKey+".lte"]: today } : { [dKey+".gte"]: from, [dKey+".lte"]: to };
        const params = { sort_by: kind === "spotlight" ? dKey+".desc" : kind === "soon" ? "popularity.desc" : dKey+".asc", ...dates };
        if (spec.lang) params.with_original_language = spec.lang;
        if (spec.country) params.with_origin_country = spec.country;
        jobs.push(TMDB.discoverResults(type, params).then(xs => (xs||[]).map(x=>({...x,media_type:type,...(spec.country ? {_countryQuery:spec.country} : {})}))));
      }
      const settled = await Promise.allSettled(jobs);
      if (settled.every(x=>x.status === "rejected")) throw new Error("release_data_unavailable");
      const all = settled.filter(x=>x.status === "fulfilled").flatMap(x=>x.value).filter(x => { const date=x.release_date||x.first_air_date; return x.poster_path && window.FABoxOffice.helpers.validDate(date) && (kind === "spotlight" ? date >= cutoff && date <= today : date >= from && date <= to) && (industry !== "pakistan" || x._countryQuery === "PK" || (x.origin_country||[]).includes("PK")); });
      const seen = new Set();
      return all.filter(x=>{const k=x.media_type+":"+x.id;if(seen.has(k))return false;seen.add(k);return true;})
        .sort((a,b)=> { const da=a.release_date||a.first_air_date||"", db=b.release_date||b.first_air_date||""; return kind === "spotlight" ? db.localeCompare(da) : kind === "soon" ? (b.popularity||0)-(a.popularity||0) || da.localeCompare(db) : da.localeCompare(db); });
    };
    const industryLabel = i => i === "international" ? "International / Hollywood" : i === "pakistan" ? "Pakistan" : "Bollywood";
    const homeStateKey = kind => ({spotlight:"hs",soon:"hn",calendar:"hc"}[kind]);
    const initialHomeState = kind => { const v=new URL(location.href).searchParams.get(homeStateKey(kind)); return v === "international" ? v : "bollywood"; };
    document.querySelectorAll("[data-switcher]").forEach(group => {
      const section=group.closest("section"), kind=group.dataset.switcher, result=section.querySelector("[data-results]"), link=section.querySelector(".see-all"), stateKey=homeStateKey(kind);
      let generation=0;
      const activate=async(industry,persist)=>{
        group.querySelectorAll("button").forEach(btn=>{const on=btn.dataset.industry===industry;btn.setAttribute("aria-pressed",String(on));btn.classList.toggle("active",on);});
        if(persist){const u=new URL(location.href);if(industry==="bollywood")u.searchParams.delete(stateKey);else u.searchParams.set(stateKey,industry);history.pushState(null,"",u);}
        const token=++generation;
        section.querySelector("h2").textContent=kind==="spotlight"?"Spotlight":kind==="soon"?"Coming Soon & Most Awaited":"Release Calendar";
        link.href=kind==="spotlight"?`/movies?f=${industry}&s=recent&seeall=1`:kind==="soon"?`/most-awaited?f=${industry}`:`/upcoming?f=${industry}&s=nearest&seeall=1`;
        section.querySelector(".sec-sub").textContent=kind==="spotlight"?"Browse released movies, newest first · "+industryLabel(industry):kind==="soon"?"Upcoming titles ranked by TMDB popularity, not by release date · "+industryLabel(industry):"Announced film and series dates, nearest first · "+industryLabel(industry);
        if(industry==="bollywood"){
          if(kind==="spotlight")result.innerHTML=bollyReleased.slice(0,20).map(x=>UI.posterCard(x,"movie","")).join("");
          else if(kind==="soon")result.innerHTML=bollySoon.slice(0,16).map(x=>UI.posterCard(x,"movie","")).join("");
          else result.innerHTML=upList.length?upList.map(({x,type,date})=>calendarRow(x,type,date)).join(""):'<p role="status">No confirmed Bollywood releases found in this window.</p>';
          if(!result.innerHTML)result.innerHTML='<p role="status">No matching titles found.</p>';return;
        }
        result.innerHTML='<p role="status">Loading verified release data…</p>';
        try{const from=TMDB.today(),to=new Date(Date.now()+(kind==="soon"?365:60)*864e5).toISOString().slice(0,10),items=await industryItems(industry,kind,from,to);if(token!==generation)return;
          if(kind==="calendar")result.innerHTML=items.slice(0,16).map(x=>calendarRow(x,x.media_type,x.release_date||x.first_air_date)).join("");
          else result.innerHTML=items.slice(0,kind==="spotlight"?20:16).map(x=>UI.posterCard(x,x.media_type,"")).join("");
          if(!result.innerHTML)result.innerHTML='<p role="status">No matching releases found in the requested date window.</p>';
        }catch(e){if(token===generation)result.innerHTML='<p role="status">Release data could not be loaded. Please try again.</p>';}
      };
      group.addEventListener("click",ev=>{const btn=ev.target.closest("button[data-industry]");if(btn)activate(btn.dataset.industry,true);});
      const key=stateKey, initial=new URL(location.href).searchParams.get(key)==="international"?"international":"bollywood";activate(initial,false);
      window.addEventListener("popstate",()=>activate(new URL(location.href).searchParams.get(key)==="international"?"international":"bollywood",false));
    });
    fillHomeNews();
    fillPkSections();
    fillBirthdays();
    fillOtt();

    if (window.FABoxOffice) window.FABoxOffice.mount(document.getElementById("homeLatestBoxOffice"), { homepage: true });
    if (window.FATrendingSearches) window.FATrendingSearches.mount(document.getElementById("homeTrendingSearches"), {
      context: { bollywood: bollyRecent.map(x => ({ ...x, _query_origin_country: "IN" })), international: trendAll, pakistan: [...lollyM, ...lollyT, ...lollyMP, ...lollyTP], kdrama, people },
      lookup: q => TMDB.searchMulti(q), details: (type, id) => TMDB.details(type, id)
    });

    /* Hero carousel: auto-slide every 5.5s, dots jump, pause on hover */
    (function heroCarousel() {
      const car = document.getElementById("heroCarousel");
      if (!car) return;
      const slides = [...car.querySelectorAll(".hero-slide")];
      const dots = [...car.querySelectorAll(".hero-dots button")];
      if (slides.length < 2) return;
      let cur = 0, timer = null;
      const go = (n) => {
        slides[cur].classList.remove("active");
        slides[cur].style.display = "none";
        if (dots[cur]) dots[cur].classList.remove("on");
        cur = (n + slides.length) % slides.length;
        slides[cur].classList.add("active");
        slides[cur].style.display = "block";
        if (dots[cur]) dots[cur].classList.add("on");
      };
      const start = () => { timer = setInterval(() => go(cur + 1), 5500); };
      const stop = () => { if (timer) clearInterval(timer); timer = null; };
      dots.forEach((d, i) => d.addEventListener("click", () => { stop(); go(i); start(); }));
      /* Touch swipe (audit round): left = next slide, right = previous.
         Only a clearly-horizontal gesture counts (>40px with the
         horizontal movement dominating the vertical by 1.5x), so
         vertical page scrolling is never hijacked; taps on the dots and
         the slide's links keep working, and a real swipe swallows the
         synthetic click it would otherwise trigger on a link. After a
         manual swipe the auto-slide timer resets exactly like a dot
         click (stop → go → start). */
      let tX = null, tY = null, swiped = false;
      car.addEventListener("touchstart", (e) => {
        if (e.touches.length !== 1) { tX = null; return; }
        tX = e.touches[0].clientX; tY = e.touches[0].clientY;
      }, { passive: true });
      car.addEventListener("touchend", (e) => {
        if (tX === null || !e.changedTouches.length) return;
        const dx = e.changedTouches[0].clientX - tX;
        const dy = e.changedTouches[0].clientY - tY;
        tX = null;
        if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        /* preventDefault on a confirmed swipe kills the browser's
           synthetic click at the source (the capture-click guard below
           is the backstop — a delayed synthetic click outlived a short
           guard window in testing and navigated via a slide link). */
        e.preventDefault();
        swiped = true;
        setTimeout(() => { swiped = false; }, 800);
        stop(); go(cur + (dx < 0 ? 1 : -1)); start();
      }, { passive: false });
      car.addEventListener("click", (e) => {
        if (swiped) { e.preventDefault(); e.stopPropagation(); swiped = false; }
      }, true);
      car.addEventListener("pointerenter", stop);
      car.addEventListener("pointerleave", start);
      start();
    })();
  } catch (e) {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("Could not load the homepage right now. Please check your connection and try again.")}</div>`;
  }
})();
