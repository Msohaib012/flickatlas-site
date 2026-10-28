/* FlickAtlas — TV show detail page (?id=<tmdb tv id>): published
   titles only. Rewritten 2026-10-25 (published-only rebuild, §4);
   rich detail fields added in consolidation (spec §1a): genres,
   creators, episode runtime, tagline, certification and spoken
   languages all render FROM THE BAKED-IN published entry — never a
   live TMDB.details call. The id is looked
   the id is looked up in window.FA_PUBLISHED; hero/story/facts/
   trailer/day-wise/similar all render from the baked-in published
   entry. Cast comes from the TMDB credits endpoint for this one
   title only (a single-title record, not a catalogue). A title that
   isn't published renders a plain state — the page NEVER fetches the
   title live from TMDB to fill itself. No watch/download buttons, no
   external links except the YouTube trailer embed.
   Pakistani dramas have NO seasons (seasons are an OTT thing): for a
   Pakistani drama the Seasons table is replaced by an Episodes list
   (the YouTube episode posts for that drama, each linking to its own
   episode page). OTT / world series keep their Seasons table.
   Episode count (user order 2026-10-26): for Pakistani dramas the
   "Episodes" figure comes from the episode tracker (/out/episodes.json
   — the highest tracked episode number IS the count), NOT from TMDB's
   number_of_episodes, which is stale for ongoing dramas (Bano: TMDB
   says 1). The count updates automatically as the tracker adds
   episodes; TMDB is only a fallback. While the drama is still airing
   the count reads e.g. "13 · Still airing". Related News items that
   are episodes render as thumbnail + title rows (.ep-row, the
   homepage Drama Episodes style), not bare text links. */
(async function () {
  UI.mountChrome("/show");
  const main = document.getElementById("app");
  const id = UI.getParam("id", "");
  if (!id || !/^\d+$/.test(id)) {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("Show not found.", false)}
      <p style="text-align:center"><a class="btn btn-teal" href="/tv">Browse TV Shows</a></p></div>`;
    UI.setSEO({ title: "Show not found | FlickAtlas", desc: "This show could not be found on FlickAtlas. Browse TV shows instead.", path: "/show", noindex: true });
    return;
  }

  UI.setSEO({
    title: "TV Show Details — Cast & Story | FlickAtlas",
    desc: "Full TV show details on FlickAtlas: episodes, cast & crew, story, ratings and frequently asked questions.",
    path: `/show?id=${encodeURIComponent(id)}`
  });
  main.innerHTML = `<div class="wrap">
    <div class="sk" style="height:280px;border-radius:22px;margin-top:22px"></div>
    <div class="sk" style="height:120px;border-radius:14px;margin-top:22px"></div>
  </div>`;

  const LANG_NAMES = { hi: "Hindi", en: "English", ko: "Korean", ur: "Urdu", pa: "Punjabi", ta: "Tamil", te: "Telugu", mr: "Marathi", bn: "Bengali", es: "Spanish", fr: "French", de: "German", ja: "Japanese", zh: "Chinese", th: "Thai", tr: "Turkish", ar: "Arabic" };
  const langName = (code) => LANG_NAMES[code] || (code ? String(code).toUpperCase() : "");
  const COUNTRY = { IN: "India", PK: "Pakistan", US: "United States", GB: "United Kingdom", CA: "Canada", AU: "Australia", FR: "France", DE: "Germany", JP: "Japan", KR: "South Korea", CN: "China", AE: "United Arab Emirates", SA: "Saudi Arabia", NZ: "New Zealand", IE: "Ireland", ES: "Spain", IT: "Italy", BR: "Brazil", RU: "Russia", TR: "Turkey", TH: "Thailand" };
  const countryNames = (codes) => (codes || []).map(c => COUNTRY[c] || c).filter(Boolean);
  /* Industry label from the baked-in industry value (spec §1a). */
  const IND_LABEL = { bollywood: "Bollywood", pakistani: "Pakistani", world: "World Cinema" };
  const indLabel = (pub) => IND_LABEL[pub.industry] || UI.industryTag(pub) || "";
  const titleDate = (x) => x.type === "tv" ? (x.first_air_date || "") : (x.release_date || "");
  /* Similar / You May Also Like — FA_PUBLISHED only, same industry
     first, then same type, newest first (first-air date DESC,
     published date only breaks ties), up to 6. Same medium only: a
     show page never recommends a movie (it would link to
     /show?id=<movie id> and land on "not published"). */
  const similarPublished = (pub) => {
    const todayS = TMDB.today();
    const cands = Object.values(window.FA_PUBLISHED || {})
      .filter(x => x && x.id != null && String(x.id) !== String(pub.id) && x.type === pub.type
        && titleDate(x) && titleDate(x) <= todayS);
    cands.sort((a, b) =>
      ((b.industry === pub.industry) - (a.industry === pub.industry)) ||
      ((b.type === pub.type) - (a.type === pub.type)) ||
      titleDate(b).localeCompare(titleDate(a)) ||
      String(b.published_at || "").localeCompare(String(a.published_at || "")));
    return cands.slice(0, 6);
  };

  /* Related News — articles whose PRIMARY entity (entities.titles[0])
     is this show. Same matcher as the movie page (exact name,
     substring min 6 chars, or a shared distinctive first word of 5+
     letters); only the primary entity counts, so a roundup that merely
     mentions the show does not qualify. */
  const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const titleMatches = (pubTitle, ent) => {
    const pn = normName(pubTitle), en = normName(ent);
    if (!pn || !en) return false;
    if (pn === en) return true;
    if ((pn.includes(en) || en.includes(pn)) && Math.min(pn.length, en.length) >= 6) return true;
    const pf = pn.split(" ")[0], ef = en.split(" ")[0];
    return pf && pf === ef && pf.length >= 5;
  };
  const relatedNews = (pub) => {
    const arts = Object.values(window.FA_ARTICLES || {});
    const out = [];
    for (const a of arts) {
      if (!a || a.type !== "news" || !a.id) continue;
      const ents = (a.entities && a.entities.titles) || [];
      if (!ents.length) continue;
      if (!titleMatches(UI.titleOf(pub), ents[0])) continue;
      out.push(a);
    }
    out.sort((x, y) => String(y.published || "").localeCompare(String(x.published || "")));
    return out.slice(0, 4);
  };

  /* --- Published lookup: nothing renders unless this title was chosen
     and published. No live TMDB fetch fills this page. A published
     movie id lands here by mistake — point at its real page instead
     of claiming it was never published. --- */
  const pub = (window.FA_PUBLISHED || {})[String(id)] || null;
  if (pub && pub.type === "movie") {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("This title is a movie — it lives on its own movie page.", false)}
      <p style="text-align:center"><a class="btn btn-teal" href="/movie?id=${encodeURIComponent(id)}">Open Movie Page →</a></p></div>`;
    UI.setSEO({ title: "This Title Is a Movie | FlickAtlas", desc: "This title is a movie. Open its movie page on FlickAtlas.", path: "/movie", noindex: true });
    return;
  }
  if (!pub || pub.type !== "tv") {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("This title hasn't been published on FlickAtlas yet.", false)}
      <p style="text-align:center"><a class="btn btn-teal" href="/tv">Browse TV Shows</a></p></div>`;
    UI.setSEO({ title: "Title Not Published | FlickAtlas", desc: "This show hasn't been published on FlickAtlas yet. Browse published TV shows instead.", path: "/show", noindex: true });
    return;
  }

  try {
    const name = UI.titleOf(pub);
    const year = UI.yearOf(pub);
    /* Deep link from the episode guide (?season=N&ep=M): highlight the
       matching season row and say which episode was linked, instead of
       silently ignoring the params. OTT only — Pakistani dramas have
       no seasons, and their episodes link to their own episode page. */
    const seasonParam = UI.getParam("season", "");
    const epParam = UI.getParam("ep", "");
    const deepLinkNote = (seasonParam && /^\d+$/.test(seasonParam))
      ? `<p class="prov-note">Linked episode: Season ${seasonParam}${epParam && /^\d+$/.test(epParam) ? ` · Episode ${epParam}` : ""} — highlighted below.</p>` : "";
    const rating = UI.ratingText(pub);
    const poster = UI.img(pub.poster_path, "w342");
    const backdrop = UI.img(pub.backdrop_path, "w1280");
    const firstAir = pub.first_air_date || "";
    const channel = pub.channel || "";
    /* Networks may be stored as strings ("HUM TV") or as TMDB objects
       ({name: "HUM TV"}) — read the name either way, never "[object Object]". */
    const networks = (pub.networks || []).map(n => String((n && n.name) || n || "")).filter(Boolean);
    const tag = indLabel(pub);
    /* Rich detail fields, baked into the published entry (spec §1a). */
    const genres = (pub.genres || []).filter(Boolean);
    const seasons = (pub.seasons || []).filter(s2 => s2 && (s2.episode_count > 0 || s2.season_number === 0));
    const createdBy = (pub.created_by || []).filter(Boolean);
    const epRun = (pub.episode_run_time || []).filter(n => n > 0);
    const runtime = epRun.length ? UI.fmtRuntime(epRun[0]) : "";
    const spoken = (pub.spoken_languages || []).map(c => langName(c)).filter(Boolean);

    /* Cast + crew: the credits endpoint for this one published title
       only (single-title record, not a catalogue). Best effort — the
       page renders without cast if it fails. */
    let credits = null;
    try { credits = await TMDB.api(`/tv/${id}/credits`); } catch (_) { credits = null; }
    /* Cast: top 12 + the rest behind Show More (same as the movie page).
       The show page used to cap at 12 with no way to see the rest. */
    const castAll = ((credits && credits.cast) || []).filter(c => c && c.name);
    const cast = castAll.slice(0, 12);
    const castRest = castAll.slice(12, 30);
    const crew = ((credits && credits.crew) || []).filter(c => c && c.name);

    /* Official trailer: baked into the published entry (official
       YouTube trailer only). Absent when none exists — no section. */
    const trailerKey = pub.trailer && /^[A-Za-z0-9_-]{11}$/.test(pub.trailer.key || "") ? pub.trailer.key : "";
    const trailerName = pub.trailer && pub.trailer.name ? pub.trailer.name : "";

    const rows = (window.FA_DAYWISE || {})[String(id)] || null;
    const daywiseHtml = rows && rows.length ? UI.daywiseCard(rows, "Day-Wise Box Office", { titleId: id }) : "";

    const similar = similarPublished(pub);
    const related = relatedNews(pub);

    /* Pakistani dramas have NO seasons — for them the Seasons table
       is replaced by an Episodes list (the YouTube episode posts for
       this drama, each linking to its own episode page). OTT / world
       series keep their Seasons table. */
    const isPakistani = pub.industry === "pakistani";
    const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const showNorm = normName(name);
    /* Exact-match guard: the tracker truncates hyphenated drama names
       ("Dar" for "Dar-e-Nijaat", "Zehar" for "Zehar-e-Mohabbat"), so a
       short parsed name may prefix-match another drama; only use the
       prefix when no published drama is exactly that short name, so a
       real short-named drama never leaks into another's page. */
    const exactDramaExists = (d) => Object.values(window.FA_PUBLISHED || {})
      .some(x => x && x.type === "tv" && normName(UI.titleOf(x)) === normName(d));
    const truncSum = (s, n) => {
      const t = String(s || "").replace(/\s+/g, " ").trim();
      if (t.length <= n) return t;
      return t.slice(0, n).replace(/\s+\S*$/, "") + "…";
    };
    const showEpisodes = (() => {
      if (!isPakistani) return [];
      const arts = Object.values(window.FA_ARTICLES || {});
      const out = [];
      for (const a of arts) {
        if (!a || a.type !== "news") continue;
        const h = String(a.headline || "");
        const wm = h.match(/^(.*?)\s+[—–-]\s+Watch on\s+(.+)$/i);
        if (!wm) continue;
        const left = wm[1].trim();
        const em = left.match(/^(.+?)\s+Episode\s+(\d+)$/i);
        if (!em) continue;
        const dName = (a.entities && a.entities.titles && a.entities.titles[0]) || em[1].trim();
        const dNorm = normName(dName);
        if (!(dNorm === showNorm || (showNorm.startsWith(dNorm) && !exactDramaExists(dName)))) continue;
        let views = 0;
        const vf = (a.facts || []).find(f => /YouTube views:/i.test(String(f)));
        if (vf) { const vm = String(vf).match(/([\d,]+)/); if (vm) views = parseInt(vm[1].replace(/,/g, ""), 10) || 0; }
        let summary = "";
        const ss = (a.body || []).find(s => s && s.h === "Story Summary");
        if (ss && ss.p && ss.p.length) summary = ss.p.join("\n\n");
        out.push({
          episode: parseInt(em[2], 10),
          channel: (a.images && a.images[0] && a.images[0].source) || wm[2].trim(),
          published: a.published || "", views, summary,
          articleId: a.id || "",
          thumb: (a.images && a.images[0] && a.images[0].url) || ""
        });
      }
      out.sort((x, y) => String(y.published || "").localeCompare(String(x.published || "")) || (y.episode - x.episode));
      return out.filter(e => e.articleId);
    })();
    /* --- Tracker episode count (user order 2026-10-26): TMDB's
       number_of_episodes is stale for ongoing Pakistani dramas
       (Bano: TMDB says 1; the tracker knows the real latest episode).
       /out/episodes.json carries every tracked episode; the HIGHEST
       episode number for a drama IS its episode count (episodes air
       sequentially from 1). Alias: tracker "Dar" = published
       "Dar-E-Nijaat", tracker "Zehar" = "Zehar-e-Mohabbat". Falls back
       to TMDB when the tracker has nothing for this drama. The count
       updates automatically as the tracker adds episodes — no code
       change per episode. --- */
    const DRAMA_ALIASES = { "dar": "dar e nijaat", "zehar": "zehar e mohabbat" };
    const canonDrama = (d) => DRAMA_ALIASES[normName(d)] || normName(d);
    let trackerEp = null; // { count, latestPublished }
    try {
      const epRes = await fetch("/out/episodes.json", { cache: "no-store" });
      if (epRes.ok) {
        const epData = await epRes.json();
        const recs = Object.values((epData && epData.episodes) || {});
        const mine = recs.filter(r => r && canonDrama(r.drama || "") === showNorm);
        if (mine.length) {
          const nums = mine.map(r => r.episode).filter(n => Number.isInteger(n) && n > 0);
          const latestPub = mine.map(r => r.published || "").filter(Boolean).sort().pop() || "";
          if (nums.length) trackerEp = { count: Math.max(...nums), latestPublished: latestPub };
        }
      }
    } catch (_) { trackerEp = null; }
    /* Episode count: tracker first, TMDB only as a fallback. */
    const epCount = trackerEp ? trackerEp.count : (pub.number_of_episodes || 0);
    /* Still airing: the latest tracked episode aired within the last
       7 days AND TMDB still lists the show as returning — a drama
       whose last episode is older, or whose status is Ended, shows
       just the total. */
    const isStillAiring = (() => {
      if (!trackerEp || !trackerEp.latestPublished) return false;
      const last = Date.parse(trackerEp.latestPublished);
      if (!Number.isFinite(last)) return false;
      const days = (Date.now() - last) / 86400000;
      return days <= 7 && String(pub.status || "").toLowerCase().indexOf("returning") !== -1;
    })();
    const epCountLabel = epCount ? (isStillAiring ? `${epCount} · Still airing` : String(epCount)) : "";
    const epCardShow = (e) => {
      const air = e.published ? UI.fmtDate(e.published) : "";
      const views = (typeof e.views === "number" && e.views > 0) ? e.views.toLocaleString("en-US") : "";
      const sum = truncSum(e.summary, 280);
      const href = `/news-item?id=${encodeURIComponent(e.articleId)}`;
      return `<div class="content-card"><div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start">
        ${e.thumb ? `<a href="${href}"><img src="${UI.esc(UI.newsImg(e.thumb, 300))}" alt="" loading="lazy" style="width:140px;border-radius:12px" onerror="this.onerror=null;this.src='${UI.esc(e.thumb)}'"></a>` : ""}
        <div style="flex:1;min-width:200px">
          <h2 style="margin-top:0"><a href="${href}">Episode ${e.episode}</a></h2>
          <dl class="facts-table">
            ${air ? `<div class="fact-row"><dt>Air Date</dt><dd>${UI.esc(air)}</dd></div>` : ""}
            ${e.channel ? `<div class="fact-row"><dt>Channel</dt><dd>${UI.esc(e.channel)}</dd></div>` : ""}
            ${views ? `<div class="fact-row"><dt>Views</dt><dd>${UI.esc(views)}</dd></div>` : ""}
          </dl>
          ${sum ? `<p class="article-summary">${UI.esc(sum)}</p>` : ""}
          <p><a class="btn btn-teal" href="${href}">Open episode →</a></p>
        </div></div></div>`;
    };
    const episodesHtml = showEpisodes.length
      ? `<section class="section"><div class="section-head"><h2>Episodes</h2></div>${showEpisodes.map(epCardShow).join("")}</section>`
      : "";

    const heroFacts = [];
    if (rating) heroFacts.push(["Rating", `${rating}${pub.vote_count ? ` (${pub.vote_count.toLocaleString("en-US")} votes)` : ""}`]);
    if (firstAir) heroFacts.push(["First Aired", UI.fmtDate(firstAir)]);
    if (pub.status) heroFacts.push(["Status", pub.status]);
    if (runtime) heroFacts.push(["Episode Runtime", runtime]);
    if (pub.number_of_seasons && !isPakistani) heroFacts.push(["Seasons", String(pub.number_of_seasons)]);
    if (epCount) heroFacts.push(["Episodes", epCountLabel]);
    if (channel) heroFacts.push(["Channel", channel]);
    if (tag) heroFacts.push(["Industry", tag]);

    /* Crew groups: key crew jobs from the one title's credits
       (deduped, capped). No creator records are baked in, so the
       section is crew only. */
    const crewGroups = [];
    const seenCrew = new Set();
    for (const job of ["Director", "Writer", "Executive Producer", "Producer"]) {
      const list = crew.filter(c => c && c.job === job && c.name && !seenCrew.has(c.id))
        .slice(0, 6).map(c => ({ id: c.id, name: c.name, job: c.department || job }));
      list.forEach(c => seenCrew.add(c.id));
      if (list.length) crewGroups.push([job === "Director" ? "Directors" : job === "Writer" ? "Writers" : job === "Executive Producer" ? "Executive Producers" : "Producers", list]);
    }

    const factRows = [];
    if (firstAir) factRows.push(["First Aired", UI.fmtDate(firstAir)]);
    if (pub.status) factRows.push(["Status", pub.status]);
    if (createdBy.length) factRows.push(["Created by", createdBy.join(", ")]);
    if (pub.number_of_seasons && !isPakistani) factRows.push(["Seasons", String(pub.number_of_seasons)]);
    if (epCount) factRows.push(["Episodes", epCountLabel]);
    if (runtime) factRows.push(["Episode Runtime", runtime]);
    if (genres.length) factRows.push(["Genres", genres.join(", ")]);
    if (pub.original_language) factRows.push(["Original Language", langName(pub.original_language)]);
    if (spoken.length) factRows.push(["Spoken Languages", spoken.join(", ")]);
    if (pub.certification) factRows.push(["Certification", pub.certification]);
    if (countryNames(pub.origin_country || []).length) factRows.push(["Country", countryNames(pub.origin_country).join(", ")]);
    if (networks.length) factRows.push(["Network", networks.join(", ")]);
    if (channel) factRows.push(["Channel", channel]);
    if (tag) factRows.push(["Industry", tag]);

    /* Related News rows: an episode item renders as a thumbnail +
       title row (.ep-row — the same style as the homepage Drama
       Episodes rail), NOT a bare text link. Non-episode news stays
       the plain .news-item row. */
    const EP_HEADLINE_RE = /^(.*?)\s+[—–-]\s+Watch on\s+(.+)$/i;
    const isEpisodeArticle = (a) => {
      const h = String(a.headline || "");
      const wm = h.match(EP_HEADLINE_RE);
      return !!(wm && wm[1].trim().match(/^(.+?)\s+Episode\s+(\d+)$/i));
    };
    const relatedRow = (a) => {
      const h = String(a.headline || "");
      const wm = h.match(EP_HEADLINE_RE);
      const em = wm && wm[1].trim().match(/^(.+?)\s+Episode\s+(\d+)$/i);
      if (wm && em) {
        const img = (a.images && a.images[0] && a.images[0].url) || "";
        const channel = (a.images && a.images[0] && a.images[0].source) || wm[2].trim();
        const date = (a.published || "").slice(0, 10);
        return `<a class="ep-row" href="/news-item?id=${encodeURIComponent(a.id)}">
          <span class="ep-thumb">${img ? `<img src="${UI.esc(img)}" alt="${UI.esc(h)}" loading="lazy" decoding="async" onerror="this.remove()">` : `<span class="noimg"><span>EP</span></span>`}</span>
          <span class="ep-info"><b>${UI.esc(h)}</b>
          <span>${date ? UI.esc(UI.fmtDate(date)) : ""}${channel ? ` · ${UI.esc(channel)}` : ""}</span></span>
        </a>`;
      }
      return `<a class="news-item" href="/news-item?id=${encodeURIComponent(a.id)}">
        <span class="news-txt"><b>${UI.esc(a.headline || "")}</b>
        <span>${a.published ? UI.relTime(Date.parse(a.published)) : ""}</span></span>
      </a>`;
    };
    const relatedHasEp = related.some(isEpisodeArticle);

    /* Top Searches (keywords round 2026-10-28): the show had NO visible
       keywords section at all. Phrases come only from this show's own
       data — its name, top cast, seasons/episodes and (Pakistani dramas)
       the latest-episode searches people actually type. Nothing is
       invented: a phrase appears only when its data exists on this page.
       They render in ONE custom .fa-select dropdown (never a native
       <select>); choosing a phrase opens /search?q=<phrase>. */
    const kwDedupe = (arr) => { const seen = new Set(); return arr.filter(x => { const k = String(x || "").trim(); if (!k || seen.has(k)) return false; seen.add(k); return true; }); };
    const latestSeasonNum = seasons.length ? Math.max(...seasons.map(s2 => Number(s2.season_number) || 0)) : 0;
    const kwPhrases = kwDedupe([
      name,
      `${name} cast`,
      `${name} review`,
      `${name} story`,
      ...(epCount ? [`${name} episodes`] : []),
      ...(latestSeasonNum > 1 ? [`${name} season ${latestSeasonNum}`] : []),
      ...(cast.length ? [`${cast[0].name} ${name}`] : []),
      ...(isPakistani ? [`${name} latest episode`, `${name} watch online`] : []),
    ]);

    main.innerHTML = `<div class="wrap">
    <p class="article-crumb"><a href="/tv">← TV &amp; Web Series</a></p>
    <div class="detail-hero">
      ${backdrop ? `<div class="hero-bg"><img src="${backdrop}" alt="" loading="lazy" onerror="this.remove()"></div><div class="hero-shade"></div>` : ""}
      <div class="detail-in">
        ${poster ? `<div class="detail-poster"><img src="${poster}" alt="${UI.esc(name)} poster" loading="lazy" onerror="this.remove()"></div>` : ""}
        <div class="detail-main">
          <h1>${UI.esc(name)}${year ? ` (${year})` : ""}</h1>
          ${pub.tagline ? `<p class="detail-sub">${UI.esc(pub.tagline)}</p>` : ""}
          ${heroFacts.length ? `<div class="detail-facts">${heroFacts.map(([k, v]) => `<div><span>${UI.esc(k)}</span><b>${UI.esc(v)}</b></div>`).join("")}</div>` : ""}
        </div>
      </div>
    </div>

    ${pub.overview ? `<div class="content-card" id="story-summary"><h2>Story</h2><p class="article-summary">${UI.esc(pub.overview)}</p></div>` : ""}

    ${isPakistani ? episodesHtml : (seasons.length ? `<div class="content-card"><h2>Seasons</h2>
      ${deepLinkNote}
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Season</th><th>Name</th><th>Episodes</th><th>First Aired</th></tr></thead>
        <tbody>${seasons.map(s2 => `<tr${Number(seasonParam) === Number(s2.season_number) ? ' class="dw-hl"' : ""}>
          <td><b>${s2.season_number === 0 ? "Specials" : `Season ${s2.season_number}`}</b></td>
          <td>${UI.esc(s2.name || "—")}</td>
          <td>${s2.episode_count != null ? s2.episode_count : "—"}</td>
          <td>${s2.air_date ? UI.fmtDate(s2.air_date) : "—"}</td>
        </tr>`).join("")}</tbody></table></div></div>` : "")}

    ${cast.length ? `<div class="content-card"><h2>Top Cast</h2>
      <div class="cast-grid">${cast.map(c => UI.personCard(c, c.character || "")).join("")}</div>
      ${castRest.length ? `<div class="cast-grid more-wrap" id="castMore">${castRest.map(c => UI.personCard(c, c.character || "")).join("")}</div>
      <button type="button" class="btn more-btn" data-target="castMore" data-more="Show More Cast" data-less="Show Less" onclick="UI.toggleMore(this)">Show More Cast</button>` : ""}
      <p class="prov-note">Full credited cast with photos and filmographies on each person's FlickAtlas profile.</p></div>` : ""}

    ${(createdBy.length || crewGroups.length) ? `<div class="content-card"><h2>Creators &amp; Crew</h2>
      <div class="crew-groups">${createdBy.length ? `<div class="crew-group"><h4>Created by</h4>
        <ul>${createdBy.map(n => `<li>${UI.esc(n)}</li>`).join("")}</ul></div>` : ""}${crewGroups.map(([label, people]) => `<div class="crew-group"><h4>${UI.esc(label)}</h4>
        <ul>${people.map(p => `<li><a href="/person?id=${p.id}">${UI.esc(p.name)}</a><span class="crew-job">${UI.esc(p.job || "")}</span></li>`).join("")}</ul></div>`).join("")}</div></div>` : ""}

    ${trailerKey ? `<div class="content-card" id="official-trailer"><h2>Official Trailer</h2>
      <div class="video-embed"><iframe src="https://www.youtube-nocookie.com/embed/${trailerKey}" title="Official trailer: ${UI.esc(trailerName || name)}" loading="lazy" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div></div>` : ""}

    ${daywiseHtml}

    ${related.length ? `<section class="section"><div class="section-head"><h2>Related News</h2>
      <a class="see-all" href="/news">All News →</a></div>
      <div class="${relatedHasEp ? "tl-list" : "news-list"}">${related.map(relatedRow).join("")}</div></section>` : ""}

    ${factRows.length ? `<div class="content-card"><h2>Show Details</h2>
      <dl class="facts-table">${factRows.map(([k, v]) => `<div class="fact-row"><dt>${UI.esc(k)}</dt><dd>${UI.esc(v)}</dd></div>`).join("")}</dl></div>` : ""}

    ${similar.length ? `<section class="section"><div class="section-head"><h2>Similar Shows</h2></div>
      <div class="grid">${similar.map(x => UI.posterCard(x, "tv", UI.industryTag(x))).join("")}</div>
      <p class="img-credit">Images: TMDB</p></section>` : ""}

    ${kwPhrases.length ? `<section class="section"><div class="section-head"><h2 id="kwSelectLabel">Top Searches</h2></div>
      <div class="fa-select" id="kwSelect"><button type="button" class="fa-select-trigger" id="kwSelectTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="kwSelectOptions" aria-labelledby="kwSelectLabel kwSelectValue"><span class="fa-select-value" id="kwSelectValue">Keyword chuno</span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="kwSelectOptions" role="listbox" aria-labelledby="kwSelectLabel" hidden></div></div></section>` : ""}
  </div>`;

    UI.setSEO({
      title: `${name}${year ? ` (${year})` : ""} — ${isPakistani ? "Episodes, Cast & Story" : "Seasons, Cast & Story"} | FlickAtlas`,
      desc: (pub.overview || `${name} — ${isPakistani ? "episodes" : "seasons"}, cast, crew and story on FlickAtlas.`).slice(0, 160),
      path: `/show?id=${encodeURIComponent(id)}`,
      type: "video.tv_show",
      image: backdrop || poster || "",
      jsonld: {
        "@context": "https://schema.org",
        "@type": "TVSeries",
        "name": name,
        "url": CONFIG.BASE + `/show?id=${encodeURIComponent(id)}`,
        ...(pub.overview ? { "description": pub.overview.slice(0, 300) } : {}),
        ...(genres.length ? { "genre": genres } : {}),
        ...(firstAir ? { "datePublished": firstAir } : {}),
        ...(pub.number_of_seasons && !isPakistani ? { "numberOfSeasons": pub.number_of_seasons } : {}),
        ...(epCount ? { "numberOfEpisodes": epCount } : {}),
        ...(pub.vote_average ? { "aggregateRating": { "@type": "AggregateRating", "ratingValue": Math.round(pub.vote_average * 10) / 10, "bestRating": 10, "ratingCount": pub.vote_count || 1 } } : {}),
      }
    });

    const kwHost = document.getElementById("kwSelect");
    if (kwHost && kwPhrases.length) {
      const opts = [{ value: "", label: "Keyword chuno" }].concat(kwPhrases.map(p => ({ value: p, label: p })));
      UI.mountFaSelect(kwHost, opts, "", v => { if (v) location.href = "/search?q=" + encodeURIComponent(v); });
    }

  } catch (e) {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("Could not load this show. Please try again.")}</div>`;
  }
})();



