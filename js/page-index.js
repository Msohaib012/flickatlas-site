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
       first by RELEASE/AIR DATE desc (user order 2026-10-26 — the latest
       release leads, then going back); published_at only breaks ties.
       Each section shows the first HOME_LIMITS items of its See All
       page's ordered list (no distinct-title skipping, no one-item
       rails). */
    const pubAll = () => Object.values(window.FA_PUBLISHED || {});
    const typeOf = (x) => (x && (x.type || x.media_type)) || "movie";
    const dateOf = (x) => typeOf(x) === "tv" ? (x.first_air_date || "") : (x.release_date || "");
    const byNewest = (a, b) => dateOf(b).localeCompare(dateOf(a)) || (b.published_at || "").localeCompare(a.published_at || "");
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
    /* Spotlight (user order 2026-10-26, revised: show 10-15): the 12 newest
       released movies per industry (was 'fresh this week' only, which capped
       Bollywood at 4). New titles join daily via the nightly seeder. */
    const HOME_LIMITS = { soon: 12, calendar: 6, trending: 6, boxoffice: 8, news: 7, lollywood: 6, dramas: 13 };
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
        /* Owner order 2026-10-26: show 10-15 on the homepage (was 4-5:
           the old 'fresh this week' rule capped Bollywood at the 4 movies
           released in the last 7 days). Now the 12 NEWEST released movies
           (fresh first by sort order). Bollywood has only 8 released
           titles in the catalogue, so its tab shows 8 (all of them) until
           the seeder adds more; World shows 12. */
        const rel = items.filter(x => typeOf(x) === "movie" && isReleased(x)).sort(byNewest);
        return rel.slice(0, 12);
      }
      if (kind === "soon") return items.filter(x => isUpcoming(x)).sort(byMostAwaited);
      return items.filter(x => isUpcoming(x)).sort((a, b) => dateOf(a).localeCompare(dateOf(b)) || byNewest(a, b));
    };
    const hasKind = (kind) => publishedFor(kind, "bollywood").length > 0 || publishedFor(kind, "international").length > 0;

    /* ---------- HERO = latest currently-running movies (user order
       2026-10-26): max 4 slides, the 4 NEWEST published movies that are
       currently running (released + fresh = in cinemas now), newest
       first. A slide is "live" when the title has day-wise rows (Day N
       collection + running total); otherwise it shows Release Date +
       "Now in Cinemas" (the non-live branch of heroSlideHtml). No live
       TMDB fetch — a title with no day-wise rows simply has no live
       stats. ------- */
    const dwData = window.FA_DAYWISE || {};
    const heroPool = pubAll()
      .filter(x => x && typeOf(x) === "movie" && x.poster_path && isReleased(x) && UI.isFresh(x))
      .sort(byNewest);
    const heroSlides = heroPool.slice(0, 4).map(entry => {
      const rows = dwData[String(entry.id)];
      if (Array.isArray(rows) && rows.length) {
        const total = rows.reduce((s, r) => s + (r.collection || 0), 0);
        const last = rows[rows.length - 1];
        return { d: entry, live: true, total, last, dayN: UI.dayNumOf(last) };
      }
      return { d: entry, live: false };
    });

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
    const bollyReleased = publishedFor("spotlight", "bollywood");
    const bollyHtml = hasKind("spotlight") ? `<section class="section" data-sec="bollywood-spotlight" id="homeSpotlight"><div class="section-head"><h2>Spotlight</h2><a class="see-all" href="/movies?f=bollywood&s=recent&seeall=1">See All →</a></div>${switchButtons("spotlight")}<p class="sec-sub">All movies running now, newest first; filter by industry.</p><div class="scroller" data-results>${bollyReleased.map(x => UI.posterCard(x, "movie", "")).join("")}</div></section>` : "";
    const bollySoon = publishedFor("soon", "bollywood").slice(0, HOME_LIMITS.soon);
    const bollySoonHtml = hasKind("soon") ? `<section class="section" data-sec="bollywood-soon" id="homeSoon"><div class="section-head"><h2>Coming Soon &amp; Most Awaited</h2><a class="see-all" href="/most-awaited?f=bollywood">See All →</a></div>${switchButtons("soon")}<p class="sec-sub">Most awaited first; dates may change.</p><div class="scroller" data-results>${bollySoon.map((x, i) => UI.posterCard(x, typeOf(x), "", i + 1)).join("")}</div></section>` : "";

    /* ---------- Lollywood: Pakistani released titles, fresh-first (falls
       back to all released, same as the other rails), newest first. The
       filter is strict (industry === "pakistani") — verified 2026-10-26
       against live FA_PUBLISHED: only 3 Pakistani titles exist (all TV
       dramas, all correctly industry=pakistani) and no non-Pakistani
       title leaks in. First 6 — the same ordered pool the Lollywood See
       All page lists. (Pakistani EPISODES live in the rail below, not
       here — titles and episodes are separate sections by user order.)
       ---------- */
    const releasedPool = (pred) => {
      const rel = pubAll().filter(x => x && x.poster_path && isReleased(x) && pred(x)).sort(byNewest);
      const fresh = rel.filter(x => freshReleased(x));
      return fresh.length ? fresh : rel;
    };
    /* Lollywood = Pakistani MOVIES only (user order 2026-10-26): Pakistani TV
       dramas (type "tv") are excluded — they live in the episodes rail, not here. */
    const lollyLatest = releasedPool(x => (x.industry || "") === "pakistani" && typeOf(x) === "movie").slice(0, HOME_LIMITS.lollywood);

    /* ---------- Trending Worldwide: AUTHENTIC trending only (user order
       2026-10-26). Renders ONLY from window.FA_TRENDING — a list of TMDB
       ids in trending order (js/trending-data.js) — matched to published
       entries in FA_PUBLISHED, in trending order, up to 6. If FA_TRENDING
       is missing or empty, the section renders NOTHING: no fallback to
       the newest/mixed pool — that fallback is exactly what the user
       called inauthentic. ---------- */
    const trendingIds = Array.isArray(window.FA_TRENDING) ? window.FA_TRENDING : [];
    const trendingEntries = trendingIds
      .map(id => (window.FA_PUBLISHED || {})[String(id)])
      .filter(x => x && typeOf(x) === "movie" && x.poster_path)
      .slice(0, HOME_LIMITS.trending);
    const trendingHtml = rowSection("Trending Worldwide", "/movies?f=all&seeall=1",
      trendingEntries.length ? `<div class="scroller">${trendingEntries.map((x, i) => UI.posterCard(x, "movie", tagFor(x), i + 1)).join("")}</div>` : "",
      "Trending this week, worldwide.",
      "mixed-trending");
    /* Trending Searches: the feed itself is a published file
       (/api/trends); the context pools are published titles only, and
       no TMDB lookup runs — enrichment is skipped. */
    const searchesHtml = `<section class="section" data-sec="trending-searches" id="homeTrendingSearches"><h2>Trending Searches</h2><p role="status">Loading trend feed…</p></section>`;

    /* ---------- Box Office: recently-released published movies, newest
       first (release date DESC) — the same pool and order as /box-office.
       Today / 7-day sums come only from the reported rows; "Recorded" is
       the sum of the tracked days (never a lifetime gross — FA_PUBLISHED
       carries no revenue figure). Titles with no day-wise rows yet show
       an honest "Not reported" state. First 8 cards; no section at all
       when no published movie qualifies. ---------- */
    /* Short "26 Oct" date for the Today cell (compact for mobile). */
    const shortDate = (s) => {
      const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return "";
      const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const mo = +m[2];
      if (mo < 1 || mo > 12) return "";
      return `${+m[3]} ${MO[mo - 1]}`;
    };
    const boCardHtml = (entry, rows) => {
      const clean = (rows || []).filter(r => r && r.date && typeof r.collection === "number");
      /* Date of the latest reported day-wise row — the "Today" figure's date. */
      const latestDate = clean.reduce((mx, r) => (r.date > mx ? r.date : mx), "");
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
      return `<a class="fa-box-latest-card" data-movie-id="${UI.esc(entry.id)}" data-release="${UI.esc(date)}" href="/movie?id=${entry.id}" aria-label="${UI.esc(UI.titleOf(entry))} — box office details"><div class="fa-box-card-head">${poster}<div class="fa-box-card-labels"><span class="fa-box-latest-title" title="${UI.esc(UI.titleOf(entry))}">${UI.esc(UI.titleOf(entry))}</span><p class="fa-box-latest-meta">Released ${UI.esc(UI.fmtDate(date))}</p></div><span class="fa-box-card-arrow" aria-hidden="true">›</span></div><dl aria-label="Reported box office summary"><div title="Today's reported collection · ${UI.esc(today)} UTC"><dt>Today${latestDate ? ` · ${shortDate(latestDate)}` : ""}</dt><dd>${todayRows.length ? UI.fmtMoney(todaySum) : missing}</dd></div><div title="${UI.esc(weekDays ? weekDays + " of 7 days reported" : "No daily records reported for this period")} · ${UI.esc(weekStart)} to ${UI.esc(today)} UTC"><dt>7 Days</dt><dd>${weekRows.length ? `${UI.fmtMoney(weekSum)}${weekDays < 7 ? `<abbr class="fa-box-partial" title="${UI.esc(weekDays + " of 7 days reported · partial")}">${weekDays}/7</abbr>` : ""}` : missing}</dd></div><div title="Sum of the reported day-wise collections tracked by FlickAtlas"><dt>Recorded</dt><dd>${clean.length ? UI.fmtMoney(totalSum) : missing}</dd></div></dl></a>`;
    };
    /* Box Office (user order 2026-10-26): the SAME pool and order as
       /box-office — recently-released published movies, newest first
       (release date DESC). A title qualifies if it is released and (has
       day-wise rows OR is fresh); titles with no rows yet show an honest
       "not yet recorded" state in the card. First 8. */
    const boHasRows = (x) => { const r = dwData[String(x.id)]; return Array.isArray(r) && r.length > 0; };
    const boPool = pubAll()
      .filter(x => x && typeOf(x) === "movie" && x.poster_path && (x.release_date || "") && (x.release_date || "") <= today && (boHasRows(x) || UI.isFresh(x)))
      .sort(byNewest);
    /* Box Office by industry (user order 2026-10-26): the same pool as
       /box-office, split by industry for the homepage switcher — the
       exact switchButtons()/activate() pattern the Spotlight and Coming
       Soon sections use. Default view = Bollywood. */
    const boPoolFor = (industry) => {
      const ind = industry === "international" ? "world" : "bollywood";
      return boPool.filter(x => inIndustry(x, ind));
    };
    const boHasKind = boPoolFor("bollywood").length > 0 || boPoolFor("international").length > 0;
    const boPicks = boPoolFor("bollywood").slice(0, HOME_LIMITS.boxoffice).map(entry => ({ entry, rows: dwData[String(entry.id)] || [] }));
    const boHtml = boHasKind ? `<section class="section" data-sec="box-office" id="homeBoxOffice">
      <div class="section-head"><h2>Box Office</h2>
      <a class="see-all" href="/box-office?f=bollywood">See All →</a></div>
      ${switchButtons("boxoffice")}<p class="sec-sub">Recently-released films, newest first · Bollywood</p>
      <div data-results>${boPicks.map(p => boCardHtml(p.entry, p.rows)).join("")}</div>
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
    /* News slider (user order 2026-10-26): directly below the hero, the
       SAME articles as Trending News (newest first) as image slides.
       Placeholder only — filled by fillHomeNews from the same single
       /api/news fetch (no second fetch). Removes itself when the feed
       fails or is empty, exactly like Trending News. */
    const newsSliderHtml = `<section class="section" id="homeNewsSlider" data-sec="news-slider">
      <div class="section-head"><h2>Latest News</h2>
      <a class="see-all" href="/news">See All →</a></div>
      <div class="sk" style="height:230px;border-radius:14px"></div></section>`;
    /* News tag derivation — REUSED from js/page-news.js (same helpers,
       same keyword lists, same TAGKEYS order) so a story gets the same
       tags on the homepage slider as on /news. "Kollywood" means South
       Indian cinema (Tamil/Telugu), per the owner's wording. */
    const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hasWord = (text, phrase) => {
      const words = String(phrase).split(" ");
      const pat = words.map((w, i) => escRe(w) + (i === words.length - 1 ? "s?" : "")).join("\\s+");
      return new RegExp("\\b" + pat + "\\b", "i").test(text);
    };
    const TAGKEYS = ["bollywood", "lollywood", "kollywood", "world", "pakistan", "celebrity", "viral", "award", "ott", "music", "tech"];
    const SLIDERTAGLABEL = { bollywood: "Bollywood", kollywood: "Kollywood" };
    const deriveTags = (it) => {
      const tags = new Set();
      const cats = (Array.isArray(it.cats) ? it.cats : []).map(c => String(c).toLowerCase());
      const text = ((it.title || "") + " " + (it.summary || "")).toLowerCase();
      /* KOREAN GUARD (2026-10-26, browser-verified): the feed misclassifies
         Korean stories as 'bollywood' (Kim Ji Won K-drama Doctor X carried
         cats ['bollywood','celebrity'] and showed in the Indian-only slider
         labelled Bollywood). A story whose text is Korean is NEVER Indian,
         so the feed's 'bollywood' cat is ignored for it. */
      const isKorean = hasWord(text, "k-drama") || hasWord(text, "kdrama") ||
        hasWord(text, "korean") || hasWord(text, "k-pop") || hasWord(text, "kpop") ||
        hasWord(text, "seoul") || hasWord(text, "kim ji won");
      if (cats.includes("bollywood") && !isKorean) tags.add("bollywood");
      if (cats.includes("pakistan")) { tags.add("pakistan"); tags.add("lollywood"); }
      if (cats.includes("celebrity")) tags.add("celebrity");
      if (cats.includes("viral")) tags.add("viral");
      if (cats.includes("world") || cats.includes("international")) tags.add("world");
      /* ₹ is the Indian rupee sign — a clean Bollywood signal for items
         the feed misclassified (e.g. a Ramayana box-office item filed
         under "korea"). */
      if (hasWord(text, "bollywood") || text.includes("₹")) tags.add("bollywood");
      if (hasWord(text, "tamil") || hasWord(text, "kollywood") || hasWord(text, "tamil cinema") ||
          hasWord(text, "telugu") || hasWord(text, "tollywood")) tags.add("kollywood");
      if (hasWord(text, "lollywood") || hasWord(text, "pakistani") || hasWord(text, "hum tv") ||
          hasWord(text, "ary") || hasWord(text, "geo tv") || hasWord(text, "green tv")) tags.add("lollywood");
      if (hasWord(text, "award") || hasWord(text, "filmfare") || hasWord(text, "oscar") ||
          hasWord(text, "iifa") || hasWord(text, "national award") ||
          hasWord(text, "best actor") || hasWord(text, "best film")) tags.add("award");
      if (hasWord(text, "ott") || hasWord(text, "netflix") || hasWord(text, "streaming") ||
          hasWord(text, "prime video") || hasWord(text, "disney+ hotstar") || hasWord(text, "hotstar") ||
          hasWord(text, "jiohotstar")) tags.add("ott");
      if (hasWord(text, "music") || hasWord(text, "soundtrack") || hasWord(text, "song") ||
          hasWord(text, "album") || hasWord(text, "singer") || hasWord(text, "composer")) tags.add("music");
      if (hasWord(text, "ai") || hasWord(text, "tech") || hasWord(text, "technology") ||
          hasWord(text, "artificial intelligence") || hasWord(text, "app") || hasWord(text, "gadget")) tags.add("tech");
      return TAGKEYS.filter(k => tags.has(k));
    };
    /* News slider renderer (owner spec 2026-10-26, corrected 21:18 PKT,
       tags + Indian-only 2026-10-26 ~21:35 PKT):
       INDIAN-ONLY, newest 8, YouTube/Sacnilk style — a 16:9 image frame
       on top, title + date below, with a TAG CHIP (Bollywood / Kollywood)
       overlaid on the image top-left. LIGHT card, visually separate
       from the dark hero above. Items from the shared /api/news fetch;
       image from window.FA_ARTICLES (already loaded; every /api/news id
       has a matching FA_ARTICLES entry with an images array). Carousel
       mirrors the hero: show/hide slides, dots jump, prev/next arrows,
       auto-advance every 6s, pause on hover, touch swipe. Items without
       an image are skipped; with < 2 slides the controls and timer are
       omitted. */
    const renderNewsSlider = (arts) => {
      const host = document.getElementById("homeNewsSlider");
      if (!host) return;
      const fa = window.FA_ARTICLES || {};
      /* INDIAN-ONLY (owner order 2026-10-26): a slide qualifies only
         when its derived tags include "bollywood" OR "kollywood"
         (Tamil/Telugu/South Indian). No Hollywood, no World Cinema, no
         Pakistani, no other country. The chip shows the primary Indian
         tag — Bollywood first, else Kollywood. */
      const slides = arts.map(it => ({ it, tags: deriveTags(it) }))
        .filter(x => x.tags.includes("bollywood") || x.tags.includes("kollywood"))
        .map(({ it, tags }) => {
          const art = fa[it.id] || {};
          const imgs = Array.isArray(art.images) ? art.images : [];
          const img = imgs.length && imgs[0] && imgs[0].url ? String(imgs[0].url) : "";
          const primary = tags.includes("bollywood") ? "bollywood" : "kollywood";
          return { it, img, primary };
        }).filter(x => x.img).slice(0, 8);
      if (!slides.length) { host.remove(); return; }
      host.innerHTML = `<div class="section-head"><h2>Latest News</h2>
        <a class="see-all" href="/news">See All →</a></div>
        <div class="news-slider" id="newsSlider">
          <div class="news-slider-viewport">${slides.map(({ it, img, primary }, i) => {
            const meta = Number.isFinite(it.ts) && it.ts > 0 ? UI.relTime(it.ts) : "";
            return `<a class="news-slide${i === 0 ? " active" : ""}" href="${UI.newsItemPath(it)}" style="display:${i === 0 ? "block" : "none"}">
              <span class="news-slide-img"><img src="${UI.newsImg(img, 800)}" alt="" ${i === 0 ? 'fetchpriority="high"' : ''} decoding="async" onerror="this.onerror=null;this.src='${UI.esc(img)}'"><span class="news-slide-tag">${UI.esc(SLIDERTAGLABEL[primary] || primary)}</span></span>
              <span class="news-slide-body"><span class="news-slide-title">${UI.esc(it.title || "")}</span>
              ${meta ? `<span class="news-slide-meta">${UI.esc(meta)}</span>` : ""}</span>
            </a>`;
          }).join("")}</div>
          ${slides.length > 1 ? `<button type="button" class="news-slider-arrow news-slider-prev" aria-label="Previous story">‹</button>
          <button type="button" class="news-slider-arrow news-slider-next" aria-label="Next story">›</button>
          <div class="news-slider-dots">${slides.map((_, i) => `<button type="button" data-slide="${i}" class="${i === 0 ? "on" : ""}" aria-label="Show story ${i + 1}"></button>`).join("")}</div>` : ""}
        </div>`;
      /* Carousel wiring (hero pattern): show/hide + dots + arrows +
         6s auto-advance, pause on hover, horizontal touch swipe. */
      const car = host.querySelector("#newsSlider");
      const els = [...car.querySelectorAll(".news-slide")];
      const dots = [...car.querySelectorAll(".news-slider-dots button")];
      if (els.length < 2) return;
      let cur = 0, timer = null;
      const go = (n) => {
        els[cur].classList.remove("active"); els[cur].style.display = "none";
        if (dots[cur]) dots[cur].classList.remove("on");
        cur = (n + els.length) % els.length;
        els[cur].classList.add("active"); els[cur].style.display = "block";
        if (dots[cur]) dots[cur].classList.add("on");
      };
      const start = () => { timer = setInterval(() => go(cur + 1), 6000); };
      const stop = () => { if (timer) clearInterval(timer); timer = null; };
      dots.forEach((d, i) => d.addEventListener("click", () => { stop(); go(i); start(); }));
      const prev = car.querySelector(".news-slider-prev"), next = car.querySelector(".news-slider-next");
      if (prev) prev.addEventListener("click", () => { stop(); go(cur - 1); start(); });
      if (next) next.addEventListener("click", () => { stop(); go(cur + 1); start(); });
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
    };
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
        /* The slider gets the FULL feed (not the 7-item Trending News cap):
           it needs the whole feed to find 8 Indian (bollywood/kollywood)
           items with images. No second fetch — same j.items, normalised
           the same way. */
        const sliderArts = j.items.map(it => ({
          ...it,
          cats: (Array.isArray(it.cats) ? it.cats : []).map(c => c === "international" ? "world" : c).filter(c => c !== "korea")
        }));
        try { renderNewsSlider(sliderArts); } catch (_) { document.getElementById("homeNewsSlider")?.remove(); }
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
        document.getElementById("homeNewsSlider")?.remove();
      }
    };

    /* ---------- Lollywood: latest Pakistani releases (computed above). ---------- */
    const lollyHtml = lollyLatest.length ? `<section class="section" data-sec="lollywood">
      <div class="section-head"><h2>Lollywood — Latest Pakistani Releases</h2>
      <a class="see-all" href="/category?cat=lollywood">See All →</a></div>
      <p class="sec-sub">Pakistani movies &amp; dramas only, latest first.</p>
      <div class="scroller">${lollyLatest.map(x => UI.posterCard(x, typeOf(x), typeOf(x) === "tv" ? "Pakistani Drama" : "Pakistani Film")).join("")}</div></section>` : "";

    /* Drama episodes (user order 2026-10-26, LIST format 21:37 PKT):
       a VERTICAL LIST — NOT poster cards and NOT a slider. One row per
       episode, thumbnail LEFT + title/date RIGHT, side by side.
       Episode articles come from FA_ARTICLES (loaded before this script);
       identified by the episode headline pattern "— Watch on <channel>"
       (the same pattern the episode-guides hub uses — every episode post
       carries it and no news article does). Each row links to its episode
       detail page (/news-item?id=<article_id>). This is NOT a duplicate of
       Lollywood: Lollywood lists Pakistani TITLES (poster cards); this
       lists EPISODES. First 6. */
    const episodeRow = (a) => {
      const img = (a.images && a.images[0] && a.images[0].url) || "";
      const channel = (a.images && a.images[0] && a.images[0].source) || "";
      const date = (a.published || "").slice(0, 10);
      return `<a class="ep-row" href="${UI.newsItemPath(a)}">
        <span class="ep-thumb">${img ? `<img src="${UI.esc(img)}" alt="${UI.esc(a.headline || "")}" loading="lazy" decoding="async" onerror="this.remove()">` : `<span class="noimg"><span>EP</span></span>`}</span>
        <span class="ep-info"><b>${UI.esc(a.headline || "")}</b>
        <span>${date ? UI.esc(UI.fmtDate(date)) : ""}${channel ? ` · ${UI.esc(channel)}` : ""}</span></span>
      </a>`;
    };
    /* ---------- Pakistani Dramas (user order 2026-10-26): POSTER cards
       of the published Pakistani TV dramas, newest first (by first_air_date).
       Sits ABOVE the Drama Episodes rail: the user picks a drama poster,
       opens its show page, and that page lists the drama's episodes (each
       linking to its own episode page). Movies are NOT here — they live in
       Lollywood above. ---------- */
    const pkDramas = pubAll()
      .filter(x => x && x.poster_path && typeOf(x) === "tv" && (x.industry || "") === "pakistani")
      .sort(byNewest);
    const pkDramasHtml = pkDramas.length ? `<section class="section" id="homeDramas" data-sec="pk-drama-list">
      <div class="section-head"><h2>Pakistani Dramas</h2>
      <a class="see-all" href="/dramas">See All →</a></div>
      <p class="sec-sub">Pakistani dramas, newest first; open a drama for its episode list.</p>
      <div class="scroller">${pkDramas.slice(0, HOME_LIMITS.dramas).map(x => UI.posterCard(x, "tv", "Pakistani Drama")).join("")}</div></section>` : "";

    const epArticles = Object.values(window.FA_ARTICLES || {})
      .filter(a => a && a.id && (a.headline || "").includes("Watch on") && a.published)
      .sort((a, b) => String(b.published || "").localeCompare(String(a.published || "")));
    const epLatest = epArticles.slice(0, HOME_LIMITS.dramas);
    const pkRailHtml = epLatest.length ? `<section class="section" id="homePk" data-sec="pk-dramas">
      <div class="section-head"><h2><a href="/episode-guides" style="color:inherit">Drama Episodes</a></h2>
      <a class="see-all" href="/episode-guides">See All →</a></div>
      <p class="sec-sub">Latest drama episodes from YouTube channels, newest first; open an episode for its story summary.</p>
      <div class="tl-list">${epLatest.map(a => episodeRow(a)).join("")}</div></section>` : "";

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
       hero → Bollywood Spotlight → Bollywood Coming Soon →
       Box Office → mixed trending → Coming Soon calendar →
       Trending Searches → Trending News → awards → Lollywood →
       Pakistani Dramas (posters) → Drama Episodes. K-Drama, birthdays, OTT and episode strips are
       gone: they had no published data source. ("Star Spotlight" stays
       removed by user order.) */
    main.innerHTML = `<div class="wrap">
      ${heroHtml}
      ${newsSliderHtml}
      ${bollyHtml}
      ${bollySoonHtml}
      ${boHtml}
      ${trendingHtml}
      ${upHtml}
      ${searchesHtml}
      ${newsHtml}
      ${awardsStripHtml}
      ${lollyHtml}
      ${pkDramasHtml}
      ${pkRailHtml}
    </div>`;
    rendered = true;
    if (window.FARailScroll) window.FARailScroll.enhance(document.querySelectorAll("#homeSpotlight .scroller, #homeSoon .scroller"));

    // Shared, lazy industry switcher — filters the published catalogue
    // only (no live TMDB discover). Query only after a non-default tab
    // is chosen; the default Bollywood view is pre-rendered above.
    const industryLabel = i => i === "international" ? "World Cinema" : i === "pakistan" ? "Pakistan" : "Bollywood";
    const homeStateKey = kind => ({ spotlight: "hs", soon: "hn", calendar: "hc", boxoffice: "hb" }[kind]);
    document.querySelectorAll("[data-switcher]").forEach(group => {
      const section = group.closest("section"), kind = group.dataset.switcher, result = section.querySelector("[data-results]"), link = section.querySelector(".see-all"), stateKey = homeStateKey(kind);
      const activate = (industry, persist) => {
        group.querySelectorAll("button").forEach(btn => { const on = btn.dataset.industry === industry; btn.setAttribute("aria-pressed", String(on)); btn.classList.toggle("active", on); });
        if (persist) { const u = new URL(location.href); if (industry === "bollywood") u.searchParams.delete(stateKey); else u.searchParams.set(stateKey, industry); history.pushState(null, "", u); }
        section.querySelector("h2").textContent = kind === "spotlight" ? "Spotlight" : kind === "soon" ? "Coming Soon & Most Awaited" : kind === "boxoffice" ? "Box Office" : "Release Calendar";
        link.href = kind === "spotlight" ? `/movies?f=${industry}&s=recent&seeall=1` : kind === "soon" ? `/most-awaited?f=${industry}` : kind === "boxoffice" ? `/box-office?f=${industry}` : `/upcoming?f=${industry}&s=nearest&seeall=1`;
        section.querySelector(".sec-sub").textContent = kind === "spotlight" ? "All movies running now, newest first · " + industryLabel(industry) : kind === "soon" ? "Upcoming titles, most awaited first · " + industryLabel(industry) : kind === "boxoffice" ? "Recently-released films, newest first · " + industryLabel(industry) : "Announced film and series dates, nearest first · " + industryLabel(industry);
        const limitKey = kind === "spotlight" ? "spotlight" : kind === "soon" ? "soon" : kind === "boxoffice" ? "boxoffice" : "calendar";
        /* Spotlight: full pool, no cap (user order 2026-10-26). */
        const items = kind === "spotlight" ? publishedFor(kind, industry) : kind === "boxoffice" ? boPoolFor(industry).slice(0, HOME_LIMITS.boxoffice) : publishedFor(kind, industry).slice(0, HOME_LIMITS[limitKey]);
        if (kind === "calendar") result.innerHTML = items.length ? items.map(x => calendarRow(x, typeOf(x), dateOf(x))).join("") : '<p role="status">No confirmed releases found in this window.</p>';
        else if (kind === "boxoffice") result.innerHTML = items.length ? items.map(entry => boCardHtml(entry, dwData[String(entry.id)] || [])).join("") : '<p role="status">No matching titles found.</p>';
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













