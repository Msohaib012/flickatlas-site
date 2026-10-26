/* FlickAtlas — shared UI: header/footer chrome, cards, formatting, SEO.
   Plain multi-page site (no SPA): every page is a real URL, this file only
   renders the shared chrome and provides helpers. */
const UI = (() => {
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const img = (path, size = "w500") => path ? `${CONFIG.IMG}/${size}${path}` : "";
  const qs = (obj) => new URLSearchParams(Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();
  if (typeof document.addEventListener === "function") document.addEventListener("error", event => {
    const failed = event.target;
    if (!failed || failed.tagName !== "IMG") return;
    const host = failed.parentElement;
    if (!host || !host.matches(".card-poster,.person-photo") || host.querySelector(".noimg")) return;
    const fallback = document.createElement("span"), letters = document.createElement("span");
    fallback.className = "noimg" + (host.matches(".person-photo") ? " round" : "");
    fallback.setAttribute("aria-label", "Artwork unavailable");
    letters.textContent = initials((failed.alt || "FlickAtlas").replace(/ poster$/, ""));
    fallback.appendChild(letters); host.insertBefore(fallback, failed);
  }, true);
  const pageQuery = () => new URLSearchParams(location.search);
  /* Source-aware navigation: bounded URLs, same-origin returns, natural history. */
  const detailPaths = new Set(['/movie','/show','/person','/news-item','/box-office-day']);
  const localRoutes = new Set(['/','/movies','/tv','/movie','/show','/person','/search','/category','/news','/news-item','/box-office','/box-office-day','/upcoming','/most-awaited','/trailers','/celebrities','/celebrity-today','/ott','/episode-guides','/where-to-watch','/airing-today','/awards','/about','/privacy','/contact','/dmca','/terms']);
  const routePath = path => path === '/index.html' ? '/' : path.replace(/\.html$/, '');
  const navigationFallback = () => ({'/movie':'/movies?f=bollywood','/show':'/tv','/person':'/celebrities','/news-item':'/news','/box-office-day':'/box-office'}[routePath(location.pathname)] || '/');
  function safeMovieSource(value) {
    if (!value || typeof value !== 'string' || /^[\s\\]*[\\/]{2}/.test(value) || /[\r\n\\]/.test(value)) return '';
    try {
      const u = new URL(value, location.origin);
      if (u.origin !== location.origin || u.username || u.password || !localRoutes.has(routePath(u.pathname))) return '';
      return u.pathname + u.search + u.hash;
    } catch (_) { return ''; }
  }
  const navStorageKey = 'fa_navigation_v1';
  function navigationRecords() { try { return JSON.parse(sessionStorage.getItem(navStorageKey) || '{}'); } catch (_) { return {}; } }
  function writeNavigationRecords(records) { try { sessionStorage.setItem(navStorageKey, JSON.stringify(records)); } catch (_) {} }
  function cleanNavigationUrl(value) {
    const safe = safeMovieSource(value); if (!safe) return '';
    const u = new URL(safe, location.origin); u.searchParams.delete('from'); u.searchParams.delete('via');
    return u.pathname + u.search + u.hash;
  }
  function returnContext() {
    const current = location.pathname + location.search + location.hash;
    const params = new URLSearchParams(location.search), records = navigationRecords(), record = records[params.get('via')];
    if (record && Date.now() - record.at < 7200000 && record.target.split('#')[0] === cleanNavigationUrl(current).split('#')[0]) {
      const source = safeMovieSource(record.source);
      if (source && cleanNavigationUrl(source) !== cleanNavigationUrl(current)) return {url:source,record};
    }
    const explicit = cleanNavigationUrl(params.get('from'));
    if (explicit && explicit !== cleanNavigationUrl(current)) return {url:explicit};
    const referring = cleanNavigationUrl(document.referrer);
    if (referring && !detailPaths.has(routePath(new URL(referring,location.origin).pathname)) && referring !== cleanNavigationUrl(current)) return {url:referring};
    return {url:navigationFallback()};
  }
  function movieReturnUrl() { return returnContext().url; }
  function returnLabel(url) {
    const path = routePath(new URL(url, location.origin).pathname);
    const names = {'/':'Home','/movies':'Movies','/tv':'TV & Web Series','/search':'Search results','/category':'Category','/box-office':'Box Office','/upcoming':'Upcoming releases','/most-awaited':'Most Awaited','/trailers':'Trailers','/celebrities':'Celebrities','/celebrity-today':'Celebrity Today','/news':'News','/ott':'OTT releases','/episode-guides':'Episode guides','/awards':'Awards','/movie':'Movie details','/show':'Show details','/person':'Profile','/box-office-day':'Box Office details'};
    return '← ' + (names[path] || 'Back');
  }
  function movieReturnLabel() { return returnLabel(movieReturnUrl()); }
  let restorePending = null;
  function queueScrollRestore(context) {
    if (!context.record) return;
    try { sessionStorage.setItem('fa_restore_navigation_v1',JSON.stringify({url:context.url,y:context.record.y || 0,at:Date.now()})); } catch (_) {}
  }
  function restoreNavigationScroll() {
    if (restorePending === null) {
      try { restorePending = JSON.parse(sessionStorage.getItem('fa_restore_navigation_v1') || 'false'); } catch (_) { restorePending = false; }
    }
    if (!restorePending || restorePending.url !== location.pathname + location.search + location.hash || Date.now()-restorePending.at > 120000) return;
    const height = Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
    if (height < restorePending.y + (window.innerHeight || 0) - 4 && document.querySelector('#app .sk')) return;
    const y = restorePending.y; restorePending = false;
    try { sessionStorage.removeItem('fa_restore_navigation_v1'); } catch (_) {}
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => window.scrollTo({top:y,behavior:'instant'}));
  }
  const backSelector = '.fa-return-link,.article-crumb > a:first-child,.bo-detail-back > a';
  function refreshReturnNavigation(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    const app = root.id === 'app' ? root : root.querySelector('#app');
    if (app) {
      let back = app.querySelector(backSelector);
      const params = new URLSearchParams(location.search), context = returnContext();
      if (!back && routePath(location.pathname) !== '/' && (params.has('from') || params.has('via'))) {
        const nav = document.createElement('nav'); nav.className = 'fa-return-nav';
        back = document.createElement('a'); back.className = 'fa-return-link'; nav.appendChild(back);
        const wrap = app.querySelector('.wrap') || app; wrap.insertBefore(nav,wrap.firstChild);
      }
      if (back) {
        back.classList.add('fa-return-link');
        const label = returnLabel(context.url);
        if (back.getAttribute('href') !== context.url) back.setAttribute('href',context.url);
        if (back.textContent !== label) back.textContent = label;
        if (back.getAttribute('aria-label') !== 'Back to ' + label.replace(/^←\s*/,'')) back.setAttribute('aria-label','Back to ' + label.replace(/^←\s*/,''));
      }
    }
    root.querySelectorAll('.section-head .see-all').forEach(a => {
      const heading = a.closest('.section-head')?.querySelector('h1,h2,h3')?.textContent?.trim();
      if (heading && a.getAttribute('aria-label') !== `See all ${heading}`) a.setAttribute('aria-label',`See all ${heading}`);
    });
    restoreNavigationScroll();
  }
  if (typeof document.addEventListener === 'function') document.addEventListener('click', event => {
    const a = event.target?.closest?.('a[href]'); if (!a || a.hasAttribute('download')) return;
    if (a.matches(backSelector)) {
      const context = returnContext(); a.setAttribute('href',context.url);
      if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || a.target && a.target !== '_self') return;
      let previous = '';
      try { const entries = window.navigation?.entries?.() || [], index = entries.findIndex(e=>e.key===window.navigation.currentEntry?.key); previous = index > 0 ? safeMovieSource(entries[index-1].url) : ''; } catch (_) {}
      queueScrollRestore(context); event.preventDefault();
      if (previous === context.url && history.length > 1) history.back();
      else location.replace(context.url);
      return;
    }
    if (event.defaultPrevented) return;
    let target; try { target = new URL(a.getAttribute('href'),location.href); } catch (_) { return; }
    if (target.origin !== location.origin || !localRoutes.has(routePath(target.pathname))) return;
    if (target.pathname === location.pathname && target.search === location.search) return;
    const source = safeMovieSource(location.pathname + location.search + location.hash);
    if (!source || cleanNavigationUrl(source) === cleanNavigationUrl(target.pathname+target.search+target.hash)) return;
    const at = Date.now(), key = at.toString(36) + Math.random().toString(36).slice(2,9), records = navigationRecords();
    Object.keys(records).sort((a,b)=>(records[b].at||0)-(records[a].at||0)).slice(79).forEach(k=>delete records[k]);
    records[key] = {source,target:cleanNavigationUrl(target.pathname+target.search+target.hash),y:window.scrollY||0,at};
    writeNavigationRecords(records);
    target.searchParams.set('from',cleanNavigationUrl(source)); target.searchParams.set('via',key);
    a.setAttribute('href',target.pathname+target.search+target.hash);
  },true);
  if (typeof document.querySelectorAll === 'function') {
    refreshReturnNavigation(document);
    if (typeof MutationObserver !== 'undefined' && document.documentElement) new MutationObserver(()=>refreshReturnNavigation(document)).observe(document.documentElement,{childList:true,subtree:true});
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pageshow',()=>{restorePending=null;refreshReturnNavigation(document)});
    window.addEventListener('popstate',()=>refreshReturnNavigation(document));
  }
  const titleOf = (d) => d.title || d.name || "Untitled";
  const yearOf = (d) => String(d.release_date || d.first_air_date || "").slice(0, 4);
  const rating = (d) => d.vote_average ? Math.round(d.vote_average * 10) / 10 : "";
  const star = '<svg class="star-ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z"/></svg>';

  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const MONTHS_L = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  function fmtDate(s) {
    if (!s) return "";
    const str = String(s).slice(0, 10);
    const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return "";
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return "";
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return "";
    return `${d} ${MONTHS_L[mo - 1]} ${y}`;
  }
  const ratingText = (d) => { const r = rating(d); return r ? `${r}/10` : ""; };
  /* Industry label from a title's original language — used in mixed feeds */
  function industryTag(item) {
    const l = (item && item.original_language) || "";
    const countries = item?.origin_country || item?.production_countries?.map(c => c.iso_3166_1) || [];
    if (item?._ind === "lollywood" || item?._ind === "pakistani" || item?._countryQuery === "PK" || countries.includes("PK")) return "Pakistani";
    if (l === "hi") return "Bollywood";
    if (l === "ur") return "Pakistani";
    return "World Cinema";
  }
  function monthLabel(s) {
    const [y, m] = String(s || "").split("-");
    return y && m ? `${MONTHS_L[parseInt(m, 10) - 1]} ${y}` : "";
  }
  function fmtRuntime(min) {
    if (!min) return "";
    const h = Math.floor(min / 60), m = min % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
  }
  /* ---------- Currency switcher ----------
     All money data stays USD; the fmtMoney* helpers convert at display
     time into the visitor's chosen currency (USD / INR / PKR, persisted
     in localStorage "fa_ccy", applied from first render). Each figure
     is emitted as a tagged span (data-usd + data-kind), so a tap on the
     header switcher re-converts every figure on the page in place — no
     reload. Rates live in js/config.js (FA_RATES). USD formatting is
     exactly as before; INR/PKR compact uses the local style (grouped
     thousands below 1 lakh, "X lakh", "X crore"); INR/PKR full figures
     use Indian digit grouping. */
  const CCYS = ["USD", "INR", "PKR"];
  const RATES = (typeof FA_RATES !== "undefined" && FA_RATES) || { USD: 1, INR: 94.65, PKR: 276.9, asOf: "23 October 2026" };
  let ccy = "USD";
  try { const s = localStorage.getItem("fa_ccy"); if (CCYS.indexOf(s) >= 0) ccy = s; } catch (e) {}
  const getCcy = () => ccy;
  let industryContext = "";
  function setIndustryContext(industry) {
    industryContext = industry === "bollywood" ? "bollywood" : "";
    if (document.body) document.body.dataset.industry = industryContext;
  }
  function trimNum(x, dp) {
    const f = Math.pow(10, dp);
    return String(Math.round(x * f) / f);
  }
  function moneyPlain(n, kind) {
    if (n === 0) return ccy === "USD" ? "$0" : ccy === "INR" ? "₹0" : "Rs 0";
    if (!n || n <= 0) return "";
    const v = n * (RATES[ccy] || 1);
    if (ccy === "USD") {
      if (kind === "full") return "$" + n.toLocaleString("en-US");
      if (kind === "words") {
        if (n >= 1e9) { const x = n / 1e9; return "$" + (Number.isInteger(x) ? x : x.toFixed(2).replace(/\.?0+$/, "")) + " billion"; }
        if (n >= 1e6) { const x = n / 1e6; return "$" + (Number.isInteger(x) ? x : Math.round(x * 10) / 10) + " million"; }
        if (n >= 1e3) return "$" + Math.round(n / 1e3) + " thousand";
        return "$" + n.toLocaleString("en-US");
      }
      if (n >= 1e9) return "$" + (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
      if (n >= 1e6) return "$" + (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
      if (n >= 1e3) return "$" + Math.round(n / 1e3) + "K";
      return "$" + n.toLocaleString("en-US");
    }
    const sym = ccy === "INR" ? "₹" : "Rs ";
    if (kind === "full") return sym + Math.round(v).toLocaleString("en-IN");
    if (v >= 1e7) return sym + trimNum(v / 1e7, 2) + " crore";
    if (v >= 1e5) return sym + trimNum(v / 1e5, 2) + " lakh";
    return sym + Math.round(v).toLocaleString("en-IN");
  }
  function moneySpan(n, kind) {
    const t = moneyPlain(n, kind);
    if (!t) return "";
    return `<span class="fa-money" data-usd="${n}" data-kind="${kind}">${esc(t)}</span>`;
  }
  function fmtMoney(n) { return moneySpan(n, "compact"); }
  function fmtMoneyFull(n) { return moneySpan(n, "full"); }
  /* Prose form for sentences and fact lists: "$225 million", "$2.52 billion" */
  function fmtMoneyWords(n) { return moneySpan(n, "words"); }
  /* Escape composed prose while preserving money spans (their text is
     formatter output from numeric input only, so it is safe markup). */
  const MONEY_SPAN_RE = /(<span class="fa-money" data-usd="[\d.]+" data-kind="[a-z]+">[^<]*<\/span>)/g;
  function escRich(s) {
    return String(s == null ? "" : s).split(MONEY_SPAN_RE)
      .map((part, i) => (i % 2 === 1 ? part : esc(part))).join("");
  }
  function stripTags(s) { return String(s == null ? "" : s).replace(/<[^>]*>/g, ""); }
  function refreshMoneyEl(el) {
    const t = moneyPlain(parseFloat(el.getAttribute("data-usd")), el.getAttribute("data-kind") || "compact");
    if (t && el.textContent !== t) el.textContent = t;
  }
  function refreshMoneySpans(root) {
    (root || document).querySelectorAll(".fa-money").forEach(refreshMoneyEl);
  }
  function setCcy(c, persist = true) {
    if (CCYS.indexOf(c) < 0) return;
    ccy = c;
    if (persist) { try { localStorage.setItem("fa_ccy", c); } catch (e) {} }
    document.querySelectorAll("[data-ccy]").forEach(b => {
      const on = b.getAttribute("data-ccy") === c;
      b.classList.toggle("on", on);
      if (b.getAttribute("role") === "menuitemradio") b.setAttribute("aria-checked", String(on));
      else b.setAttribute("aria-pressed", String(on));
    });
    document.querySelectorAll("[data-currency-code]").forEach(el => { el.textContent = c; });
    document.querySelectorAll("[data-currency-trigger]").forEach(el => { el.setAttribute("aria-label", "Display currency: " + c); });
    document.querySelectorAll("[data-currency-select]").forEach(select => { select.value = c; });
    refreshMoneySpans(document);
  }
  /* Content swapped in after a switch (tab panels, async sections) can
     carry spans rendered under an earlier choice — keep every .fa-money
     span in sync with the current currency. */
  let moneyObsOn = false;
  function watchMoney() {
    if (moneyObsOn || typeof MutationObserver === "undefined" || !document.body) return;
    moneyObsOn = true;
    new MutationObserver(muts => {
      for (const m of muts) for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.classList && node.classList.contains("fa-money")) refreshMoneyEl(node);
        if (node.querySelectorAll) node.querySelectorAll(".fa-money").forEach(refreshMoneyEl);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }
  function rateNote() {
    return `<details class="ccy-note"><summary>Currency reference rates</summary><p>$1 = ₹${RATES.INR} / Rs ${RATES.PKR} · ${RATES.asOf}. Display conversion only.</p></details>`;
  }
  /* Availability info (TEXT ONLY — names of platforms per region, never links).
     Input: details["watch/providers"].results keyed by country code. */
  const REGIONS = [["US", "United States"], ["IN", "India"], ["PK", "Pakistan"], ["GB", "United Kingdom"]];
  function providerLines(providers) {
    if (!providers || !providers.results) return [];
    const res = providers.results;
    const names = (arr, cap = 4) => [...new Set((arr || []).map(p => p.provider_name).filter(Boolean))].slice(0, cap);
    const lineFor = (entry) => {
      if (!entry) return "";
      const parts = [];
      const s = names(entry.flatrate); if (s.length) parts.push("Stream: " + s.join(", "));
      const r = names(entry.rent); if (r.length) parts.push("Rent: " + r.join(", "));
      const b = names(entry.buy); if (b.length) parts.push("Buy: " + b.join(", "));
      return parts.join(" · ");
    };
    const out = [];
    for (const [code, label] of REGIONS) {
      const t = lineFor(res[code]);
      if (t) out.push([label, t]);
    }
    if (!out.length) {
      for (const code of Object.keys(res)) {
        const t = lineFor(res[code]);
        if (t) { out.push([code, t]); break; }
      }
    }
    return out;
  }
  /* Day-Wise Box Office table — renders ONLY when real rows exist.
     The live data engine (a later phase) supplies rows via window.FA_DAYWISE
     (see js/daywise-data.js); TMDB itself has no day-wise data, so until the
     engine lands this returns "" and the section is completely absent.
     rows: [{ date: "2026-07-29", day: "Day 1", collection: 40200000 }]
     opts.titleId links every row's day to its own per-day page (§6.5);
     opts.highlight marks one day's row (used on the per-day page itself). */
  function dayNumOf(rw, idx) {
    const m = String((rw && rw.day) || "").match(/(\d+)/);
    return m ? parseInt(m[1], 10) : idx + 1;
  }
  function bollywoodRows(rows) {
    const today = new Date().toISOString().slice(0, 10), seen = new Set();
    return rows.map((r, i) => ({ ...r, _day: dayNumOf(r, i) })).filter(r => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || "") || r.date > today ||
        !Number.isFinite(Date.parse(r.date + "T00:00:00Z")) || new Date(r.date + "T00:00:00Z").toISOString().slice(0, 10) !== r.date ||
        typeof r.collection !== "number" || !Number.isFinite(r.collection) || r.collection < 0 || seen.has(r._day)) return false;
      seen.add(r._day); return true;
    }).sort((a, b) => a._day - b._day).map(({ _day, ...r }) => ({ ...r, day: `Day ${_day}` }));
  }
  function daywiseCard(rows, heading, opts) {
    if (!Array.isArray(rows) || !rows.length) return "";
    const o = opts || {};
    const clean = bollywoodRows(rows);
    const body = clean.map((rw, idx) => {
      const n = dayNumOf(rw, idx);
      const dayCell = o.titleId
        ? `<a href="/box-office-day?title=${encodeURIComponent(o.titleId)}&day=${n}"><b>${esc(rw.day || ("Day " + n))}</b></a>`
        : esc(rw.day || "");
      return `<tr${o.highlight === n ? ' class="dw-hl"' : ""}><td>${esc(fmtDate(rw.date))}</td><td>${dayCell}</td><td><b>${fmtMoney(rw.collection)}</b></td></tr>`;
    }).join("");
    if (!body) return "";
    return `<div class="content-card"><h2>${esc(heading || "Day-Wise Box Office")}</h2>
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Date</th><th>Day</th><th>Collection</th></tr></thead>
        <tbody>${body}</tbody></table></div>
      <p class="prov-note">${industryContext === "bollywood" ? "Available dated collection records. Territory and gross/net basis are not supplied in this dataset; figures are not independently reconciled here." : "Day-wise worldwide collections, as reported by the FlickAtlas data engine."}${o.titleId ? " Open any day for its own collection page." : ""}</p></div>`;
  }

  /* ---------- Freshness window (MASTER §7.6, correction round) ----------
     Listings show only titles released within the last 3 months, or with a
     future (upcoming) date. Items without a date never qualify. */
  function freshCutoff() {
    const d = new Date();
    d.setMonth(d.getMonth() - 3);
    return d.toISOString().slice(0, 10);
  }
  function isFresh(item) {
    const dt = (item && (item.release_date || item.first_air_date)) || "";
    return !!dt && dt >= freshCutoff();
  }
  /* News items (MASTER §6.6): stable id = FNV-1a hash of the source link,
     identical to the id /api/news assigns server-side; the /news-item path
     is where every headline on the site links. */
  function newsId(it) {
    if (!it) return "";
    if (it.id) return String(it.id);
    let h = 0x811c9dc5;
    const s = String(it.link || "");
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }
  function newsItemPath(it) { return "/news-item?id=" + encodeURIComponent(newsId(it)); }
  /* Show more / show less toggle for long cast lists and biographies */
  function toggleMore(btn) {
    const t = document.getElementById(btn.getAttribute("data-target"));
    if (!t) return;
    const open = t.classList.toggle("open");
    btn.textContent = open ? (btn.getAttribute("data-less") || "Show Less") : (btn.getAttribute("data-more") || "Show More");
    btn.setAttribute("aria-expanded", String(open));
  }

  /* Box-office verdict — always an estimate from reported budget vs gross */
  function verdict(budget, revenue) {
    if (!budget || !revenue || budget <= 0 || revenue <= 0) return null;
    if (revenue >= 2.5 * budget) return { label: "Hit", cls: "hit" };
    if (revenue < budget) return { label: "Flop", cls: "flop" };
    return { label: "Average", cls: "avg" };
  }

  const LOGO = `<img class="logo-ic" src="/brand-mark.svg?v=fa-20261025b" alt="" aria-hidden="true" width="48" height="48">`;

  const NAV = [
    ["Movies", "/movies"], ["TV Shows", "/tv"], ["Box Office", "/box-office"],
    ["Upcoming", "/upcoming"], ["Celebrities", "/celebrities"],
    ["News", "/news"],
  ];

  function mountChrome(active = "") {
    const params = pageQuery();
    if (active !== "/box-office" && (params.get("cat") === "bollywood" || params.get("f") === "bollywood")) setIndustryContext("bollywood");
    watchMoney();
    const nav = document.getElementById("site-nav");
    if (nav) {
      nav.innerHTML = `<a class="skip-link" href="#app">Skip to content</a><header class="site-head"><div class="wrap head-in">
        <a class="brand" href="/" aria-label="FlickAtlas home">${LOGO}<span class="brand-name">Flick<em>Atlas</em></span></a>
        <button class="nav-toggle" id="navToggle" aria-label="Open menu" aria-expanded="false" aria-controls="mainNav">
          <svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/></svg>
        </button>
        <nav class="main-nav" id="mainNav" aria-label="Main navigation">
          ${NAV.map(([t, h]) => `<a href="${h}"${active === h ? ' class="on" aria-current="page"' : ""}>${t}</a>`).join("")}
        </nav>
        <form class="head-search" action="/search" method="get" role="search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10 2a8 8 0 1 0 4.9 14.3l5 5 1.5-1.4-5-5A8 8 0 0 0 10 2zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12z"/></svg>
          <input type="search" name="q" placeholder="Search movies, TV, people…" aria-label="Search FlickAtlas" required>
        </form>
        <div class="ccy-switch ccy-menu" data-currency-control>
          <button type="button" class="currency-trigger" data-currency-trigger id="currencyTrigger" aria-label="Display currency: ${ccy}" aria-haspopup="menu" aria-controls="currencyMenu" aria-expanded="false"><span data-currency-code>${ccy}</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <div class="currency-menu-panel" id="currencyMenu" role="menu" aria-labelledby="currencyTrigger" hidden>${CCYS.map(c => `<button type="button" role="menuitemradio" class="currency-option${c===ccy?' on':''}" data-ccy="${c}" aria-checked="${c===ccy}" tabindex="-1"><span><b>${c}</b><small>${{USD:"US dollar",INR:"Indian rupee",PKR:"Pakistani rupee"}[c]}</small></span><span class="currency-symbol" aria-hidden="true">${{USD:"$",INR:"₹",PKR:"Rs"}[c]}</span></button>`).join("")}</div>
        </div>
      </div></header>`;
      const currencyControl=nav.querySelector("[data-currency-control]"), currencyTrigger=nav.querySelector("[data-currency-trigger]"), currencyMenu=nav.querySelector("#currencyMenu"), currencyOptions=[...currencyMenu.querySelectorAll("[data-ccy]")];
      const closeCurrency=(focus=false)=>{currencyMenu.hidden=true;currencyTrigger.setAttribute("aria-expanded","false");if(focus)currencyTrigger.focus();};
      const openCurrency=()=>{currencyMenu.hidden=false;currencyTrigger.setAttribute("aria-expanded","true");(currencyOptions.find(b=>b.dataset.ccy===ccy)||currencyOptions[0]).focus();};
      currencyTrigger.addEventListener("click",()=>currencyMenu.hidden?openCurrency():closeCurrency(true));
      currencyMenu.addEventListener("click",e=>{const b=e.target.closest("[data-ccy]");if(!b)return;setCcy(b.dataset.ccy);closeCurrency(true);});
      currencyControl.addEventListener("keydown",e=>{if(e.key==="Escape"){closeCurrency(true);e.preventDefault();return;}if(e.key==="Tab"){closeCurrency();return;}if(["ArrowDown","ArrowUp","Home","End"].includes(e.key)){e.preventDefault();if(currencyMenu.hidden){openCurrency();return;}const i=currencyOptions.indexOf(document.activeElement);const next=e.key==="Home"?0:e.key==="End"?currencyOptions.length-1:(i+(e.key==="ArrowDown"?1:-1)+currencyOptions.length)%currencyOptions.length;currencyOptions[next].focus();}});
      currencyControl.addEventListener("focusout",e=>{if(e.relatedTarget&&!currencyControl.contains(e.relatedTarget))closeCurrency();});
      document.addEventListener("click",e=>{if(!currencyControl.contains(e.target))closeCurrency();});
      window.addEventListener("storage",e=>{if(e.key==="fa_ccy"&&CCYS.includes(e.newValue))setCcy(e.newValue, false);});
      const tg = nav.querySelector("#navToggle");
      const menu = nav.querySelector("#mainNav");
      const setMenu = (open) => {
        menu.classList.toggle("open", open);
        tg.setAttribute("aria-expanded", String(open));
        tg.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      };
      tg.addEventListener("click", () => setMenu(!menu.classList.contains("open")));
      menu.addEventListener("click", (e) => { if (e.target.closest("a")) setMenu(false); });
      nav.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && menu.classList.contains("open")) { setMenu(false); tg.focus(); }
      });
    }
    const foot = document.getElementById("site-foot");
    if (foot) {
      foot.innerHTML = `<footer class="site-foot"><div class="wrap foot-grid">
        <div class="foot-brand">
          <a class="brand light" href="/">${LOGO}<span class="brand-name">Flick<em>Atlas</em></span></a>
          <p>Explore movies, series and the people behind them. Find credits, release dates and reported box office.</p>
        </div>
        <details class="foot-col" open><summary>Explore</summary><div class="foot-links">
          <a href="/movies">Movies</a><a href="/tv">TV &amp; Web Series</a><a href="/box-office">Box Office</a>
          <a href="/upcoming">Upcoming &amp; Release Dates</a><a href="/most-awaited?f=bollywood">Coming Soon &amp; Most Awaited</a><a href="/trailers">Trailers</a><a href="/celebrities">Celebrities</a>
          <a href="/episode-guides">Episode Guides</a><a href="/airing-today">Airing Today</a>
          <a href="/where-to-watch">Where to Watch</a><a href="/ott">OTT Releases This Week</a>
          <a href="/awards">Awards</a>
          <a href="/news">Industry News</a><a href="/search">Search</a></div></details>
        <details class="foot-col" open><summary>Industries</summary><div class="foot-links">
          <a href="/category?cat=bollywood">Bollywood</a><a href="/category?cat=world">World Cinema</a>
          <a href="/category?cat=lollywood">Lollywood</a>
          <a href="/episode-guides">Pakistani YouTube Dramas</a></div></details>
        <details class="foot-col" open><summary>Company &amp; Legal</summary><div class="foot-links">
          <a href="/about">About Us</a><a href="/privacy">Privacy Policy</a><a href="/terms">Terms &amp; Conditions</a><a href="/dmca">DMCA &amp; Copyright</a><a href="/contact">Contact</a></div></details>
      </div>
      <div class="wrap foot-base">
        <span>© ${new Date().getFullYear()} FlickAtlas. All rights reserved.</span>
        <span class="foot-note">Data &amp; artwork via TMDB. Box office verdicts are estimates.</span>
      </div></footer>`;
      const compactFooter = window.matchMedia("(max-width:900px)");
      const setFooterMode = () => foot.querySelectorAll("details.foot-col").forEach(group => { group.open = !compactFooter.matches; });
      setFooterMode();
      if (compactFooter.addEventListener) compactFooter.addEventListener("change", setFooterMode);
    }
  }

  function initials(name) {
    return String(name || "?").trim().split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase() || "?";
  }

  /* Celebrity Today — engine-fed (v2-classified registry feeds, TMDB-
     verified names; wording slot-composed by the engine). Renders ONLY
     items that are genuinely fresh (< 24h old) with celebrity/what/when
     filled; anything else returns "" so the homepage falls back to its
     honestly-named "Celebrities in Spotlight" rail — stale items are
     never dressed up as today's news. */
  /* Celebrity Today items carry no id in the engine export — their stable
     id is the FNV-1a hash of the source story URL (same scheme as news),
     computed identically here and on the event page. */
  /* ---------- Box-office PERIODS (correction 8): Today / 7 Days /
     30 Days figures computed ONLY from real engine day-wise rows
     (FA_DAYWISE) — latest row = Today, trailing rows summed for the
     windows. A title without day-wise data has NO period figures and
     appears only under Lifetime. Nothing is ever estimated here. */
  function boPeriodData() {
    const dw = window.FA_DAYWISE || {};
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = days => { const d = new Date(today + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - days + 1); return d.toISOString().slice(0, 10); };
    const sum = arr => arr.reduce((s, r) => s + r.collection, 0);
    return Object.entries(dw)
      .filter(([, rows]) => Array.isArray(rows) && rows.length)
      .map(([id, rows]) => {
        rows = bollywoodRows(rows).sort((a, b) => a.date.localeCompare(b.date));
        if (!rows.length) return null;
        const dayRows = rows.filter(r => r.date === today), week = rows.filter(r => r.date >= cutoff(7)), month = rows.filter(r => r.date >= cutoff(30));
        const last = dayRows[dayRows.length - 1];
        return { id, rows, days: rows.length,
          today: sum(dayRows), todayDate: last?.date || "", todayDay: last ? dayNumOf(last, rows.indexOf(last)) : null,
          todayCount: dayRows.length, d7Count: week.length, d30Count: month.length,
          d7: sum(week), d30: sum(month), total: sum(rows),
          firstDay: dayNumOf(rows[0], 0) };
      }).filter(Boolean);
  }
  /* Ranked period rows; detailsMap = { tmdbId: TMDB details } for art/titles. */
  function boPeriodHtml(periodKey, detailsMap) {
    const data = boPeriodData().filter(p => detailsMap[p.id] && p[periodKey === "today" ? "todayCount" : periodKey === "d7" ? "d7Count" : "d30Count"] > 0);
    if (!data.length) return "";
    const val = (p) => periodKey === "today" ? p.today : periodKey === "d7" ? p.d7 : p.d30;
    const sorted = data.slice().sort((a, b) => val(b) - val(a));
    const max = Math.max(...sorted.map(val), 1);
    const sub = (p) => periodKey === "today"
      ? `Today · Day ${p.todayDay}${p.todayDate ? ` · ${fmtDate(p.todayDate)}` : ""} · Recorded sum ${fmtMoney(p.total)}`
      : periodKey === "d7"
        ? `Last 7 calendar days · ${p.d7Count} recorded rows · Recorded sum ${fmtMoney(p.total)}`
        : `Last 30 calendar days · ${p.d30Count} recorded rows · Recorded sum ${fmtMoney(p.total)}`;
    return `<div class="bo-panel">${sorted.map(p => { const d = detailsMap[p.id]; return `
      <div class="bo-row">
        <a href="/movie?id=${d.id}"><img src="${img(d.poster_path, "w92")}" alt="" loading="lazy" onerror="this.remove()"></a>
        <div><a class="bo-title" href="/movie?id=${d.id}">${esc(titleOf(d))}</a>
          <div class="bo-bars"><div class="bo-bar"><span style="width:118px">${periodKey === "today" ? "Today" : periodKey === "d7" ? "7 Days" : "30 Days"}</span><span class="track"><span class="fill gross" style="width:${Math.max(4, val(p) / max * 100)}%"></span></span><span>${fmtMoney(val(p))}</span></div></div>
          <div style="color:var(--muted);font-size:.8rem;margin-top:3px">${sub(p)}</div></div>
        <div class="bo-amt"><b>${fmtMoney(val(p))}</b><span>${periodKey === "today" ? "today" : periodKey === "d7" ? "last 7 days" : "last 30 days"}</span></div>
      </div>`; }).join("")}
      <p style="margin-top:12px;font-size:.8rem;color:var(--muted)">Period figures are sums of the reported day-wise collections tracked by the FlickAtlas data engine — titles without day-wise tracking appear under Lifetime only.</p>
    </div>`;
  }

  /* Daily Collection (audit round, ORDER I): the movie page's own
     day-wise table — Date / Day / Collection / running total, with the
     day cells linking to the per-day pages exactly as on the hub. */
  function dailyCollectionCard(rows, titleId) {
    if (!Array.isArray(rows) || !rows.length) return "";
    const clean = bollywoodRows(rows);
    if (!clean.length) return "";
    let run = 0;
    const body = clean.map((rw, idx) => {
      run += rw.collection || 0;
      const n = dayNumOf(rw, idx);
      return `<tr><td>${esc(fmtDate(rw.date))}</td><td><a href="/box-office-day?title=${encodeURIComponent(titleId)}&day=${n}"><b>${esc(rw.day || ("Day " + n))}</b></a></td><td><b>${fmtMoney(rw.collection)}</b></td><td>${fmtMoney(run)}</td></tr>`;
    }).join("");
    return `<div class="content-card"><h2>Daily Collection</h2>
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Date</th><th>Day</th><th>Collection</th><th>${industryContext === "bollywood" ? "Recorded Sum" : "Total So Far"}</th></tr></thead>
        <tbody>${body}</tbody></table></div>
      <p class="prov-note">${industryContext === "bollywood" ? "The running sum adds only the displayed records; missing dates are not estimated. Territory and gross/net basis are not specified in this data. Source-level reconciliation has not been independently verified here." : "Day-wise collections as reported by the FlickAtlas data engine"} — open any day for its own collection page.</p></div>`;
  }

  /* Explore More contains navigation, not descriptive keywords or measured trends. */
  function exploreLinksHtml(links) {
    if (!links.length) return "";
    return `<section class="section ts-block"><div class="section-head"><h2>Explore More</h2></div><p class="sec-sub">Jump to a section or search FlickAtlas for related records.</p><nav class="explore-grid" aria-label="Explore this page">${links.map(link => `<a class="explore-link" href="${esc(link.href)}"><span>${esc(link.label)}</span><span aria-hidden="true">→</span></a>`).join("")}</nav></section>`;
  }
  async function topSearchesHtml(entities) {
    return exploreLinksHtml([...new Set((entities || []).map(x => String(x || "").trim()).filter(Boolean))].slice(0, 5).map(title => ({label:`Search “${title}”`,href:`/search?q=${encodeURIComponent(title)}`})));
  }
  /* templates (3rd arg): "Top Searches" phrases, e.g. "Jailer 2 box office
     collection" — built by the caller from entities the page actually
     resolved to. Rendered as search links after the section links. */
  function mountTopSearches(main, entities, templates) {
    if (!main) return;
    const wrap = main.querySelector(".wrap") || main;
    if (wrap.querySelector(".ts-block")) return;
    const headings = [...main.querySelectorAll("h2,h3")].filter(heading => /facts|cast|crew|box office|where to watch|episode|filmography|related/i.test(heading.textContent));
    const combinedCrew = headings.some(heading => /cast.*crew/i.test(heading.textContent));
    const links = [], labels = new Set();
    for (const heading of headings) {
      const label = heading.textContent.trim();
      if (combinedCrew && /^crew$/i.test(label) || labels.has(label.toLowerCase())) continue;
      if (!heading.id) { let n = links.length + 1; while (document.getElementById(`explore-section-${n}`)) n++; heading.id = `explore-section-${n}`; }
      links.push({label,href:`#${encodeURIComponent(heading.id)}`}); labels.add(label.toLowerCase());
      if (links.length === 5) break;
    }
    const title = (entities || []).map(x => String(x || "").trim()).find(Boolean);
    if (title) links.push({label:`Search “${title}”`,href:`/search?q=${encodeURIComponent(title)}`});
    for (const t of (templates || [])) {
      const phrase = String(t || "").trim();
      if (!phrase || labels.has(phrase.toLowerCase())) continue;
      links.push({label: phrase, href: `/search?q=${encodeURIComponent(phrase)}`});
      labels.add(phrase.toLowerCase());
      if (links.length >= 12) break;
    }
    if (!links.length) return;
    /* Keep the trailer last WITHOUT moving it: insert the explore block
       just before it when it is a direct child of the wrap; otherwise
       append at the end. (Never appendChild() the trailer — that would
       rip it out of its own container and break the page layout.) */
    const trailer = wrap.querySelector("#official-trailer");
    if (trailer && trailer.parentNode === wrap) trailer.insertAdjacentHTML("beforebegin", exploreLinksHtml(links));
    else wrap.insertAdjacentHTML("beforeend", exploreLinksHtml(links));
  }

  function celebItemId(it) {
    if (!it) return "";
    let h = 0x811c9dc5;
    const s = String(it.source_url || (it.celebrity + "|" + it.when) || "");
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }
  function celebHeadline(it) {
    return `${it.celebrity || ""} ${String(it.what || "").replace(/\s+—\s+/g, " ")}`.trim();
  }
  function celebTodaySection(data) {
    const now = Date.now();
    const items = ((data && data.items) || []).filter(it => {
      if (!it || !it.celebrity || !it.what || !it.when) return false;
      const t = Date.parse(it.when);
      return !isNaN(t) && t <= now + 3600 * 1000 && (now - t) < 24 * 3600 * 1000;
    });
    if (!items.length) return "";
    items.sort((a, b) => Date.parse(b.when) - Date.parse(a.when)); /* newest first */
    /* Each item is an EVENT and opens its own event page (§6.6 correction) —
       never the person's biography page; type must match the label. */
    const rows = items.slice(0, 8).map(it => `
      <a class="news-item" href="/celebrity-today?item=${encodeURIComponent(celebItemId(it))}">
        <span class="news-txt"><b>${esc(celebHeadline(it))}</b>
        <span>${relTime(Date.parse(it.when))}</span></span>
      </a>`).join("");
    return `<section class="section">
      <div class="section-head"><h2>Celebrity Today</h2>
      <a class="see-all" href="/celebrity-today">See All →</a></div>
      <p style="color:var(--muted);margin:-6px 0 14px;max-width:70ch">What the stars are up to right now — appearances, events and announcements, as they happen.</p>
      <div class="news-list">${rows}</div></section>`;
  }

  function posterCard(item, type, tag, rank, extraMeta) {
    const t = type || (item.media_type === "tv" ? "tv" : "movie");
    const href = t === "tv" ? `/show?id=${item.id}` : `/movie?id=${item.id}`;
    const p = img(item.poster_path, "w342");
    const r = rating(item);
    const title = titleOf(item);
    return `<a class="card" href="${href}">
      <span class="card-poster">${p
        ? `<img src="${p}" alt="${esc(title)} poster" loading="lazy" decoding="async" onerror="this.remove()">`
        : `<span class="noimg"><span>${esc(initials(title))}</span></span>`}
      ${rank ? `<span class="rank-badge">${rank}</span>` : ""}
      ${r ? `<span class="rate-badge">${star}${r}/10</span>` : ""}</span>
      <span class="card-body"><span class="card-title">${esc(title)}</span>
      <span class="card-meta">${esc(yearOf(item))}${item.media_type || t ? ` · ${t === "tv" ? "TV" : "Movie"}` : ""}${tag ? ` · ${esc(tag)}` : ""}</span>
      ${extraMeta ? `<span class="card-extra-meta">${esc(extraMeta)}</span>` : ""}</span>
    </a>`;
  }

  function personCard(person, sub) {
    const p = img(person.profile_path, "w185");
    return `<a class="person-card" href="/person?id=${person.id}">
      <span class="person-photo">${p
        ? `<img src="${p}" alt="${esc(person.name)}" loading="lazy" decoding="async" onerror="this.remove()">`
        : `<span class="noimg round"><span>${esc(initials(person.name))}</span></span>`}</span>
      <span class="person-name">${esc(person.name || "")}</span>
      ${sub ? `<span class="person-sub">${esc(sub)}</span>` : ""}
    </a>`;
  }

  function skelCards(n = 6) {
    return Array.from({ length: n }, () => `<span class="card skel"><span class="card-poster sk"></span><span class="sk sk-line"></span><span class="sk sk-line short"></span></span>`).join("");
  }

  function stateMsg(msg, retry = true) {
    return `<div class="state-msg"><p>${esc(msg)}</p>${retry ? `<button class="btn btn-teal" onclick="location.reload()">Retry</button>` : ""}</div>`;
  }

  /* SEO: canonical / OG / twitter / JSON-LD all derive from CONFIG.BASE */
  function setSEO({ title, desc, path = "/", type = "website", image = "", jsonld = null, noindex }) {
    if (title) document.title = title;
    const url = CONFIG.BASE + path;
    const put = (attr, key, val) => {
      if (!val) return;
      let el = document.head.querySelector(`meta[${attr}="${key}"]`);
      if (!el) { el = document.createElement("meta"); el.setAttribute(attr, key); document.head.appendChild(el); }
      el.setAttribute("content", val);
    };
    put("name", "description", desc);
    // Only an explicit choice may replace an existing template robots policy.
    if (typeof noindex === "boolean") put("name", "robots", noindex ? "noindex,follow" : "index,follow");
    put("property", "og:site_name", CONFIG.SITE);
    put("property", "og:title", title);
    put("property", "og:description", desc);
    put("property", "og:type", type);
    put("property", "og:url", url);
    put("property", "og:image", image);
    put("name", "twitter:card", image ? "summary_large_image" : "summary");
    put("name", "twitter:title", title);
    put("name", "twitter:description", desc);
    put("name", "twitter:image", image);
    let can = document.head.querySelector("link[rel='canonical']");
    if (!can) { can = document.createElement("link"); can.setAttribute("rel", "canonical"); document.head.appendChild(can); }
    can.setAttribute("href", url);
    if (jsonld) {
      const old = document.getElementById("fa-jsonld");
      if (old) old.remove();
      const sc = document.createElement("script");
      sc.type = "application/ld+json"; sc.id = "fa-jsonld";
      sc.textContent = JSON.stringify(jsonld);
      document.head.appendChild(sc);
    }
  }

  /* Relative time for news rows: "12 min ago", "3 hrs ago", "2 days ago" */
  function relTime(ts) {
    if (!ts) return "";
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 3600) return Math.max(1, Math.floor(s / 60)) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + (Math.floor(s / 3600) === 1 ? " hr ago" : " hrs ago");
    const d = Math.floor(s / 86400);
    return d + (d === 1 ? " day ago" : " days ago");
  }

  /* ---------- Filter chips (MASTER-STRUCTURE §4) ----------
     Locked standard: every hub has a chip row, first chip "All" (everything
     mixed, the default); chips are URL-param filters (?f=) applied client-side
     over the loaded grid. Pages render items as elements with data-fitem plus
     their own data-* attributes and pass a predicate. */
  function chipRow(filters, activeKey, defaultKey = "all") {
    return `<nav class="tabs fchips" aria-label="Filter">${filters.map(([k, label]) => {
      const url = new URL(location.href);
      if (k === defaultKey) url.searchParams.delete("f"); else url.searchParams.set("f", k);
      return `<a href="${esc(url.pathname + url.search + url.hash)}" data-f="${esc(k)}" data-default-f="${esc(defaultKey)}"${k === activeKey ? ' class="on" aria-current="page"' : ""}>${escRich(label)}</a>`;
    }).join("")}</nav>`;
  }
  function getParam(name, dflt) {
    return new URLSearchParams(location.search).get(name) || dflt;
  }
  function syncChipLinks() {
    document.querySelectorAll("a[data-f]").forEach(link => {
      const url = new URL(location.href);
      const key = link.dataset.f;
      if (key === (link.dataset.defaultF || "all")) url.searchParams.delete("f"); else url.searchParams.set("f", key);
      link.setAttribute("href", url.pathname + url.search + url.hash);
    });
  }
  function setParam(name, value) {
    const u = new URL(location.href);
    if (value) u.searchParams.set(name, value); else u.searchParams.delete(name);
    if (u.href !== location.href) history.pushState(null, "", u);
    syncChipLinks();
  }
  /* Wire a chip row: on click, mark active, persist ?f=, run apply(). */
  function wireChips(container, onChange, defaultKey = "all", param = "f") {
    const mark = key => container.querySelectorAll("[data-f]").forEach(x => {
      const active = x.dataset.f === key;
      x.classList.toggle("on", active);
      if (active) x.setAttribute("aria-current", "page"); else x.removeAttribute("aria-current");
      if (x.tagName === "BUTTON") x.setAttribute("aria-pressed", String(active));
    });
    container.querySelectorAll("[data-f]").forEach(b => b.addEventListener("click", event => {
      if (event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      setParam(param, b.dataset.f === defaultKey ? "" : b.dataset.f);
      mark(b.dataset.f);
      onChange(b.dataset.f);
    }));
    window.addEventListener("popstate", () => {
      const key = getParam(param, defaultKey);
      const match = [...container.querySelectorAll("[data-f]")].some(x => x.dataset.f === key);
      syncChipLinks();
      mark(match ? key : defaultKey);
      onChange(match ? key : defaultKey);
    });
  }
  /* Show/hide [data-fitem] elements inside root by predicate; returns count. */
  function applyFilter(root, pred) {
    let n = 0;
    root.querySelectorAll("[data-fitem]").forEach(el => {
      const show = pred(el.dataset, el);
      el.style.display = show ? "" : "none";
      if (show) n++;
    });
    return n;
  }

  return { esc, img, qs, pageQuery, movieReturnUrl, movieReturnLabel, safeMovieSource, titleOf, yearOf, rating, ratingText, star, fmtDate, monthLabel,
    fmtRuntime, fmtMoney, fmtMoneyFull, fmtMoneyWords, moneyText: moneyPlain, getCcy, setCcy, setIndustryContext, rateNote, escRich, stripTags, verdict, mountChrome, posterCard, personCard,
    skelCards, stateMsg, setSEO, initials, industryTag, providerLines, toggleMore, daywiseCard, dailyCollectionCard, topSearchesHtml, mountTopSearches, dayNumOf, boPeriodData, boPeriodHtml, celebTodaySection,
    freshCutoff, isFresh, newsId, newsItemPath, celebItemId, celebHeadline,
    relTime, chipRow, getParam, setParam, wireChips, applyFilter };
})();
window.UI = UI;


