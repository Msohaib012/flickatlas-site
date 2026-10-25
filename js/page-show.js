/* FlickAtlas — TV show detail page (?id=<tmdb tv id>): published
   titles only. Rewritten 2026-10-25 (published-only rebuild, §4);
   rich detail fields added in consolidation (spec §1a): seasons table,
   genres, creators, episode runtime, tagline, certification and spoken
   languages all render FROM THE BAKED-IN published entry — never a
   live TMDB.details call. The id is looked
   the id is looked up in window.FA_PUBLISHED; hero/story/facts/
   trailer/day-wise/similar all render from the baked-in published
   entry. Cast comes from the TMDB credits endpoint for this one
   title only (a single-title record, not a catalogue). A title that
   isn't published renders a plain state — the page NEVER fetches the
   title live from TMDB to fill itself. No watch/download buttons, no
   external links except the YouTube trailer embed. */
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
    title: "TV Show Details — Seasons, Cast & Story | FlickAtlas",
    desc: "Full TV show details on FlickAtlas: seasons and episode counts, cast & crew, story, ratings and frequently asked questions.",
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
     first, then same type, newest first, one item (slice(0,1)). */
  const similarPublished = (pub) => {
    const cands = Object.values(window.FA_PUBLISHED || {})
      .filter(x => x && x.id != null && String(x.id) !== String(pub.id));
    cands.sort((a, b) =>
      ((b.industry === pub.industry) - (a.industry === pub.industry)) ||
      ((b.type === pub.type) - (a.type === pub.type)) ||
      String(b.published_at || "").localeCompare(String(a.published_at || "")) ||
      titleDate(b).localeCompare(titleDate(a)));
    return cands.slice(0, 1);
  };

  /* --- Published lookup: nothing renders unless this title was chosen
     and published. No live TMDB fetch fills this page. --- */
  const pub = (window.FA_PUBLISHED || {})[String(id)] || null;
  if (!pub || pub.type !== "tv") {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("This title hasn't been published on FlickAtlas yet.", false)}
      <p style="text-align:center"><a class="btn btn-teal" href="/tv">Browse TV Shows</a></p></div>`;
    UI.setSEO({ title: "Title Not Published | FlickAtlas", desc: "This show hasn't been published on FlickAtlas yet. Browse published TV shows instead.", path: "/show", noindex: true });
    return;
  }

  try {
    const name = UI.titleOf(pub);
    const year = UI.yearOf(pub);
    const rating = UI.ratingText(pub);
    const poster = UI.img(pub.poster_path, "w342");
    const backdrop = UI.img(pub.backdrop_path, "w1280");
    const firstAir = pub.first_air_date || "";
    const channel = pub.channel || "";
    const networks = (pub.networks || []).map(n => String(n)).filter(Boolean);
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
    const cast = ((credits && credits.cast) || []).filter(c => c && c.name).slice(0, 12);
    const crew = ((credits && credits.crew) || []).filter(c => c && c.name);

    /* Official trailer: baked into the published entry (official
       YouTube trailer only). Absent when none exists — no section. */
    const trailerKey = pub.trailer && /^[A-Za-z0-9_-]{11}$/.test(pub.trailer.key || "") ? pub.trailer.key : "";
    const trailerName = pub.trailer && pub.trailer.name ? pub.trailer.name : "";

    const rows = (window.FA_DAYWISE || {})[String(id)] || null;
    const daywiseHtml = rows && rows.length ? UI.daywiseCard(rows, name, { titleId: id }) : "";

    const similar = similarPublished(pub);

    const heroFacts = [];
    if (rating) heroFacts.push(["Rating", `${rating}${pub.vote_count ? ` (${pub.vote_count.toLocaleString("en-US")} votes)` : ""}`]);
    if (firstAir) heroFacts.push(["First Aired", UI.fmtDate(firstAir)]);
    if (pub.status) heroFacts.push(["Status", pub.status]);
    if (runtime) heroFacts.push(["Episode Runtime", runtime]);
    if (pub.number_of_seasons) heroFacts.push(["Seasons", String(pub.number_of_seasons)]);
    if (pub.number_of_episodes) heroFacts.push(["Episodes", String(pub.number_of_episodes)]);
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
    if (pub.number_of_seasons) factRows.push(["Seasons", String(pub.number_of_seasons)]);
    if (pub.number_of_episodes) factRows.push(["Episodes", String(pub.number_of_episodes)]);
    if (runtime) factRows.push(["Episode Runtime", runtime]);
    if (genres.length) factRows.push(["Genres", genres.join(", ")]);
    if (pub.original_language) factRows.push(["Original Language", langName(pub.original_language)]);
    if (spoken.length) factRows.push(["Spoken Languages", spoken.join(", ")]);
    if (pub.certification) factRows.push(["Certification", pub.certification]);
    if (countryNames(pub.origin_country || []).length) factRows.push(["Country", countryNames(pub.origin_country).join(", ")]);
    if (networks.length) factRows.push(["Network", networks.join(", ")]);
    if (channel) factRows.push(["Channel", channel]);
    if (tag) factRows.push(["Industry", tag]);

    main.innerHTML = `<div class="wrap">
    <p class="article-crumb"><a href="/tv">← TV &amp; Web Series</a></p>
    <div class="detail-hero">
      ${backdrop ? `<div class="hero-bg"><img src="${backdrop}" alt="" loading="lazy" onerror="this.remove()"></div><div class="hero-shade"></div>` : ""}
      <div class="detail-in">
        <div class="detail-poster">${poster ? `<img src="${poster}" alt="${UI.esc(name)} poster" loading="lazy" onerror="this.remove()">` : ""}</div>
        <div class="detail-main">
          <h1>${UI.esc(name)}${year ? ` (${year})` : ""}</h1>
          ${pub.tagline ? `<p class="detail-sub">${UI.esc(pub.tagline)}</p>` : ""}
          ${pub.overview ? `<p style="color:#D8EDE8;margin-top:12px;max-width:62ch">${UI.esc(pub.overview)}</p>` : ""}
          ${heroFacts.length ? `<div class="detail-facts">${heroFacts.map(([k, v]) => `<div><span>${UI.esc(k)}</span><b>${UI.esc(v)}</b></div>`).join("")}</div>` : ""}
        </div>
      </div>
    </div>

    ${pub.overview ? `<div class="content-card"><h2>Story</h2><p class="article-summary">${UI.esc(pub.overview)}</p></div>` : ""}

    ${seasons.length ? `<div class="content-card"><h2>Seasons</h2>
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Season</th><th>Name</th><th>Episodes</th><th>First Aired</th></tr></thead>
        <tbody>${seasons.map(s2 => `<tr>
          <td><b>${s2.season_number === 0 ? "Specials" : `Season ${s2.season_number}`}</b></td>
          <td>${UI.esc(s2.name || "—")}</td>
          <td>${s2.episode_count != null ? s2.episode_count : "—"}</td>
          <td>${s2.air_date ? UI.fmtDate(s2.air_date) : "—"}</td>
        </tr>`).join("")}</tbody></table></div></div>` : ""}

    ${cast.length ? `<div class="content-card"><h2>Top Cast</h2>
      <div class="cast-grid">${cast.map(c => UI.personCard(c, c.character || "")).join("")}</div></div>` : ""}

    ${(createdBy.length || crewGroups.length) ? `<div class="content-card"><h2>Creators &amp; Crew</h2>
      <div class="crew-groups">${createdBy.length ? `<div class="crew-group"><h4>Created by</h4>
        <ul>${createdBy.map(n => `<li>${UI.esc(n)}</li>`).join("")}</ul></div>` : ""}${crewGroups.map(([label, people]) => `<div class="crew-group"><h4>${UI.esc(label)}</h4>
        <ul>${people.map(p => `<li><a href="/person?id=${p.id}">${UI.esc(p.name)}</a><span class="crew-job">${UI.esc(p.job || "")}</span></li>`).join("")}</ul></div>`).join("")}</div></div>` : ""}

    ${trailerKey ? `<div class="content-card"><h2>Official Trailer</h2>
      <div class="video-embed"><iframe src="https://www.youtube-nocookie.com/embed/${trailerKey}" title="Official trailer: ${UI.esc(trailerName || name)}" loading="lazy" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div></div>` : ""}

    ${daywiseHtml}

    ${factRows.length ? `<div class="content-card"><h2>Show Details</h2>
      <dl class="facts-table">${factRows.map(([k, v]) => `<div class="fact-row"><dt>${UI.esc(k)}</dt><dd>${UI.esc(v)}</dd></div>`).join("")}</dl></div>` : ""}

    ${similar.length ? `<section class="section"><div class="section-head"><h2>Similar Shows</h2></div>
      <div class="grid">${similar.map(x => UI.posterCard(x, "tv", UI.industryTag(x))).join("")}</div>
      <p class="img-credit">Images: TMDB</p></section>` : ""}
  </div>`;

    UI.setSEO({
      title: `${name}${year ? ` (${year})` : ""} — Seasons, Cast & Story | FlickAtlas`,
      desc: (pub.overview || `${name} — seasons, cast, crew and story on FlickAtlas.`).slice(0, 160),
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
        ...(pub.number_of_seasons ? { "numberOfSeasons": pub.number_of_seasons } : {}),
        ...(pub.number_of_episodes ? { "numberOfEpisodes": pub.number_of_episodes } : {}),
        ...(pub.vote_average ? { "aggregateRating": { "@type": "AggregateRating", "ratingValue": Math.round(pub.vote_average * 10) / 10, "bestRating": 10, "ratingCount": pub.vote_count || 1 } } : {}),
      }
    });

    try { UI.mountTopSearches(main, [name]); } catch (_) {}
  } catch (e) {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("Could not load this show. Please try again.")}</div>`;
  }
})();
