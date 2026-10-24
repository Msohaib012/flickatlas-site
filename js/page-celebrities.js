/* FlickAtlas — Celebrities hub: people browse with §4 filter chips (All ·
   Bollywood · Hollywood · Pakistani · Korean · Actors · Actresses ·
   Directors) + a sampled Star Power comparison. */
(async function () {
  UI.mountChrome("/celebrities");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Celebrities — Actor Biographies, Photos & Filmographies | FlickAtlas",
    desc: "Meet popular movie and TV celebrities on FlickAtlas. Open a profile for biography, photos, known-for titles and the complete filmography.",
    path: "/celebrities"
  });

  const FILTERS = [["all", "All"], ["bollywood", "Bollywood"], ["hollywood", "Hollywood"],
    ["pakistani", "Pakistani"], ["korean", "Korean"], ["actors", "Actors"],
    ["actresses", "Actresses"], ["directors", "Directors"]];
  let f = UI.getParam("f", "all");
  if (!FILTERS.some(([k]) => k === f)) f = "all";

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Celebrities</h1>
      <p>Celebrity profiles with biographies, photos and screen credits.</p></div>
    <div id="bdayHost"></div>
    <div id="chipHost">${UI.chipRow(FILTERS, f)}</div>
    <p class="fcount" id="fcount"></p>
    <div class="people-grid" id="grid">${UI.skelCards(12)}</div>
    <div id="emptyHost"></div>
    <div id="spWrap"></div>
  </div>`;
  const grid = main.querySelector("#grid");
  const fcount = main.querySelector("#fcount");
  const emptyHost = main.querySelector("#emptyHost");
  const spWrap = main.querySelector("#spWrap");

  const INDUSTRIES = [
    { key: "bollywood", language: "hi", country: "IN" },
    { key: "hollywood", language: "en", country: "US" },
    { key: "pakistani", country: "PK" },
    { key: "korean", language: "ko", country: "KR" }
  ];
  const knownForDate = p => (p.known_for || []).map(c => c.release_date || c.first_air_date || "").filter(Boolean).sort().pop() || "";
  let pool = [];
  function render() {
    const items = pool.filter(p => {
      if (["bollywood", "hollywood", "pakistani", "korean"].includes(f)) return (p._inds || []).includes(f);
      if (f === "actors") return p.gender === 2 && p.known_for_department === "Acting";
      if (f === "actresses") return p.gender === 1 && p.known_for_department === "Acting";
      if (f === "directors") return p.known_for_department === "Directing";
      return true;
    });
    grid.innerHTML = items.map(p => `<div class="fcell" data-fitem>${UI.personCard(p, p.known_for_department || "")}</div>`).join("");
    fcount.textContent = items.length ? `${items.length} celebrit${items.length === 1 ? "y" : "ies"}` : "";
    emptyHost.innerHTML = items.length ? "" : UI.stateMsg("No celebrities match this filter in the current chart.", false);
  }
  UI.wireChips(main.querySelector("#chipHost"), k => { f = k; render(); });

  /* ---------- Star Power: an explicitly limited, sampled gross comparison ---------- */
  async function starPower(people) {
    const cache = new Map();
    const details = id => {
      if (!cache.has(id)) cache.set(id, TMDB.details("movie", id).catch(() => null));
      return cache.get(id);
    };
    const rows = [];
    for (const p of people.slice(0, 8)) {
      try {
        const cr = await TMDB.personCredits(p.id);
        const films = (cr.cast || []).filter(c => c.media_type === "movie" && (c.order === undefined || c.order <= 2))
          .sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 6);
        const det = (await Promise.all(films.map(x => details(x.id)))).filter(d => d && d.revenue > 0);
        if (!det.length) continue;
        det.sort((a, b) => b.revenue - a.revenue);
        const sample = det.slice(0, 5);
        rows.push({ p, total: sample.reduce((a, d) => a + d.revenue, 0), biggest: det[0], count: sample.length });
      } catch (e) {}
    }
    rows.sort((a, b) => b.total - a.total);
    if (!rows.length) return;
    spWrap.innerHTML = `<section class="section"><div class="section-head"><h2>Star Power — Sampled Film Gross</h2></div>
      <div class="content-card" style="margin:0"><div class="table-scroll"><table class="data">
      <thead><tr><th>#</th><th></th><th>Star</th><th>Combined Gross — Sampled Films</th><th>Highest-Grossing Sampled Film</th></tr></thead>
      <tbody>${rows.map((rw, i) => `<tr>
        <td class="rank">${i + 1}</td>
        <td><a href="/person?id=${rw.p.id}"><img class="sp-photo" src="${UI.img(rw.p.profile_path, "w185")}" alt="" loading="lazy" onerror="this.remove()"></a></td>
        <td><a href="/person?id=${rw.p.id}"><b>${UI.esc(rw.p.name)}</b></a></td>
        <td><b>${UI.fmtMoney(rw.total)}</b> <span class="muted">(${rw.count} available sampled films)</span></td>
        <td><a href="/movie?id=${rw.biggest.id}">${UI.esc(UI.titleOf(rw.biggest))}</a> (${UI.fmtMoney(rw.biggest.revenue)})</td></tr>`).join("")}
      </tbody></table></div>
      <p class="prov-note">A comparison of available reported grosses among a limited sample of popular people and sampled lead-role films. It is not a global or lifetime ranking; reported figures may be incomplete.</p></div></section>`;
  }

  /* Birthdays are drawn only from the current pool, and exclude deceased or future-dated records. */
  async function birthdaysToday(poolPeople) {
    const host = document.getElementById("bdayHost");
    if (!host) return;
    const today = TMDB.today(), md = today.slice(5), yearNow = Number(today.slice(0, 4));
    const found = [], queue = poolPeople.filter(p => p.profile_path);
    for (let i = 0; i < queue.length; i += 12) {
      const chunk = queue.slice(i, i + 12);
      const dets = await Promise.all(chunk.map(p => TMDB.person(p.id).catch(() => null)));
      dets.forEach((d, j) => {
        if (d && !d.deathday && d.birthday && d.birthday <= today && d.birthday.slice(5) === md)
          found.push({ p: chunk[j], born: d.birthday, age: yearNow - Number(d.birthday.slice(0, 4)) });
      });
      if (found.length >= 6) break;
    }
    if (!found.length) return;
    host.innerHTML = `<section class="section" style="margin-top:22px">
      <div class="section-head"><h2>Celebrity Birthdays Today</h2></div>
      <div class="people-row">${found.map(({ p, born, age }) => UI.personCard(p, `Turns ${age} today · Born ${UI.fmtDate(born)}`)).join("")}</div>
    </section>`;
  }

  /* Recent, industry-specific discover results provide verified title-credit membership.
     Discover at most one recent movie and one recent TV title per industry (8 total); details/credits use a small worker pool. */
  async function recentTitleCandidates() {
    const today = TMDB.today(), cutoff = UI.freshCutoff();
    const requests = INDUSTRIES.flatMap(ind => ["movie", "tv"].map(type => {
      const params = { sort_by: type === "movie" ? "primary_release_date.desc" : "first_air_date.desc",
        "vote_count.gte": 1, page: 1 };
      if (ind.language) params.with_original_language = ind.language;
      if (ind.country) params.with_origin_country = ind.country;
      params[type === "movie" ? "primary_release_date.gte" : "first_air_date.gte"] = cutoff;
      params[type === "movie" ? "primary_release_date.lte" : "first_air_date.lte"] = today;
      return TMDB.discoverResults(type, params).catch(() => []).then(results => ({ ind, type, results }));
    }));
    const groups = await Promise.all(requests), titles = [];
    for (const g of groups) {
      const candidate = g.results.find(t => {
        const date = g.type === "movie" ? t.release_date : t.first_air_date;
        return date && date >= cutoff && date <= today && t.id;
      });
      if (candidate) titles.push({ ...candidate, media_type: g.type, _industry: g.ind.key });
    }
    return titles.slice(0, 8);
  }
  async function mapWorkers(items, limit, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) { const i = next++; await fn(items[i]); }
    }));
  }

  try {
    const pages = await Promise.all([1, 2, 3, 4].map(p => TMDB.popularPeople(p).then(d => d.results || []).catch(() => [])));
    const cutoff = UI.freshCutoff();
    const popular = pages.flat().filter((p, i, a) => a.findIndex(x => x.id === p.id) === i)
      .filter(p => knownForDate(p) >= cutoff).map(p => ({ ...p, _inds: [] }));
    const byId = new Map(popular.map(p => [p.id, p]));
    const titles = await recentTitleCandidates();
    await mapWorkers(titles, 5, async title => {
      try {
        const d = await TMDB.details(title.media_type, title.id);
        const credits = d && d.credits;
        if (!credits) return;
        const credited = [...(credits.cast || []), ...(credits.crew || [])];
        credited.forEach(person => {
          if (!person.id || !person.name) return;
          let p = byId.get(person.id);
          if (!p) {
            p = { ...person, profile_path: person.profile_path || null, known_for_department: person.known_for_department || (person.job ? "Directing" : "Acting"), _inds: [] };
            byId.set(p.id, p);
          }
          if (!p._inds.includes(title._industry)) p._inds.push(title._industry);
          if (person.job === "Director") p.known_for_department = "Directing";
        });
      } catch (e) {}
    });
    pool = [...byId.values()];
    render();
    starPower(pool);
    birthdaysToday(pool.slice(0, 60));
  } catch (e) {
    grid.innerHTML = UI.stateMsg("Could not load celebrities. Please try again.");
  }
})();
