/* FlickAtlas — Movie detail page (?id=<tmdb_id>):
   cast & crew, story, budget vs box office, official trailer, day-wise
   collections, where to watch and similar titles. Created 2026-10-25:
   the /movie page shipped referencing this script but the file was never
   committed, so every movie detail page stayed on "Loading FlickAtlas…".
   Follows the page-news-item.js detail pattern (mountChrome, setSEO,
   render into #app, try/catch with a stateMsg fallback). Money always
   goes through UI.fmtMoney* (USD data, auto-converts on currency
   change); no watch/download buttons, no external links except the
   YouTube trailer embed. */
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

  try {
    const d = await TMDB.details("movie", id);
    if (!d || !d.title) throw new Error("movie not found");
    const title = UI.titleOf(d);
    const year = UI.yearOf(d);

    /* Bollywood context (locks money display to USD, same as the other
       Bollywood pages) — set before any money is rendered. */
    const countries = d.origin_country || (d.production_countries || []).map(c => c.iso_3166_1);
    if (d.original_language === "hi" && countries.includes("IN")) UI.setIndustryContext("bollywood");

    const poster = UI.img(d.poster_path, "w342");
    const backdrop = UI.img(d.backdrop_path, "w1280");
    const genres = (d.genres || []).map(g => g.name).filter(Boolean);
    const rating = UI.ratingText(d);
    const relDate = UI.fmtDate(d.release_date);
    const runtime = UI.fmtRuntime(d.runtime);
    const tag = UI.industryTag(d);

    /* Certification: prefer the US theatrical rating, else any listed one. */
    let cert = "";
    const relDates = (d.release_dates && d.release_dates.results) || [];
    const us = relDates.find(r => r.iso_3166_1 === "US");
    const certFrom = (entry) => {
      if (!entry || !entry.release_dates) return "";
      const th = entry.release_dates.find(r => r.type === 3 && r.certification) ||
                 entry.release_dates.find(r => r.certification);
      return th ? th.certification : "";
    };
    cert = certFrom(us) || relDates.map(certFrom).find(Boolean) || "";

    const cast = ((d.credits && d.credits.cast) || []).filter(c => c && c.name);
    const crew = ((d.credits && d.credits.crew) || []).filter(c => c && c.name);
    const directors = [...new Map(crew.filter(c => c.job === "Director").map(c => [c.id, c])).values()];
    const writers = [...new Map(crew.filter(c => ["Writer", "Screenplay", "Story", "Author"].includes(c.job)).map(c => [c.id, c])).values()];
    const crewLink = (p) => `<a href="/person?id=${p.id}">${UI.esc(p.name)}</a>`;

    /* Official trailer: verified official YouTube trailer only. */
    let trailerKey = "";
    if (window.OfficialTrailers && typeof window.OfficialTrailers.verified === "function") {
      const v = window.OfficialTrailers.verified(d);
      if (v) trailerKey = v.key;
    } else {
      const vids = (d.videos && d.videos.results) || [];
      const v = vids.find(v => v && v.official === true && v.site === "YouTube" && v.type === "Trailer" && /^[A-Za-z0-9_-]{11}$/.test(v.key || ""));
      if (v) trailerKey = v.key;
    }

    const rows = (window.FA_DAYWISE || {})[String(id)] || null;
    const daywiseHtml = rows && rows.length ? UI.daywiseCard(rows, title) : "";

    const provLines = UI.providerLines(d["watch/providers"]);
    const similar = ((d.similar && d.similar.results) || []).filter(x => x && x.id !== d.id).slice(0, 12);

    const verdict = UI.verdict(d.budget, d.revenue);
    const factRows = [];
    if (directors.length) factRows.push(["Director", directors.map(crewLink).join(", ")]);
    if (writers.length) factRows.push(["Written by", writers.map(crewLink).join(", ")]);
    if (d.original_title && d.original_title !== title) factRows.push(["Original Title", UI.esc(d.original_title)]);
    if (d.original_language) factRows.push(["Original Language", UI.esc(langName(d.original_language))]);
    if ((d.spoken_languages || []).length) factRows.push(["Spoken Languages", UI.esc(d.spoken_languages.map(l => l.english_name || l.name).filter(Boolean).join(", "))]);
    if (cert) factRows.push(["Certification", UI.esc(cert)]);
    if (d.status) factRows.push(["Status", UI.esc(d.status)]);
    if (relDate) factRows.push(["Release Date", UI.esc(relDate)]);
    if (runtime) factRows.push(["Runtime", UI.esc(runtime)]);
    if (genres.length) factRows.push(["Genres", UI.esc(genres.join(", "))]);
    if ((d.production_companies || []).length) factRows.push(["Production", UI.esc(d.production_companies.map(c => c.name).filter(Boolean).join(", "))]);
    if ((d.production_countries || []).length) factRows.push(["Production Countries", UI.esc(d.production_countries.map(c => c.name).filter(Boolean).join(", "))]);
    if (d.budget) factRows.push(["Budget", UI.fmtMoneyWords(d.budget)]);
    if (d.revenue) factRows.push(["Worldwide Gross", UI.fmtMoneyWords(d.revenue)]);

    const heroFacts = [];
    if (relDate) heroFacts.push(`<div><span>Release Date</span><b>${UI.esc(relDate)}</b></div>`);
    if (runtime) heroFacts.push(`<div><span>Runtime</span><b>${UI.esc(runtime)}</b></div>`);
    if (rating) heroFacts.push(`<div><span>Rating</span><b>${UI.esc(rating)}${d.vote_count ? ` · ${d.vote_count.toLocaleString("en-US")} votes` : ""}</b></div>`);
    if (d.status) heroFacts.push(`<div><span>Status</span><b>${UI.esc(d.status)}</b></div>`);
    if (tag) heroFacts.push(`<div><span>Industry</span><b>${UI.esc(tag)}</b></div>`);
    if (d.original_language) heroFacts.push(`<div><span>Language</span><b>${UI.esc(langName(d.original_language))}</b></div>`);

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
          <p class="detail-sub">${d.tagline ? UI.esc(d.tagline) : UI.esc([genres.join(", "), runtime, relDate].filter(Boolean).join(" · "))}</p>
          ${heroFacts.length ? `<div class="detail-facts">${heroFacts.join("")}</div>` : ""}
        </div>
      </div>
    </section>

    ${d.overview ? `<div class="content-card"><h2>Story</h2><p class="article-summary">${UI.esc(d.overview)}</p></div>` : ""}

    ${(d.budget || d.revenue) ? `<div class="content-card"><h2>Box Office</h2>
      <div class="bo-verdict-card"><div class="bo-nums">
        ${d.budget ? `<div><span>Budget</span><b>${UI.fmtMoney(d.budget)}</b></div>` : ""}
        ${d.revenue ? `<div><span>Worldwide Gross</span><b>${UI.fmtMoney(d.revenue)}</b></div>` : ""}
        ${verdict ? `<div><span>Verdict</span><b>${UI.esc(verdict.label)}</b></div>` : ""}
      </div></div>
      <p class="prov-note">Budget and gross are reported figures; the verdict is an estimate from budget vs gross, not an official declaration.</p></div>` : ""}

    ${factRows.length ? `<div class="content-card"><h2>Movie Facts</h2>
      <dl class="facts-table">${factRows.map(([k, v]) => `<div class="fact-row"><dt>${UI.esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl></div>` : ""}

    ${trailerKey ? `<div class="content-card" id="official-trailer"><h2>Official Trailer</h2>
      <div class="video-embed"><iframe src="https://www.youtube.com/embed/${trailerKey}" title="Official trailer — ${UI.esc(title)}" loading="lazy" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div>
      <p class="prov-note">Official trailer via YouTube.</p></div>` : ""}

    ${castTop.length ? `<div class="content-card"><h2>Top Cast</h2>
      <div class="cast-grid">${castTop.map(c => UI.personCard(c, c.character || "")).join("")}</div>
      ${castRest.length ? `<div class="cast-grid more-wrap" id="castMore">${castRest.map(c => UI.personCard(c, c.character || "")).join("")}</div>
      <button type="button" class="btn more-btn" data-target="castMore" data-more="Show More Cast" data-less="Show Less" onclick="UI.toggleMore(this)">Show More Cast</button>` : ""}
      <p class="prov-note">Full credited cast with photos and filmographies on each person's FlickAtlas profile.</p></div>` : ""}

    ${daywiseHtml}

    ${provLines.length ? `<div class="content-card"><h2>Where to Watch</h2>
      <dl class="facts-table">${provLines.map(([region, text]) => `<div class="fact-row"><dt>${UI.esc(region)}</dt><dd>${UI.esc(text)}</dd></div>`).join("")}</dl>
      <p class="prov-note">Availability names only — listings change by region and over time.</p></div>` : ""}

    ${similar.length ? `<section class="section"><div class="section-head"><h2>Similar Movies</h2></div>
      <div class="grid">${similar.map(x => UI.posterCard(x, "movie", UI.industryTag(x))).join("")}</div></section>` : ""}
  </div>`;

    UI.setSEO({
      title: `${title}${year ? ` (${year})` : ""} — Cast, Story, Budget & Box Office | FlickAtlas`,
      desc: (d.overview || `${title} — cast, story, budget and box office on FlickAtlas.`).slice(0, 160),
      path: `/movie?id=${encodeURIComponent(id)}`,
      type: "video.movie",
      image: poster || "",
      jsonld: {
        "@context": "https://schema.org", "@type": "Movie",
        "name": title,
        "url": `https://flickatlas.vercel.app/movie?id=${encodeURIComponent(id)}`,
        ...(d.release_date ? { "datePublished": d.release_date } : {}),
        ...(d.overview ? { "description": d.overview.slice(0, 300) } : {}),
        ...(poster ? { "image": poster } : {}),
        ...(rating ? { "aggregateRating": { "@type": "AggregateRating", "ratingValue": String(UI.rating(d)), "bestRating": "10", "ratingCount": String(d.vote_count || "") } } : {}),
        ...(directors.length ? { "director": directors.map(p => ({ "@type": "Person", "name": p.name })) } : {}),
        ...(castTop.length ? { "actor": castTop.slice(0, 5).map(p => ({ "@type": "Person", "name": p.name })) } : {}),
      }
    });
  } catch (e) {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("Could not load this movie. Please try again.")}</div>`;
  }
})();
