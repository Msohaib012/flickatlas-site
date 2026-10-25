/* FlickAtlas — TV show detail page (?id=<tmdb tv id>): hero with poster
   and key facts, story, seasons table, top cast, creators & crew,
   official trailer, where-to-watch (text only), facts, keywords and
   similar shows. Created 2026-10-25: the page shipped referencing this
   script but the file was never committed (0 commits in repo history),
   so every /show page stayed on "Loading FlickAtlas…". Follows the
   page-news-item.js detail pattern (mountChrome, setSEO, try/catch with
   stateMsg fallback) and the site's detail-page CSS classes. */
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

  try {
    const d = await TMDB.details("tv", id);
    if (!d || !d.name) throw new Error("TMDB_HTTP_404");
    const name = UI.titleOf(d);
    const year = UI.yearOf(d);
    const rating = UI.ratingText(d);
    const genres = (d.genres || []).map(g => g.name).filter(Boolean);
    const poster = UI.img(d.poster_path, "w342");
    const backdrop = UI.img(d.backdrop_path, "w1280");
    const firstAir = d.first_air_date || "";
    const lastAir = d.last_air_date || "";
    const seasons = (d.seasons || []).filter(s => s && (s.episode_count > 0 || s.season_number === 0));
    const cast = ((d.credits && d.credits.cast) || []).slice(0, 12);
    const crew = (d.credits && d.credits.crew) || [];
    const creators = (d.created_by || []).filter(c => c && c.name);
    const contentRating = ((d.content_ratings && d.content_ratings.results) || [])
      .find(r => r && r.iso_3166_1 === "US");
    const channel = (typeof window !== "undefined" && window.PK && typeof window.PK.channelOf === "function")
      ? window.PK.channelOf(d) : "";
    const runtime = (d.episode_run_time && d.episode_run_time[0]) ? UI.fmtRuntime(d.episode_run_time[0]) : "";
    const networks = (d.networks || []).map(n => n.name).filter(Boolean);
    const companies = (d.production_companies || []).map(c => c.name).filter(Boolean);
    const keywords = ((d.keywords && d.keywords.results) || []).map(k => k.name).filter(Boolean).slice(0, 12);
    const similar = ((d.similar && d.similar.results) || []).filter(x => x && x.poster_path).slice(0, 12);
    const providers = UI.providerLines(d["watch/providers"] || null);

    /* Official trailer: the verified official YouTube Trailer if one is
       listed, otherwise any YouTube Trailer. Embedded, no autoplay. */
    let trailer = null;
    if (typeof window !== "undefined" && window.OfficialTrailers && typeof window.OfficialTrailers.verified === "function") {
      trailer = window.OfficialTrailers.verified(d);
    }
    if (!trailer) {
      const vids = ((d.videos && d.videos.results) || []);
      trailer = vids.find(v => v && v.site === "YouTube" && v.type === "Trailer" && /^[A-Za-z0-9_-]{11}$/.test(v.key || "")) || null;
    }

    const heroFacts = [];
    if (rating) heroFacts.push(["Rating", `${rating}${d.vote_count ? ` (${d.vote_count.toLocaleString("en-US")} votes)` : ""}`]);
    if (firstAir) heroFacts.push(["First Aired", UI.fmtDate(firstAir)]);
    if (lastAir) heroFacts.push(["Last Aired", UI.fmtDate(lastAir)]);
    if (d.status) heroFacts.push(["Status", d.status]);
    if (d.number_of_seasons) heroFacts.push(["Seasons", String(d.number_of_seasons)]);
    if (d.number_of_episodes) heroFacts.push(["Episodes", String(d.number_of_episodes)]);
    if (channel) heroFacts.push(["Channel", channel]);
    if (contentRating && contentRating.rating) heroFacts.push(["Content Rating", contentRating.rating]);

    /* Crew groups: creators first, then key crew jobs (deduped, capped). */
    const crewGroups = [];
    if (creators.length) crewGroups.push(["Created by", creators.map(c => ({ id: c.id, name: c.name, job: "Creator" }))]);
    const seenCrew = new Set();
    for (const job of ["Director", "Writer", "Executive Producer", "Producer"]) {
      const list = crew.filter(c => c && c.job === job && c.name && !seenCrew.has(c.id))
        .slice(0, 6).map(c => ({ id: c.id, name: c.name, job: c.department || job }));
      list.forEach(c => seenCrew.add(c.id));
      if (list.length) crewGroups.push([job === "Director" ? "Directors" : job === "Writer" ? "Writers" : job === "Executive Producer" ? "Executive Producers" : "Producers", list]);
    }

    const factRows = [];
    if (firstAir) factRows.push(["First Aired", UI.fmtDate(firstAir)]);
    if (lastAir) factRows.push(["Last Aired", UI.fmtDate(lastAir)]);
    if (d.status) factRows.push(["Status", d.status]);
    if (d.number_of_seasons) factRows.push(["Seasons", String(d.number_of_seasons)]);
    if (d.number_of_episodes) factRows.push(["Episodes", String(d.number_of_episodes)]);
    if (runtime) factRows.push(["Episode Runtime", runtime]);
    if (d.original_language) factRows.push(["Original Language", langName(d.original_language)]);
    if (d.origin_country && d.origin_country.length) factRows.push(["Country", d.origin_country.join(", ")]);
    if (networks.length) factRows.push(["Network", networks.join(", ")]);
    if (companies.length) factRows.push(["Production", companies.join(", ")]);
    if (channel) factRows.push(["Channel", channel]);
    if (d.type) factRows.push(["Type", d.type]);
    if (contentRating && contentRating.rating) factRows.push(["Content Rating", contentRating.rating]);

    main.innerHTML = `<div class="wrap">
    <p class="article-crumb"><a href="/tv">← TV &amp; Web Series</a></p>
    <div class="detail-hero">
      ${backdrop ? `<div class="hero-bg"><img src="${backdrop}" alt="" loading="lazy" onerror="this.remove()"></div><div class="hero-shade"></div>` : ""}
      <div class="detail-in">
        <div class="detail-poster">${poster ? `<img src="${poster}" alt="${UI.esc(name)} poster" loading="lazy" onerror="this.remove()">` : ""}</div>
        <div class="detail-main">
          <h1>${UI.esc(name)}${year ? ` (${year})` : ""}</h1>
          ${d.tagline ? `<p class="detail-sub">${UI.esc(d.tagline)}</p>` : ""}
          ${d.overview ? `<p style="color:#D8EDE8;margin-top:12px;max-width:62ch">${UI.esc(d.overview)}</p>` : ""}
          ${genres.length ? `<div class="kw-chips" style="margin-top:14px">${genres.map(g => {
            const gid = (d.genres || []).find(x => x.name === g);
            return gid ? `<a class="kw-chip" href="/tv?g=${gid.id}">${UI.esc(g)}</a>` : `<span class="kw-chip">${UI.esc(g)}</span>`;
          }).join("")}</div>` : ""}
          ${heroFacts.length ? `<div class="detail-facts">${heroFacts.map(([k, v]) => `<div><span>${UI.esc(k)}</span><b>${UI.esc(v)}</b></div>`).join("")}</div>` : ""}
        </div>
      </div>
    </div>

    ${d.overview ? `<div class="content-card"><h2>Story</h2><p class="article-summary">${UI.esc(d.overview)}</p></div>` : ""}

    ${seasons.length ? `<div class="content-card"><h2>Seasons</h2>
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Season</th><th>Name</th><th>Episodes</th><th>First Aired</th></tr></thead>
        <tbody>${seasons.map(s => `<tr>
          <td><b>${s.season_number === 0 ? "Specials" : `Season ${s.season_number}`}</b></td>
          <td>${UI.esc(s.name || "—")}</td>
          <td>${s.episode_count != null ? s.episode_count : "—"}</td>
          <td>${s.air_date ? UI.fmtDate(s.air_date) : "—"}</td>
        </tr>`).join("")}</tbody></table></div></div>` : ""}

    ${cast.length ? `<div class="content-card"><h2>Top Cast</h2>
      <div class="cast-grid">${cast.map(c => UI.personCard(c, c.character || "")).join("")}</div></div>` : ""}

    ${crewGroups.length ? `<div class="content-card"><h2>Creators &amp; Crew</h2>
      <div class="crew-groups">${crewGroups.map(([label, people]) => `<div class="crew-group"><h4>${UI.esc(label)}</h4>
        <ul>${people.map(p => `<li><a href="/person?id=${p.id}">${UI.esc(p.name)}</a><span class="crew-job">${UI.esc(p.job || "")}</span></li>`).join("")}</ul></div>`).join("")}</div></div>` : ""}

    ${trailer ? `<div class="content-card"><h2>Official Trailer</h2>
      <div class="video-embed"><iframe src="https://www.youtube-nocookie.com/embed/${trailer.key}" title="Official trailer: ${UI.esc(name)}" loading="lazy" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div></div>` : ""}

    ${providers.length ? `<div class="content-card"><h2>Where to Watch</h2>
      ${providers.map(([label, text]) => `<div class="prov-line"><b>${UI.esc(label)}</b><span>${UI.esc(text)}</span></div>`).join("")}
      <p class="prov-note">Availability varies by region and can change — check the platform for the latest catalogue.</p></div>` : ""}

    ${factRows.length ? `<div class="content-card"><h2>Show Details</h2>
      <dl class="facts-table">${factRows.map(([k, v]) => `<div class="fact-row"><dt>${UI.esc(k)}</dt><dd>${UI.esc(v)}</dd></div>`).join("")}</dl></div>` : ""}

    ${keywords.length ? `<div class="content-card"><h2>Keywords</h2>
      <div class="kw-chips">${keywords.map(k => `<a class="kw-chip" href="/search?q=${encodeURIComponent(k)}">${UI.esc(k)}</a>`).join("")}</div></div>` : ""}

    ${similar.length ? `<section class="section"><div class="section-head"><h2>Similar Shows</h2></div>
      <div class="grid">${similar.map(x => UI.posterCard(x, "tv", UI.industryTag(x))).join("")}</div>
      <p class="img-credit">Images: TMDB</p></section>` : ""}
  </div>`;

    UI.setSEO({
      title: `${name}${year ? ` (${year})` : ""} — Seasons, Cast & Story | FlickAtlas`,
      desc: (d.overview || `${name} — seasons, cast, crew and story on FlickAtlas.`).slice(0, 160),
      path: `/show?id=${encodeURIComponent(id)}`,
      type: "video.tv_show",
      image: backdrop || poster || "",
      jsonld: {
        "@context": "https://schema.org",
        "@type": "TVSeries",
        "name": name,
        "url": CONFIG.BASE + `/show?id=${encodeURIComponent(id)}`,
        ...(d.overview ? { "description": d.overview.slice(0, 300) } : {}),
        ...(firstAir ? { "datePublished": firstAir } : {}),
        ...(genres.length ? { "genre": genres } : {}),
        ...(d.number_of_seasons ? { "numberOfSeasons": d.number_of_seasons } : {}),
        ...(d.number_of_episodes ? { "numberOfEpisodes": d.number_of_episodes } : {}),
        ...(d.vote_average ? { "aggregateRating": { "@type": "AggregateRating", "ratingValue": Math.round(d.vote_average * 10) / 10, "bestRating": 10, "ratingCount": d.vote_count || 1 } } : {}),
      }
    });

    try { UI.mountTopSearches(main, [name]); } catch (_) {}
  } catch (e) {
    const is404 = /404/.test(String((e && e.message) || e || ""));
    main.innerHTML = `<div class="wrap">${is404
      ? UI.stateMsg("Show not found.", false)
      : UI.stateMsg("Could not load this show. Please try again.")}</div>`;
    if (is404) UI.setSEO({ title: "Show not found | FlickAtlas", desc: "This show could not be found on FlickAtlas.", path: "/show", noindex: true });
  }
})();
