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
     first, then same type, newest first, one item (slice(0,1)).
     Same medium only: a movie page never recommends a TV show (it
     would link to /movie?id=<tv id> and land on "not published"). */
  const similarPublished = (pub) => {
    const cands = Object.values(window.FA_PUBLISHED || {})
      .filter(x => x && x.id != null && String(x.id) !== String(pub.id) && x.type === pub.type);
    cands.sort((a, b) =>
      ((b.industry === pub.industry) - (a.industry === pub.industry)) ||
      ((b.type === pub.type) - (a.type === pub.type)) ||
      String(b.published_at || "").localeCompare(String(a.published_at || "")) ||
      titleDate(b).localeCompare(titleDate(a)));
    return cands.slice(0, 1);
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
    let credits = null;
    try { credits = await TMDB.api(`/movie/${id}/credits`); } catch (_) { credits = null; }
    const cast = ((credits && credits.cast) || []).filter(c => c && c.name);
    const crew = ((credits && credits.crew) || []).filter(c => c && c.name);
    const directors = [...new Map(crew.filter(c => c.job === "Director").map(c => [c.id, c])).values()];
    const writers = [...new Map(crew.filter(c => ["Writer", "Screenplay", "Story", "Author"].includes(c.job)).map(c => [c.id, c])).values()];
    const crewLink = (p) => `<a href="/person?id=${p.id}">${UI.esc(p.name)}</a>`;

    /* Official trailer: baked into the published entry (official
       YouTube trailer only). Absent when none exists — no section. */
    const trailerKey = pub.trailer && /^[A-Za-z0-9_-]{11}$/.test(pub.trailer.key || "") ? pub.trailer.key : "";
    const trailerName = pub.trailer && pub.trailer.name ? pub.trailer.name : "";

    const rows = (window.FA_DAYWISE || {})[String(id)] || null;
    const daywiseHtml = rows && rows.length ? UI.daywiseCard(rows, "Day-Wise Box Office", { titleId: id }) : "";

    const similar = similarPublished(pub);

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

    ${pub.overview ? `<div class="content-card"><h2>Story</h2><p class="article-summary">${UI.esc(pub.overview)}</p></div>` : ""}

    ${(pub.budget || pub.revenue) ? `<div class="content-card"><h2>Box Office</h2>
      <div class="bo-verdict-card"><div class="bo-nums">
        ${pub.budget ? `<div><span>Budget</span><b>${UI.fmtMoney(pub.budget)}</b></div>` : ""}
        ${pub.revenue ? `<div><span>Worldwide Gross</span><b>${UI.fmtMoney(pub.revenue)}</b></div>` : ""}
        ${verdict ? `<div><span>Verdict</span><b>${UI.esc(verdict.label)}</b></div>` : ""}
      </div></div>
      <p class="prov-note">Budget and gross are reported figures; the verdict is an estimate from budget vs gross, not an official declaration.</p></div>` : ""}

    ${factRows.length ? `<div class="content-card"><h2>Movie Facts</h2>
      <dl class="facts-table">${factRows.map(([k, v]) => `<div class="fact-row"><dt>${UI.esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl></div>` : ""}

    ${trailerKey ? `<div class="content-card" id="official-trailer"><h2>Official Trailer</h2>
      <div class="video-embed"><iframe src="https://www.youtube-nocookie.com/embed/${trailerKey}" title="Official trailer — ${UI.esc(trailerName || title)}" loading="lazy" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div>
      <p class="prov-note">Official trailer via YouTube.</p></div>` : ""}

    ${castTop.length ? `<div class="content-card"><h2>Top Cast</h2>
      <div class="cast-grid">${castTop.map(c => UI.personCard(c, c.character || "")).join("")}</div>
      ${castRest.length ? `<div class="cast-grid more-wrap" id="castMore">${castRest.map(c => UI.personCard(c, c.character || "")).join("")}</div>
      <button type="button" class="btn more-btn" data-target="castMore" data-more="Show More Cast" data-less="Show Less" onclick="UI.toggleMore(this)">Show More Cast</button>` : ""}
      <p class="prov-note">Full credited cast with photos and filmographies on each person's FlickAtlas profile.</p></div>` : ""}

    ${daywiseHtml}

    ${similar.length ? `<section class="section"><div class="section-head"><h2>Similar Movies</h2></div>
      <div class="grid">${similar.map(x => UI.posterCard(x, "movie", UI.industryTag(x))).join("")}</div></section>` : ""}
  </div>`;

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
