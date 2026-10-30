/* FlickAtlas — Episode Guides hub (/episode-guides): the episode LIST.
   Drama episodes — every episode post, newest first, as a LIST (user
   order 2026-10-26): one row per episode, homepage .ep-row style
   (thumbnail LEFT + title/date RIGHT, same as the homepage Drama
   Episodes rail), NOT poster cards and NOT the old date-block rows.
   A drama filter (a CUSTOM in-page dropdown — a button + a panel that
   expands DOWNWARD inside the page) at the top narrows the list to
   one drama. It must NOT be a native <select>: Chrome on Android
   phones renders a native <select> as a modal popup dialog, and the
   user ordered a dropdown, not a popup. Reuses the site's .fa-select
   styles (same component as the Movies/Upcoming pages).
   detail page (/news-item?id=<article_id>). Episodes come from the
   YouTube episode tracker (scripts/episode-guides.py): each new episode
   gets an info post the same day, and the top episodes by views get an
   AI story summary added gradually.
   PAKISTANI DRAMAS ONLY (user order 2026-10-26): an episode appears
   here only when its drama is on the site's published Pakistani TV
   list (window.FA_PUBLISHED, type tv + industry pakistani). Tracker
   aliases: "Dar" = "Dar-E-Nijaat", "Zehar" = "Zehar-e-Mohabbat".
   Anything else (Bulbulay Season 2, an interview, an unlisted drama)
   is excluded from this list.
   Identification: primary = /out/episodes.json (the tracker's state
   file — drama, episode, channel, views, article_id, summary, all
   structured); fallback = FA_ARTICLES headline pattern
   "<Drama> Episode <N> — Watch on <channel>". */
(async function () {
  UI.mountChrome("/episode-guides");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Pakistani Drama Episode Guides | FlickAtlas",
    desc: "Browse published Pakistani drama episode updates with episode numbers, air dates and channel details where available. Coverage reflects recorded posts, not every broadcast.",
    path: "/episode-guides"
  });

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Drama — Episode Guides</h1>
      </div>
    <p class="fcount" id="fcount" aria-live="polite">Loading episodes…</p>
    <div id="chipHost"></div>
    <div id="guideHost"><div class="sk" style="height:280px;border-radius:22px"></div></div>
  </div>`;
  const fcount = main.querySelector("#fcount");
  const filterHost = main.querySelector("#chipHost");
  const host = main.querySelector("#guideHost");

  /* --- Pakistani Dramas only (user order 2026-10-26) -----------------
     The published list is window.FA_PUBLISHED (loaded on this page
     before this script). FALLBACK_PK_DRAMAS is the user-confirmed list
     of the 13 dramas, used only if that data file fails to load, so
     the filter never silently empties the page. */
  const DRAMA_ALIASES = { "dar": "Dar-E-Nijaat", "zehar": "Zehar-e-Mohabbat" };
  const FALLBACK_PK_DRAMAS = ["Aangan", "Bano", "Circle Story", "Dar-E-Nijaat",
    "Dastoor", "Izzat", "Khushi", "Mitti De Baway", "Mohabbat Mukhtasir",
    "Nashtar", "Rutba", "Uswah", "Zehar-e-Mohabbat"];
  const normName = (s) => String(s || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  function pkDramaMap() {
    const map = new Map();
    const pub = window.FA_PUBLISHED || {};
    for (const t of Object.values(pub)) {
      if (!t || t.type !== "tv" || UI.industryOf(t) !== "pakistani") continue;
      const name = String(t.title || "").trim();
      if (name) map.set(normName(name), name);
    }
    if (!map.size) for (const n of FALLBACK_PK_DRAMAS) map.set(normName(n), n);
    return map;
  }
  /* Canonical published drama name for a tracker/article drama name,
     or null when it is NOT a listed Pakistani drama (excluded). */
  function canonicalDrama(name, pkMap) {
    const n = normName(name);
    if (!n) return null;
    if (DRAMA_ALIASES[n]) {
      const target = DRAMA_ALIASES[n];
      return pkMap.has(normName(target)) ? target : null;
    }
    return pkMap.has(n) ? pkMap.get(n) : null;
  }
  const PK_MAP = pkDramaMap();

  /* One episode ROW — homepage Drama Episodes style (.ep-row):
     thumbnail LEFT + title/date RIGHT, side by side. Links to the
     episode's own detail page. The title is the episode headline
     ("<Drama> Episode <N> — Watch on <channel>"), exactly as the
     homepage rail shows it. */
  function epRow(e) {
    const epLabel = (e.isFinale && !e.episode) ? "Final Episode"
      : `Episode ${e.episode}${e.isFinale ? " (Finale)" : ""}`;
    const title = `${e.drama} ${epLabel} — Watch on ${e.channel}`;
    const href = `/news-item?id=${encodeURIComponent(e.articleId)}`;
    const air = e.published ? UI.fmtDate(e.published) : "";
    const meta = [air, e.channel].filter(Boolean).join(" · ");
    const thumb = e.thumb || "";
    return `<a class="ep-row" href="${href}">
      <span class="ep-thumb">${thumb ? UI.epThumbImg(thumb, title) : `<span class="noimg"><span>EP</span></span>`}</span>
      <span class="ep-info"><b>${UI.esc(title)}</b><span>${UI.esc(meta)}</span></span>
    </a>`;
  }

  /* Primary: /out/episodes.json — the tracker's state file. Each
     record carries drama, episode, channel, views, article_id and the
     summary; the thumbnail comes from the matching FA_ARTICLES entry
     (falling back to the YouTube thumbnail for the video id). Only
     listed Pakistani dramas survive (canonicalDrama). */
  async function episodesFromState() {
    try {
      const res = await fetch("/out/episodes.json", { cache: "no-store" });
      if (!res.ok) return null;
      const data = await res.json();
      const recs = Object.values((data && data.episodes) || {});
      if (!recs.length) return null;
      const arts = window.FA_ARTICLES || {};
      return recs.map(r => {
        const drama = canonicalDrama(r.drama || "", PK_MAP);
        if (!drama) return null;
        const a = arts[r.article_id] || null;
        const thumb = (a && a.images && a.images[0] && a.images[0].url)
          || (r.video_id ? `https://i.ytimg.com/vi/${r.video_id}/hqdefault.jpg` : "");
        return {
          drama, episode: r.episode, isFinale: !!r.is_finale,
          channel: r.channel || "", published: r.published || "",
          views: r.views || 0, summary: r.summary || "",
          articleId: r.article_id || "", thumb
        };
      }).filter(e => e && e.articleId && e.drama && e.episode != null);
    } catch (_) { return null; }
  }

  /* Fallback: FA_ARTICLES headline pattern
     "<Drama> Episode <N> — Watch on <channel>" (and the "<Drama> -
     Last Episode" finale form). Views come from the article facts,
     the summary from the "Story Summary" body section. Only listed
     Pakistani dramas survive (canonicalDrama). */
  function episodesFromArticles() {
    const arts = Object.values(window.FA_ARTICLES || {});
    const out = [];
    for (const a of arts) {
      if (!a || a.type !== "news") continue;
      const h = String(a.headline || "");
      const wm = h.match(/^(.*?)\s+[—–-]\s+Watch on\s+(.+)$/i);
      if (!wm) continue;
      const left = wm[1].trim();
      const em = left.match(/^(.+?)\s+Episode\s+(\d+)$/i);
      const fm = !em && left.match(/^(.+?)\s+[—–-]?\s*Last Episode$/i);
      if (!em && !fm) continue;
      const rawDrama = (a.entities && a.entities.titles && a.entities.titles[0]) || (em ? em[1].trim() : fm[1].trim());
      const drama = canonicalDrama(rawDrama, PK_MAP);
      if (!drama) continue;
      const channel = (a.images && a.images[0] && a.images[0].source) || wm[2].trim();
      const thumb = (a.images && a.images[0] && a.images[0].url) || "";
      let views = 0;
      const vf = (a.facts || []).find(f => /YouTube views:/i.test(String(f)));
      if (vf) { const vm = String(vf).match(/([\d,]+)/); if (vm) views = parseInt(vm[1].replace(/,/g, ""), 10) || 0; }
      let summary = "";
      const ss = (a.body || []).find(s => s && s.h === "Story Summary");
      if (ss && ss.p && ss.p.length) summary = ss.p.join("\n\n");
      out.push({
        drama, episode: em ? parseInt(em[2], 10) : 0, isFinale: !!fm,
        channel, published: a.published || "", views, summary,
        articleId: a.id || "", thumb
      });
    }
    return out.filter(e => e.articleId && e.drama);
  }

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

  try {
    let eps = await episodesFromState();
    if (!eps || !eps.length) eps = episodesFromArticles();
    const publishedMs = value => { const ms = Date.parse(value || ""); return Number.isFinite(ms) ? ms : 0; };
    eps.sort((a, b) => publishedMs(b.published) - publishedMs(a.published)
      || ((b.episode || 0) - (a.episode || 0))
      || String(a.articleId || "").localeCompare(String(b.articleId || "")));
    if (!eps.length) {
      fcount.textContent = "No episode guides yet.";
      host.innerHTML = UI.stateMsg("No drama episodes have been published yet. New episodes appear here as they air on YouTube.", false);
      return;
    }
    /* Drama filter (user order 2026-10-26, rebuilt 2026-10-27 as a
       CUSTOM in-page dropdown): a button + a panel expanding
       DOWNWARD inside the page — never a native <select>, which
       Chrome on Android phones renders as a modal popup dialog.
       Options are the listed Pakistani dramas that have episodes,
       sorted; "All Dramas" is default. Filter logic unchanged. */
    let activeDrama = "";
    const dramas = [...new Set(eps.map(e => e.drama))].sort((a, b) => a.localeCompare(b));
    const renderList = () => {
      const list = activeDrama ? eps.filter(e => e.drama === activeDrama) : eps;
      fcount.textContent = `${list.length} episode${list.length === 1 ? "" : "s"}${activeDrama ? ` · ${activeDrama}` : ""}`;
      host.innerHTML = list.length
        ? `<div class="tl-list">${list.map(epRow).join("")}</div>`
        : UI.stateMsg("No episodes for this drama yet.", false);
    };
    filterHost.innerHTML = `<div class="listing-select-row listing-select-row--single"><div class="filter-select" role="group" aria-labelledby="dramaFilterLabel"><span id="dramaFilterLabel">Drama</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="dramaTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="dramaOptions" aria-labelledby="dramaFilterLabel dramaValue"><span class="fa-select-value" id="dramaValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="dramaOptions" role="listbox" aria-labelledby="dramaFilterLabel" hidden></div></div></div></div>`;
    mountFaSelect(filterHost.querySelector(".filter-select"),
      [{ value: "", label: "All Dramas" }, ...dramas.map(d => ({ value: d, label: d }))],
      "", (value) => { activeDrama = value; renderList(); });
    renderList();
  } catch (e) {
    fcount.textContent = "Episode guides could not be loaded.";
    host.innerHTML = UI.stateMsg("Could not load episode guides. Please try again.");
  }
})();

