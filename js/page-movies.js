/* FlickAtlas — Movies hub with .fa-select in-page dropdowns: Category
   (Bollywood · World Cinema · All · US Films · Lollywood · Top Rated),
   Year, Sort by, Genre and Type — never a native <select> popup.
   PUBLISHED-ONLY (2026-10-25 rebuild): every title comes from
   window.FA_PUBLISHED — TMDB is a data source, not a catalogue, so
   nothing is fetched live. K-Drama filter REMOVED (spec §6). Published
   entries carry a baked `industry` (bollywood | pakistani | world);
   "US Films" is the US-English slice of world, "Lollywood" is the
   Pakistani industry. Genres ARE baked into published entries (rich
   fields), so the genre select is populated from the pool.
   TRENDING MODE (2026-10-28, user order): `?f=trending` is a dedicated
   view — the homepage "Trending Worldwide" See All lands here. It shows
   ONLY the first 20 window.FA_TRENDING IDs matched to published movies
   with a poster, displayed newest release date first. Membership remains
   the strict weekly trending/published intersection; no fallback. When FA_TRENDING is missing/empty the page says so
   honestly — it never falls back to the full catalogue. */
(async function () {
  UI.mountChrome("/movies");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Movies — Popular, Top Rated & Upcoming Films with Cast and Box Office | FlickAtlas",
    desc: "Browse popular, top rated, in-cinemas and upcoming movies on FlickAtlas. Open any film for its full cast, story, budget vs box office earnings and release details.",
    path: "/movies"
  });

  const MAIN_FILTERS = [["bollywood", "Bollywood"], ["international", "World Cinema"]];
  const MORE_FILTERS = [["all", "All"], ["hollywood", "US Films"], ["lollywood", "Lollywood"], ["top", "Top Rated"]];
  const FILTERS = [...MAIN_FILTERS, ...MORE_FILTERS];
  const TRENDING_FILTER = "trending"; /* dedicated view, not a chip */
  /* The Category dropdown covers every f value, so the old ?seeall=1
     entry split (chips vs dropdown) is gone — one control always. */
  let f = UI.getParam("f", "bollywood");
  let sort = UI.getParam("s", "recent");
  if (!["popular", "recent", "oldest"].includes(sort)) sort = "recent";
  if (!(f === TRENDING_FILTER || FILTERS.some(([k]) => k === f))) f = "bollywood";
  const isTrending = () => f === TRENDING_FILTER;
  let g = UI.getParam("g", "");
  /* TV order 2026-10-27: the hub lists movies AND TV series, with a
     Type dropdown (Movies / TV Series / All). Default is Movies, so
     the page's current view is unchanged on load and the 2026-10-27
     movies-only order is preserved by default; TV is one tap away
     (?t=tv, ?t=all). The homepage Spotlight See All link carries ?t=. */
  let t = UI.getParam("t", "movie");
  if (!["movie", "tv", "all"].includes(t)) t = "movie";

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1 id="moviesTitle">Movies</h1>
      <p id="moviesSub">Filter movies and TV series by industry, year or rating; open a title for details.</p></div>
    <div id="chipHost"><div class="listing-select-row">
        <div class="filter-select" role="group" aria-labelledby="catSelectLabel"><span class="filter-select-label" id="catSelectLabel">Filter by category</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="catTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="catOptions" aria-labelledby="catSelectLabel catValue"><span class="fa-select-value" id="catValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="catOptions" role="listbox" aria-labelledby="catSelectLabel" hidden></div></div></div>
        <div class="filter-select" role="group" aria-labelledby="yearSelectLabel"><span class="filter-select-label" id="yearSelectLabel">Year</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="yearTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="yearOptions" aria-labelledby="yearSelectLabel yearValue"><span class="fa-select-value" id="yearValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="yearOptions" role="listbox" aria-labelledby="yearSelectLabel" hidden></div></div></div>
        <div class="filter-select" role="group" aria-labelledby="sortSelectLabel"><span class="filter-select-label" id="sortSelectLabel">Sort by</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="sortTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="sortOptions" aria-labelledby="sortSelectLabel sortValue"><span class="fa-select-value" id="sortValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="sortOptions" role="listbox" aria-labelledby="sortSelectLabel" hidden></div></div></div>
        <div class="filter-select" role="group" aria-labelledby="genreSelectLabel"><span class="filter-select-label" id="genreSelectLabel">Genre</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="genreTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="genreOptions" aria-labelledby="genreSelectLabel genreValue"><span class="fa-select-value" id="genreValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="genreOptions" role="listbox" aria-labelledby="genreSelectLabel" hidden></div></div></div>
        <div class="filter-select" role="group" aria-labelledby="typeSelectLabel"><span class="filter-select-label" id="typeSelectLabel">Type</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="typeTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="typeOptions" aria-labelledby="typeSelectLabel typeValue"><span class="fa-select-value" id="typeValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="typeOptions" role="listbox" aria-labelledby="typeSelectLabel" hidden></div></div></div>
      </div></div>
    <p class="fcount" id="fcount" aria-live="polite">Loading movies…</p>
    <div class="grid" id="grid">${UI.skelCards(12)}</div>
    <div id="emptyHost"></div>
  </div>`;
  const grid = main.querySelector("#grid");
  const fcount = main.querySelector("#fcount");
  const emptyHost = main.querySelector("#emptyHost");
  /* All five filters are the shared UI.mountFaSelect component (options
     as JS objects — no native <select> anywhere on this page). Category,
     Sort and Type mount now (static options); Year and Genre mount below,
     once their option lists are built from the pool. */
  const filterHosts = main.querySelector("#chipHost").querySelectorAll(".filter-select");
  const catDd = UI.mountFaSelect(filterHosts[0],
    FILTERS.map(([value, label]) => ({ value, label })),
    f, (v) => setFilter(v));
  const sortDd = UI.mountFaSelect(filterHosts[2],
    [{ value: "recent", label: "Newest release date first" }, { value: "oldest", label: "Oldest release date first" }, { value: "popular", label: "Most Popular" }],
    sort, (v) => { sort = v; UI.setParam("s", sort === "recent" ? "" : sort); render(); });
  const typeDd = UI.mountFaSelect(filterHosts[4],
    [{ value: "movie", label: "Movies" }, { value: "tv", label: "TV Series" }, { value: "all", label: "All" }],
    t, (v) => {
      t = ["movie", "tv", "all"].includes(v) ? v : "movie";
      UI.setParam("t", t === "movie" ? "" : t);
      render();
    });

  /* Published titles only: window.FA_PUBLISHED, keyed by TMDB id.
     Entries carry a baked `industry` (bollywood | pakistani | world)
     and `type` ("movie" | "tv"). No live TMDB calls anywhere.
     Industry tag for cards: "World Cinema" for world-industry titles
     (UI.industryTag now returns "World Cinema" — fixed in ui.js; the local override is a harmless guard). */
  const tagFor = (x) => UI.industryTag(x);
  const todayStr = () => UI.todayPKT();
  /* Spotlight window (owner order 2026-10-28, same 60-day window as
     page-index.js): "Movies running now" is 60 days back from the IST
     today. Used only by the ?seeall=1 Spotlight view below. */
  const SPOTLIGHT_WINDOW_DAYS = 60;
  const spotlightCutoff = (() => {
    const pkt = UI.todayPKT();
    const d = new Date(pkt + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - SPOTLIGHT_WINDOW_DAYS);
    return d.toISOString().slice(0, 10);
  })();
  const inSpotlightWindow = (x) => { const d = dateOf(x); return !!d && d >= spotlightCutoff; };
  const published = () => Object.values(window.FA_PUBLISHED || {});
  const typeOf = (x) => (x && (x.type || x.media_type)) || "movie";
  const dateOf = x => typeOf(x) === "tv" ? (x.first_air_date || "") : (f === "lollywood" && x.pakistan_theatrical_release_date && x.pakistan_release_source ? x.pakistan_theatrical_release_date : (x.release_date || ""));
  /* Normal Movies hub date order is newest first — RELEASE DATE desc,
     with published_at only breaking ties. The homepage Spotlight See All
     view below intentionally overrides that to oldest-first within the
     recent-release window, so titles keep their chronological position.
     "Popular" sorts by rating (published entries carry no TMDB popularity
     score). */
  const byNewest = (a, b) => dateOf(b).localeCompare(dateOf(a))
    || (b.published_at || "").localeCompare(a.published_at || "");
  const byOldest = (a, b) => dateOf(a).localeCompare(dateOf(b))
    || (a.published_at || "").localeCompare(b.published_at || "");
  const byPopular = (a, b) => (b.vote_average || 0) - (a.vote_average || 0)
    || (b.vote_count || 0) - (a.vote_count || 0);

  /* Hub shows released movies AND TV series (future-dated titles live
     on /upcoming). YEARLY (user order 2026-10-27): the hub is organised
     by release year — the Year dropdown picks one year (default: the
     latest year present in the data) and the list shows that year's
     released titles, newest first. The 3-month freshness rule does NOT
     gate this hub: a year view is an explicit browse of that year's
     catalogue, so the pool is all released titles and render() applies
     the year gate. Streaming-first MOVIES stay out (the earlier
     exclusion order stands — this is the Spotlight See All); TV series
     are a different content type and are never excluded. */
  const released = published().filter(x => {
    if (!x || !x.id) return false;
    const confirmedPK = f === "lollywood" && UI.industryOf(x) === "pakistani"
      && /^\d{4}-\d{2}-\d{2}$/.test(x.pakistan_theatrical_release_date || "")
      && /^https:\/\//.test(x.pakistan_release_source || "");
    if (!x.poster_path && !confirmedPK) return false;
    /* Festival-only titles (date_kind="festival", owner decision
       2026-10-27) are not released — they live on /upcoming. */
    if (x.date_kind === "festival" && !confirmedPK) return false;
    const d = dateOf(x);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > todayStr()) return false;
    if (typeOf(x) === "tv") return true;
    return typeOf(x) === "movie" && (confirmedPK || !UI.isStreamingOnly(x));
  });
  const years = [...new Set(released.map(x => dateOf(x).slice(0, 4)).concat(published().filter(x => x && x.type === "movie" && UI.industryOf(x) === "pakistani" && x.pakistan_theatrical_release_date && x.pakistan_release_source).map(x => x.pakistan_theatrical_release_date.slice(0, 4))))].sort().reverse();
  let y = UI.getParam("y", "");
  if (!years.includes(y)) y = years[0] || "";
  const pool = released;

  /* Genres ARE baked into published entries (rich fields) — populate the
     genre select from the pool so the filter works (audit fix: the select
     used to stay at "All Genres" and any ?g= was cleared as stale). */
  const genreList = [...new Set(pool.flatMap(x => Array.isArray(x.genres) ? x.genres : []))].sort((a, b) => a.localeCompare(b));
  if (g && !genreList.includes(g)) g = ""; /* unknown genre param -> All */
  const genreDd = UI.mountFaSelect(filterHosts[3],
    [{ value: "", label: "All Genres" }, ...genreList.map(gName => ({ value: gName, label: gName }))],
    g, (v) => { g = v; UI.setParam("g", g); render(); });

  /* Year dropdown: one option per year present in the released pool,
     default = latest year. A custom .fa-select (in-page panel, never the
     Android popup a native <select> becomes) — the same component as
     Sort / Genre on this page. */
  const yearDd = UI.mountFaSelect(filterHosts[1],
    years.map(yr => ({ value: String(yr), label: String(yr) })),
    y, (v) => {
      y = v;
      if (!years.includes(y)) y = years[0] || "";
      UI.setParam("y", y === (years[0] || "") ? "" : y);
      render();
    });

  /* Trending pool: FA_TRENDING order (TMDB /trending/movie/week) matched
     to published movies with a poster. Deliberately NOT release-gated:
     a title trending this week belongs here even if it released months
     ago or is still upcoming (TMDB trending includes both — same
     eligibility as the homepage rail in page-index.js). The list is
     only as long as the overlap between FA_TRENDING and FA_PUBLISHED;
     the seeder (title-seed.py) now prioritises trending titles so the
     overlap grows a few titles per run instead of starving in the
     general 4/day backfill. */
  const trendingPool = [...new Set((Array.isArray(window.FA_TRENDING) ? window.FA_TRENDING : []).slice(0, 20).map(String))]
    .map(id => (window.FA_PUBLISHED || {})[id])
    .filter(x => x && x.id && x.type === "movie" && x.poster_path)
    .sort(byNewest);

  const heroTitle = main.querySelector("#moviesTitle");
  const heroSub = main.querySelector("#moviesSub");
  function syncHero() {
    if (isTrending()) {
      heroTitle.textContent = "Trending Worldwide";
      heroSub.textContent = "This week's most-trending movies, worldwide — refreshed daily from TMDB. Only titles trending right now appear here.";
    } else {
      heroTitle.textContent = "Movies";
      heroSub.textContent = "Filter movies and TV series by industry, year or rating; open a title for details.";
    }
  }
  /* Year + Sort do not apply to the trending rank order, so hide them
     in trending mode (Genre still applies, preserving rank order). */
  function syncTrendingUI() {
    const show = !isTrending();
    [filterHosts[1], filterHosts[2]].forEach(host => {
      if (host) host.style.display = show ? "" : "none";
    });
    syncHero();
  }

  function render() {
    syncTrendingUI();
    if (isTrending()) {
      /* Trending-only: rank order from FA_TRENDING, genre filter only.
         NO fallback to the full catalogue — an empty/missing trending
         list renders an honest empty state (same rule as the homepage
         rail, user order 2026-10-26). */
      const items = trendingPool.filter(x =>
        !g || (Array.isArray(x.genres) && x.genres.includes(g)));
      grid.innerHTML = items.map(x =>
        `<div class="fcell" data-fitem>${UI.posterCard(f === "lollywood" ? { ...x, release_date: dateOf(x) } : x, "movie", tagFor(x))}</div>`).join("");
      fcount.textContent = `${items.length} trending movie${items.length === 1 ? "" : "s"} · in weekly trending eligibility · newest release date first · refreshed daily`;
      emptyHost.innerHTML = items.length ? ""
        : UI.stateMsg(trendingPool.length
          ? "No trending titles match this genre right now."
          : "Nothing is trending right now — check back soon.", false);
      return;
    }
    /* Homepage Spotlight See All (owner order 2026-10-28): when the page
       is opened from the homepage rail (?seeall=1, default filters) it
       must show the SAME set, in the SAME order, as the homepage
       Spotlight rail — released movies in the 60-day "running now"
       window, newest release date first, streaming-only excluded. The yearly hub
       pool (19 Bollywood titles) is a different set; the year gate
       does not apply here. Changing any filter drops out of See All
       mode into the normal yearly browse. */
    const seeAll = UI.getParam("seeall", "") === "1"
      && (f === "bollywood" || f === "international")
      && sort === "recent" && t === "movie" && !g && y === (years[0] || "");
    const items = pool.filter(x => {
      if (seeAll) {
        if (typeOf(x) !== "movie") return false;
        if (UI.isStreamingOnly(x)) return false;
        if (!inSpotlightWindow(x)) return false;
      } else if (y && dateOf(x).slice(0, 4) !== y) return false;
      if (t === "movie" && typeOf(x) !== "movie") return false;
      if (t === "tv" && typeOf(x) !== "tv") return false;
      /* Industry rule (owner order 2026-10-28): Bollywood = ALL Indian
         titles (canonical UI.industryOf), World Cinema = only
         international — the gates apply to TV series too. (The old
         "TV series are not split by industry" bypass let Bollywood+TV
         show Pakistani dramas — the same bug the homepage fixed on
         2026-10-27.) "US Films" stays the US-English slice of World. */
      if (f === "bollywood" && UI.industryOf(x) !== "bollywood") return false;
      if (f === "hollywood" && !(UI.industryOf(x) === "world" && x.original_language === "en" && (x.origin_country || []).includes("US"))) return false;
      if (f === "international" && UI.industryOf(x) !== "world") return false;
      if (f === "lollywood" && UI.industryOf(x) !== "pakistani") return false;
      /* Current-year Lollywood is a source-confirmed Pakistan theatrical scope; older years retain the full catalog. */
      if (f === "lollywood" && y === UI.todayPKT().slice(0, 4) && (!x.pakistan_theatrical_release_date || !x.pakistan_release_source || !/^https:\/\//.test(x.pakistan_release_source) || x.pakistan_theatrical_release_date.slice(0, 4) !== y || x.pakistan_theatrical_release_date > UI.todayPKT())) return false;
      /* "Top Rated" is a sort-by-rating view, not a gate: the old gate
         (rating >= 7.5 AND vote_count >= 300) could never match published
         titles (vote_count 2-3), so the filter always showed empty. */
      if (g && !(Array.isArray(x.genres) && x.genres.includes(g))) return false;
      return true;
    });
    items.sort((a, b) => f === "top" ? byPopular(a, b)
      : sort === "oldest" ? byOldest(a, b)
      : sort === "recent" ? byNewest(a, b) : byPopular(a, b));
    grid.innerHTML = items.map(x =>
      `<div class="fcell" data-fitem>${UI.posterCard(f === "lollywood" ? { ...x, release_date: dateOf(x) } : x, typeOf(x), tagFor(x), undefined, undefined, true)}</div>`).join("");
    const noun = t === "movie" ? "movie" : t === "tv" ? "TV series" : "title";
    fcount.textContent = `${items.length} ${noun}${items.length === 1 ? "" : "s"}${y ? ` · ${y}` : ""}`;
    emptyHost.innerHTML = items.length ? ""
      : UI.stateMsg(pool.length
        ? "No titles match this filter right now."
        : "No titles have been published yet.", false);
  }

  /* setFilter: the single Category dropdown covers every f value
     (Bollywood / World Cinema / All / US Films / Lollywood / Top Rated),
     so no separate industry chips are needed any more. */
  function setFilter(key) {
    f = (key === TRENDING_FILTER || FILTERS.some(([candidate]) => candidate === key)) ? key : "bollywood";
    UI.setParam("f", f === "bollywood" ? "" : f);
    render();
  }
  window.addEventListener("popstate", () => {
    f = (UI.getParam("f", "bollywood") === TRENDING_FILTER || FILTERS.some(([candidate]) => candidate === UI.getParam("f", "bollywood"))) ? UI.getParam("f", "bollywood") : "bollywood";
    g = UI.getParam("g", "");
    if (g && !genreList.includes(g)) g = ""; /* unknown genre -> All */
    sort = UI.getParam("s", "recent"); if (!["popular", "recent", "oldest"].includes(sort)) sort = "recent";
    t = UI.getParam("t", "movie"); if (!["movie", "tv", "all"].includes(t)) t = "movie";
    y = UI.getParam("y", "");
    if (!years.includes(y)) y = years[0] || "";
    catDd.setValue(f);
    sortDd.setValue(sort);
    typeDd.setValue(t);
    genreDd.setValue(g);
    yearDd.setValue(y);
    render();
  });

  render();
})();




