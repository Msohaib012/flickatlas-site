/* FlickAtlas — Release Calendar (§3 calendar-native, §4 chips): movies + TV
   premieres in ONE dated, month-grouped list. Bollywood and World Cinema
   are primary industries; format, month and legacy Pakistani scopes remain available.
   PUBLISHED-ONLY (2026-10-25 rebuild): every release comes from
   window.FA_PUBLISHED entries whose release/air date is in the future —
   TMDB is a data source, not a catalogue, so nothing is fetched live.
   Trailer status comes from the baked-in `trailer` object (official
   trailer only), never from a live videos call. Freshness rule does not
   apply to upcoming (§7). */
(async function () {
  UI.mountChrome("/upcoming");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Upcoming Movies & TV Shows — Release Date Calendar | FlickAtlas",
    desc: "The FlickAtlas release calendar: upcoming movies and TV premieres grouped by month, with exact release dates, ratings and cast shortcuts.",
    path: "/upcoming"
  });

  const MAIN_FILTERS = [["bollywood", "Bollywood"], ["international", "World Cinema"]];
  const MORE_FILTERS = [["all", "All"], ["movies", "Movies"], ["tv", "TV"], ["month", "This Month"], ["pakistani", "Pakistani"]];
  const FILTERS = [...MAIN_FILTERS, ...MORE_FILTERS];
  const seeAllEntry = UI.getParam("seeall", "") === "1";
  let f = UI.getParam("f", "bollywood");
  let sort = UI.getParam("s", "nearest"); if (sort !== "nearest") sort = "nearest";
  if (!FILTERS.some(([k]) => k === f)) f = "bollywood";

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Upcoming Releases</h1>
      <p>Upcoming movie and TV dates by month; dates may change.</p></div>
    <div id="chipHost"><div data-filter-scope="main">${UI.chipRow(MAIN_FILTERS, f, "bollywood")}</div>
      ${seeAllEntry
        ? `<div class="filter-select listing-custom-filter" role="group" aria-labelledby="upcomingFilterLabel"><span class="filter-select-label" id="upcomingFilterLabel">Filter by category</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="moreFilterTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="moreFilterOptions" aria-labelledby="upcomingFilterLabel moreFilterValue"><span id="moreFilterValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="moreFilterOptions" role="listbox" aria-labelledby="upcomingFilterLabel" hidden></div></div><select class="fsel" id="moreFilterSel" aria-label="Additional upcoming category filter" aria-hidden="true" tabindex="-1" hidden><option value="">Choose a filter</option>${MORE_FILTERS.map(([key, label]) => `<option value="${UI.esc(key)}">${UI.esc(label)}</option>`).join("")}</select></div>`
        : `<div class="listing-more-filters"><p class="filter-group-label">More categories</p><div data-filter-scope="more">${UI.chipRow(MORE_FILTERS, f, "bollywood")}</div></div>`}</div>
    <p class="sec-sub">Nearest first · movies and TV premieres</p>
    <p class="fcount" id="fcount"></p>
    <div id="upWrap">${UI.skelCards(8)}</div>
  </div>`;
  const wrap = main.querySelector("#upWrap");
  const fcount = main.querySelector("#fcount");
  const moreFilterSel = main.querySelector("#moreFilterSel");
  if (moreFilterSel) moreFilterSel.value = MORE_FILTERS.some(([key]) => key === f) ? f : "";
  const MONTHS_S = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function mountFilterMenu(select) {
    const host = select.closest(".filter-select");
    const trigger = host.querySelector(".fa-select-trigger");
    const label = host.querySelector("[id$='Value']");
    const listbox = host.querySelector('[role="listbox"]');
    let activeIndex = 0, opened = false, typeAhead = "", typeAheadTimer;
    function activate(index) {
      const options = [...listbox.querySelectorAll('[role="option"]')];
      if (!options.length) return;
      activeIndex = (index + options.length) % options.length;
      const active = options[activeIndex];
      trigger.setAttribute("aria-activedescendant", active.id);
      options.forEach((option, i) => option.classList.toggle("is-active", i === activeIndex));
      active.scrollIntoView?.({ block: "nearest" });
    }
    function sync() {
      const options = [...select.options];
      const selectedIndex = options.findIndex(option => option.value === select.value);
      activeIndex = selectedIndex >= 0 ? selectedIndex : 0;
      label.textContent = options[activeIndex]?.textContent || "Choose a filter";
      listbox.innerHTML = options.map((option, index) => `<div class="fa-select-option" id="${listbox.id}-option-${index}" role="option" aria-selected="${index === activeIndex}" data-index="${index}"><span>${UI.esc(option.textContent)}</span><span class="fa-select-check" aria-hidden="true">✓</span></div>`).join("");
      if (opened) activate(activeIndex);
    }
    function close(restoreFocus = false) {
      if (!opened) return;
      opened = false; listbox.hidden = true; trigger.setAttribute("aria-expanded", "false");
      trigger.removeAttribute("aria-activedescendant");
      if (restoreFocus) trigger.focus();
    }
    function open() {
      sync(); if (!select.options.length) return;
      opened = true; listbox.hidden = false; trigger.setAttribute("aria-expanded", "true");
      activate(activeIndex);
    }
    function choose() {
      const option = select.options[activeIndex]; if (!option) return;
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      close(true);
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
        else activate(select.options.length - 1);
        return;
      }
      if ((event.key === "Enter" || event.key === " ") && opened) { event.preventDefault(); choose(); return; }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        typeAhead += event.key.toLocaleLowerCase();
        const match = [...select.options].findIndex(option => option.textContent.trim().toLocaleLowerCase().startsWith(typeAhead));
        if (match >= 0) { if (!opened) open(); activate(match); event.preventDefault(); }
        clearTimeout(typeAheadTimer); typeAheadTimer = setTimeout(() => { typeAhead = ""; }, 700);
      }
    });
    listbox.addEventListener("click", event => {
      const option = event.target.closest('[role="option"]'); if (!option) return;
      activeIndex = Number(option.dataset.index); choose();
    });
    select.addEventListener("change", sync);
    document.addEventListener("pointerdown", event => { if (opened && !host.contains(event.target)) close(); });
    sync();
    return { sync };
  }
  const moreFilterMenu = moreFilterSel ? mountFilterMenu(moreFilterSel) : null;

  /* Published titles only: window.FA_PUBLISHED, keyed by TMDB id.
     Upcoming = entries whose release/air date is in the future.
     `industry` is baked (bollywood | pakistani | world); `trailer` is
     the baked official trailer object (null when none exists). */
  const today = new Date().toISOString().slice(0, 10);
  const dateOf = x => x.type === "tv" ? (x.first_air_date || "") : (x.release_date || "");
  const items = Object.values(window.FA_PUBLISHED || {})
    .filter(x => x && x.id && x.poster_path && dateOf(x) > today)
    .map(x => ({ ...x, _date: dateOf(x) }))
    .sort((a, b) => a._date.localeCompare(b._date)
      || (b.published_at || "").localeCompare(a.published_at || ""))
    .slice(0, 120);

  function render() {
    const ym = new Date().toISOString().slice(0, 7);
    const list = items.filter(x => {
      if (f === "movies") return x.type === "movie";
      if (f === "tv") return x.type === "tv";
      if (f === "bollywood") return x.industry === "bollywood";
      if (f === "pakistani") return x.industry === "pakistani";
      if (f === "international") return x.industry === "world";
      if (f === "month") return (x._date || "").slice(0, 7) === ym;
      return true;
    });
    fcount.textContent = list.length ? `${list.length} upcoming release${list.length === 1 ? "" : "s"}` : "";
    if (!list.length) {
      wrap.innerHTML = UI.stateMsg(items.length
        ? "No upcoming releases match this filter right now."
        : "No upcoming releases have been published yet.", false);
      return;
    }
    const groups = new Map();
    for (const x of list) {
      const key = UI.monthLabel(x._date);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(x);
    }
    let html = "";
    for (const [label, group] of groups) {
      html += `<section class="section"><div class="section-head"><h2>${UI.esc(label)}</h2></div>
        <div class="tl-list">${group.map(x => { const [, mm, dd] = x._date.split("-"); return `
          <a class="tl-row" href="/${x.type === "tv" ? "show" : "movie"}?id=${x.id}#official-trailer">
            <span class="tl-date"><b>${dd ? parseInt(dd, 10) : "—"}</b><span>${mm ? MONTHS_S[parseInt(mm, 10) - 1] : ""}</span></span>
            <img src="${UI.img(x.poster_path, "w92")}" alt="" loading="lazy" onerror="this.remove()">
            <span class="tl-info"><b>${UI.esc(UI.titleOf(x))}</b>
            <span>${x.type === "tv" ? "Premieres " : ""}${UI.fmtDate(x._date)}${UI.rating(x) ? ` · ${UI.rating(x)}/10` : ""} · ${x.trailer ? "Official trailer listed" : "No verified official trailer listed"}</span></span>
            <span class="tag-chip">${UI.esc(UI.industryTag(x))}</span>
          </a>`; }).join("")}
        </div></section>`;
    }
    wrap.innerHTML = html || UI.stateMsg("No upcoming releases have been published yet.", false);
  }
  const chipHost = main.querySelector("#chipHost");
  const mainFilterHost = main.querySelector('[data-filter-scope="main"]');
  function syncSeeAllFilters() {
    if (!seeAllEntry) return;
    moreFilterSel.value = MORE_FILTERS.some(([key]) => key === f) ? f : "";
    moreFilterMenu.sync();
    mainFilterHost.querySelectorAll("[data-f]").forEach(link => {
      const active = link.dataset.f === f;
      link.classList.toggle("on", active);
      if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    });
  }
  function setSeeAllFilter(key) {
    f = FILTERS.some(([candidate]) => candidate === key) ? key : "bollywood";
    UI.setParam("f", f === "bollywood" ? "" : f);
    syncSeeAllFilters();
    render();
  }
  if (seeAllEntry) {
    mainFilterHost.querySelectorAll("a[data-f]").forEach(link => link.addEventListener("click", event => {
      if (event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      setSeeAllFilter(link.dataset.f);
    }));
    moreFilterSel.addEventListener("change", () => setSeeAllFilter(moreFilterSel.value || "bollywood"));
    syncSeeAllFilters();
  } else {
    UI.wireChips(chipHost, (key) => { f = key; render(); }, "bollywood");
  }
  window.addEventListener("popstate", () => {
    f = UI.getParam("f", "bollywood"); if (!FILTERS.some(([k]) => k === f)) f = "bollywood";
    sort = UI.getParam("s", "nearest"); if (sort !== "nearest") sort = "nearest";
    if (seeAllEntry) syncSeeAllFilters();
    render();
  });

  render();
})();
