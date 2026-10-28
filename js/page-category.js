/* FlickAtlas — Industry category page (?cat=bollywood|world|pakistani):
   movies + TV shows for one industry, newest first. PUBLISHED-ONLY
   (2026-10-25 rebuild): every title comes from window.FA_PUBLISHED —
   TMDB is a data source, not a catalogue, so nothing is fetched live.
   K-drama category REMOVED (spec §6): dramas are Indian + Pakistani +
   viral international only. Legacy params map: lollywood → pakistani,
   hollywood/international → world (old kdrama links fall back to bollywood).
   Follows the page-movies.js / page-tv.js pattern (same poster cards,
   same recency sort). The Type filter is a .fa-select in-page dropdown
   (All / Movies / TV Shows) — never a native <select> popup. */
(async function () {
  const CATS = {
    bollywood: { label: "Bollywood", desc: "Indian cinema — Hindi, Tamil, Telugu, Malayalam, Kannada, Punjabi, Bengali, Marathi and every Indian language: the biggest stars, openings and collections." },
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
    <div id="chipHost"><div class="listing-select-row listing-select-row--single">
      <div class="filter-select" role="group" aria-labelledby="typeSelectLabel"><span class="filter-select-label" id="typeSelectLabel">Type</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="typeTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="typeOptions" aria-labelledby="typeSelectLabel typeValue"><span class="fa-select-value" id="typeValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="typeOptions" role="listbox" aria-labelledby="typeSelectLabel" hidden></div></div></div>
    </div></div>
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
  /* Homepage rule (correction 9, as amended 2026-10-26 by user order):
     recency-sorted everywhere, newest first — RELEASE/AIR DATE desc (the
     latest release leads, then going back); published_at only breaks
     ties. The old published_at-first sort scrambled the order whenever
     titles were published in batches — so this page shows the SAME title
     the homepage section shows, not a different one. */
  const byNewest = (a, b) => dateOf(b).localeCompare(dateOf(a))
    || (b.published_at || "").localeCompare(a.published_at || "");

  /* Industry tag for cards: UI.industryTag now returns "World Cinema" for
     world-industry titles (fixed in ui.js) — the explicit label is kept
     as a harmless guard. */
  const tagFor = (x) => UI.industryTag(x);
  /* Freshness first (site rule: nothing older than 3 months on listings);
     fall back to the full published category pool so the page is never
     empty while published titles exist for this industry. Released
     titles only — future-dated titles live on /upcoming. */
  const pool = (() => {
    const today = new Date().toISOString().slice(0, 10);
    /* Industry rule (owner order 2026-10-28): Bollywood = ALL Indian
       titles (canonical UI.industryOf), World Cinema = only
       international — never the baked `industry` alone. */
    const inCategory = published().filter(x => x && x.id && UI.industryOf(x) === cat
      && dateOf(x) && dateOf(x) <= today && x.date_kind !== "festival");
    const fresh = inCategory.filter(UI.isFresh);
    return (fresh.length ? fresh : inCategory).sort(byNewest);
  })();

  function render() {
    const items = pool.filter(x => {
      if (t === "movie" && x.type !== "movie") return false;
      if (t === "tv" && x.type !== "tv") return false;
      return true;
    });
    grid.innerHTML = items.map(x =>
      `<div class="fcell" data-fitem>${UI.posterCard(x, x.type, tagFor(x))}</div>`).join("");
    const label = t === "movie" ? "movie" : t === "tv" ? "show" : "title";
    fcount.textContent = `${items.length} ${label}${items.length === 1 ? "" : "s"}`;
    emptyHost.innerHTML = items.length ? ""
      : UI.stateMsg(pool.length
        ? `No ${info.label} titles match this filter right now.`
        : `No ${info.label} titles have been published yet.`, false);
  }

  /* Type filter is a .fa-select in-page dropdown (All / Movies / TV
     Shows). Everything stays on the `t` param — no `f` param is written,
     so back-button and new-tab links behave (the old chip wiring wrote
     both ?f= and ?t=). */
  const chipHost = main.querySelector("#chipHost");
  const typeDd = UI.mountFaSelect(chipHost.querySelector(".filter-select"),
    TYPE_FILTERS.map(([value, label]) => ({ value, label: label === "TV Shows" ? "TV Shows" : label })),
    t, (v) => {
      t = v;
      UI.setParam("t", t === "all" ? "" : t);
      render();
    });
  window.addEventListener("popstate", () => {
    t = UI.getParam("t", "all");
    if (!TYPE_FILTERS.some(([k]) => k === t)) t = "all";
    typeDd.setValue(t);
    render();
  });

  render();
})();





