/* FlickAtlas — homepage (PUBLISHED-ONLY, 2026-10-25): every movie/TV
   section reads window.FA_PUBLISHED (the pipeline-written catalogue of
   titles sohaib chose to publish) and NEVER fetches a live TMDB
   catalogue for its items. Hero = FA_DAYWISE box office + the published
   title's baked-in art. News = /api/news (the same feed /news renders).
   Celebrity Today =
   FA_CELEBRITY_TODAY. Sections with zero published items render nothing
   — no empty shell, no TMDB fallback. K-Drama is gone from this page. */
(async function () {
  UI.mountChrome("");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "FlickAtlas — Movie & TV Guide: Cast, Box Office, Budgets & Upcoming Releases",
    desc: "FlickAtlas is your global guide to movies and TV shows — full cast & crew, budgets vs box office earnings, upcoming release dates and celebrity filmographies for Bollywood, World Cinema and Lollywood.",
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

  const today = new Date().toISOString().slice(0, 10);
  const cutoff = UI.freshCutoff();
  /* Audit fix: the outer catch used to wipe the whole rendered homepage
     whenever a post-render step threw. `rendered` tracks whether the page
     is already on screen — once it is, a wiring failure is non-fatal. */
  let rendered = false;
  try {
    /* ---------- published data (single source of truth) ----------
       FA_PUBLISHED is written by the pipeline (js/published-titles.js),
       keyed by TMDB id. Guarded: an absent file means "nothing published
       yet", never a crash and never a live TMDB fetch. Sort: newest
       first (published_at desc, then release/air date desc) — the
       homepage recency rule. Each section shows the first HOME_LIMITS
       items of its See All page's ordered list (no distinct-title
       skipping, no one-item rails). */
    const pubAll = () => Object.values(window.FA_PUBLISHED || {});
    const typeOf = (x) => (x && (x.type || x.media_type)) || "movie";
    const dateOf = (x) => typeOf(x) === "tv" ? (x.first_air_date || "") : (x.release_date || "");
    const byNewest = (a, b) => (b.published_at || "").localeCompare(a.published_at || "") || dateOf(b).localeCompare(dateOf(a));
    const isReleased = (x) => { const d = dateOf(x); return !!d && d <= today; };
    const isUpcoming = (x) => { const d = dateOf(x); return !!d && d > today; };
    const freshReleased = (x) => isReleased(x) && UI.isFresh(x);
    const inIndustry = (x, industry) => (x.industry || "") === industry;

    /* Published titles for a homepage rail, by kind + industry. Returns
       the FULL ordered pool (no slice, no distinct filtering) — the caller
       slices HOME_LIMITS items off the front.
       kind "spotlight": released movies, fresh-first (falls back to all
         released, same as /movies), newest first.
       kind "soon": upcoming movies + TV, most-awaited sort (rating desc,
         then nearest date — same as /most-awaited).
       kind "calendar": upcoming movies + TV, nearest date first. */
    /* Homepage limits (2026-10-26, homepage/See-All match): every section
       shows the FIRST N items of the exact ordered list its See All page
       shows — no distinct-title skipping, no one-item rails. The See All
       page lists the full pool in the same order. */
    const HOME_LIMITS = { spotlight: 6, soon: 6, calendar: 6, trending: 6, boxoffice: 8, news: 7, lollywood: 6, dramas: 6 };
    /* Most-awaited sort: /most-awaited ranks upcoming titles by rating
       (vote_average desc, then vote_count desc, then nearest date) — NOT
       byNewest. The homepage "Coming Soon & Most Awaited" rail uses this
       same sort so its first item is the same title /most-awaited shows. */
    const byMostAwaited = (a, b) => (b.vote_average || 0) - (a.vote_average || 0)
      || (b.vote_count || 0) - (a.vote_count || 0)
      || dateOf(a).localeCompare(dateOf(b));
    /* Industry tag for cards: UI.industryTag now returns "World Cinema" for
       world-industry titles (fixed in ui.js) — the explicit label is kept
       as a harmless guard. */
    const tagFor = (x) => (x && x.industry === "world") ? "World Cinema" : UI.industryTag(x);
    const publishedFor = (kind, industry) => {
      const ind = industry === "international" ? "world" : "bollywood";
      const items = pubAll().filter(x => x && x.poster_path && inIndustry(x, ind));
      if (kind === "spotlight") {
        /* Fresh first, same fallback as /movies: when no fresh released
           title exists, the full released pool is used so the rail is
           never empty while published movies exist. */
        const rel = items.filter(x => typeOf(x) === "movie" && isReleased(x)).sort(byNewest);
        const fresh = rel.filter(x => freshReleased(x));
        return fresh.length ? fresh : rel;
      }
      if (kind === "soon") return items.filter(x => isUpcoming(x)).sort(byMostAwaited);
      return items.filter(x => isUpcoming(x)).sort((a, b) => dateOf(a).localeCompare(dateOf(b)) || byNewest(a, b));
    };
    const hasKind = (kind) => publishedFor(kind, "bollywood").length > 0 || publishedFor(kind, "international").length > 0;

    /* ---------- HERO = LIVE BOX-OFFICE CAROUSEL (§2.1, correction 6 —
       Sacnilk model): the newest day-wise title that is published, with
       its baked-in art from FA_PUBLISHED. Slides with engine day-wise
       data lead: latest day collection + running total + "collections
       through {date}" label. No live TMDB details fetch — a day-wise
       title that is not published simply has no slide. Info links only;
       no play/watch button. ------- */
    const dwData = window.FA_DAYWISE || {};
    const dwKeys = Object.keys(dwData).sort((a, b) => {
      const lastOf = (k) => { const rows = dwData[k]; return Array.isArray(rows) && rows.length ? (rows[rows.length - 1].date || "") : ""; };
      return lastOf(b).localeCompare(lastOf(a));
    });
    const heroSlides = [];
    for (const dwId of dwKeys) {
      if (heroSlides.length >= 1) break;
      const rows = dwData[dwId];
      if (!Array.isArray(rows) || !rows.length) continue;
      const entry = (window.FA_PUBLISHED || {})[String(dwId)];
      if (!entry || !entry.backdrop_path) continue;
      const total = rows.reduce((s, r) => s + (r.collection || 0), 0);
      const last = rows[rows.length - 1];
      heroSlides.push({ d: entry, live: true, total, last, dayN: UI.dayNumOf(last) });
    }

    const heroSlideHtml = (s, idx) => {
      const hd = s.d;
      const indLabel = hd.industry === "bollywood" ? "Bollywood" : hd.industry === "pakistani" ? "Pakistani" : "World Cinema";
      /* One single meta line (hero cleanup + mobile organisation): rating ·
         year, inline on one line. Sits directly under the title. */
      const year = (hd.release_date || hd.first_air_date || "").slice(0, 4);
      const metaHtml = (hd.vote_average || year) ? `<div class="hero-meta">
          ${hd.vote_average ? `<span class="chip">${UI.star}${UI.ratingText(hd)}</span>` : ""}
          ${year ? `<span class="hero-year">${year}</span>` : ""}
        </div>` : "";
      const stats = [];
      if (s.live) {
        stats.push([`Day ${s.dayN} Collection`, UI.fmtMoney(s.last.collection)]);
        stats.push(["Total So Far", UI.fmtMoney(s.total)]);
      } else {
        if (hd.release_date) stats.push(["Release Date", UI.fmtDate(hd.release_date)]);
        stats.push(["Status", hd.release_date && hd.release_date <= today ? "Now in Cinemas" : "Coming Soon"]);
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
          <span class="hero-kicker">${s.live ? `<span class="live-dot"></span>Live Box Office · ${indLabel}` : `Featured · ${indLabel}`}</span>
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
        `<button type="button" data-slide="${i}" class="${i === 0 ? " on" : ""}" aria-label="Show slide ${i + 1}"></button>`).join("")}</div>` : ""}
    </div></section>` : "";

    /* ---------- Bollywood block (leads the page; fix round 2, Bug F:
       Bollywood is FIRST and more than half the homepage — two full
       Bollywood rails + the Bollywood-led news and box office blocks
       below, before any international section appears) ---------- */
    const rowSection = (title, href, inner, sub, sec) => inner ? `
      <section class="section" data-sec="${sec || ""}"><div class="section-head"><h2>${title}</h2>
      <a class="see-all" href="${href}">See All →</a></div>
      ${sub ? `<p class="sec-sub">${sub}</p>` : ""}${inner}</section>` : "";
    const switchButtons = (id) => `<div class="home-industry-switchers" role="group" aria-label="Choose industry" data-switcher="${id}">${[["bollywood","Bollywood"],["international","World Cinema"]].map(([v,l],i)=>`<button type="button" class="chip home-industry-switch${i===0?" active":""}" data-industry="${v}" aria-pressed="${i===0}">${l}</button>`).join("")}</div>`;
    const bollyReleased = publishedFor("spotlight", "bollywood").slice(0, HOME_LIMITS.spotlight);
    const bollyHtml = hasKind("spotlight") ? `<section class="section" data-sec="bollywood-spotlight" id="homeSpotlight"><div class="section-head"><h2>Spotlight</h2><a class="see-all" href="/movies?f=bollywood&s=recent&seeall=1">See All →</a></div>${switchButtons("spotlight")}<p class="sec-sub">Newest released films first; filter by industry.</p><div class="scroller" data-results>${bollyReleased.map(x => UI.posterCard(x, "movie", "")).join("")}</div></section>` : "";
    const bollySoon = publishedFor("soon", "bollywood").slice(0, HOME_LIMITS.soon);
    const bollySoonHtml = hasKind("soon") ? `<section class="section" data-sec="bollywood-soon" id="homeSoon"><div class="section-head"><h2>Coming Soon &amp; Most Awaited</h2><a class="see-all" href="/most-awaited?f=bollywood">See All →</a></div>${switchButtons("soon")}<p class="sec-sub">Most awaited first; dates may change.</p><div class="scroller" data-results>${bollySoon.map((x, i) => UI.posterCard(x, typeOf(x), "", i + 1)).join("")}</div></section>` : "";

    /* ---------- Lollywood + Pakistani dramas: Pakistani released titles,
       fresh-first (falls back to all released, same as the other rails),
       newest first. First 6 each — the same ordered pool their See All
       pages list. ---------- */
    const releasedPool = (pred) => {
      const rel = pubAll().filter(x => x && x.poster_path && isReleased(x) && pred(x)).sort(byNewest);
      const fresh = rel.filter(x => freshReleased(x));
      return fresh.length ? fresh : rel;
    };
    const lollyLatest = releasedPool(x => (x.industry || "") === "pakistani").slice(0, HOME_LIMITS.lollywood);
    const pkLatest = releasedPool(x => (x.industry || "") === "pakistani" && typeOf(x) === "tv").slice(0, HOME_LIMITS.dramas);

    /* ---------- Newest published titles, all industries: same pool and
       order as /movies?f=all&s=recent (released movies, fresh-first with
       the full-pool fallback, newest first). First 6. ---------- */
    const mixedPool = pubAll().filter(x => x && typeOf(x) === "movie" && x.poster_path && isReleased(x)).sort(byNewest);
    const mixedFresh = mixedPool.filter(x => freshReleased(x));
    const mixed = (mixedFresh.length ? mixedFresh : mixedPool).slice(0, HOME_LIMITS.trending);
    const mixedHtml = rowSection("Trending Worldwide", "/movies?f=all&seeall=1",
      mixed.length ? `<div class="scroller">${mixed.map((x, i) => UI.posterCard(x, "movie", tagFor(x), i + 1)).join("")}</div>` : "",
      "Newest published titles across all industries.",
      "mixed-trending");
    /* Trending Searches: the feed itself is a published file
       (/api/trends); the context pools are published titles only, and
       no TMDB lookup runs — enrichment is skipped. */
    const searchesHtml = `<section class="section" data-sec="trending-searches" id="homeTrendingSearches"><h2>Trending Searches</h2><p role="status">Loading trend feed…</p></section>`;

    /* ---------- Celebrities: engine-fed "Celebrity Today" when the data
       engine's v2-classified items are fresh (< 24h — enforced inside
       UI.celebTodaySection). No TMDB-people fallback: when nothing is
       fresh today, the section renders nothing. ---------- */
    const celebTodayHtml = (UI.celebTodaySection(window.FA_CELEBRITY_TODAY) || "")
      .replaceAll('class="news-list"', 'class="editorial-grid"').replaceAll('class="news-item"', 'class="editorial-card"');

    /* ---------- Box Office: published titles with real day-wise rows
       (FA_DAYWISE). Today / 7-day sums come only from the reported rows;
       "Recorded" is the sum of the tracked days (never a lifetime gross —
       FA_PUBLISHED carries no revenue figure). First 8 cards in day-wise
       order; no section at all when no published title has data. ---------- */
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
      return `<a class="fa-box-latest-card" data-movie-id="${UI.esc(entry.id)}" data-release="${UI.esc(date)}" href="/movie?id=${entry.id}" aria-label="${UI.esc(UI.titleOf(entry))} — box office details"><div class="fa-box-card-head">${poster}<div class="fa-box-card-labels"><span class="fa-box-latest-title" title="${UI.esc(UI.titleOf(entry))}">${UI.esc(UI.titleOf(entry))}</span><p class="fa-box-latest-meta">Released ${UI.esc(UI.fmtDate(date))}</p></div><span class="fa-box-card-arrow" aria-hidden="true">›</span></div><dl aria-label="Reported box office summary"><div title="Today's reported collection · ${UI.esc(today)} UTC"><dt>Today</dt><dd>${todayRows.length ? UI.fmtMoney(todaySum) : missing}</dd></div><div title="${UI.esc(weekDays ? weekDays + " of 7 days reported" : "No daily records reported for this period")} · ${UI.esc(weekStart)} to ${UI.esc(today)} UTC"><dt>7 Days</dt><dd>${weekRows.length ? `${UI.fmtMoney(weekSum)}${weekDays < 7 ? `<abbr class="fa-box-partial" title="${UI.esc(weekDays + " of 7 days reported · partial")}">${weekDays}/7</abbr>` : ""}` : missing}</dd></div><div title="Sum of the reported day-wise collections tracked by FlickAtlas"><dt>Recorded</dt><dd>${UI.fmtMoney(totalSum)}</dd></div></dl></a>`;
    };
    /* Every published title with day-wise rows, in the SAME order
       /box-office lists its day-wise titles (dwKeys: latest recorded
       date first). First 8, each as a boCardHtml card. */
    const boPicks = [];
    for (const dwId of dwKeys) {
      if (boPicks.length >= HOME_LIMITS.boxoffice) break;
      const rows = dwData[dwId];
      if (!Array.isArray(rows) || !rows.length) continue;
      const entry = (window.FA_PUBLISHED || {})[String(dwId)];
      if (entry && entry.poster_path) boPicks.push({ entry, rows });
    }
    const boHtml = boPicks.length ? `<section class="section" data-sec="box-office">
      <div class="section-head"><h2>Box Office</h2>
      <a class="see-all" href="/box-office">See All →</a></div>
      ${boPicks.map(p => boCardHtml(p.entry, p.rows)).join("")}
    </section>` : "";

    /* ---------- coming soon: a DAILY release calendar over the
       published upcoming titles — nearest date first, first 6 rows. ----- */
    const MONTHS_S = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const calendarRow = (x, type, date) => { const [, mm, dd] = date.split("-"); return `<a class="tl-row" href="/${type === "tv" ? "show" : "movie"}?id=${x.id}"><span class="tl-date"><b>${parseInt(dd, 10)}</b><span>${MONTHS_S[parseInt(mm, 10) - 1]}</span></span><img src="${UI.img(x.poster_path, "w92")}" alt="" loading="lazy" onerror="this.remove()"><span class="tl-info"><b>${UI.esc(UI.titleOf(x))}</b><span>${type === "tv" ? "Premieres " : ""}${UI.fmtDate(date)}${UI.rating(x) ? ` · ${UI.rating(x)}/10` : ""}</span></span><span class="tag-chip">${UI.esc(tagFor(x))}</span></a>`; };
    const upList = publishedFor("calendar", "bollywood").slice(0, HOME_LIMITS.calendar);
    const upHtml = hasKind("calendar") ? `<section class="section" data-sec="coming-soon" id="homeCalendar">
      <div class="section-head"><h2>Coming Soon — Release Calendar</h2>
      <a class="see-all" href="/upcoming?f=bollywood&s=nearest&seeall=1">See All →</a></div>
      ${switchButtons("calendar")}
      <p class="sec-sub">Announced film and series dates, nearest first; dates may change.</p>
      <div class="tl-list" data-results>
        ${upList.length ? upList.map(x => calendarRow(x, typeOf(x), dateOf(x))).join("") : '<p role="status">No confirmed releases found in this window.</p>'}
      </div></section>` : "";

    /* ---------- Trending News (§2.7): the SAME feed /news renders
       (/api/news), first 7 headlines, same editorial-card markup (title
       + meta). When the feed is unreachable or empty, the section
       removes itself. ---------- */
    const newsHtml = `<section class="section" id="homeNews" data-sec="news">
      <div class="section-head"><h2>Trending News</h2>
      <a class="see-all" href="/news">See All →</a></div>
      <p class="sec-sub">Recent published headlines, newest first.</p>
      <div class="sk" style="height:120px;border-radius:14px"></div></section>`;
    const fillHomeNews = async () => {
      const host = document.getElementById("homeNews");
      if (!host) return;
      try {
        /* Same source and markup as /news (page-news.js): /api/news feed,
           categories normalised the same way, first 7 items. */
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 9000);
        const r = await fetch("/api/news", { signal: ctl.signal });
        clearTimeout(to);
        if (!r.ok) throw new Error("news http " + r.status);
        const j = await r.json();
        if (!j.items || !j.items.length) throw new Error("news empty");
        const CATLABEL = { bollywood: "Bollywood", world: "World Cinema", pakistan: "Pakistan", celebrity: "Celebrity", viral: "Viral" };
        const arts = j.items.slice(0, HOME_LIMITS.news).map(it => ({
          ...it,
          cats: (Array.isArray(it.cats) ? it.cats : []).map(c => c === "international" ? "world" : c).filter(c => c !== "korea")
        }));
        host.innerHTML = `<div class="section-head"><h2>Trending News</h2>
          <a class="see-all" href="/news">See All →</a></div>
          <p class="sec-sub">Recent published headlines, newest first.</p>
          <div class="editorial-grid">${arts.map(it => {
            const categories = (Array.isArray(it.cats) ? it.cats : []).map(c => CATLABEL[c] || c);
            const meta = [categories.length ? categories.join(" · ") : "", Number.isFinite(it.ts) && it.ts > 0 ? UI.relTime(it.ts) : ""].filter(Boolean);
            return `<a class="editorial-card" href="${UI.newsItemPath(it)}">
              <span class="editorial-card__title">${UI.esc(it.title)}</span>
              ${meta.length ? `<span class="editorial-card__meta">${meta.map(UI.esc).join(" · ")}</span>` : ""}
            </a>`;
          }).join("")}</div>`;
      } catch (_) {
        host.remove();
      }
    };

    /* ---------- Lollywood: latest Pakistani releases (computed above). ---------- */
    const lollyHtml = lollyLatest.length ? `<section class="section" data-sec="lollywood">
      <div class="section-head"><h2>Lollywood — Latest Pakistani Releases</h2>
      <a class="see-all" href="/category?cat=lollywood">See All →</a></div>
      <p class="sec-sub">Recent Pakistani films and dramas with listed dates; newest first.</p>
      <div class="scroller">${lollyLatest.map(x => UI.posterCard(x, typeOf(x), typeOf(x) === "tv" ? "Pakistani Drama" : "Pakistani Film")).join("")}</div></section>` : "";

    /* Pakistani dramas rail: the newest published Pakistani dramas, with
       their channel tags. No live channel-pool fetch. */
    const pkRailHtml = pkLatest.length ? `<section class="section" id="homePk" data-sec="pk-dramas">
      <div class="section-head"><h2>Pakistani YouTube Dramas — Latest</h2>
      <a class="see-all" href="/episode-guides">Episode Guides →</a></div>
      <p class="sec-sub">Currently running Pakistani dramas; open a card for details.</p>
      <div class="scroller">${pkLatest.map(x => UI.posterCard(x, "tv", x.channel || "Pakistani Drama")).join("")}</div></section>` : "";

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
      ].map(([dt, nm, note]) => `
        <a class="tl-row" href="/awards">
          <span class="tl-date"><b>${parseInt(dt.slice(8, 10), 10)}</b><span>${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][parseInt(dt.slice(5, 7), 10) - 1]}</span></span>
          <span class="tl-info"><b>${nm}</b><span>${UI.fmtDate(dt)} · ${note}</span></span>
        </a>`).join("")}
      </div></section>`;

    /* Homepage order (MASTER-STRUCTURE §2 as amended by fix round 2,
       Bug F — Bollywood FIRST and more than half the page):
       hero → Bollywood Spotlight → Bollywood Coming Soon → Celebrity
       Today → Box Office → mixed trending → Coming Soon calendar →
       Trending Searches → Trending News → awards → Lollywood →
       Pakistani dramas. K-Drama, birthdays, OTT and episode strips are
       gone: they had no published data source. ("Star Spotlight" stays
       removed by user order.) */
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
      ${awardsStripHtml}
      ${lollyHtml}
      ${pkRailHtml}
    </div>`;
    rendered = true;
    if (window.FARailScroll) window.FARailScroll.enhance(document.querySelectorAll("#homeSpotlight .scroller, #homeSoon .scroller"));

    // Shared, lazy industry switcher — filters the published catalogue
    // only (no live TMDB discover). Query only after a non-default tab
    // is chosen; the default Bollywood view is pre-rendered above.
    const industryLabel = i => i === "international" ? "World Cinema" : i === "pakistan" ? "Pakistan" : "Bollywood";
    const homeStateKey = kind => ({ spotlight: "hs", soon: "hn", calendar: "hc" }[kind]);
    document.querySelectorAll("[data-switcher]").forEach(group => {
      const section = group.closest("section"), kind = group.dataset.switcher, result = section.querySelector("[data-results]"), link = section.querySelector(".see-all"), stateKey = homeStateKey(kind);
      const activate = (industry, persist) => {
        group.querySelectorAll("button").forEach(btn => { const on = btn.dataset.industry === industry; btn.setAttribute("aria-pressed", String(on)); btn.classList.toggle("active", on); });
        if (persist) { const u = new URL(location.href); if (industry === "bollywood") u.searchParams.delete(stateKey); else u.searchParams.set(stateKey, industry); history.pushState(null, "", u); }
        section.querySelector("h2").textContent = kind === "spotlight" ? "Spotlight" : kind === "soon" ? "Coming Soon & Most Awaited" : "Release Calendar";
        link.href = kind === "spotlight" ? `/movies?f=${industry}&s=recent&seeall=1` : kind === "soon" ? `/most-awaited?f=${industry}` : `/upcoming?f=${industry}&s=nearest&seeall=1`;
        section.querySelector(".sec-sub").textContent = kind === "spotlight" ? "Browse released movies, newest first · " + industryLabel(industry) : kind === "soon" ? "Upcoming titles, most awaited first · " + industryLabel(industry) : "Announced film and series dates, nearest first · " + industryLabel(industry);
        const limitKey = kind === "spotlight" ? "spotlight" : kind === "soon" ? "soon" : "calendar";
        const items = publishedFor(kind, industry).slice(0, HOME_LIMITS[limitKey]);
        if (kind === "calendar") result.innerHTML = items.length ? items.map(x => calendarRow(x, typeOf(x), dateOf(x))).join("") : '<p role="status">No confirmed releases found in this window.</p>';
        else result.innerHTML = items.length ? items.map((x, i) => UI.posterCard(x, typeOf(x), "", kind === "soon" ? i + 1 : undefined)).join("") : '<p role="status">No matching titles found.</p>';
      };
      group.addEventListener("click", ev => { const btn = ev.target.closest("button[data-industry]"); if (btn) activate(btn.dataset.industry, true); });
      const key = stateKey, initial = new URL(location.href).searchParams.get(key) === "international" ? "international" : "bollywood";
      /* The default Bollywood view is already pre-rendered above from the
         same pool + limit, so only activate when a non-default tab was
         requested via the URL. */
      if (initial !== "bollywood") activate(initial, false);
      window.addEventListener("popstate", () => activate(new URL(location.href).searchParams.get(key) === "international" ? "international" : "bollywood", false));
    });
    /* Wiring steps are guarded individually: a failure here must never
       wipe the rendered page (see the `rendered` flag above). A failed
       news fill removes the section instead of leaving a skeleton;
       a failed trends mount leaves one honest line instead of a stuck
       "Loading trend feed…" status. */
    try { fillHomeNews(); } catch (_) { document.getElementById("homeNews")?.remove(); }

    try {
      if (window.FATrendingSearches) window.FATrendingSearches.mount(document.getElementById("homeTrendingSearches"), {
        limit: 1,
        context: {
          bollywood: pubAll().filter(x => (x.industry || "") === "bollywood"),
          international: pubAll().filter(x => (x.industry || "") === "world"),
          pakistan: pubAll().filter(x => (x.industry || "") === "pakistani"),
        },
      });
      else {
        /* Audit fix: when the trends script itself failed to load,
           FATrendingSearches is undefined — the old code did nothing and
           the section stayed on "Loading trend feed…" forever. Show the
           honest line instead of a stuck status. */
        const ts = document.getElementById("homeTrendingSearches");
        if (ts) ts.innerHTML = `<h2>Trending Searches</h2><p role="status">Trending searches are unavailable right now.</p>`;
      }
    } catch (_) {
      const ts = document.getElementById("homeTrendingSearches");
      if (ts) ts.innerHTML = `<h2>Trending Searches</h2><p role="status">Trending searches are unavailable right now.</p>`;
    }

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
    /* Only wipe the page when nothing rendered yet. After `rendered`,
       a failure is a wiring problem, not a reason to blank the homepage. */
    if (!rendered) main.innerHTML = `<div class="wrap">${UI.stateMsg("Could not load the homepage right now. Please check your connection and try again.")}</div>`;
  }
})();

