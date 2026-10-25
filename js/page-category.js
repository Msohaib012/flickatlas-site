/* FlickAtlas — Industry category page (?cat=bollywood|world|pakistani):
   movies + TV shows for one industry, newest first. PUBLISHED-ONLY
   (2026-10-25 rebuild): every title comes from window.FA_PUBLISHED —
   TMDB is a data source, not a catalogue, so nothing is fetched live.
   K-drama category REMOVED (spec §6): dramas are Indian + Pakistani +
   viral international only. Legacy params map: lollywood → pakistani,
   hollywood/international → world (old kdrama links fall back to bollywood).
   Follows the page-movies.js / page-tv.js pattern (same poster cards,
   same All/Movies/TV chips, same recency sort). */
(async function () {
  const CATS = {
    bollywood: { label: "Bollywood", desc: "Hindi cinema — the biggest stars, openings and collections." },
    world: { label: "World Cinema", desc: "International films and series from around the world." },
    pakistani: { label: "Pakistani", desc: "The latest Pakistani films and dramas, newest first." },
  };
  /* Legacy ?cat= values from before the published-only rebuild. */
  const CAT_ALIASES = { lollywood: "pakistani", hollywood: "world", international: "world" };
  let cat = UI.getParam("cat", "bollywood");
  if (!CATS[cat]) cat = CAT_ALIASES[cat] || "bollywood";
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

  /* Published titles only: window.FA_PUBLISHED, keyed by TMDB id.
     Entries carry a baked `industry` (bollywood | pakistani | world)
     and `type` ("movie" | "tv"). */
  const published = () => Object.values(window.FA_PUBLISHED || {});
  const dateOf = x => x.type === "tv" ? (x.first_air_date || "") : (x.release_date || "");
  /* Homepage rule (correction 9): recency-sorted everywhere, newest first —
     published_at desc, then release/air date desc — so this page shows the
     SAME title the homepage section shows, not a different one. */
  const byNewest = (a, b) => (b.published_at || "").localeCompare(a.published_at || "")
    || dateOf(b).localeCompare(dateOf(a));

  /* Freshness first (site rule: nothing older than 3 months on listings);
     fall back to the full published category pool so the page is never
     empty while published titles exist for this industry. Released
     titles only — future-dated titles live on /upcoming. */
  const pool = (() => {
    const today = new Date().toISOString().slice(0, 10);
    const inCategory = published().filter(x => x && x.id && x.industry === cat
      && dateOf(x) && dateOf(x) <= today);
    const fresh = inCategory.filter(UI.isFresh);
    return (fresh.length ? fresh : inCategory).sort(byNewest);
  })();

  function render() {
    const items = pool.filter(x => {
      if (t === "movie" && x.type !== "movie") return false;
      if (t === "tv" && x.type !== "tv") return false;
      return true;
    });
    const shown = items.slice(0, 1);
    grid.innerHTML = shown.map(x =>
      `<div class="fcell" data-fitem>${UI.posterCard(x, x.type, UI.industryTag(x))}</div>`).join("");
    const label = t === "movie" ? "movie" : t === "tv" ? "show" : "title";
    fcount.textContent = `${shown.length} ${label}${shown.length === 1 ? "" : "s"}`;
    emptyHost.innerHTML = shown.length ? ""
      : UI.stateMsg(pool.length
        ? `No ${info.label} titles match this filter right now.`
        : `No ${info.label} titles have been published yet.`, false);
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

  render();
})();
