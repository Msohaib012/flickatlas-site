/* FlickAtlas — Movie detail page (?id=<tmdb_id>): published titles only.
   Rewritten 2026-10-25 (published-only rebuild, §4); rich detail fields
   added in consolidation (spec §1a): budget/revenue/verdict, genres,
   runtime, tagline, certification, status, spoken languages and
   production countries all render FROM THE BAKED-IN published entry —
   never a live TMDB.details call. The id is looked
   up in window.FA_PUBLISHED; hero/story/facts/trailer/day-wise/similar
   all render from the baked-in published entry. Cast comes from the
   TMDB credits endpoint for this one title only (a single-title
   record, not a catalogue). A title that isn't published renders a
   plain state — the page NEVER fetches the title live from TMDB to
   fill itself. Money always goes through UI.fmtMoney* (USD data,
   auto-converts on currency change); no watch/download buttons, no
   external links except the YouTube trailer embed. */
(async function () {
  UI.mountChrome("/movie");
  const main = document.getElementById("app");
  const id = UI.getParam("id", "");
  if (!id || !/^\d+$/.test(id)) {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("Movie not found.", false)}
      <p style="text-align:center"><a class="btn btn-teal" href="/movies">Browse Movies</a></p></div>`;
    UI.setSEO({ title: "Movie Not Found | FlickAtlas", desc: "This movie page could not be found. Browse movies on FlickAtlas.", path: "/movie", noindex: true });
    return;
  }
  UI.setSEO({
    title: "Movie Details — Cast, Story, Budget & Box Office | FlickAtlas",
    desc: "Full movie details on FlickAtlas: cast & crew, story, budget vs box office collection, trailer and ratings.",
    path: `/movie?id=${encodeURIComponent(id)}`
  });
  main.innerHTML = `<div class="wrap"><div class="sk" style="height:320px;border-radius:22px;margin-top:22px"></div><div class="sk" style="height:180px;border-radius:14px;margin-top:18px"></div></div>`;

  const LANG = { hi: "Hindi", en: "English", ko: "Korean", ur: "Urdu", te: "Telugu", ta: "Tamil", mr: "Marathi", pa: "Punjabi", bn: "Bengali", ml: "Malayalam", kn: "Kannada", gu: "Gujarati", fr: "French", es: "Spanish", de: "German", ja: "Japanese", zh: "Chinese" };
  const langName = (code) => LANG[code] || String(code || "").toUpperCase();
  const COUNTRY = { IN: "India", PK: "Pakistan", US: "United States", GB: "United Kingdom", CA: "Canada", AU: "Australia", FR: "France", DE: "Germany", JP: "Japan", KR: "South Korea", CN: "China", AE: "United Arab Emirates", SA: "Saudi Arabia", NZ: "New Zealand", IE: "Ireland", ES: "Spain", IT: "Italy", BR: "Brazil", RU: "Russia", TR: "Turkey", TH: "Thailand" };
  const countryNames = (codes) => (codes || []).map(c => COUNTRY[c] || c).filter(Boolean);
  /* Industry label from the baked-in industry value (spec §1a). */
  const IND_LABEL = { bollywood: "Bollywood", pakistani: "Pakistani", world: "World Cinema" };
  const indLabel = (pub) => IND_LABEL[pub.industry] || UI.industryTag(pub) || "";
  const titleDate = (x) => x.type === "tv" ? (x.first_air_date || "") : (x.release_date || "");
  /* Similar / You May Also Like — FA_PUBLISHED only, same industry
     first, then same type, up to 6. Same medium only: a movie page
     never recommends a TV show (it would link to /movie?id=<tv id>
     and land on "not published").
     UPCOMING pages (user order 2026-10-26): the current title has not
     released yet, so Similar shows UPCOMING titles only (not released
     ones), nearest date first — and the section is headed
     "Similar Upcoming". RELEASED pages keep the released-only list,
     newest first, headed "Similar Movies". */
  const similarPublished = (pub) => {
    const todayS = TMDB.today();
    /* Festival-only titles (date_kind="festival", owner decision
       2026-10-27) count as upcoming — a festival premiere is not a
       release — so their Similar rail shows upcoming titles. */
    const isUpcoming = (titleDate(pub) && titleDate(pub) > todayS) || pub.date_kind === "festival";
    const cands = Object.values(window.FA_PUBLISHED || {})
      .filter(x => x && x.id != null && String(x.id) !== String(pub.id) && x.type === pub.type
        && titleDate(x) && (isUpcoming ? (titleDate(x) > todayS || x.date_kind === "festival") : (titleDate(x) <= todayS && x.date_kind !== "festival"))
        /* Owner order 2026-10-27: streaming-only titles (OTT "now", no
           box-office rows) do not belong in Similar Movies on a
           released title's page. Upcoming pages are untouched — an
           unreleased streaming title's theatrical status is unverified. */
        && (isUpcoming || !UI.isStreamingOnly(x)));
    cands.sort((a, b) =>
      ((b.industry === pub.industry) - (a.industry === pub.industry)) ||
      ((b.type === pub.type) - (a.type === pub.type)) ||
      (isUpcoming
        ? titleDate(a).localeCompare(titleDate(b))
        : titleDate(b).localeCompare(titleDate(a))) ||
      String(b.published_at || "").localeCompare(String(a.published_at || "")));
    return cands.slice(0, 6);
  };

  /* Related News — articles whose PRIMARY entity (entities.titles[0])
     is this title. Match: exact name, substring (min 6 chars), or a
     shared distinctive first word (5+ letters, e.g. "Ramayana" in
     "Ramayana: Part 1" vs "Ramayana: Rise of a Legend"). Only the
     primary entity counts — a roundup that merely mentions the title
     does not qualify. Verified against live data: Ramayana 6, Udta
     Teer 2, Clayface 2, every other title 0, no false positives. */
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
     and published. No live TMDB fetch fills this page. A published TV
     id lands here by mistake — point at its real page instead of
     claiming it was never published. --- */
  const pub = (window.FA_PUBLISHED || {})[String(id)] || null;
  if (pub && pub.type === "tv") {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("This title is a TV show — it lives on its own show page.", false)}
      <p style="text-align:center"><a class="btn btn-teal" href="/show?id=${encodeURIComponent(id)}">Open Show Page →</a></p></div>`;
    UI.setSEO({ title: "This Title Is a TV Show | FlickAtlas", desc: "This title is a TV show. Open its show page on FlickAtlas.", path: "/show", noindex: true });
    return;
  }
  if (!pub || pub.type !== "movie") {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("This title hasn't been published on FlickAtlas yet.", false)}
      <p style="text-align:center"><a class="btn btn-teal" href="/movies">Browse Movies</a></p></div>`;
    UI.setSEO({ title: "Title Not Published | FlickAtlas", desc: "This movie hasn't been published on FlickAtlas yet. Browse published movies instead.", path: "/movie", noindex: true });
    return;
  }

  /* Similar heading — must be AFTER the pub lookup above: it reads
     pub.release_date, and pub is declared there. (Was defined before
     the lookup, which threw "Cannot access 'pub' before initialization"
     and killed the whole page on its loading skeleton.) */
  const similarHeading = titleDate(pub) && titleDate(pub) > TMDB.today() ? "Similar Upcoming" : "Similar Movies";

  try {
    const title = UI.titleOf(pub);
    const year = UI.yearOf(pub);

    /* Bollywood context (locks money display to USD, same as the other
       Bollywood pages) — set before any money is rendered. */
    const countries = pub.origin_country || [];
    if (pub.original_language === "hi" && countries.includes("IN")) UI.setIndustryContext("bollywood");

    const poster = UI.img(pub.poster_path, "w342");
    const backdrop = UI.img(pub.backdrop_path, "w1280");
    const rating = UI.ratingText(pub);
    const relDate = UI.fmtDate(pub.release_date);
    const tag = indLabel(pub);
    /* Rich detail fields, baked into the published entry (spec §1a). */
    const runtime = UI.fmtRuntime(pub.runtime);
    const genres = (pub.genres || []).filter(Boolean);
    const verdict = UI.verdict(pub.budget, pub.revenue);
    const spoken = (pub.spoken_languages || []).map(c => langName(c)).filter(Boolean);
    const prodCountries = countryNames(
      (pub.production_countries && pub.production_countries.length ? pub.production_countries : countries));

    /* Cast + crew: the credits endpoint for this one published title
       only (single-title record, not a catalogue). Best effort — the
       page renders without cast if it fails. */
    /* Cast + crew: the credits endpoint for this one published title.
       Raced against an 8s timeout (user-visible bug 2026-10-26): TMDB.api
       has NO timeout, so a stalled credits fetch hung the whole page on
       its loading skeleton forever. The page must render without cast
       if the fetch fails OR hangs — never wait forever. */
    let credits = null;
    try {
      credits = await Promise.race([
        TMDB.api(`/movie/${id}/credits`),
        new Promise((_, rej) => setTimeout(() => rej(new Error("credits timeout")), 8000))
      ]);
    } catch (_) { credits = null; }
    const cast = ((credits && credits.cast) || []).filter(c => c && c.name);
    const crew = ((credits && credits.crew) || []).filter(c => c && c.name);
    const directors = [...new Map(crew.filter(c => c.job === "Director").map(c => [c.id, c])).values()];
    const writers = [...new Map(crew.filter(c => ["Writer", "Screenplay", "Story", "Author"].includes(c.job)).map(c => [c.id, c])).values()];
    const crewLink = (p) => `<a href="/person?id=${p.id}">${UI.esc(p.name)}</a>`;

    /* Crew groups: key crew jobs from the one title's credits
       (deduped, capped at 6 per group — same pattern as the show
       page's "Creators & Crew" card). Directors/Writers also appear
       in the Facts table; Producers, Executive Producers, Music and
       Cinematography appear nowhere else on this page. */
    const crewGroups = [];
    const seenCrew = new Set();
    for (const [label, jobs] of [
      ["Directors", ["Director"]],
      ["Writers", ["Writer", "Screenplay", "Story", "Author"]],
      ["Producers", ["Producer"]],
      ["Executive Producers", ["Executive Producer"]],
      ["Music", ["Original Music Composer", "Music"]],
      ["Cinematography", ["Director of Photography"]],
    ]) {
      const list = crew.filter(c => c && jobs.includes(c.job) && c.name && !seenCrew.has(c.id))
        .slice(0, 6).map(c => ({ id: c.id, name: c.name, job: c.job }));
      list.forEach(c => seenCrew.add(c.id));
      if (list.length) crewGroups.push([label, list]);
    }

    /* Official trailer: baked into the published entry (official
       YouTube trailer only). Absent when none exists — no section. */
    const trailerKey = pub.trailer && /^[A-Za-z0-9_-]{11}$/.test(pub.trailer.key || "") ? pub.trailer.key : "";
    const trailerName = pub.trailer && pub.trailer.name ? pub.trailer.name : "";

    const rows = (window.FA_DAYWISE || {})[String(id)] || null;
    const daywiseHtml = rows && rows.length ? UI.daywiseCard(rows, "Day-Wise Box Office (India Net + Overseas)", { titleId: id }) : "";

    /* Advance booking (user order 2026-10-26): upcoming days' advance
       figures from window.FA_ADVANCE (js/advance-data.js, produced by
       the Sacnilk reader; may not exist yet, so guard). Shown AFTER the
       actual day-wise rows, clearly labeled, and NEVER mixed into the
       actual totals — advance figures are projections, not final
       collections. Same table shape and money formatting as the
       day-wise card (UI.fmtMoney, so the currency switcher re-converts
       them in place). Advance rows are NOT passed through
       UI.daywiseCard: its cleaner drops future dates. */
    const advanceHtml = (() => {
      const raw = (window.FA_ADVANCE || {})[String(id)] || [];
      const seen = new Set();
      const clean = (Array.isArray(raw) ? raw : [])
        .filter(r => r && /^\d{4}-\d{2}-\d{2}$/.test(r.date || "")
          && typeof r.collection === "number" && Number.isFinite(r.collection) && r.collection >= 0
          && !seen.has(r.date) && (seen.add(r.date), true))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      if (!clean.length) return "";
      const body = clean.map(rw => `<tr><td>${UI.esc(UI.fmtDate(rw.date))}</td><td>${UI.esc(rw.day || "")}</td><td><b>${UI.fmtMoney(rw.collection)}</b></td></tr>`).join("");
      return `<div class="content-card"><h2>Advance Booking</h2>
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Date</th><th>Day</th><th>Advance Collection</th></tr></thead>
        <tbody>${body}</tbody></table></div>
      <p class="prov-note">Advance booking figures for upcoming days, as reported. These are not final collections and may change as the day closes.</p></div>`;
    })();
    /* Day-wise section (user order 2026-10-26): the actual day-wise
       card plus the advance-booking block, placed right below the
       hero/banner — day-wise collection is the priority on this page. */
    const daywiseSection = (daywiseHtml || "") + advanceHtml;

    const similar = similarPublished(pub);
    const related = relatedNews(pub);

    const factRows = [];
    if (directors.length) factRows.push(["Director", directors.map(crewLink).join(", ")]);
    if (writers.length) factRows.push(["Written by", writers.map(crewLink).join(", ")]);
    if (pub.original_language) factRows.push(["Original Language", UI.esc(langName(pub.original_language))]);
    if (spoken.length) factRows.push(["Spoken Languages", UI.esc(spoken.join(", "))]);
    if (pub.certification) factRows.push(["Certification", UI.esc(pub.certification)]);
    if (pub.status) factRows.push(["Status", UI.esc(pub.status)]);
    if (tag) factRows.push(["Industry", UI.esc(tag)]);
    if (relDate) factRows.push(["Release Date", UI.esc(relDate)]);
    if (runtime) factRows.push(["Runtime", UI.esc(runtime)]);
    if (genres.length) factRows.push(["Genres", UI.esc(genres.join(", "))]);
    if (prodCountries.length) factRows.push(["Production Countries", UI.esc(prodCountries.join(", "))]);
    if (pub.budget) factRows.push(["Budget", UI.fmtMoneyWords(pub.budget)]);
    if (pub.revenue) factRows.push(["Worldwide Gross", UI.fmtMoneyWords(pub.revenue)]);

    const heroFacts = [];
    if (relDate) heroFacts.push(`<div><span>Release Date</span><b>${UI.esc(relDate)}</b></div>`);
    if (runtime) heroFacts.push(`<div><span>Runtime</span><b>${UI.esc(runtime)}</b></div>`);
    if (rating) heroFacts.push(`<div><span>Rating</span><b>${UI.esc(rating)}${pub.vote_count ? ` · ${pub.vote_count.toLocaleString("en-US")} votes` : ""}</b></div>`);
    if (pub.status) heroFacts.push(`<div><span>Status</span><b>${UI.esc(pub.status)}</b></div>`);
    if (tag) heroFacts.push(`<div><span>Industry</span><b>${UI.esc(tag)}</b></div>`);
    if (pub.original_language) heroFacts.push(`<div><span>Language</span><b>${UI.esc(langName(pub.original_language))}</b></div>`);

    const castTop = cast.slice(0, 12);
    const castRest = cast.slice(12, 30);

    /* Reviews (Movies Flare format): a full review from FA_REVIEWS —
       the Movies Flare seed for Udta Teer, a FlickAtlas Review for the
       rest — plus the TMDB audience score and the BollyMovieReviewz
       critic average where they exist. No entry -> no section at all
       (the slot stays empty, never a made-up score). */
    const fmtScore = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return "";
      return (Math.round(n * 10) / 10).toString().replace(/\.0$/, "");
    };
    const review = (window.FA_REVIEWS || {})[String(id)] || null;
    const reviewsHtml = (() => {
      if (!review) return "";
      const cats = review.categories || {};
      const catRows = Object.entries(cats).map(([label, score]) => {
        const pct = Math.max(0, Math.min(100, Number(score) * 10));
        return `<div class="rv-row"><span>${UI.esc(label)}</span><span class="rv-bar"><i style="width:${pct}%"></i></span><b>${UI.esc(fmtScore(score))}/10</b></div>`;
      }).join("");
      const srcLabel = review.source === "Movies Flare" ? "Movies Flare Rating" : "FlickAtlas Review";
      const tmdbLine = (pub.vote_average && Number(pub.vote_average) > 0)
        ? `TMDB audience: <b>${UI.esc(fmtScore(pub.vote_average))}/10</b>${pub.vote_count ? ` (${Number(pub.vote_count).toLocaleString("en-US")} votes)` : ""}` : "";
      const critic = review.critic || null;
      const criticLine = critic
        ? `BollyMovieReviewz critic average: <b>${UI.esc(fmtScore(critic.score_10))}/10</b> (${UI.esc(critic.raw || "")}${critic.count ? `, ${critic.count} critics` : ""})` : "";
      const scoreNotes = [tmdbLine, criticLine].filter(Boolean).join(" · ");
      const srcNote = review.source === "Movies Flare"
        ? "Review by Movies Flare — scores and text from their Udta Teer review carousel."
        : "FlickAtlas's own review, written from the film's story, cast and genres and what reviewers are saying online.";
      const strengths = Array.isArray(review.strengths) ? review.strengths.filter(Boolean) : [];
      const swHtml = (strengths.length || review.weaknesses) ? `<div class="rv-sw">
        ${strengths.length ? `<div><h3>Strengths</h3><ul class="rv-list">${strengths.map(s => `<li>${UI.esc(s)}</li>`).join("")}</ul></div>` : ""}
        ${review.weaknesses ? `<div><h3>Weaknesses</h3><p>${UI.esc(review.weaknesses)}</p></div>` : ""}
      </div>` : "";
      return `<div class="content-card" id="movie-reviews"><h2>Reviews</h2>
      <div class="rv-head">
        <div class="rv-overall"><span class="rv-star">★</span><b>${UI.esc(fmtScore(review.overall))}<small>/10</small></b></div>
        <div class="rv-head-txt"><b>${UI.esc(srcLabel)}</b><span>Overall rating · Source: ${UI.esc(review.source || "")}</span></div>
      </div>
      ${catRows ? `<div class="rv-cats">${catRows}</div>` : ""}
      ${review.story_plot ? `<h3>Story &amp; Plot</h3><p>${UI.esc(review.story_plot)}</p>` : ""}
      ${review.comedy ? `<h3>Comedy &amp; Entertainment</h3><p>${UI.esc(review.comedy)}</p>` : ""}
      ${review.performances ? `<h3>Performances &amp; Direction</h3><p>${UI.esc(review.performances)}</p>` : ""}
      ${swHtml}
      ${review.verdict ? `<h3>Final Verdict</h3><p>${UI.esc(review.verdict)}</p>` : ""}
      ${scoreNotes ? `<p class="prov-note">${scoreNotes}</p>` : ""}
      <p class="prov-note">${UI.esc(srcNote)}</p></div>`;
    })();

    /* Top Searches phrases (movie pages had NO visible keywords):
       built only from this entry's own data - never invented. The same
       phrases must also appear in the page's meta keywords (seo-meta.json
       "k", generated by scripts/seo_assets.py) so a visible keyword is
       also findable from Google search. */
    const kwPhrases = (() => {
      const list = [title];
      const push = (p) => { if (p && !list.includes(p)) list.push(p); };
      if (rows && rows.length) push(`${title} box office collection`);
      if (cast.length) push(`${title} cast`);
      if (review) push(`${title} movie review`);
      if (pub.budget) push(`${title} budget`);
      if (trailerKey) push(`${title} trailer`);
      if (relDate) push(`${title} release date`);
      if (pub.overview) push(`${title} story`);
      if ((pub.providers || []).length) push(`${title} watch online`);
      return list;
    })();
    const kwHtml = `<section class="section"><div class="section-head"><h2>Top Searches</h2></div>
      <div class="home-filter-row"><div class="fa-select" id="kwSelect">
        <button type="button" class="fa-select-trigger" aria-expanded="false" aria-haspopup="listbox"><span class="fa-select-value">Top searches</span><span class="fa-select-chevron"></span></button>
        <div class="fa-select-menu" role="listbox" id="kwSelect-menu" hidden></div>
      </div></div>
      <p class="prov-note">Pick a search to open it.</p></section>`;

    main.innerHTML = `<div class="wrap">
    <p class="article-crumb"><a href="/movies">← Movies</a></p>
    <section class="detail-hero">
      ${backdrop ? `<div class="hero-bg"><img src="${backdrop}" alt="" loading="lazy" decoding="async"></div>` : ""}
      <div class="hero-shade"></div>
      <div class="detail-in">
        ${poster ? `<div class="detail-poster"><img src="${poster}" alt="${UI.esc(title)} poster" loading="lazy" decoding="async" onerror="this.remove()"></div>` : ""}
        <div class="detail-main">
          <h1>${UI.esc(title)}${year ? ` (${year})` : ""}</h1>
          <p class="detail-sub">${pub.tagline ? UI.esc(pub.tagline) : UI.esc([genres.join(", "), runtime, relDate].filter(Boolean).join(" · "))}</p>
          ${heroFacts.length ? `<div class="detail-facts">${heroFacts.join("")}</div>` : ""}
        </div>
      </div>
    </section>

    ${daywiseSection}

    ${pub.overview ? `<div class="content-card" id="story-summary"><h2>Story</h2><p class="article-summary">${UI.esc(pub.overview)}</p></div>` : ""}

    ${reviewsHtml}

    ${(pub.budget || pub.revenue) ? `<div class="content-card"><h2>Box Office</h2>
      <div class="bo-verdict-card"><div class="bo-nums">
        ${pub.budget ? `<div><span>Budget</span><b>${UI.fmtMoney(pub.budget)}</b></div>` : ""}
        ${pub.revenue ? `<div><span>Worldwide Gross</span><b>${UI.fmtMoney(pub.revenue)}</b></div>` : ""}
        ${verdict ? `<div><span>Verdict</span><b>${UI.esc(verdict.label)}</b></div>` : ""}
      </div></div>
      <p class="prov-note">Budget and gross are reported figures; the verdict is an estimate from budget vs gross, not an official declaration.</p></div>` : ""}

    ${factRows.length ? `<div class="content-card" id="movie-facts"><h2>Movie Facts</h2>
      <dl class="facts-table">${factRows.map(([k, v]) => `<div class="fact-row"><dt>${UI.esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl></div>` : ""}

    ${trailerKey ? `<div class="content-card" id="official-trailer"><h2>Official Trailer</h2>
      <div class="video-embed"><iframe src="https://www.youtube-nocookie.com/embed/${trailerKey}" title="Official trailer — ${UI.esc(trailerName || title)}" loading="lazy" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div>
      <p class="prov-note">Official trailer via YouTube.</p></div>` : ""}

    ${castTop.length ? `<div class="content-card"><h2>Top Cast</h2>
      <div class="cast-grid">${castTop.map(c => UI.personCard(c, c.character || "")).join("")}</div>
      ${castRest.length ? `<div class="cast-grid more-wrap" id="castMore">${castRest.map(c => UI.personCard(c, c.character || "")).join("")}</div>
      <button type="button" class="btn more-btn" data-target="castMore" data-more="Show More Cast" data-less="Show Less" onclick="UI.toggleMore(this)">Show More Cast</button>` : ""}
      <p class="prov-note">Full credited cast with photos and filmographies on each person's FlickAtlas profile.</p></div>` : ""}

    ${crewGroups.length ? `<div class="content-card"><h2>Crew</h2>
      <div class="crew-groups">${crewGroups.map(([label, people]) => `<div class="crew-group"><h4>${UI.esc(label)}</h4>
        <ul>${people.map(p => `<li><a href="/person?id=${p.id}">${UI.esc(p.name)}</a><span class="crew-job">${UI.esc(p.job || "")}</span></li>`).join("")}</ul></div>`).join("")}</div></div>` : ""}

    ${related.length ? `<section class="section"><div class="section-head"><h2>Related News</h2>
      <a class="see-all" href="/news">All News →</a></div>
      <div class="news-list">${related.map(a => `<a class="news-item" href="/news-item?id=${encodeURIComponent(a.id)}">
        <span class="news-txt"><b>${UI.esc(a.headline || "")}</b>
        <span>${a.published ? UI.relTime(Date.parse(a.published)) : ""}</span></span>
      </a>`).join("")}</div></section>` : ""}

    ${similar.length ? `<section class="section"><div class="section-head"><h2>${similarHeading}</h2></div>
      <div class="grid">${similar.map(x => UI.posterCard(x, "movie", UI.industryTag(x))).join("")}</div></section>` : ""}

    ${`<section class="section" id="audiencePulse"><div class="section-head"><h2>Audience Pulse</h2></div>
      <div class="ap-cards">
        ${rating ? `<div class="ap-card"><span class="ap-source">TMDB</span><b class="ap-score">${UI.esc(rating)}</b><span class="ap-meta">${pub.vote_count ? `${pub.vote_count.toLocaleString("en-US")} votes` : "Audience rating"}</span></div>` : `<div class="ap-card"><span class="ap-source">TMDB</span><b class="ap-score">—</b><span class="ap-meta">No audience rating yet</span></div>`}
        <div class="ap-card" id="apShared"><span class="ap-source">FlickAtlas viewers</span><b class="ap-score">—</b><span class="ap-meta">Loading viewer ratings…</span></div>
      </div>
      <p class="prov-note">Audience rating from TMDB, plus the average of viewer reviews on FlickAtlas. BookMyShow and IMDb ratings are not available on this page yet.</p>
      <button type="button" class="btn btn-teal" onclick="document.getElementById('rateMovie').scrollIntoView({behavior:'smooth',block:'center'})">Rate ${UI.esc(title)}</button>
    </section>`}

    ${`<section class="section" id="rateMovie"><div class="section-head"><h2>Rate This Movie</h2></div>
      <div class="rate-widget">
        <div class="rate-stars" role="radiogroup" aria-label="Your rating">
          ${[1, 2, 3, 4, 5].map(n => `<button type="button" class="rate-star" data-value="${n}" aria-label="${n} star${n > 1 ? "s" : ""}" role="radio" aria-checked="false">★</button>`).join("")}
        </div>
        <p class="rate-hint" id="rateHint">Tap a star to rate</p>
        <input type="text" id="rateName" maxlength="30" placeholder="Your name (optional)" autocomplete="nickname" style="width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:10px;padding:10px 12px;font:inherit;margin-bottom:12px;background:#fff;color:var(--ink)">
        <textarea id="rateComment" rows="3" maxlength="500" placeholder="Write a comment"></textarea>
        <button type="button" class="btn btn-teal" id="rateSubmit">Submit Rating</button>
        <p class="prov-note">Your review is public \u2014 it shows to everyone on FlickAtlas, with your stars and comment.</p>
      </div>
    </section>`}

    ${`<section class="section" id="viewerReviews"><div class="section-head"><h2>Viewer Reviews</h2></div>
      <p class="prov-note" id="viewerAgg">Loading reviews\u2026</p>
      <div id="viewerList"></div>
    </section>`}

    ${kwHtml}
  </div>`;

    /* Shared viewer reviews (owner order 2026-10-28): reviews are
       PUBLIC — POSTed to /api/review, stored in Cloudflare KV, and shown
       to every visitor below the form. Nothing about a review lives in
       localStorage: the only local marker is fa-reviewed-<id> (a
       timestamp), used solely to grey out the form for a day after you
       post — never as the store. */
    const renderStars = (n) => {
      let out = "";
      for (let i = 1; i <= 5; i++) out += `<span style="color:${i <= n ? "var(--gold)" : "var(--muted)"}">\u2605</span>`;
      return out;
    };
    const renderReviewItem = (r) => {
      const when = r.at ? UI.relTime(r.at) : "";
      return `<div class="content-card" style="margin-top:12px"><div><b>${renderStars(Number(r.s) || 0)}</b> <span style="color:var(--muted)">${UI.esc(r.n || "A FlickAtlas viewer")}${when ? ` \u00b7 ${UI.esc(when)}` : ""}</span></div><p style="margin:8px 0 0">${UI.esc(r.c || "")}</p></div>`;
    };
    const aggText = (average, count) =>
      (average == null ? "No viewer reviews yet \u2014 be the first to rate this movie."
        : `${average.toFixed(1)} \u2605 from ${count} viewer review${count === 1 ? "" : "s"}.`);
    const paintShared = (average, count) => {
      const card = main.querySelector("#apShared");
      if (card) {
        const score = card.querySelector(".ap-score");
        const meta = card.querySelector(".ap-meta");
        if (score) score.textContent = average == null ? "\u2014" : `${average.toFixed(1)}/5`;
        if (meta) meta.textContent = average == null ? "No viewer ratings yet" : `${count} review${count === 1 ? "" : "s"}`;
      }
      const agg = main.querySelector("#viewerAgg");
      if (agg) agg.textContent = aggText(average, count);
    };
    const renderList = (items) => {
      const list = main.querySelector("#viewerList");
      if (!list) return;
      list.innerHTML = items.length ? items.map(renderReviewItem).join("")
        : `<p class="prov-note">No viewer reviews yet \u2014 be the first to rate this movie.</p>`;
    };
    const loadReviews = async () => {
      try {
        const res = await fetch(`/api/reviews?tmdb=${encodeURIComponent(id)}`);
        if (!res.ok) throw new Error("reviews " + res.status);
        const data = await res.json();
        paintShared(data.average == null ? null : Number(data.average), Number(data.count) || 0);
        renderList(Array.isArray(data.items) ? data.items : []);
      } catch (_) {
        paintShared(null, 0);
        const card = main.querySelector("#apShared");
        if (card) { const meta = card.querySelector(".ap-meta"); if (meta) meta.textContent = "Viewer ratings unavailable"; }
        const agg = main.querySelector("#viewerAgg");
        if (agg) agg.textContent = "Could not load reviews.";
        const list = main.querySelector("#viewerList");
        if (list) list.innerHTML = `<p class="prov-note">Could not load reviews. Please refresh the page.</p>`;
      }
    };
    loadReviews();
    try {
      const rateKey = `fa-reviewed-${id}`;
      const stars = [...main.querySelectorAll(".rate-star")];
      const hint = main.querySelector("#rateHint");
      const comment = main.querySelector("#rateComment");
      const nameInput = main.querySelector("#rateName");
      const submit = main.querySelector("#rateSubmit");
      let picked = 0;
      let already = false;
      try {
        const at = Number(localStorage.getItem(rateKey) || "0");
        already = !!at && Date.now() - at < 86400000;
      } catch (_) {}
      const paint = (n) => {
        stars.forEach(s => {
          const on = Number(s.dataset.value) <= n;
          s.classList.toggle("on", on);
          s.setAttribute("aria-checked", String(Number(s.dataset.value) === n));
        });
        if (hint) hint.textContent = n ? `Your rating: ${n}/5` : "Tap a star to rate";
      };
      const setDone = () => {
        if (submit) { submit.disabled = true; submit.textContent = "Thanks \u2014 review posted \u2713"; }
        if (hint) hint.textContent = "You already reviewed this movie today.";
      };
      stars.forEach(s => s.addEventListener("click", () => { if (already) return; picked = Number(s.dataset.value); paint(picked); }));
      if (already) { paint(0); setDone(); }
      if (submit) submit.addEventListener("click", async () => {
        if (already) return;
        if (!picked) { if (hint) hint.textContent = "Please pick a star rating first."; return; }
        const text = (comment.value || "").trim();
        if (!text) { if (hint) hint.textContent = "Please write a comment."; return; }
        const nm = (nameInput.value || "").trim();
        submit.disabled = true;
        submit.textContent = "Posting\u2026";
        try {
          const res = await fetch("/api/review", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tmdb: id, stars: picked, comment: text, name: nm || undefined }),
          });
          const data = await res.json().catch(() => null);
          if (!res.ok || !data || !data.ok) {
            throw new Error((data && data.error) || "Could not save \u2014 please try again.");
          }
          try { localStorage.setItem(rateKey, String(Date.now())); } catch (_) {}
          already = true;
          paintShared(data.average == null ? null : Number(data.average), Number(data.count) || 0);
          if (data.review) {
            const list = main.querySelector("#viewerList");
            if (list) {
              const empty = list.querySelector(".prov-note");
              if (empty) list.innerHTML = "";
              list.insertAdjacentHTML("afterbegin", renderReviewItem(data.review));
            }
          }
          if (comment) comment.value = "";
          if (nameInput) nameInput.value = "";
          picked = 0; paint(0);
          setDone();
          const vr = document.getElementById("viewerReviews");
          if (vr && vr.scrollIntoView) vr.scrollIntoView({ behavior: "smooth", block: "nearest" });
        } catch (e) {
          submit.disabled = false;
          submit.textContent = "Submit Rating";
          if (hint) hint.textContent = e.message || "Could not save \u2014 please try again.";
        }
      });
    } catch (_) {}
    /* Top Searches dropdown (movie pages had no visible keywords):
       phrases built only from this entry's own data. Picking a phrase
       opens /search?q=<phrase>. Custom .fa-select, never a native
       <select> (Android Chrome renders <select> as a modal popup). */
    try {
      const kwHost = main.querySelector("#kwSelect");
      if (kwHost && kwPhrases.length) {
        const opts = [{ value: "", label: "Top searches" },
          ...kwPhrases.map(p => ({ value: p, label: p }))];
        UI.mountFaSelect(kwHost, opts, "", (v) => {
          if (v) location.href = "/search?q=" + encodeURIComponent(v);
        });
      }
    } catch (_) {}

    UI.setSEO({
      title: `${title}${year ? ` (${year})` : ""} — Cast, Story, Budget & Box Office | FlickAtlas`,
      desc: (pub.overview || `${title} — cast, story, budget and box office on FlickAtlas.`).slice(0, 160),
      path: `/movie?id=${encodeURIComponent(id)}`,
      type: "video.movie",
      image: poster || "",
      jsonld: {
        "@context": "https://schema.org", "@type": "Movie",
        "name": title,
        "url": `https://flickatlas.vercel.app/movie?id=${encodeURIComponent(id)}`,
        ...(pub.release_date ? { "datePublished": pub.release_date } : {}),
        ...(pub.overview ? { "description": pub.overview.slice(0, 300) } : {}),
        ...(genres.length ? { "genre": genres } : {}),
        ...(poster ? { "image": poster } : {}),
        ...(rating ? { "aggregateRating": { "@type": "AggregateRating", "ratingValue": String(UI.rating(pub)), "bestRating": "10", "ratingCount": String(pub.vote_count || "") } } : {}),
        ...(directors.length ? { "director": directors.map(p => ({ "@type": "Person", "name": p.name })) } : {}),
        ...(castTop.length ? { "actor": castTop.slice(0, 5).map(p => ({ "@type": "Person", "name": p.name })) } : {}),
      }
    });

  } catch (e) {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("Could not load this movie. Please try again.")}</div>`;
  }
})();












