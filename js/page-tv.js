/* FlickAtlas — TV & Web Series hub with §4 filter chips: All (mixed) ·
   Bollywood · Hollywood · Lollywood · K-Drama · This Year · Top Rated +
   a Genre select. Chips are ?f= URL-param filters over the loaded pool. */
(async function () {
  UI.mountChrome("/tv");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "TV Shows — Popular Series, Seasons, Cast & Episode Info | FlickAtlas",
    desc: "Browse popular and top rated TV shows on FlickAtlas. Open any series for its seasons, episode counts, full cast, story and ratings.",
    path: "/tv"
  });

  const FILTERS = [["all", "All"], ["bollywood", "Bollywood"], ["hollywood", "Hollywood"],
    ["lollywood", "Lollywood"], ["kdrama", "K-Drama"], ["year", "This Year"], ["top", "Top Rated"]];
  let f = UI.getParam("f", "all");
  if (!FILTERS.some(([k]) => k === f)) f = "all";
  let g = UI.getParam("g", "");

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>TV Shows</h1>
      <p>Filter TV series by genre; open a show for cast and episode details.</p></div>
    <div id="chipHost">${UI.chipRow(FILTERS, f)}
      <div class="listing-select-row listing-select-row--single"><label class="filter-select"><span>Genre</span><select class="fsel" id="genreSel" aria-label="Filter by genre"><option value="">All Genres</option></select></label></div></div>
    <p class="fcount" id="fcount" aria-live="polite">Loading shows…</p>
    <div class="grid" id="grid">${UI.skelCards(12)}</div>
    <div id="emptyHost"></div>
  </div>`;
  const grid = main.querySelector("#grid");
  const fcount = main.querySelector("#fcount");
  const emptyHost = main.querySelector("#emptyHost");
  const genreSel = main.querySelector("#genreSel");
  if (g) genreSel.value = g;

  const indOf = x => {
    const countries = x.origin_country || [];
    if (x.original_language === "hi" && countries.includes("IN")) return "bollywood";
    if (countries.includes("PK")) return "lollywood";
    if (x.original_language === "ko" && countries.includes("KR")) return "kdrama";
    if (x.original_language === "en" && countries.includes("US")) return "hollywood";
    return "international";
  };

  let pool = [];
  function render() {
    const year = String(new Date().getFullYear());
    const items = pool.filter(x => {
      if (["bollywood", "hollywood", "lollywood", "kdrama"].includes(f) && x._ind !== f) return false;
      if (f === "year" && (x.first_air_date || "").slice(0, 4) !== year) return false;
      if (f === "top" && !((x.vote_average || 0) >= 7.5 && (x.vote_count || 0) >= 200)) return false;
      if (g && !(x.genre_ids || []).includes(Number(g))) return false;
      return true;
    });
    items.sort((a, b) => f === "top"
      ? (b.vote_average || 0) - (a.vote_average || 0)
      : (b.popularity || 0) - (a.popularity || 0));
    grid.innerHTML = items.map(x =>
      `<div class="fcell" data-fitem>${UI.posterCard(x, "tv", UI.industryTag(x))}</div>`).join("");
    fcount.textContent = `${items.length} show${items.length === 1 ? "" : "s"}`;
    emptyHost.innerHTML = items.length ? "" : UI.stateMsg("No shows match this filter right now.", false);
  }

  UI.wireChips(main.querySelector("#chipHost"), (key) => { f = key; render(); });
  genreSel.addEventListener("change", () => {
    g = genreSel.value;
    UI.setParam("g", g);
    render();
  });
  /* Genre is independent of the category chips; browser history restores both. */
  window.addEventListener("popstate", () => {
    g = UI.getParam("g", "");
    genreSel.value = g;
    render();
  });

  try {
    const cutoff = UI.freshCutoff();
    const today = TMDB.today();
    const futureDate = new Date(`${today}T00:00:00Z`); futureDate.setUTCDate(futureDate.getUTCDate() + 60);
    const horizon = futureDate.toISOString().slice(0, 10);
    const currentWin = { "first_air_date.gte": cutoff, "first_air_date.lte": today, sort_by: "popularity.desc" };
    const futureWin = { "first_air_date.gte": today, "first_air_date.lte": horizon, sort_by: "popularity.desc" };
    const [pop1, pop2, top, hi, pk, ko, us, recent, future, genres] = await Promise.all([
      TMDB.popular("tv", 1), TMDB.popular("tv", 2), TMDB.topRated("tv", 1),
      TMDB.discoverResults("tv", { with_original_language: "hi", with_origin_country: "IN", ...currentWin }),
      TMDB.discoverResults("tv", { with_origin_country: "PK", ...currentWin }),
      TMDB.discoverResults("tv", { with_original_language: "ko", with_origin_country: "KR", ...currentWin }),
      TMDB.discoverResults("tv", { with_original_language: "en", with_origin_country: "US", ...currentWin }),
      TMDB.discoverResults("tv", { ...currentWin, page: 1 }),
      TMDB.discoverResults("tv", { ...futureWin, page: 1 }),
      TMDB.api("/genre/tv/list").catch(() => ({ genres: [] })),
    ]);
    const seen = new Map();
    const add = (arr, marker = "") => (arr || []).forEach(x => {
      if (!x.poster_path) return;
      if (!seen.has(x.id)) { x._countryQuery = marker; seen.set(x.id, x); }
      else if (marker) seen.get(x.id)._countryQuery = marker;
    });
    add(hi, "IN"); add(pk, "PK"); add(ko, "KR"); add(us, "US");
    add(recent); add(future); add(pop1.results); add(pop2.results); add(top.results);
    const balanced = new Map();
    const groups = [hi, pk, ko, us, future, pop1.results || [], pop2.results || [], recent];
    for (let i = 0; i < 20 && balanced.size < 64; i++) {
      for (const group of groups) {
        const row = group[i];
        if (row && seen.has(row.id)) balanced.set(row.id, seen.get(row.id));
        if (balanced.size >= 64) break;
      }
    }
    const candidates = [...balanced.values()];
    let cursor = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (cursor < candidates.length) {
        const x = candidates[cursor++];
        try {
          const detail = await TMDB.details("tv", x.id);
          x.last_episode_to_air = detail.last_episode_to_air || null;
          x.origin_country = detail.origin_country || x.origin_country;
          x.original_language = detail.original_language || x.original_language;
        } catch (_) { x._detailFailed = true; }
        const verified = indOf(x);
        x._ind = verified !== "international" ? verified : ({ IN: "bollywood", PK: "lollywood", KR: "kdrama", US: "hollywood" }[x._countryQuery] || "international");
      }
    }));
    if (candidates.length && candidates.every(x => x._detailFailed)) throw new Error("TV detail requests failed");
    pool = candidates.filter(x => {
      if (x._detailFailed) return false;
      const last = x.last_episode_to_air?.air_date || "";
      const first = x.first_air_date || "";
      return (last >= cutoff && last <= today) || (first >= today && first <= horizon);
    });
    const present = new Set(pool.flatMap(x => x.genre_ids || []));
    (genres.genres || []).filter(gr => present.has(gr.id)).forEach(gr => {
      const o = document.createElement("option"); o.value = gr.id; o.textContent = gr.name; genreSel.appendChild(o);
    });
    if (g && !present.has(Number(g))) { g = ""; genreSel.value = ""; UI.setParam("g", ""); }
    if (g) genreSel.value = g;
    render();
  } catch (e) {
    fcount.textContent = "TV shows could not be loaded.";
    grid.innerHTML = UI.stateMsg("Could not load TV shows. Please try again.");
  }
})();
