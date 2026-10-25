/* FlickAtlas — Industry category page (?cat=bollywood|hollywood|lollywood|kdrama):
   movies + TV shows for one industry, newest/popular first. Created
   2026-10-25: the page shipped referencing this script but the file was
   never committed, so every /category page stayed on "Loading FlickAtlas…".
   Follows the page-movies.js / page-tv.js pattern (same TMDB pools,
   same indOf classification, same poster cards). */
(async function () {
  const CATS = {
    bollywood: { label: "Bollywood", desc: "Hindi cinema — the biggest stars, openings and collections." },
    hollywood: { label: "Hollywood", desc: "Hollywood and international English-language films and series." },
    lollywood: { label: "Lollywood", desc: "The latest Pakistani films and dramas, newest first." },
    kdrama: { label: "K-Drama", desc: "Korean drama and film, with cast and episode guides." },
  };
  let cat = UI.getParam("cat", "bollywood");
  if (!CATS[cat]) cat = "bollywood";
  const info = CATS[cat];

  UI.mountChrome("/category");
  const main = document.getElementById("app");
  UI.setSEO({
    title: `${info.label} Movies & Shows — Cast, Box Office & Release Dates | FlickAtlas`,
    desc: `Browse ${info.label} movies and shows on FlickAtlas. ${info.desc}`,
    path: `/category?cat=${cat}`
  });

  const TYPE_FILTERS = [["all", "All"], ["movie", "Movies"], ["tv", "TV Shows"]];
  let t = UI.getParam("t", "all");
  if (!TYPE_FILTERS.some(([k]) => k === t)) t = "all";

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>${UI.esc(info.label)}</h1>
      <p>${UI.esc(info.desc)}</p></div>
    <div id="chipHost">${UI.chipRow(TYPE_FILTERS, t)}</div>
    <p class="fcount" id="fcount" aria-live="polite">Loading titles…</p>
    <div class="grid" id="grid">${UI.skelCards(12)}</div>
    <div id="emptyHost"></div>
  </div>`;
  const grid = main.querySelector("#grid");
  const fcount = main.querySelector("#fcount");
  const emptyHost = main.querySelector("#emptyHost");

  const indOf = x => {
    const countries = x.origin_country || x.production_countries?.map(c => c.iso_3166_1) || [];
    if (x.original_language === "hi" && countries.includes("IN")) return "bollywood";
    if (countries.includes("PK")) return "lollywood";
    if (x.original_language === "ko" && countries.includes("KR")) return "kdrama";
    if (x.original_language === "en" && countries.includes("US")) return "hollywood";
    return "international";
  };

  let pool = [];
  function render() {
    const items = pool.filter(x => {
      if (t === "movie" && x.media_type !== "movie") return false;
      if (t === "tv" && x.media_type !== "tv") return false;
      return true;
    });
    items.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    grid.innerHTML = items.map(x =>
      `<div class="fcell" data-fitem>${UI.posterCard(x, x.media_type, UI.industryTag(x))}</div>`).join("");
    const label = t === "movie" ? "movie" : t === "tv" ? "show" : "title";
    fcount.textContent = `${items.length} ${label}${items.length === 1 ? "" : "s"}`;
    emptyHost.innerHTML = items.length ? "" : UI.stateMsg(`No ${info.label} titles match this filter right now.`, false);
  }

  UI.wireChips(main.querySelector("#chipHost"), (key) => {
    t = key;
    UI.setParam("t", t === "all" ? "" : t);
    render();
  });
  window.addEventListener("popstate", () => {
    t = UI.getParam("t", "all");
    if (!TYPE_FILTERS.some(([k]) => k === t)) t = "all";
    render();
  });

  const INDUSTRY_PARAMS = {
    bollywood: { lang: "hi", country: "IN" },
    hollywood: { lang: "en", country: "US" },
    lollywood: { lang: null, country: "PK" },
    kdrama: { lang: "ko", country: "KR" },
  };
  const spec = INDUSTRY_PARAMS[cat];
  const movieParams = { ...(spec.lang ? { with_original_language: spec.lang } : {}), with_origin_country: spec.country };
  const tvParams = { ...(spec.lang ? { with_original_language: spec.lang } : {}), with_origin_country: spec.country };

  try {
    const cutoff = UI.freshCutoff();
    const today = TMDB.today();
    const freshMovieWin = { "primary_release_date.gte": cutoff, "primary_release_date.lte": today, sort_by: "popularity.desc" };
    const freshTvWin = { "first_air_date.gte": cutoff, "first_air_date.lte": today, sort_by: "popularity.desc" };
    const [mDisc, tDisc, mPop, tPop, mTop, tTop] = await Promise.all([
      TMDB.discoverResults("movie", { ...movieParams, ...freshMovieWin }),
      TMDB.discoverResults("tv", { ...tvParams, ...freshTvWin }),
      TMDB.popular("movie", 1).then(d => d.results || []).catch(() => []),
      TMDB.popular("tv", 1).then(d => d.results || []).catch(() => []),
      TMDB.topRated("movie", 1).then(d => d.results || []).catch(() => []),
      TMDB.topRated("tv", 1).then(d => d.results || []).catch(() => []),
    ]);
    const seen = new Map();
    const add = (arr, type) => (arr || []).forEach(x => {
      if (!x || !x.poster_path || seen.has(type + x.id)) return;
      x.media_type = type;
      seen.set(type + x.id, x);
    });
    add(mDisc, "movie"); add(tDisc, "tv");
    add(mPop, "movie"); add(tPop, "tv");
    add(mTop, "movie"); add(tTop, "tv");
    const inCategory = [...seen.values()].filter(x => indOf(x) === cat);
    /* Freshness first (site rule: nothing older than 3 months on listings);
       fall back to the full category pool so the page is never empty
       when TMDB has titles for this industry. */
    const fresh = inCategory.filter(UI.isFresh);
    pool = fresh.length ? fresh : inCategory;
    render();
  } catch (e) {
    fcount.textContent = `${info.label} titles could not be loaded.`;
    grid.innerHTML = UI.stateMsg("Could not load titles. Please try again.");
  }
})();
