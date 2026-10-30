/* FlickAtlas — Pakistani Dramas hub (/dramas): poster grid of the
   published Pakistani TV dramas, newest first (by first_air_date).
   User order 2026-10-26: the Drama category is a POSTER-style list;
   clicking a drama poster opens its show page (/show?id=<id>), which
   lists that drama's episodes (each linking to its own episode page).
   PUBLISHED-ONLY: every drama comes from window.FA_PUBLISHED — TMDB is
   a data source, not a catalogue, so nothing is fetched live. Movies
   are NOT here — they live on /category?cat=lollywood.
   Each card also shows the live episode count from the episode
   tracker (/out/episodes.json — "13 episodes · Still airing"), so
   the page reads as a live drama guide, not just a poster wall. A
   sort dropdown (Newest / Oldest / A–Z) orders the grid — a CUSTOM
   in-page dropdown (button + downward panel), never a native
   <select>, which Chrome on Android phones renders as a modal popup
   dialog (user order 2026-10-27). Reuses the site's .fa-select
   styles, same component as the Movies/Upcoming pages. */
(async function () {
  UI.mountChrome("/dramas");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Pakistani Dramas — Latest Pakistani Drama Serials | FlickAtlas",
    desc: "Pakistani dramas on FlickAtlas — the latest Pakistani drama serials, newest first. Open a drama for its episode list.",
    path: "/dramas"
  });

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Pakistani Dramas</h1>
      </div>
    <div id="chipHost">
      <div class="listing-select-row listing-select-row--single"><div class="filter-select" role="group" aria-labelledby="sortFilterLabel"><span id="sortFilterLabel">Sort</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="sortTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="sortOptions" aria-labelledby="sortFilterLabel sortValue"><span class="fa-select-value" id="sortValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="sortOptions" role="listbox" aria-labelledby="sortFilterLabel" hidden></div></div></div></div>
    </div>
    <p class="fcount" id="fcount" aria-live="polite">Loading dramas…</p>
    <div class="grid" id="grid">${UI.skelCards(6)}</div>
    <div id="emptyHost"></div>
  </div>`;
  const grid = main.querySelector("#grid");
  const fcount = main.querySelector("#fcount");
  const emptyHost = main.querySelector("#emptyHost");
  let sort = "newest";

  /* Tracker episode counts (user order 2026-10-26): the highest
     tracked episode number per drama IS its episode count (episodes
     air sequentially from 1). Alias: tracker "Dar" = published
     "Dar-E-Nijaat", tracker "Zehar" = "Zehar-e-Mohabbat". A drama
     whose latest tracked episode aired within 7 days and whose
     status is still Returning Series is still airing. When the
     tracker has nothing for a drama, its card shows no episode line
     (the card still renders — the tracker is a live extra, not a
     gate). */
  const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const DRAMA_ALIASES = { "dar": "dar e nijaat", "zehar": "zehar e mohabbat" };
  const canonDrama = (d) => DRAMA_ALIASES[normName(d)] || normName(d);
  const trackerByDrama = {};
  try {
    const res = await fetch("/out/episodes.json", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      for (const r of Object.values((data && data.episodes) || {})) {
        if (!r || !r.drama) continue;
        const key = canonDrama(r.drama);
        const n = r.episode;
        if (!Number.isInteger(n) || n <= 0) continue;
        const cur = trackerByDrama[key];
        const pub = r.published || "";
        if (!cur || n > cur.count || (n === cur.count && pub > cur.latestPublished)) {
          trackerByDrama[key] = { count: n, latestPublished: pub };
        }
      }
    }
  } catch (_) { /* tracker unavailable — cards render without episode counts */ }
  const epMeta = (x) => {
    const t = trackerByDrama[canonDrama(UI.titleOf(x))];
    if (!t) return "";
    let airing = false;
    if (t.latestPublished) {
      const last = Date.parse(t.latestPublished);
      airing = Number.isFinite(last) && (Date.now() - last) / 86400000 <= 7
        && String(x.status || "").toLowerCase().indexOf("returning") !== -1;
    }
    return `${t.count} episode${t.count === 1 ? "" : "s"}${airing ? " · Still airing" : ""}`;
  };

  /* Custom in-page dropdown (user order 2026-10-27): a button showing
     the current choice + a list panel that expands DOWNWARD directly
     below the button, inside the page — never a native <select>, which
     Chrome on Android phones renders as a modal popup dialog.
     Reuses the site's .fa-select styles (same component as the
     Movies/Upcoming pages) and the same behaviour: click toggles,
     click an option chooses + closes, click outside closes, Escape
     closes, arrows/Home/End move, Enter/Space chooses, typing
     jumps to a matching option. No <select> exists in this control. */
  function mountFaSelect(host, options, initialValue, onPick) {
    const trigger = host.querySelector(".fa-select-trigger");
    const label = host.querySelector(".fa-select-value");
    const listbox = host.querySelector('[role="listbox"]');
    let value = initialValue;
    let activeIndex = Math.max(0, options.findIndex(o => o.value === value));
    let opened = false, typeAhead = "", typeAheadTimer;
    function renderMenu() {
      listbox.innerHTML = options.map((option, index) =>
        `<div class="fa-select-option" id="${listbox.id}-option-${index}" role="option" aria-selected="${index === activeIndex}" data-index="${index}"><span>${UI.esc(option.label)}</span><span class="fa-select-check" aria-hidden="true">✓</span></div>`).join("");
    }
    function sync() {
      activeIndex = Math.max(0, options.findIndex(o => o.value === value));
      label.textContent = options[activeIndex] ? options[activeIndex].label : "Choose an option";
      renderMenu();
      if (opened) activate(activeIndex);
    }
    function activate(index) {
      const opts = [...listbox.querySelectorAll('[role="option"]')];
      if (!opts.length) return;
      activeIndex = (index + opts.length) % opts.length;
      const active = opts[activeIndex];
      trigger.setAttribute("aria-activedescendant", active.id);
      opts.forEach((option, i) => option.classList.toggle("is-active", i === activeIndex));
      active.scrollIntoView?.({ block: "nearest" });
    }
    function close(restoreFocus) {
      if (!opened) return;
      opened = false; listbox.hidden = true; trigger.setAttribute("aria-expanded", "false");
      trigger.removeAttribute("aria-activedescendant");
      if (restoreFocus) trigger.focus();
    }
    function open() {
      sync(); if (!options.length) return;
      opened = true; listbox.hidden = false; trigger.setAttribute("aria-expanded", "true");
      activate(activeIndex);
    }
    function choose() {
      const option = options[activeIndex]; if (!option) return;
      value = option.value;
      sync();
      close(true);
      onPick(value);
    }
    trigger.addEventListener("click", () => opened ? close() : open());
    trigger.addEventListener("keydown", event => {
      if (event.key === "Escape" && opened) { event.preventDefault(); close(); return; }
      if (event.key === "Tab" && opened) { close(); return; }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        if (!opened) open();
        else if (event.key === "ArrowDown") activate(activeIndex + 1);
        else if (event.key === "ArrowUp") activate(activeIndex - 1);
        else if (event.key === "Home") activate(0);
        else activate(options.length - 1);
        return;
      }
      if ((event.key === "Enter" || event.key === " ") && opened) { event.preventDefault(); choose(); return; }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        typeAhead += event.key.toLocaleLowerCase();
        const match = options.findIndex(option => option.label.trim().toLocaleLowerCase().startsWith(typeAhead));
        if (match >= 0) { if (!opened) open(); activate(match); event.preventDefault(); }
        clearTimeout(typeAheadTimer); typeAheadTimer = setTimeout(() => { typeAhead = ""; }, 700);
      }
    });
    listbox.addEventListener("click", event => {
      const option = event.target.closest('[role="option"]'); if (!option) return;
      activeIndex = Number(option.dataset.index); choose();
    });
    document.addEventListener("pointerdown", event => { if (opened && !host.contains(event.target)) close(); });
    sync();
    return { get value() { return value; }, setValue(v) { value = v; sync(); } };
  }

  const dateOf = (x) => (x && (x.first_air_date || "")) || "";
  const allDramas = Object.values(window.FA_PUBLISHED || {})
    .filter(x => x && x.id && x.poster_path && (x.type || x.media_type) === "tv" && UI.industryOf(x) === "pakistani");

  if (!allDramas.length) {
    fcount.textContent = "No Pakistani dramas have been published yet.";
    grid.innerHTML = "";
    emptyHost.innerHTML = UI.stateMsg("No Pakistani dramas have been published yet.", false);
    return;
  }
  const renderGrid = () => {
    const dramas = [...allDramas].sort((a, b) => {
      if (sort === "oldest") return dateOf(a).localeCompare(dateOf(b)) || (a.published_at || "").localeCompare(b.published_at || "");
      if (sort === "az") return UI.titleOf(a).localeCompare(UI.titleOf(b));
      return dateOf(b).localeCompare(dateOf(a)) || (b.published_at || "").localeCompare(a.published_at || "");
    });
    fcount.textContent = `${dramas.length} drama${dramas.length === 1 ? "" : "s"}`;
    grid.innerHTML = dramas.map(x =>
      `<div class="fcell" data-fitem>${UI.posterCard(x, "tv", "Pakistani Drama", null, epMeta(x))}</div>`).join("");
  };
  mountFaSelect(main.querySelector("#chipHost .filter-select"),
    [{ value: "newest", label: "Newest first" }, { value: "oldest", label: "Oldest first" }, { value: "az", label: "A – Z" }],
    "newest", (value) => { sort = value; renderGrid(); });
  renderGrid();
})();

