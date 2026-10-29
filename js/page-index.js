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
    /* SEO audit 2026-10-28 (claude-seo): no jsonld here — the home shell
       already carries the WebSite block WITH SearchAction; the JS copy
       added a second WebSite block without it. */
  });

  main.innerHTML = `<div class="wrap">
    <div class="sk" style="height:340px;border-radius:22px;margin:26px 0 8px"></div>
    <section class="section"><div class="section-head"><h2>Spotlight</h2></div>
      <div class="scroller">${UI.skelCards(6)}</div></section>
  </div>`;

  /* Category transitions follow the user's Pakistan-local date. Box-office
     reports keep their separately defined India (IST) reporting day. */
  const today = UI.todayPKT();
  const todayIST = UI.todayIST();
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
    const byOldest = (a, b) => dateOf(a).localeCompare(dateOf(b)) || (a.published_at || "").localeCompare(b.published_at || "");
    /* A future festival premiere can appear in Coming Soon while its date
       is still ahead; once that date passes it is no longer upcoming and
       does not masquerade as a theatrical release in Spotlight. */
    const isFestivalOnly = (x) => x && x.date_kind === "festival";
    const isReleased = (x) => { const d = dateOf(x); return !!d && d <= today && !isFestivalOnly(x); };
    const isUpcoming = (x) => { const d = dateOf(x); return !!d && d > today; };
    const freshReleased = (x) => isReleased(x) && UI.isFresh(x);
    /* Spotlight recency (2026-10-28, user report: 2023/2025 titles on the
       rail): "Movies running now" is a 60-day window — a theatrical run
       is ~8 weeks, and the section's own sub-text promises "running now".
       Live counts 2026-10-28 (released on/before today): Bollywood 12 of
       14 in window (drops The Last Ride 2025-07-05, Sumo Didi 2023-10-27),
       World 28 of 33. After the standing streaming-only exclusion the
       Bollywood rail shows 8 (Gajab Raat, Reporting Live, Lust Stories 3
       and Gandhari are streaming-only) and the World rail stays full at
       12 — 8 is the true count of theatrically-running Bollywood movies
       today; no window can make it 12 without breaking the streaming-only
       exclusion or re-adding old titles. A 90-day window keeps the same
       titles (nothing sits between 2026-07-30 and 2026-08-29); 60 days is
       the tighter "running now" reading. The retained pool is ordered by
       release date newest-first; festival and streaming-only exclusions
       remain in effect. */
    const SPOTLIGHT_WINDOW_DAYS = 60;
    const spotlightCutoff = (() => {
      const d = new Date(today + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - SPOTLIGHT_WINDOW_DAYS);
      return d.toISOString().slice(0, 10);
    })();
    const inSpotlightWindow = (x) => { const d = dateOf(x); return !!d && d >= spotlightCutoff; };
    /* Industry rule (owner order 2026-10-28): Bollywood = ALL Indian
       titles, World Cinema = only international — via the canonical
       UI.industryOf(), never the baked `industry` (the seeder filed
       non-Hindi Indian titles as "world"). */
    const inIndustry = (x, industry) => UI.industryOf(x) === industry;

    /* Published titles for a homepage rail, by kind + industry. Returns
       the FULL ordered pool (no slice, no distinct filtering) — the caller
       slices HOME_LIMITS items off the front.
       kind "spotlight": movies released in the last 60 days, newest
         release date first.
       kind "soon": future-dated movies only, nearest release date first.
       kind "calendar": future-dated movies + TV, oldest date first. */
    /* Homepage limits (2026-10-26, homepage/See-All match): every section
       shows the FIRST N items of the exact ordered list its See All page
       shows — no distinct-title skipping, no one-item rails. The See All
       page lists the full pool in the same order. */
    /* Spotlight shows its recent-release pool in chronological order;
       it is not artificially capped, so newly released titles retain
       their correct date position at the end of the ordered rail. */
    /* OTT limit (2026-10-28, owner order): the homepage OTT rails show
       AT LEAST as many titles as the homepage movies rail (Spotlight,
       12 cards) — the old ott:7 cap bound the rails before the data did. */
    const HOME_LIMITS = { soon: 12, calendar: 6, trending: 6, boxoffice: 8, news: 7, lollywood: 6, dramas: 13, ott: 12 };
    /* Coming Soon order (shared with /most-awaited): only future-dated
       movies enter; sort by nearest release date, then use stable ratings
       and title tie-breaks for entries sharing the same date. */
    const byComingSoon = (a, b) => dateOf(a).localeCompare(dateOf(b))
        || (b.popularity || 0) - (a.popularity || 0)
        || (b.vote_count || 0) - (a.vote_count || 0)
        || (b.vote_average || 0) - (a.vote_average || 0)
        || String(UI.titleOf(a) || "").localeCompare(String(UI.titleOf(b) || ""));
    /* Industry tag for cards: UI.industryTag now returns "World Cinema" for
       world-industry titles (fixed in ui.js) — the explicit label is kept
       as a harmless guard. */
    const tagFor = (x) => UI.industryTag(x);
    /* ---------- Episode tracker (drama sections) ----------
       The Pakistani Dramas carousel and the Drama Episodes rail both
       need the live episode tracker (/out/episodes.json): the carousel
       shows the same "N episodes · Still airing" line as /dramas/
       (same extraMeta logic as js/page-dramas.js) and BOTH sections
       show only on-airing dramas (user order 2026-10-27). The fetch
       starts HERE so it runs while the other sections compute; it is
       awaited (with a 2s cap) just before the drama sections are
       built. If the tracker is unavailable, both sections fall back
       to their old behaviour (all dramas, no episode lines) — the
       tracker is a live extra, never a gate that empties the
       homepage. Keys are normalised drama names (aliases Dar =
       Dar-E-Nijaat, Zehar = Zehar-e-Mohabbat), exactly as in
       js/page-dramas.js. */
    const normDramaName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const DRAMA_ALIASES = { "dar": "dar e nijaat", "zehar": "zehar e mohabbat" };
    const canonDramaKey = (d) => DRAMA_ALIASES[normDramaName(d)] || normDramaName(d);
    const loadTracker = async () => {
      const map = {};
      try {
        const res = await fetch("/out/episodes.json", { cache: "no-store" });
        if (!res.ok) return map;
        const data = await res.json();
        for (const r of Object.values((data && data.episodes) || {})) {
          if (!r || !r.drama) continue;
          const key = canonDramaKey(r.drama);
          const n = r.episode;
          if (!Number.isInteger(n) || n <= 0) continue;
          const cur = map[key];
          const pub = r.published || "";
          if (!cur || n > cur.count || (n === cur.count && pub > cur.latestPublished)) {
            map[key] = { count: n, latestPublished: pub, drama: r.drama };
          }
        }
      } catch (_) { /* fall through with whatever loaded */ }
      return map;
    };
    const trackerPromise = loadTracker();
    /* TV order 2026-10-27, revised 2026-10-27 (owner order): the
       Movie/TV Type filter lives ONLY in OTT now — Spotlight and
       Coming Soon are movies-only, so no homepage UI passes "tv" or
       "all" to them any more. `type` is "movie" | "tv" | "all"
       (default "all" so the Release Calendar, which does not pass a
       type, keeps its old mixed pool). TV series ARE split by the
       Bollywood/World industry tabs here (fix 2026-10-27): the old
       rule let TV bypass the industry gate, so Bollywood + TV showed
       the 13 Pakistani dramas — the bug the owner reported. There is
       no Bollywood TV series in the catalogue, so an industry-gated
       TV view is honestly empty instead of showing the wrong
       industry's dramas. Streaming-first MOVIES stay out of
       Spotlight (the earlier exclusion order stands). */
    const publishedFor = (kind, industry, type = "all") => {
      const ind = industry === "international" ? "world" : "bollywood";
      const items = pubAll().filter(x => x && x.poster_path && UI.industryOf(x) === ind);
      const byType = (list) => type === "movie" ? list.filter(x => typeOf(x) === "movie")
        : type === "tv" ? list.filter(x => typeOf(x) === "tv") : list;
      const releasedTv = () => items
        .filter(x => x && x.poster_path && typeOf(x) === "tv" && isReleased(x)).sort(byNewest);
      if (kind === "spotlight") {
        /* Owner order 2026-10-26: show 10-15 on the homepage (was 4-5:
           the old 'fresh this week' rule capped Bollywood at the 4 movies
           released in the last 7 days). Now the 12 NEWEST released movies
           in the 60-day "running now" window (inSpotlightWindow, above).
           Live 2026-10-28: Bollywood 12 in-window, World 28 — the
           Bollywood rail shows 8 after the streaming-only exclusion,
           the World rail stays full at 12. New titles join daily via
           the nightly seeder. */
        const rel = items.filter(x => typeOf(x) === "movie" && isReleased(x) && inSpotlightWindow(x) && !UI.isStreamingOnly(x)).sort(byNewest);
        if (type === "tv") return releasedTv().slice(0, 12);
        if (type === "all") {
          /* "All" must visibly show BOTH types: a plain newest-first
             merge squeezes TV out — the 12 newest released items are
             all movies (every Oct 2026 movie is newer than the newest
             drama, Bano 13 Oct). So interleave newest movie / newest
             TV, alternating until the 12-card cap; each type stays
             newest-first within itself. When a type is empty the other
             fills the rail. */
          const tv = releasedTv();
          const merged = [];
          let mi = 0, ti = 0;
          while (merged.length < 12 && (mi < rel.length || ti < tv.length)) {
            if (mi < rel.length) merged.push(rel[mi++]);
            if (merged.length >= 12) break;
            if (ti < tv.length) merged.push(tv[ti++]);
          }
          return merged;
        }
        return rel.slice(0, 12);
      }
      if (kind === "soon") return byType(items.filter(x => isUpcoming(x))).sort(byComingSoon);
      return byType(items.filter(x => isUpcoming(x))).sort((a, b) => dateOf(a).localeCompare(dateOf(b)) || byNewest(a, b));
    };
    const hasKind = (kind) => publishedFor(kind, "bollywood").length > 0 || publishedFor(kind, "international").length > 0;

    /* ---------- HERO = latest currently-running movies (user order
       2026-10-28): 5 slides — first 2 Indian (industry "bollywood"),
       remaining 3 international ("world" + "pakistani"), newest-first
       within each bucket. If a bucket is short, the other bucket fills
       the remaining slots newest-first, so the hero stays full whenever
       the pool allows. A slide is "live" when the title has day-wise rows (Day N
       collection + running total); otherwise it shows Release Date +
       "Now in Cinemas" (the non-live branch of heroSlideHtml). No live
       TMDB fetch — a title with no day-wise rows simply has no live
       stats. Streaming-only titles NEVER enter the pool (user order
       2026-10-27, same UI.isStreamingOnly rule as Spotlight/Box
       Office): a Netflix title with no day-wise rows must not claim
       "Now in Cinemas". Theatrical titles that later reach OTT keep
       their day-wise rows and stay. ------- */
    const dwData = window.FA_DAYWISE || {};
    const heroPool = pubAll()
      .filter(x => x && typeOf(x) === "movie" && x.poster_path && isReleased(x) && UI.isFresh(x) && !UI.isStreamingOnly(x))
      .sort(byNewest);
    /* Strict latest-first means chronology across the eligible pool, not
       separate industry buckets; retain the existing eligibility gates. */
    const heroPicked = heroPool.slice(0, 5);
    const heroSlides = heroPicked.map(entry => {
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
      // SEO: one H1 per page — only the first hero slide carries the H1;
      // slides 2-5 use H2 (same visual styling, see css/style.css
      // .hero-in h1/.hero-in h2). Previously all 5 slides were H1s.
      const titleTag = idx === 0 ? "h1" : "h2";
      const indLabel = UI.industryTag(hd);
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
        stats.push(["Status", hd.release_date && hd.release_date <= today && hd.date_kind !== "festival" ? "Now in Cinemas" : "Coming Soon"]);
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
          <${titleTag}>${UI.esc(UI.titleOf(hd))}</${titleTag}>
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
    /* Homepage filter row (TV order 2026-10-27, corrected 2026-10-27,
       revised 2026-10-27 owner order): Industry + Type as .fa-select
       in-page dropdowns side by side in ONE horizontal line
       (.home-filter-row) — never chips, never a native <select>.
       OTT keeps BOTH dropdowns; Spotlight and Coming Soon are
       movies-only, so they get the Industry dropdown alone
       (withType=false) and no Type dropdown. Box Office and the
       Release Calendar keep the chip switcher. Default type is
       Movies (the sections' current view is unchanged on load). */
    const TYPE_OPTIONS = [{ value: "movie", label: "Movies" }, { value: "tv", label: "TV Series" }, { value: "all", label: "All" }];
    const INDUSTRY_OPTIONS = [{ value: "bollywood", label: "Bollywood" }, { value: "international", label: "World Cinema" }];
    const homeFilterRow = (kind, withType = true) => `<div class="home-filter-row" data-filter-row="${kind}">
      <div class="filter-select" role="group" aria-labelledby="${kind}IndLabel"><span id="${kind}IndLabel">Industry</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="${kind}IndTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="${kind}IndOptions" aria-labelledby="${kind}IndLabel ${kind}IndValue"><span class="fa-select-value" id="${kind}IndValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="${kind}IndOptions" role="listbox" aria-labelledby="${kind}IndLabel" hidden></div></div></div>
      ${withType ? `<div class="filter-select" role="group" aria-labelledby="${kind}TypeLabel"><span id="${kind}TypeLabel">Type</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="${kind}TypeTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="${kind}TypeOptions" aria-labelledby="${kind}TypeLabel ${kind}TypeValue"><span class="fa-select-value" id="${kind}TypeValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="${kind}TypeOptions" role="listbox" aria-labelledby="${kind}TypeLabel" hidden></div></div></div>` : ""}
    </div>`;
    const bollyReleased = publishedFor("spotlight", "bollywood", "movie");
    const bollyHtml = hasKind("spotlight") ? `<section class="section" data-sec="bollywood-spotlight" id="homeSpotlight"><div class="section-head"><h2>Spotlight</h2><a class="see-all" href="/movies?f=bollywood&seeall=1">See All →</a></div>${homeFilterRow("spotlight", false)}<p class="sec-sub">Movies running now · newest releases first.</p><div class="scroller" data-results>${bollyReleased.map(x => UI.posterCard(x, typeOf(x), "", undefined, undefined, true)).join("")}</div></section>` : "";
    const bollySoon = publishedFor("soon", "bollywood", "movie").slice(0, HOME_LIMITS.soon);
    const bollySoonHtml = hasKind("soon") ? `<section class="section" data-sec="bollywood-soon" id="homeSoon"><div class="section-head"><h2>Coming Soon &amp; Most Awaited</h2><a class="see-all" href="/most-awaited?f=bollywood&s=oldest">See All →</a></div>${homeFilterRow("soon", false)}<p class="sec-sub">Upcoming movies only · oldest release date first (nearest date first); dates may change.</p><div class="scroller" data-results>${bollySoon.map((x, i) => UI.posterCard(x, typeOf(x), "", i + 1, undefined, true)).join("")}</div></section>` : "";

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
    const lollyLatest = releasedPool(x => UI.industryOf(x) === "pakistani" && typeOf(x) === "movie").slice(0, HOME_LIMITS.lollywood);

    /* ---------- Trending Worldwide: AUTHENTIC trending only (user order
       2026-10-26). Renders ONLY from window.FA_TRENDING — a list of TMDB
       ids in trending order (js/trending-data.js) — matched to published
       entries in FA_PUBLISHED, in trending order, up to 6. If FA_TRENDING
       is missing or empty, the section renders NOTHING: no fallback to
       the newest/mixed pool — that fallback is exactly what the user
       called inauthentic. ---------- */
    const trendingIds = Array.isArray(window.FA_TRENDING) ? window.FA_TRENDING : [];
    const trendingTop20 = [...new Set(trendingIds.slice(0, 20).map(String))];
    const trendingEntries = trendingTop20
      .map(id => (window.FA_PUBLISHED || {})[id])
      .filter(x => x && typeOf(x) === "movie" && x.poster_path)
      .sort(byNewest)
      .slice(0, HOME_LIMITS.trending);
    const trendingHtml = rowSection("Trending Worldwide", "/movies?f=trending&seeall=1",
      trendingEntries.length ? `<div class="scroller">${trendingEntries.map((x, i) => UI.posterCard(x, "movie", tagFor(x), i + 1)).join("")}</div>` : "",
      "Eligible published movies trending this week, displayed newest release date first.",
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
      const weekStartDate = new Date(todayIST + "T00:00:00Z");
      weekStartDate.setUTCDate(weekStartDate.getUTCDate() - 6);
      const weekStart = weekStartDate.toISOString().slice(0, 10);
      const todayRows = clean.filter(r => r.date === todayIST);
      const weekRows = clean.filter(r => r.date >= weekStart && r.date <= todayIST);
      const todaySum = todayRows.reduce((s, r) => s + r.collection, 0);
      const weekSum = weekRows.reduce((s, r) => s + r.collection, 0);
      const weekDays = new Set(weekRows.map(r => r.date)).size;
      const totalSum = clean.reduce((s, r) => s + r.collection, 0);
      const date = entry.release_date || "";
      const missing = '<span class="fa-box-unavailable">Not reported</span>';
      const poster = `<span class="fa-box-poster${entry.poster_path ? "" : " is-missing"}" role="img" aria-label="${entry.poster_path ? UI.esc(UI.titleOf(entry)) + " poster" : "Poster unavailable"}">${entry.poster_path ? `<img src="${UI.img(entry.poster_path, "w92")}" alt="" loading="lazy" onerror="this.parentElement.classList.add('is-missing');this.parentElement.setAttribute('aria-label','Poster unavailable');this.remove()">` : ""}<span aria-hidden="true">No poster</span></span>`;
      return `<a class="fa-box-latest-card" data-movie-id="${UI.esc(entry.id)}" data-release="${UI.esc(date)}" href="/movie?id=${entry.id}" aria-label="${UI.esc(UI.titleOf(entry))} — box office details"><div class="fa-box-card-head">${poster}<div class="fa-box-card-labels"><span class="fa-box-latest-title" title="${UI.esc(UI.titleOf(entry))}">${UI.esc(UI.titleOf(entry))}</span><p class="fa-box-latest-meta">Released ${UI.esc(UI.fmtDate(date))}</p></div><span class="fa-box-card-arrow" aria-hidden="true">›</span></div><dl aria-label="Reported box office summary"><div title="Today's reported collection · ${UI.esc(todayIST)} IST"><dt>Today${latestDate ? ` · ${shortDate(latestDate)}` : ""}</dt><dd>${todayRows.length ? UI.fmtMoney(todaySum) : missing}</dd></div><div title="${UI.esc(weekDays ? weekDays + " of 7 days reported" : "No daily records reported for this period")} · ${UI.esc(weekStart)} to ${UI.esc(todayIST)} IST"><dt>7 Days</dt><dd>${weekRows.length ? `${UI.fmtMoney(weekSum)}${weekDays < 7 ? `<abbr class="fa-box-partial" title="${UI.esc(weekDays + " of 7 days reported · partial")}">${weekDays}/7</abbr>` : ""}` : missing}</dd></div>${(() => { const ww = (window.FA_WORLDWIDE || {})[String(entry.id)]; if (clean.length) return `<div title="Sum of the reported day-wise collections tracked by FlickAtlas"><dt>Recorded</dt><dd>${UI.fmtMoney(totalSum)}</dd></div>`; if (ww && ww.total_usd) return `<div title="Reported ${UI.esc(ww.scope === "domestic-only-so-far" || ww.scope === "domestic-opening-weekend" ? "domestic" : "worldwide")} theatrical total · ${UI.esc(ww.source || "")} · as of ${UI.esc(ww.as_of || "")} — no India-Net day-wise figures reported"><dt>Worldwide total</dt><dd>${UI.fmtMoney(ww.total_usd)}</dd></div>`; return `<div title="Sum of the reported day-wise collections tracked by FlickAtlas"><dt>Recorded</dt><dd>${missing}</dd></div>`; })()}</dl></a>`;
    };
    /* Box Office sort (2026-10-28 fix): release date DESC, then published_at
       DESC, then recorded total DESC (India-Net rows, else the worldwide
       fallback total). The old release-date-only sort left every title
       sharing a release date (e.g. all five 23 Oct 2026 releases) in
       arbitrary catalogue order, which read as unsorted. */
    const boTotal = (x) => { const r = dwData[String(x.id)] || []; const s = r.reduce((a, rw) => a + (rw.collection || 0), 0); if (s) return s; const w = (window.FA_WORLDWIDE || {})[String(x.id)]; return (w && w.total_usd) || 0; };
    const boSort = (a, b) => byNewest(a, b) || (boTotal(b) - boTotal(a));
    /* Box Office (user order 2026-10-26): the SAME pool and order as
       /box-office — recently-released published movies, newest first
       (release date DESC). A title qualifies if it is released and (has
       day-wise rows OR is fresh); titles with no rows yet show an honest
       "not yet recorded" state in the card. First 8. */
    const boHasRows = (x) => { const r = dwData[String(x.id)]; return Array.isArray(r) && r.length > 0; };
    const boPool = pubAll()
      .filter(x => x && typeOf(x) === "movie" && x.poster_path && (x.release_date || "") && (x.release_date || "") <= today && x.date_kind !== "festival" && (boHasRows(x) || UI.isFresh(x)) && !UI.isStreamingOnly(x))
      .sort(boSort);
    /* Box Office by industry (user order 2026-10-26): the same pool as
       /box-office, split by industry for the homepage switcher — the
       exact switchButtons()/activate() pattern the Spotlight and Coming
       Soon sections use. Default view = Bollywood. */
    const boPoolFor = (industry) => {
      const ind = industry === "international" ? "world" : "bollywood";
      return boPool.filter(x => UI.industryOf(x) === ind);
    };
    const boHasKind = boPoolFor("bollywood").length > 0 || boPoolFor("international").length > 0;
    const boPicks = boPoolFor("bollywood").slice(0, HOME_LIMITS.boxoffice).map(entry => ({ entry, rows: dwData[String(entry.id)] || [] }));
    const boHtml = boHasKind ? `<section class="section" data-sec="box-office" id="homeBoxOffice">
      <div class="section-head"><h2>Box Office</h2>
      <a class="see-all" href="/box-office?f=bollywood">See All →</a></div>
      ${switchButtons("boxoffice")}<p class="sec-sub">Recently-released films, newest first · Bollywood</p>
      <div data-results>${boPicks.map(p => boCardHtml(p.entry, p.rows)).join("")}</div>
    </section>` : "";

    /* ---------- OTT (owner order 2026-10-27): the separate OTT
       section — Now on OTT + Coming to OTT, from window.FA_OTT
       (generated by scripts/build_ott.py). Falls back to deriving the
       groups from FA_PUBLISHED when ott-data.js has not loaded.
       Industry rules match /box-office (Bollywood = industry
       "bollywood" OR origin IN; World Cinema = world AND NOT Indian).
       Default view = Bollywood; the switcher re-renders both rails. */
    const ottGroups = (() => {
      const o = window.FA_OTT;
      if (o && Array.isArray(o.now) && Array.isArray(o.coming)) return o;
      const now = [], coming = [];
      for (const x of pubAll()) {
        /* Owner correction 2026-10-28 21:10 PKT: Pakistani dramas are a
           SEPARATE category (YouTube-sourced), NOT TV series — they NEVER
           appear on OTT, which carries only movies + TV series. */
        if (UI.industryOf(x) === "pakistani") continue;
        if (!x || !x.id || !x.poster_path || !(x.providers || []).length) continue;
        const d = dateOf(x);
        if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
        /* A release/air date is usable as evidence for movie availability;
           TV requires a canonical OTT group with its own confirmed date. */
        if (typeOf(x) === "tv") continue;
        (d <= today ? now : coming).push({ id: x.id, type: typeOf(x), providers: x.providers, date: d, date_kind: "release" });
      }
      now.sort((a, b) => b.date.localeCompare(a.date));
      coming.sort((a, b) => a.date.localeCompare(b.date));
      return { now, coming };
    })();
    const pubMap = {};
    pubAll().forEach(x => { if (x && x.id != null) pubMap[String(x.id)] = x; });
    /* OTT industry rules match /box-office and /ott (canonical
       UI.industryOf): Bollywood = all Indian, World = only international. */
    const ottInIndustry = (x, industry) => industry === "international"
      ? UI.industryOf(x) === "world"
      : UI.industryOf(x) === "bollywood";
    const ottFor = (group, industry, type = "all") => (ottGroups[group] || [])
      .map(g => ({ g, x: pubMap[String(g.id)] }))
      .filter(({ g, x }) => {
        if (!x || !x.poster_path || !(Array.isArray(g.providers) && g.providers.length)) return false;
        const d = String(g.date || "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
        if (typeOf(x) === "tv") {
          const cutoffDate = new Date(today + "T00:00:00Z");
          cutoffDate.setUTCDate(cutoffDate.getUTCDate() - 30);
          const cutoff = cutoffDate.toISOString().slice(0, 10);
          const air = String(x.first_air_date || "");
          if (!/^\d{4}-\d{2}-\d{2}$/.test(air)) return false;
          if (group === "now" && (air > today || air < cutoff || d !== air)) return false;
          /* TV upcoming requires explicit digital/streaming date evidence;
             a provider + future first-air date is not OTT confirmation. */
          if (group === "coming" && (d <= today || !["digital", "streaming", "ott"].includes(String(g.date_kind || "").toLowerCase()))) return false;
        }
        if (group === "now" && d > today) return false;
        if (group === "coming" && d <= today) return false;
        /* Owner correction 2026-10-28 21:10 PKT: Pakistani dramas are a
           SEPARATE category (YouTube-sourced), NOT TV series — they NEVER
           appear on OTT, which carries only movies + TV series. Excluded
           CATEGORICALLY here, not via providers or the industry gate:
           all 15 catalogue "TV" entries today are Pakistani dramas, so
           without this the "All" OTT TV rail would leak them. TV series
           follow the SAME industry gate as movies (supersedes the
           2026-10-27 "TV ignores the industry tabs" rule). */
        if (UI.industryOf(x) === "pakistani") return false;
        if (type === "movie" && typeOf(x) !== "movie") return false;
        if (type === "tv" && typeOf(x) !== "tv") return false;
        return ottInIndustry(x, industry);
      })
      .sort((a, b) => group === "now" ? String(b.g.date).localeCompare(String(a.g.date)) : String(a.g.date).localeCompare(String(b.g.date)))
      .slice(0, HOME_LIMITS.ott);
    const ottCardHtml = ({ g, x }, coming) => UI.ottCard(x, { coming, providers: g.providers, tag: tagFor(x), date: g.date, dateKind: g.date_kind });
    const ottRailHtml = (items, coming) => items.length
      ? items.map(p => ottCardHtml(p, coming)).join("")
      : `<p role="status">No ${coming ? "upcoming OTT releases" : "confirmed recent OTT series or titles"} reported for this industry yet.</p>`;
    const ottHasKind = ["bollywood", "international"].some(ind =>
      ottFor("now", ind).length > 0 || ottFor("coming", ind).length > 0);
    const ottHtml = ottHasKind ? `<section class="section" data-sec="ott" id="homeOtt">
      <div class="section-head"><h2>OTT</h2>
      <a class="see-all" href="/ott?f=bollywood">See All →</a></div>
      ${homeFilterRow("ott")}<p class="sec-sub">Movies now streaming, and what's coming next · Bollywood</p>
      <div class="ott-group"><h3>Now on OTT</h3><div class="scroller" data-results="now">${ottRailHtml(ottFor("now", "bollywood", "movie"), false)}</div></div>
      <div class="ott-group"><h3>Coming to OTT</h3><div class="scroller" data-results="coming">${ottRailHtml(ottFor("coming", "bollywood", "movie"), true)}</div></div>
    </section>` : "";

    /* ---------- coming soon: a DAILY release calendar over the
       published upcoming titles — nearest date first, first 6 rows. ----- */
    const MONTHS_S = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const calendarRow = (x, type, date) => { const [, mm, dd] = date.split("-"); return `<a class="tl-row" href="/${type === "tv" ? "show" : "movie"}?id=${x.id}"><span class="tl-date"><b>${parseInt(dd, 10)}</b><span>${MONTHS_S[parseInt(mm, 10) - 1]}</span></span><img src="${UI.img(x.poster_path, "w92")}" alt="" loading="lazy" onerror="this.remove()"><span class="tl-info"><b>${UI.esc(UI.titleOf(x))}</b><span>${type === "tv" ? "Premieres " : ""}${UI.fmtDate(date)}${UI.rating(x) ? ` · ${UI.rating(x)}/10` : ""}</span></span><span class="tag-chip">${UI.esc(tagFor(x))}</span></a>`; };
    const upList = publishedFor("calendar", "bollywood").slice(0, HOME_LIMITS.calendar);
    const upHtml = hasKind("calendar") ? `<section class="section" data-sec="coming-soon" id="homeCalendar">
      <div class="section-head"><h2>Coming Soon — Release Calendar</h2>
      <a class="see-all" href="/upcoming?f=bollywood&s=oldest&seeall=1">See All →</a></div>
      ${switchButtons("calendar")}
      <p class="sec-sub">Upcoming release and premiere dates only · oldest release date first.</p>
      <div class="tl-list" data-results>
        ${upList.length ? upList.map(x => calendarRow(x, typeOf(x), dateOf(x))).join("") : '<p role="status">No confirmed releases found in this window.</p>'}
      </div></section>` : "";

    /* ---------- Trending News (§2.7): the SAME feed /news renders
       (/api/news), first 7 headlines, same editorial-card markup (title
       + meta). NEWS EXPIRY (owner order 2026-10-28): only headlines from
       the last 24 hours are listed (UI.isNewsFresh) — older items stay
       in the data and on their article pages, they just leave the
       listings. When the feed is unreachable or empty, the section
       removes itself; when the feed has only stale items, the section
       stays and says so honestly. ---------- */
    const newsHtml = `<section class="section" id="homeNews" data-sec="news">
      <div class="section-head"><h2>Trending News</h2>
      <a class="see-all" href="/news">See All →</a></div>
      <p class="sec-sub">Pichle 24 ghante ki khabrein — newest first.</p>
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
      /* Indian-language stories belong in Bollywood (owner order
         2026-10-28: Bollywood = ALL India-related) — Tamil/Telugu keep
         their Kollywood tag as well, Malayalam/Kannada/Punjabi/Marathi/
         Bengali/Gujarati stories gain the Bollywood tag here. */
      if (hasWord(text, "tamil") || hasWord(text, "telugu") || hasWord(text, "malayalam") ||
          hasWord(text, "mollywood") || hasWord(text, "kannada") || hasWord(text, "sandalwood") ||
          hasWord(text, "punjabi") || hasWord(text, "marathi") || hasWord(text, "bengali") ||
          hasWord(text, "gujarati") || text.includes("₹")) tags.add("bollywood");
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
      /* Bollywood and World Cinema are mutually exclusive (owner order
         2026-10-28): an Indian or Pakistani story is never World Cinema,
         even when the feed filed it under "international". Runs last so
         keyword-derived tags above are all counted. */
      if (tags.has("bollywood") || tags.has("kollywood") || tags.has("lollywood") || tags.has("pakistan")) tags.delete("world");
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
              <span class="news-slide-img">${UI.newsThumbImg(img, 800, { srcset: true, loading: i === 0 ? "eager" : "lazy", fetchpriority: i === 0 ? "high" : "" })}<span class="news-slide-tag">${UI.esc(SLIDERTAGLABEL[primary] || primary)}</span></span>
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
    /* NEWS PURITY (owner order 2026-10-27): episode posts are NOT
       news — drop them from the feed here so neither Trending News
       nor the slider ever shows one. Same test as page-news.js. */
    const isEpisodeItem = (it) => {
      const t = String((it && it.title) || "");
      const l = String((it && it.link) || "");
      return /(?:Episode\s+\d+|Last Episode)\s*[—–-]\s*Watch on\b/i.test(t)
        || /youtube\.com\/watch|youtu\.be\//i.test(l);
    };
    /* Trending News filter options (same 12 categories as /news,
       js/page-news.js FILTERS). The dropdown itself is the page's
       existing mountFaSelect (Drama Episodes filter, same component). */
    const NEWS_FILTERS = [["bollywood", "Bollywood"], ["lollywood", "Lollywood"], ["kollywood", "Kollywood"], ["world", "World Cinema"], ["pakistan", "Pakistan"], ["celebrity", "Celebrity"], ["viral", "Viral"], ["award", "Award"], ["ott", "OTT"], ["music", "Music"], ["tech", "Tech"]];
    const NEWS_FILTER_LABEL = Object.fromEntries(NEWS_FILTERS);
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
        /* NEWS EXPIRY (owner order 2026-10-28): the feed carries 48 h
           of items (convert-news.py), but the listings show only the
           last 24 h. One filter here covers BOTH the slider and the
           Trending News grid below — both derive from feedItems. */
        const feedItems = j.items.filter(it => !isEpisodeItem(it) && UI.isNewsFresh(it))
          .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0) || String(a.id || "").localeCompare(String(b.id || "")));
        const CATLABEL = { bollywood: "Bollywood", world: "World Cinema", pakistan: "Pakistan", celebrity: "Celebrity", viral: "Viral" };
        /* The slider gets the FULL feed (not the 7-item Trending News cap):
           it needs the whole feed to find 8 Indian (bollywood/kollywood)
           items with images. No second fetch — same j.items, normalised
           the same way. */
        const sliderArts = feedItems.map(it => ({
          ...it,
          cats: (Array.isArray(it.cats) ? it.cats : []).map(c => c === "international" ? "world" : c).filter(c => c !== "korea")
        }));
        try { renderNewsSlider(sliderArts); } catch (_) { document.getElementById("homeNewsSlider")?.remove(); }
        /* Trending News filter (user order 2026-10-27, clarified 02:16
           PKT): homepage filters are DROPDOWNS in one single line — one
           .fa-select in-page dropdown (same component as /news and the
           Drama Episodes filter), never a native <select> popup and
           never wrapping chips. Filters the same feed the /news
           dropdown filters (deriveTags, same as /news), newest 7 of
           the filtered list. Thumbnails (user order 2026-10-27): each
           row with an article image renders thumb-left / title-right
           like the episode .ep-row rows; rows without an image keep
           today's text card. */
        const fa = window.FA_ARTICLES || {};
        const filterPool = feedItems.map(it => ({
          ...it,
          cats: (Array.isArray(it.cats) ? it.cats : []).map(c => c === "international" ? "world" : c).filter(c => c !== "korea")
        }));
        let homeFilter = "all";
        host.innerHTML = `<div class="section-head"><h2>Trending News</h2>
          <a class="see-all" href="/news">See All →</a></div>
          <p class="sec-sub" id="homeNewsSub">Pichle 24 ghante ki khabrein — newest first.</p>
          <div id="chipHost"><div class="listing-select-row listing-select-row--single"><div class="filter-select" role="group" aria-labelledby="homeNewsFilterLabel"><span id="homeNewsFilterLabel">Category</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="homeNewsFilterTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="homeNewsFilterOptions" aria-labelledby="homeNewsFilterLabel homeNewsFilterValue"><span class="fa-select-value" id="homeNewsFilterValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="homeNewsFilterOptions" role="listbox" aria-labelledby="homeNewsFilterLabel" hidden></div></div></div></div></div>
          <div class="editorial-grid" id="homeNewsGrid"></div>`;
        const grid = host.querySelector("#homeNewsGrid");
        const sub = host.querySelector("#homeNewsSub");
        const renderHomeNewsGrid = () => {
          const list = (homeFilter === "all" ? filterPool : filterPool.filter(it => deriveTags(it).includes(homeFilter))).slice(0, HOME_LIMITS.news);
          sub.textContent = homeFilter === "all"
            ? "Pichle 24 ghante ki khabrein — newest first."
            : `${list.length} headline${list.length === 1 ? "" : "s"} · ${NEWS_FILTER_LABEL[homeFilter] || homeFilter}`;
          /* Empty state (owner order 2026-10-28): when nothing fresh
             arrived in the last 24 h, say so honestly — never fill the
             grid with old items. */
          if (!list.length) {
            grid.innerHTML = UI.stateMsg(filterPool.length
              ? "Is category me pichle 24 ghante me koi khabar nahi aayi."
              : "Pichle 24 ghante me koi nayi khabar nahi aayi.", false);
            return;
          }
          grid.innerHTML = list.map((it, idx) => {
            const art = fa[it.id] || {};
            const imgs = Array.isArray(art.images) ? art.images : [];
            const img = imgs.length && imgs[0] && imgs[0].url ? String(imgs[0].url) : "";
            const categories = (Array.isArray(it.cats) ? it.cats : []).map(c => CATLABEL[c] || c);
            const meta = [categories.length ? categories.join(" · ") : "", Number.isFinite(it.ts) && it.ts > 0 ? UI.relTime(it.ts) : ""].filter(Boolean);
            if (img) {
              return `<a class="editorial-card editorial-card--thumb" href="${UI.newsItemPath(it)}">
              <span class="editorial-card__thumb">${UI.newsThumbImg(img, 200, { loading: idx < 3 ? "eager" : "lazy" })}</span>
              <span class="editorial-card__body"><span class="editorial-card__title">${UI.esc(it.title)}</span>
              ${meta.length ? `<span class="editorial-card__meta">${meta.map(UI.esc).join(" · ")}</span>` : ""}</span>
            </a>`;
            }
            return `<a class="editorial-card" href="${UI.newsItemPath(it)}">
              <span class="editorial-card__title">${UI.esc(it.title)}</span>
              ${meta.length ? `<span class="editorial-card__meta">${meta.map(UI.esc).join(" · ")}</span>` : ""}
            </a>`;
          }).join("");
        };
        mountFaSelect(host.querySelector("#chipHost .filter-select"),
          [{ value: "all", label: "All" }, ...NEWS_FILTERS.map(([k, label]) => ({ value: k, label }))],
          "all", (value) => { homeFilter = value; renderHomeNewsGrid(); });
        renderHomeNewsGrid();
      } catch (_) {
        host.remove();
        document.getElementById("homeNewsSlider")?.remove();
      }
    };

    /* ---------- Lollywood: latest Pakistani releases (computed above). ---------- */
    const lollyHtml = lollyLatest.length ? `<section class="section" data-sec="lollywood">
      <div class="section-head"><h2>Lollywood — Latest Pakistani Releases</h2>
      <a class="see-all" href="/category?cat=lollywood&t=movie">See All →</a></div>
      <p class="sec-sub">Pakistani movies, latest first.</p>
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
        <span class="ep-thumb">${img ? UI.epThumbImg(img, a.headline || "") : `<span class="noimg"><span>EP</span></span>`}</span>
        <span class="ep-info"><b>${UI.esc(a.headline || "")}</b>
        <span>${date ? UI.esc(UI.fmtDate(date)) : ""}${channel ? ` · ${UI.esc(channel)}` : ""}</span></span>
      </a>`;
    };
    /* Custom in-page dropdown (user order 2026-10-27): a button showing
       the current choice + a list panel that expands DOWNWARD directly
       below the button, inside the page — never a native <select>, which
       Chrome on Android phones renders as a modal popup dialog.
       Same component and behaviour as js/page-guides.js (the Drama
       Episodes filter there) and js/page-dramas.js. Reuses the site's
       .fa-select styles. No <select> exists in this control. */
    function mountFaSelect(host, options, initialValue, onPick) {
      const trigger = host.querySelector(".fa-select-trigger");
      const label = host.querySelector(".fa-select-value");
      const listbox = host.querySelector('[role="listbox"]');
      let value = initialValue;
      let activeIndex = Math.max(0, options.findIndex(o => o.value === value));
      let opened = false, typeAhead = "", typeAheadTimer;
      function renderMenu() {
        listbox.innerHTML = options.map((option, index) =>
          `<div class="fa-select-option" id="${listbox.id}-option-${index}" role="option" aria-selected="${index === activeIndex}" data-index="${index}"><span>${UI.esc(option.label)}</span><span class="fa-select-check" aria-hidden="true">✓</span></div>`).join("");
      }
      function sync() {
        activeIndex = Math.max(0, options.findIndex(o => o.value === value));
        label.textContent = options[activeIndex] ? options[activeIndex].label : "Choose an option";
        renderMenu();
        if (opened) activate(activeIndex);
      }
      function activate(index) {
        const opts = [...listbox.querySelectorAll('[role="option"]')];
        if (!opts.length) return;
        activeIndex = (index + opts.length) % opts.length;
        const active = opts[activeIndex];
        trigger.setAttribute("aria-activedescendant", active.id);
        opts.forEach((option, i) => option.classList.toggle("is-active", i === activeIndex));
        active.scrollIntoView?.({ block: "nearest" });
      }
      function close(restoreFocus) {
        if (!opened) return;
        opened = false; listbox.hidden = true; trigger.setAttribute("aria-expanded", "false");
        trigger.removeAttribute("aria-activedescendant");
        if (restoreFocus) trigger.focus();
      }
      function open() {
        sync(); if (!options.length) return;
        opened = true; listbox.hidden = false; trigger.setAttribute("aria-expanded", "true");
        activate(activeIndex);
      }
      function choose() {
        const option = options[activeIndex]; if (!option) return;
        value = option.value;
        sync();
        close(true);
        onPick(value);
      }
      trigger.addEventListener("click", () => opened ? close() : open());
      trigger.addEventListener("keydown", event => {
        if (event.key === "Escape" && opened) { event.preventDefault(); close(); return; }
        if (event.key === "Tab" && opened) { close(); return; }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          if (!opened) open();
          else if (event.key === "ArrowDown") activate(activeIndex + 1);
          else if (event.key === "ArrowUp") activate(activeIndex - 1);
          else if (event.key === "Home") activate(0);
          else activate(options.length - 1);
          return;
        }
        if ((event.key === "Enter" || event.key === " ") && opened) { event.preventDefault(); choose(); return; }
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          typeAhead += event.key.toLocaleLowerCase();
          const match = options.findIndex(option => option.label.trim().toLocaleLowerCase().startsWith(typeAhead));
          if (match >= 0) { if (!opened) open(); activate(match); event.preventDefault(); }
          clearTimeout(typeAheadTimer); typeAheadTimer = setTimeout(() => { typeAhead = ""; }, 700);
        }
      });
      listbox.addEventListener("click", event => {
        const option = event.target.closest('[role="option"]'); if (!option) return;
        activeIndex = Number(option.dataset.index); choose();
      });
      document.addEventListener("pointerdown", event => { if (opened && !host.contains(event.target)) close(); });
      sync();
      return { get value() { return value; }, setValue(v) { value = v; sync(); } };
    }

    /* ---------- Pakistani Dramas (user order 2026-10-26): POSTER cards
       of the published Pakistani TV dramas, newest first (by first_air_date).
       Sits ABOVE the Drama Episodes rail: the user picks a drama poster,
       opens its show page, and that page lists the drama's episodes (each
       linking to its own episode page). Movies are NOT here — they live in
       Lollywood above.
       Episode line + on-airing filter (user orders 2026-10-27): each card
       carries the same "N episodes · Still airing" line as /dramas/
       (UI.posterCard extraMeta — same markup, same text), and the
       carousel shows ONLY on-airing dramas: latest tracked episode
       within 7 days AND TMDB status "Returning Series" (the show
       page's "Still airing" rule). A drama with no tracker data
       (Rutba, Circle Story, Mitti De Baway) therefore does NOT appear
       here — it stays on /dramas/, which keeps the full list. If the
       tracker failed to load, the filter is skipped and all dramas
       show without episode lines (fail-open). ---------- */
    const trackerByDrama = await Promise.race([
      trackerPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
    ]).catch(() => null) || {};
    const trackerLoaded = Object.keys(trackerByDrama).length > 0;
    const pkByKey = {};
    for (const x of pubAll()) {
      if (x && typeOf(x) === "tv" && UI.industryOf(x) === "pakistani") {
        pkByKey[canonDramaKey(UI.titleOf(x))] = x;
      }
    }
    const isAiringKey = (key) => {
      if (!trackerLoaded || !key) return false;
      const t = trackerByDrama[key];
      if (!t || !t.latestPublished) return false;
      const last = Date.parse(t.latestPublished);
      if (!Number.isFinite(last) || (Date.now() - last) / 86400000 > 7) return false;
      const pub = pkByKey[key];
      return !pub || String(pub.status || "").toLowerCase().indexOf("returning") !== -1;
    };
    const epMetaFor = (x) => {
      const t = trackerByDrama[canonDramaKey(UI.titleOf(x))];
      if (!t) return "";
      let airing = false;
      if (t.latestPublished) {
        const last = Date.parse(t.latestPublished);
        airing = Number.isFinite(last) && (Date.now() - last) / 86400000 <= 7
          && String(x.status || "").toLowerCase().indexOf("returning") !== -1;
      }
      return `${t.count} episode${t.count === 1 ? "" : "s"}${airing ? " · Still airing" : ""}`;
    };
    const pkDramas = pubAll()
      .filter(x => x && x.poster_path && typeOf(x) === "tv" && UI.industryOf(x) === "pakistani")
      .filter(x => !trackerLoaded || isAiringKey(canonDramaKey(UI.titleOf(x))))
      .sort(byNewest);
    const pkDramasHtml = pkDramas.length ? `<section class="section" id="homeDramas" data-sec="pk-drama-list">
      <div class="section-head"><h2>Pakistani Dramas</h2>
      <a class="see-all" href="/dramas">See All →</a></div>
      <p class="sec-sub">Pakistani dramas, newest first; open a drama for its episode list.</p>
      <div class="scroller">${pkDramas.slice(0, HOME_LIMITS.dramas).map(x => UI.posterCard(x, "tv", "Pakistani Drama", null, epMetaFor(x))).join("")}</div></section>` : "";

    /* Drama identity of an episode article (same headline parsing as
       js/page-guides.js: "<Drama> Episode <N> — Watch on <channel>"
       and the "<Drama> — Last Episode" finale form; entities.titles[0]
       preferred when present). Returns { key, name } — key for the
       airing check + filter, name (published title when the drama is
       listed, else the raw headline name) for the filter options.
       Returns null when the headline is not an episode headline. */
    const dramaOfArticle = (a) => {
      const h = String((a && a.headline) || "");
      const wm = h.match(/^(.*?)\s+[—–-]\s+Watch on\s+(.+)$/i);
      if (!wm) return null;
      const left = wm[1].trim();
      const em = left.match(/^(.+?)\s+Episode\s+(\d+)$/i);
      const fm = !em && left.match(/^(.+?)\s+[—–-]?\s*Last Episode$/i);
      if (!em && !fm) return null;
      const raw = ((a.entities && a.entities.titles && a.entities.titles[0])
        || (em ? em[1].trim() : fm[1].trim()) || "").trim();
      if (!raw) return null;
      const key = canonDramaKey(raw);
      const pub = pkByKey[key];
      return { key, name: pub ? UI.titleOf(pub) : raw };
    };
    const epArticles = Object.values(window.FA_ARTICLES || {})
      .filter(a => a && a.id && (a.headline || "").includes("Watch on") && a.published)
      .sort((a, b) => (Date.parse(b.published || "") || 0) - (Date.parse(a.published || "") || 0) || String(a.id || "").localeCompare(String(b.id || "")));
    /* On-airing filter (user order 2026-10-27): an episode stays only
       when its drama is airing (latest tracked episode within 7 days
       + Returning Series where the drama is listed). Rows whose drama
       cannot be parsed stay — the tracker writes every episode
       headline in the standard format, so this is a fail-open guard
       only. When the tracker failed to load, nothing is filtered. */
    /* Pakistani-Dramas gate (user order 2026-10-26): the rail holds
       ONLY episodes of dramas listed in FA_PUBLISHED (type tv,
       industry pakistani) — Bulbulay Season 2 (sitcom) and Exclusive
       Chat (interview) are tracker entries, not listed dramas, so
       their rows never appear here, newest or not. Applies whether
       or not the tracker loaded (identity, not airing); headlines
       that cannot be parsed stay (fail-open guard). */
    const epListed = epArticles.filter(a => { const d = dramaOfArticle(a); return !d || pkByKey[d.key]; });
    const epAiring = trackerLoaded
      ? epListed.filter(a => { const d = dramaOfArticle(a); return !d || isAiringKey(d.key); })
      : epListed;
    const epLatest = epAiring.slice(0, HOME_LIMITS.dramas);
    /* Drama filter options: the dramas that have (airing) episodes in
       this rail, A–Z like /episode-guides. "All Dramas" is added at
       mount time. */
    const epDramaOptions = (() => {
      const seen = new Map();
      for (const a of epAiring) {
        const d = dramaOfArticle(a);
        /* Pakistani-Dramas gate (same rule as /episode-guides):
           only dramas listed in FA_PUBLISHED (type tv, industry
           pakistani, aliases Dar/Zehar resolved by canonDramaKey)
           become filter options. Bulbulay Season 2 (sitcom) and
           Exclusive Chat (interview) are tracker entries, not listed
           dramas, so they never appear here. */
        if (d && pkByKey[d.key] && !seen.has(d.key)) seen.set(d.key, d.name);
      }
      return [...seen.entries()].map(([value, label]) => ({ value, label }))
        .sort((x, y) => x.label.localeCompare(y.label));
    })();
    const pkRailHtml = epLatest.length ? `<section class="section" id="homePk" data-sec="pk-dramas">
      <div class="section-head"><h2><a href="/episode-guides" style="color:inherit">Drama Episodes</a></h2>
      <a class="see-all" href="/episode-guides">See All →</a></div>
      <p class="sec-sub">Latest drama episodes from YouTube channels, newest first; open an episode for its story summary.</p>
      <div id="homePkFilter"></div>
      <div class="tl-list" id="homePkList">${epLatest.map(a => episodeRow(a)).join("")}</div></section>` : "";

    /* ---------- Awards strip REMOVED (owner order 2026-10-27):
       the homepage awards strip is gone entirely. The Awards
       hub (/awards) still carries the verified ceremony dates. ---------- */

    /* Homepage order (MASTER-STRUCTURE §2 as amended by fix round 2,
       Bug F — Bollywood FIRST and more than half the page):
       hero → Bollywood Spotlight → Bollywood Coming Soon →
       Box Office → mixed trending → Coming Soon calendar →
       Trending Searches → Trending News → Lollywood →
       Pakistani Dramas (posters) → Drama Episodes. K-Drama, birthdays, OTT and episode strips are
       gone: they had no published data source. ("Star Spotlight" stays
       removed by user order.) */
    main.innerHTML = `<div class="wrap">
      ${heroHtml}
      ${newsSliderHtml}
      ${bollyHtml}
      ${bollySoonHtml}
      ${boHtml}
      ${ottHtml}
      ${trendingHtml}
      ${upHtml}
      ${searchesHtml}
      ${newsHtml}
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
    const homeStateKey = kind => ({ spotlight: "hs", soon: "hn", calendar: "hc", boxoffice: "hb", ott: "ho" }[kind]);
    document.querySelectorAll("[data-switcher]").forEach(group => {
      const section = group.closest("section"), kind = group.dataset.switcher, result = section.querySelector("[data-results]"), link = section.querySelector(".see-all"), stateKey = homeStateKey(kind);
      const activate = (industry, persist) => {
        group.querySelectorAll("button").forEach(btn => { const on = btn.dataset.industry === industry; btn.setAttribute("aria-pressed", String(on)); btn.classList.toggle("active", on); });
        if (persist) { const u = new URL(location.href); if (industry === "bollywood") u.searchParams.delete(stateKey); else u.searchParams.set(stateKey, industry); history.pushState(null, "", u); }
        /* OTT renders TWO rails (Now + Coming) instead of the single
           [data-results] the other sections use — handle it here and
           return before the generic single-list rendering below. */
        if (kind === "ott") {
          section.querySelector("h2").textContent = "OTT";
          link.href = `/ott?f=${industry}`;
          section.querySelector(".sec-sub").textContent = "Movies now streaming, and what's coming next · " + industryLabel(industry);
          const nowHost = section.querySelector('[data-results="now"]');
          const comingHost = section.querySelector('[data-results="coming"]');
          const nowItems = ottFor("now", industry);
          const comingItems = ottFor("coming", industry);
          if (nowHost) nowHost.innerHTML = nowItems.length ? nowItems.map(p => ottCardHtml(p, false)).join("") : `<p role="status">No titles streaming on OTT for ${industryLabel(industry)} yet.</p>`;
          if (comingHost) comingHost.innerHTML = comingItems.length ? comingItems.map(p => ottCardHtml(p, true)).join("") : `<p role="status">No upcoming OTT releases reported for ${industryLabel(industry)} yet.</p>`;
          return;
        }
        section.querySelector("h2").textContent = kind === "spotlight" ? "Spotlight" : kind === "soon" ? "Coming Soon & Most Awaited" : kind === "boxoffice" ? "Box Office" : "Release Calendar";
        link.href = kind === "spotlight" ? `/movies?f=${industry}&seeall=1` : kind === "soon" ? `/most-awaited?f=${industry}&s=oldest` : kind === "boxoffice" ? `/box-office?f=${industry}` : `/upcoming?f=${industry}&s=oldest&seeall=1`;
        section.querySelector(".sec-sub").textContent = kind === "spotlight" ? "Movies running now, newest release date first · " + industryLabel(industry) : kind === "soon" ? "Upcoming movies only, oldest release date first · " + industryLabel(industry) : kind === "boxoffice" ? "Recently-released films, newest first · " + industryLabel(industry) : "Upcoming movie and TV dates, oldest first · " + industryLabel(industry);
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
    /* Homepage dropdown filters (TV order 2026-10-27, corrected
       2026-10-27, revised 2026-10-27 owner order): OTT filters by
       Industry + Type with the .home-filter-row dropdowns above —
       one row, never chips. Spotlight and Coming Soon are
       movies-only (Industry dropdown alone — no Type dropdown, so
       state.type stays "movie" and their See All links carry no ?t=
       param). Box Office and the Release Calendar keep the chip
       switcher wired just above. The OTT See All link carries the
       type (?t=tv / ?t=all) so the /ott page opens on the same view;
       Movies is the See All default, so no param is needed for it. */
    const typeLabel = (t) => t === "tv" ? "TV Series" : t === "all" ? "All" : "Movies";
    const typeParam = (t) => t === "movie" ? "" : `&t=${t}`;
    document.querySelectorAll("[data-filter-row]").forEach(row => {
      const kind = row.dataset.filterRow;
      const section = row.closest("section");
      const link = section.querySelector(".see-all");
      const stateKey = homeStateKey(kind);
      const state = {
        industry: new URL(location.href).searchParams.get(stateKey) === "international" ? "international" : "bollywood",
        type: "movie",
      };
      const render = () => {
        const industry = state.industry, type = state.type;
        if (kind === "ott") {
          section.querySelector("h2").textContent = "OTT";
          link.href = `/ott?f=${industry}${typeParam(type)}`;
          section.querySelector(".sec-sub").textContent = (type === "tv" ? "Recent TV premieres and confirmed upcoming OTT dates" : "Movies now streaming, and what's coming next") + " · " + industryLabel(industry) + " · " + typeLabel(type);
          const nowHost = section.querySelector('[data-results="now"]');
          const comingHost = section.querySelector('[data-results="coming"]');
          const nowItems = ottFor("now", industry, type);
          const comingItems = ottFor("coming", industry, type);
          /* Empty states name the selected Type too (2026-10-28: with
             Industry=Bollywood + Type=TV Series the old "for Bollywood
             yet" line hid which filter was empty). */
          const ottTypeNoun = type === "tv" ? "TV series" : type === "all" ? "titles" : "movies";
          const nowEmpty = type === "tv"
            ? `No recent series premiere is confirmed in the published ${industryLabel(industry)} catalogue (past 30 days). Older streaming series are excluded from this latest-releases view.`
            : `No ${ottTypeNoun} streaming on OTT for ${industryLabel(industry)} yet.`;
          const comingEmpty = type === "tv"
            ? `No published ${industryLabel(industry)} TV series has a confirmed upcoming OTT date.`
            : `No upcoming OTT releases reported for ${industryLabel(industry)} ${ottTypeNoun} yet.`;
          if (nowHost) nowHost.innerHTML = nowItems.length ? nowItems.map(p => ottCardHtml(p, false)).join("") : `<p class="ott-empty" role="status">${nowEmpty}</p>`;
          if (comingHost) comingHost.innerHTML = comingItems.length ? comingItems.map(p => ottCardHtml(p, true)).join("") : `<p class="ott-empty" role="status">${comingEmpty}</p>`;
          return;
        }
        section.querySelector("h2").textContent = kind === "spotlight" ? "Spotlight" : "Coming Soon & Most Awaited";
        link.href = kind === "spotlight"
          ? `/movies?f=${industry}&seeall=1${typeParam(type)}`
          : `/most-awaited?f=${industry}${typeParam(type)}`;
        section.querySelector(".sec-sub").textContent = kind === "spotlight"
          ? "Movies running now, newest release date first · " + industryLabel(industry)
          : "Upcoming movies only, oldest release date first · " + industryLabel(industry);
        const result = section.querySelector("[data-results]");
        const items = kind === "spotlight" ? publishedFor(kind, industry, type) : publishedFor(kind, industry, type).slice(0, HOME_LIMITS.soon);
        result.innerHTML = items.length
          ? items.map((x, i) => UI.posterCard(x, typeOf(x), "", kind === "soon" ? i + 1 : undefined, undefined, true)).join("")
          : '<p role="status">No matching titles found.</p>';
      };
      const selects = row.querySelectorAll(".filter-select");
      UI.mountFaSelect(selects[0], INDUSTRY_OPTIONS, state.industry, (v) => {
        state.industry = v;
        const u = new URL(location.href);
        if (v === "bollywood") u.searchParams.delete(stateKey); else u.searchParams.set(stateKey, v);
        history.pushState(null, "", u);
        render();
      });
      /* Spotlight / Coming Soon have no Type dropdown (movies-only) —
         selects[1] is undefined there; mounting it would throw. */
      if (selects[1]) UI.mountFaSelect(selects[1], TYPE_OPTIONS, state.type, (v) => { state.type = v; render(); });
      if (state.industry !== "bollywood") render();
    });
    /* Wiring steps are guarded individually: a failure here must never
       wipe the rendered page (see the `rendered` flag above). A failed
       news fill removes the section instead of leaving a skeleton;
       a failed trends mount leaves one honest line instead of a stuck
       "Loading trend feed…" status. */
    try { fillHomeNews(); } catch (_) { document.getElementById("homeNews")?.remove(); }
    /* Drama Episodes filter (user order 2026-10-27): the same custom
       in-page .fa-select dropdown as /episode-guides — never a native
       <select>. Filters the homepage episode rows by drama. */
    try {
      const pkFilterHost = document.getElementById("homePkFilter");
      const pkListHost = document.getElementById("homePkList");
      if (pkFilterHost && pkListHost && epDramaOptions.length) {
        pkFilterHost.innerHTML = `<div class="listing-select-row listing-select-row--single"><div class="filter-select" role="group" aria-labelledby="homePkFilterLabel"><span id="homePkFilterLabel">Drama</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="homePkDramaTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="homePkDramaOptions" aria-labelledby="homePkFilterLabel homePkDramaValue"><span class="fa-select-value" id="homePkDramaValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="homePkDramaOptions" role="listbox" aria-labelledby="homePkFilterLabel" hidden></div></div></div></div>`;
        mountFaSelect(pkFilterHost.querySelector(".filter-select"),
          [{ value: "", label: "All Dramas" }, ...epDramaOptions],
          "", (value) => {
            const list = value ? epAiring.filter(a => { const d = dramaOfArticle(a); return d && d.key === value; }) : epAiring;
            pkListHost.innerHTML = list.slice(0, HOME_LIMITS.dramas).map(a => episodeRow(a)).join("");
          });
      }
    } catch (_) { /* filter unavailable — rows stay unfiltered */ }

    try {
      if (window.FATrendingSearches) window.FATrendingSearches.mount(document.getElementById("homeTrendingSearches"), {
        limit: 1,
        context: {
          bollywood: pubAll().filter(x => UI.industryOf(x) === "bollywood"),
          international: pubAll().filter(x => UI.industryOf(x) === "world"),
          pakistan: pubAll().filter(x => UI.industryOf(x) === "pakistani"),
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

















