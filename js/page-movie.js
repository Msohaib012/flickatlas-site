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
    const isUpcoming = titleDate(pub) && titleDate(pub) > todayS;
    const cands = Object.values(window.FA_PUBLISHED || {})
      .filter(x => x && x.id != null && String(x.id) !== String(pub.id) && x.type === pub.type
        && titleDate(x) && (isUpcoming ? titleDate(x) > todayS : titleDate(x) <= todayS));
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
    const daywiseHtml = rows && rows.length ? UI.daywiseCard(rows, "Day-Wise Box Office (India Net)", { titleId: id }) : "";

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
      </div>
      <p class="prov-note">Audience rating from TMDB. BookMyShow and IMDb ratings are not available on this page yet.</p>
      <button type="button" class="btn btn-teal" onclick="document.getElementById('rateMovie').scrollIntoView({behavior:'smooth',block:'center'})">Rate ${UI.esc(title)}</button>
    </section>`}

    ${`<section class="section" id="rateMovie"><div class="section-head"><h2>Rate This Movie</h2></div>
      <div class="rate-widget">
        <div class="rate-stars" role="radiogroup" aria-label="Your rating">
          ${[1, 2, 3, 4, 5].map(n => `<button type="button" class="rate-star" data-value="${n}" aria-label="${n} star${n > 1 ? "s" : ""}" role="radio" aria-checked="false">★</button>`).join("")}
        </div>
        <p class="rate-hint" id="rateHint">Tap a star to rate</p>
        <textarea id="rateComment" rows="3" maxlength="500" placeholder="Write a comment (optional)"></textarea>
        <button type="button" class="btn btn-teal" id="rateSubmit">Submit Rating</button>
        <p class="prov-note">Your rating is saved on this device only.</p>
      </div>
    </section>`}
  </div>`;

    /* Rate widget: stars + optional comment, saved in localStorage (this
       device only — no backend, so ratings are personal, not shared). */
    try {
      const rateKey = `fa-rating-${id}`;
      const stars = [...main.querySelectorAll(".rate-star")];
      const hint = main.querySelector("#rateHint");
      const comment = main.querySelector("#rateComment");
      const submit = main.querySelector("#rateSubmit");
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(rateKey) || "null"); } catch (_) {}
      let picked = saved ? saved.stars : 0;
      const paint = (n) => {
        stars.forEach(s => {
          const on = Number(s.dataset.value) <= n;
          s.classList.toggle("on", on);
          s.setAttribute("aria-checked", String(Number(s.dataset.value) === n));
        });
        if (hint) hint.textContent = n ? `Your rating: ${n}/5${saved ? " (saved)" : ""}` : "Tap a star to rate";
      };
      stars.forEach(s => s.addEventListener("click", () => { picked = Number(s.dataset.value); paint(picked); }));
      if (saved && comment) comment.value = saved.comment || "";
      if (saved) paint(saved.stars);
      if (submit) submit.addEventListener("click", () => {
        if (!picked) { if (hint) hint.textContent = "Please pick a star rating first."; return; }
        try { localStorage.setItem(rateKey, JSON.stringify({ stars: picked, comment: (comment.value || "").trim(), at: Date.now() })); } catch (_) {}
        saved = { stars: picked };
        paint(picked);
        submit.textContent = "Rating Saved ✓";
        setTimeout(() => { submit.textContent = "Submit Rating"; }, 2500);
      });
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

    /* Explore More navigation (same as the show page): section links
       + a search link for this title. Best effort, never blocks.
       Placement is handled inside UI.mountTopSearches (user order
       2026-10-26): right below the Story Summary, above Movie Facts. */
    try { UI.mountTopSearches(main, [title]); } catch (_) {}
  } catch (e) {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("Could not load this movie. Please try again.")}</div>`;
  }
})();







