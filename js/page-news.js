/* FlickAtlas — Trending News (§3 newspaper-native, §5 Soompi mechanics):
   real entertainment headlines from the live feed via /api/news, presented as
   newspaper-style rows with relative timestamps and tag labels. TAGS (owner
   order 2026-10-26): News stays ONE mixed feed — all headlines together,
   newest first. Awards, music, viral, OTT, tech and the rest live INSIDE
   News as TAGS, not separate pages/categories. Tapping a tag filters the
   list to that tag. PUBLISHED-ONLY: the page renders only the feed — there
   is no live-TMDB fallback (the old fallback rendered now-playing / revenue /
   upcoming titles as "news" and linked to unpublished titles). If the feed
   is unreachable or empty, the page says so honestly. */
(async function () {
  UI.mountChrome("/news");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Bollywood & Entertainment News | FlickAtlas",
    desc: "Read recent entertainment news on film and TV releases, OTT updates, awards and celebrities across Indian, Pakistani and international cinema.",
    path: "/news"
  });

  /* Tag chips, in display order. "All" is the mixed feed (everything,
     newest first). Each tag filters the list; an article can carry
     several tags. Reuses the existing ?f= param + UI.chipRow/UI.wireChips. */
  const FILTERS = [["all", "All"], ["bollywood", "Bollywood"], ["lollywood", "Lollywood"],
    ["kollywood", "Kollywood"], ["world", "World Cinema"], ["pakistan", "Pakistan"],
    ["celebrity", "Celebrity"], ["viral", "Viral"], ["award", "Award"], ["ott", "OTT"],
    ["music", "Music"], ["tech", "Tech"]];
  let f = UI.getParam("f", "all");
  if (!FILTERS.some(([k]) => k === f)) f = "all";

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Entertainment News</h1>
      </div>
    <div id="chipHost"><div class="listing-select-row listing-select-row--single"><div class="filter-select" role="group" aria-labelledby="newsFilterLabel"><span id="newsFilterLabel">Category</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="newsFilterTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="newsFilterOptions" aria-labelledby="newsFilterLabel newsFilterValue"><span class="fa-select-value" id="newsFilterValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="newsFilterOptions" role="listbox" aria-labelledby="newsFilterLabel" hidden></div></div></div></div></div>
    <p class="fcount" id="fcount"></p>
    <div id="newsWrap"><div class="sk" style="height:220px;border-radius:14px"></div></div>
  </div>`;
  const wrap = main.querySelector("#newsWrap");
  const fcount = main.querySelector("#fcount");

  const CATLABEL = { bollywood: "Bollywood", lollywood: "Lollywood", kollywood: "Kollywood",
    world: "World Cinema", pakistan: "Pakistan", celebrity: "Celebrity", viral: "Viral",
    award: "Award", ott: "OTT", music: "Music", tech: "Tech" };
  let items = null;

  /* NEWS PURITY (owner order 2026-10-27): episode posts are NOT news.
     An item is an episode when its headline matches the episode-post
     pattern "<Drama> Episode <N> — Watch on <channel>" (or the
     "Last Episode" finale form) — the same pattern page-news-item.js
     uses to recognise episode pages — or its link is a YouTube video.
     Episodes live in Episode Guides / Drama Episodes / show pages,
     never in a news list. */
  const isEpisodeItem = (it) => {
    const t = String((it && it.title) || "");
    const l = String((it && it.link) || "");
    return /(?:Episode\s+\d+|Last Episode)\s*[—–-]\s*Watch on\b/i.test(t)
      || /youtube\.com\/watch|youtu\.be\//i.test(l);
  };

  /* Homepage and /news use the same taxonomy so regional Indian stories
     enter Bollywood and Pakistan never leaks into World Cinema. */
  const deriveTags = UI.deriveNewsTags;

  function render() {
    const list = (items || []).filter(it => f === "all" || (it.tags || []).includes(f)).slice(0, 600);
    fcount.textContent = list.length ? `${list.length} headline${list.length === 1 ? "" : "s"}` : "";
    if (!list.length) {
      /* Empty state (owner order 2026-10-28): when NO fresh news exists
         at all, say that plainly — a category with no fresh items keeps
         the category message instead. */
      wrap.innerHTML = UI.stateMsg(!(items || []).length
        ? "Pichle 15 din me koi nayi khabar nahi aayi."
        : "No headlines are listed in this category right now. Try another category.", false);
      return;
    }
    wrap.innerHTML = `<div class="editorial-grid">${list.map(it => {
      const tags = (Array.isArray(it.tags) ? it.tags : []).map(c => CATLABEL[c] || c);
      const meta = [tags.length ? tags.join(" · ") : "", Number.isFinite(it.ts) && it.ts > 0 ? UI.relTime(it.ts) : ""].filter(Boolean);
      return `<a class="editorial-card" href="${UI.newsItemPath(it)}">
        <span class="editorial-card__title">${UI.esc(it.title)}</span>
        ${meta.length ? `<span class="editorial-card__meta">${meta.map(UI.esc).join(" · ")}</span>` : ""}
      </a>`;
    }).join("")}</div>
`;
  }
  /* Custom in-page dropdown (user order 2026-10-27): a button showing
     the current category + a list panel that expands DOWNWARD directly
     below the button, inside the page — never a native <select>, which
     Chrome on Android phones renders as a modal popup dialog. Same
     .fa-select component as the Episode Guides drama filter: click
     toggles, click an option chooses + closes, click outside closes,
     Escape closes, arrows/Home/End move, Enter/Space chooses, typing
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

  const newsFilter = mountFaSelect(main.querySelector("#chipHost .filter-select"),
    [{ value: "all", label: "All" }, ...FILTERS.filter(([k]) => k !== "all").map(([k, label]) => ({ value: k, label }))],
    f, (k) => { f = k; UI.setParam("f", k === "all" ? "" : k); render(); });
  /* Back/forward buttons must move the dropdown too, like the chips did. */
  window.addEventListener("popstate", () => {
    const key = UI.getParam("f", "all");
    if (FILTERS.some(([k]) => k === key) && key !== f) { f = key; newsFilter.setValue(key); render(); }
  });

  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 9000);
    const r = await fetch("/api/news", { signal: ctl.signal });
    clearTimeout(to);
    if (!r.ok) throw new Error("news http " + r.status);
    const j = await r.json();
    if (!j.items || !j.items.length) throw new Error("news empty");
    /* Normalise feed categories to the page's labels: the feed still
       classifies some items "international" (shown here as World Cinema);
       Korea-only items keep no category label and appear under All. */
    /* NEWS WINDOW (owner orders 2026-10-28 + 2026-10-31): the feed
       carries the last 15 days of items (convert-news.py), and this
       See All page lists all of them (UI.isNewsSeeAll). The homepage
       keeps the 24 h rule (UI.isNewsFresh) \u2014 this page is the only
       15-day listing. */
    items = j.items.filter(it => !isEpisodeItem(it) && UI.isNewsSeeAll(it)).map(it => {
      const norm = {
        ...it,
        cats: (Array.isArray(it.cats) ? it.cats : []).map(c => c === "international" ? "world" : c).filter(c => c !== "korea")
      };
      norm.tags = deriveTags(norm);
      return norm;
    }).sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0) || String(a.id || "").localeCompare(String(b.id || "")));
    render();
  } catch (e) {
    wrap.innerHTML = UI.stateMsg("The news feed is unavailable right now. Please try again later.", false);
  }
})();

