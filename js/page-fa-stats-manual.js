/* FlickAtlas private MANUAL stats page — owner request 2026-11-02.
   A separate page behind the same /stats login: custom From/To dates
   (any day, month or year span) plus device / source / country /
   content filters. Every number is recomputed from the already-fetched
   RTDB counters (/fa branch) for the selected range only.
   Method: for each day, the visitor set is that day's fa_web_ ids in
   /fa/daily INTERSECTED with the chosen device/source/country id sets
   of the same day; views and content counts only include those
   visitors. Each breakdown panel ignores its own filter so values stay
   comparable. Avg. time comes from /fa/sess records in range and is
   not filtered (sessions are not tied to the filter sets). */
(function () {
  var DB = "https://arenaflix-53ce8-default-rtdb.firebaseio.com/fa";
  function $(id) { return document.getElementById(id); }
  function keyOf(ms) { return new Date(ms + 5 * 3600 * 1000).toISOString().slice(0, 10); } /* PKT day (UTC+5) */
  function isWeb(id) { return id.indexOf("fa_web_") === 0; }
  function fmt(n) { return Number(n || 0).toLocaleString("en-US"); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function dayLabel(key) {
    var d = new Date(key + "T00:00:00Z");
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  }
  var PAGE_NAMES = { home: "Home", movies: "Movies", tv: "TV Shows", boxoffice: "Box Office", boxoffice_day: "Box Office — day-wise", upcoming: "Upcoming", awaited: "Most Awaited", ott: "OTT", trailers: "Trailers", celebrities: "Celebrities", episodes: "Episode Guides", airing: "Airing Today", dramas: "Dramas", where_to_watch: "Where to Watch", news: "News", news_item: "News stories", awards: "Awards", category: "Category pages", person: "People", search: "Search", info: "Info pages" };
  var SRC_NAMES = { google: "Google", telegram: "Telegram", facebook: "Facebook", instagram: "Instagram", direct: "Direct / typed", bing: "Bing", duckduckgo: "DuckDuckGo", other: "Other sites" };
  var DEV_NAMES = { mobile: "Mobile", desktop: "Computer", tablet: "Tablet" };
  var regionNames = null;
  try { regionNames = new Intl.DisplayNames(["en"], { type: "region" }); } catch (e) {}
  function countryName(cc) {
    var up = String(cc || "xx").toUpperCase();
    if (up === "XX") return "Unknown";
    if (regionNames) { try { var n = regionNames.of(up); if (n) return n; } catch (e) {} }
    return up;
  }
  function sortedRows(totals, limit) {
    return Object.keys(totals).map(function (k) { return { key: k, val: totals[k] }; })
      .filter(function (r) { return r.val > 0; })
      .sort(function (a, b) { return b.val - a.val; }).slice(0, limit);
  }
  function panelHtml(rows, nameFn, withPct) {
    if (!rows.length) return '<p class="pn-empty">Nothing recorded for this selection yet.</p>';
    var max = rows[0].val;
    var total = rows.reduce(function (s, r) { return s + r.val; }, 0);
    return rows.map(function (r) {
      var pct = withPct && total > 0 ? ' <span class="pn-pct">' + Math.round((r.val / total) * 100) + "%</span>" : "";
      return '<div class="pn-row"><span class="pn-name">' + esc(nameFn(r.key)) + '</span><span class="pn-val">' + fmt(r.val) + pct +
        '</span></div><div class="pn-bar"><i style="width:' + Math.max(4, Math.round((r.val / max) * 100)) + '%"></i></div>';
    }).join("");
  }
  function h12(h) { var x = h % 12; return x === 0 ? 12 : x; }
  function hourLabel(h) {
    h = Number(h);
    var n = (h + 1) % 24;
    return h12(h) + (h < 12 ? " AM" : " PM") + " – " + h12(n) + (n < 12 ? " AM" : " PM");
  }
  function fmtDur(ms) {
    var sec = Math.max(0, Math.round(ms / 1000));
    var min = Math.floor(sec / 60), hr = Math.floor(min / 60);
    if (hr > 0) return hr + "h " + (min % 60) + "m";
    if (min > 0) return min + "m " + (sec % 60) + "s";
    return sec + "s";
  }
  var seoMetaCache = null;
  async function titleName(key) {
    var kind = key.charAt(0) === "t" ? "tv" : key.charAt(0) === "n" ? "news" : "movie";
    var tid = key.slice(2);
    try {
      if (!seoMetaCache) { var r = await fetch("/js/seo-meta.json"); seoMetaCache = r.ok ? await r.json() : {}; }
      var e = seoMetaCache[kind + ":" + tid];
      if (e && e.t) return e.t + (kind === "tv" ? " (TV)" : "");
    } catch (e2) {}
    return (kind === "tv" ? "Show #" : kind === "news" ? "Story #" : "Movie #") + tid;
  }

  var DATA = null;
  var F = { device: "", source: "", country: "", content: "all" };
  var fromKey = "", toKey = "";
  var ALL_FROM = "2026-11-01"; /* counting began 1 Nov 2026 */

  function rangeKeys() {
    var out = [];
    var t = new Date(fromKey + "T00:00:00Z").getTime();
    var end = new Date(toKey + "T00:00:00Z").getTime();
    while (t <= end && out.length < 400) { out.push(new Date(t).toISOString().slice(0, 10)); t += 86400000; }
    return out;
  }
  function narrow(set, node, day, bucket) {
    var sub = node && node[day] ? node[day][bucket] : null;
    var ns = {};
    if (sub && typeof sub === "object") { for (var id in set) { if (sub[id]) ns[id] = 1; } }
    return ns;
  }
  function allowedFor(day, except) {
    var base = DATA.daily ? DATA.daily[day] : null;
    var set = {};
    if (base && typeof base === "object") { for (var id in base) { if (isWeb(id)) set[id] = 1; } }
    if (F.device && except !== "dev") set = narrow(set, DATA.dev, day, F.device);
    if (F.source && except !== "src") set = narrow(set, DATA.src, day, F.source);
    if (F.country && except !== "geo") set = narrow(set, DATA.geo, day, F.country);
    return set;
  }
  function countWhere(node, day, set) {
    var tot = {};
    var bucket = node ? node[day] : null;
    if (bucket && typeof bucket === "object") {
      for (var k in bucket) {
        var sub = bucket[k];
        if (!sub || typeof sub !== "object") continue;
        var c = 0;
        for (var id in sub) { if (set[id]) c++; }
        if (c) tot[k] = c;
      }
    }
    return tot;
  }
  function addInto(dst, srcObj) { for (var k in srcObj) dst[k] = (dst[k] || 0) + srcObj[k]; }
  function sumVals(obj) { var s = 0; for (var k in obj) s += obj[k]; return s; }

  async function render() {
    if (!DATA) return;
    var keys = rangeKeys();
    var union = {}, viewsTotal = 0;
    var perDay = [];
    var devT = {}, srcT = {}, geoT = {}, refT = {}, hrT = {}, hitT = {}, qsT = {}, qzT = {};
    var sessTot = 0, sessN = 0;
    keys.forEach(function (day) {
      var set = allowedFor(day);
      for (var id in set) union[id] = 1;
      var vDay = sumVals(countWhere(DATA.pv, day, set));
      viewsTotal += vDay;
      perDay.push({ day: day, visitors: Object.keys(set).length, views: vDay });
      addInto(devT, countWhere(DATA.dev, day, allowedFor(day, "dev")));
      addInto(srcT, countWhere(DATA.src, day, allowedFor(day, "src")));
      addInto(geoT, countWhere(DATA.geo, day, allowedFor(day, "geo")));
      addInto(refT, countWhere(DATA.ref, day, set));
      addInto(hrT, countWhere(DATA.hr, day, set));
      addInto(hitT, countWhere(DATA.hits, day, set));
      addInto(qsT, countWhere(DATA.qs, day, set));
      addInto(qzT, countWhere(DATA.qz, day, set));
      var sb = DATA.sess ? DATA.sess[day] : null;
      if (sb && typeof sb === "object") {
        for (var sk in sb) {
          var sr = sb[sk];
          if (sr && typeof sr.a === "number" && typeof sr.b === "number" && sr.b >= sr.a) { sessTot += sr.b - sr.a; sessN++; }
        }
      }
    });
    $("mf-visitors").textContent = fmt(Object.keys(union).length);
    $("mf-views").textContent = fmt(viewsTotal);
    if (sessN) {
      $("mf-avg").textContent = fmtDur(sessTot / sessN);
      $("mf-avg-sub").textContent = "across " + fmt(sessN) + (sessN === 1 ? " visit" : " visits") + " in range (filters do not apply)";
    } else {
      $("mf-avg").textContent = "–";
      $("mf-avg-sub").textContent = "no timed visits in this range";
    }
    $("mf-days").textContent = fmt(keys.length);
    $("mf-days-sub").textContent = dayLabel(fromKey) + " → " + dayLabel(toKey);
    if ($("mf-range-label")) $("mf-range-label").textContent = "Showing: " + dayLabel(fromKey) + " → " + dayLabel(toKey);

    var rows = perDay.slice().reverse();
    var shown = rows.slice(0, 120);
    $("mf-byday").innerHTML = (shown.length ? shown.map(function (d) {
      return '<div class="pn-row"><span class="pn-name">' + esc(dayLabel(d.day)) + '</span><span class="pn-val">' +
        fmt(d.visitors) + ' visitors · ' + fmt(d.views) + ' views</span></div>';
    }).join("") : '<p class="pn-empty">Nothing recorded for this selection yet.</p>') +
      (rows.length > shown.length ? '<p class="pn-empty" style="margin-top:8px">Showing the latest 120 days of the range.</p>' : "");

    $("pn-devices").innerHTML = panelHtml(sortedRows(devT, 15), function (k) { return DEV_NAMES[k] || k; }, true);
    $("pn-sources").innerHTML = panelHtml(sortedRows(srcT, 15), function (k) { return SRC_NAMES[k] || k; }, true);
    $("pn-countries").innerHTML = panelHtml(sortedRows(geoT, 15), function (k) { return countryName(k); }, true);
    $("pn-ref").innerHTML = panelHtml(sortedRows(refT, 15), function (k) { return k.replace(/_/g, "."); }, false);
    $("pn-hours").innerHTML = panelHtml(sortedRows(hrT, 15), function (k) { return hourLabel(k); }, false);

    var titleRe = F.content === "movies" ? /^m_\d+$/ : F.content === "tv" ? /^t_\d+$/ : F.content === "news" ? /^n_\d+$/ : /^[mtn]_\d+$/;
    var titleRows = sortedRows(Object.keys(hitT).filter(function (k) { return titleRe.test(k); })
      .reduce(function (o, k) { o[k] = hitT[k]; return o; }, {}), 15);
    var pageRows = sortedRows(Object.keys(hitT).filter(function (k) { return !/^[mtn]_\d+$/.test(k); })
      .reduce(function (o, k) { o[k] = hitT[k]; return o; }, {}), 15);
    var names = await Promise.all(titleRows.map(function (r) { return titleName(r.key); }));
    $("pn-titles").innerHTML = panelHtml(titleRows.map(function (r, ix) { return { key: names[ix], val: r.val }; }), function (n) { return n; }, false);
    $("pn-pages").innerHTML = panelHtml(pageRows, function (k) { return PAGE_NAMES[k] || k; }, false);
    if ($("wrap-titles")) $("wrap-titles").style.display = F.content === "pages" ? "none" : "";
    if ($("wrap-pages")) $("wrap-pages").style.display = (F.content === "all" || F.content === "pages") ? "" : "none";

    /* Searched = qs minus the zero-result subset (same rule as the main page). */
    var sFound = {};
    for (var sK in qsT) { var sD = qsT[sK] - (qzT[sK] || 0); if (sD > 0) sFound[sK] = sD; }
    $("pn-searches").innerHTML = panelHtml(sortedRows(sFound, 15), function (k) { return k.replace(/_/g, " "); }, false);
    $("pn-zero").innerHTML = panelHtml(sortedRows(qzT, 15), function (k) { return k.replace(/_/g, " "); }, false);
    buildCountryMenu();
  }

  /* --- Custom dropdowns (same pattern as the main stats page) --- */
  var DD = {};
  function bindDD(name, options, curVal, onPick) {
    var btn = $("mf-" + name + "-btn"), menu = $("mf-" + name + "-menu"), cur = $("mf-" + name + "-cur");
    if (!btn || !menu || !cur) return;
    DD[name] = { options: options, val: curVal, onPick: onPick, btn: btn, menu: menu, cur: cur };
    drawDD(name);
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      for (var n in DD) { if (n !== name) DD[n].menu.hidden = true; }
      menu.hidden = !menu.hidden;
    });
    menu.addEventListener("click", function (e) {
      var t = e.target;
      if (t && t.getAttribute && t.getAttribute("data-v") !== null) {
        DD[name].val = t.getAttribute("data-v");
        menu.hidden = true;
        drawDD(name);
        onPick(DD[name].val);
      }
    });
  }
  function drawDD(name) {
    var d = DD[name];
    if (!d) return;
    d.menu.innerHTML = d.options.map(function (o) {
      return '<button type="button" data-v="' + esc(o.v) + '"' + (o.v === d.val ? ' class="on"' : "") + '>' + esc(o.label) + '</button>';
    }).join("");
    var sel = d.options.filter(function (o) { return o.v === d.val; })[0];
    d.cur.textContent = sel ? sel.label : d.options[0].label;
  }
  document.addEventListener("click", function () { for (var n in DD) DD[n].menu.hidden = true; });

  function buildCountryMenu() {
    if (!DATA) return;
    var totals = {};
    rangeKeys().forEach(function (day) { addInto(totals, countWhere(DATA.geo, day, allowedFor(day, "geo"))); });
    var opts = [{ v: "", label: "All countries" }].concat(sortedRows(totals, 20).map(function (r) {
      return { v: r.key, label: countryName(r.key) };
    }));
    if (F.country && !opts.some(function (o) { return o.v === F.country; })) opts.push({ v: F.country, label: countryName(F.country) });
    if (DD.geo) { DD.geo.options = opts; if (!opts.some(function (o) { return o.v === DD.geo.val; })) { DD.geo.val = ""; F.country = ""; } drawDD("geo"); }
    else bindDD("geo", opts, F.country, function (v) { F.country = v; render(); });
  }

  function setRange(f, t, presetName) {
    fromKey = f; toKey = t;
    if ($("mf-from")) $("mf-from").value = f;
    if ($("mf-to")) $("mf-to").value = t;
    var btns = $("mf-presets") ? $("mf-presets").querySelectorAll("button") : [];
    for (var i = 0; i < btns.length; i++) btns[i].className = btns[i].getAttribute("data-preset") === presetName ? "on" : "";
    render();
  }
  function preset(name) {
    var now = Date.now();
    var today = keyOf(now);
    if (name === "today") setRange(today, today, name);
    else if (name === "7d") setRange(keyOf(now - 6 * 86400000), today, name);
    else if (name === "30d") setRange(keyOf(now - 29 * 86400000), today, name);
    else if (name === "month") setRange(today.slice(0, 8) + "01", today, name);
    else if (name === "year") setRange(today.slice(0, 5) + "01-01", today, name);
    else if (name === "all") setRange(ALL_FROM, today, name);
  }

  async function load() {
    $("mf-status").textContent = "Loading counters…";
    try {
      var now = Date.now();
      var names = ["daily", "hits", "src", "dev", "geo", "qs", "hr", "ref", "pv", "qz", "sess"];
      var rs = await Promise.all(names.map(function (n) {
        return fetch(DB + "/" + n + ".json?_t=" + now, { cache: "no-store" });
      }));
      DATA = {};
      for (var i = 0; i < names.length; i++) DATA[names[i]] = rs[i].ok ? await rs[i].json() : null;
      if (!DATA.daily) throw new Error("empty");
      $("mf-status").textContent = "";
      render();
    } catch (e) {
      $("mf-status").textContent = "Could not load the counters — check the connection and press Refresh.";
    }
  }

  bindDD("dev", [{ v: "", label: "All devices" }].concat(Object.keys(DEV_NAMES).map(function (k) { return { v: k, label: DEV_NAMES[k] }; })), "", function (v) { F.device = v; render(); });
  bindDD("src", [{ v: "", label: "All sources" }].concat(Object.keys(SRC_NAMES).map(function (k) { return { v: k, label: SRC_NAMES[k] }; })), "", function (v) { F.source = v; render(); });
  bindDD("content", [
    { v: "all", label: "All content" },
    { v: "movies", label: "Movies" },
    { v: "tv", label: "TV shows" },
    { v: "news", label: "News stories" },
    { v: "pages", label: "Pages" }
  ], "all", function (v) { F.content = v; render(); });

  var presetsEl = $("mf-presets");
  if (presetsEl) presetsEl.addEventListener("click", function (e) {
    var t = e.target;
    if (t && t.getAttribute && t.getAttribute("data-preset")) preset(t.getAttribute("data-preset"));
  });
  function onDateChange() {
    var f = $("mf-from").value, t = $("mf-to").value;
    if (!f || !t) return;
    if (f > t) { var tmp = f; f = t; t = tmp; }
    setRange(f, t, "");
  }
  if ($("mf-from")) $("mf-from").addEventListener("change", onDateChange);
  if ($("mf-to")) $("mf-to").addEventListener("change", onDateChange);
  if ($("mf-refresh")) $("mf-refresh").addEventListener("click", load);

  var todayK = keyOf(Date.now());
  fromKey = keyOf(Date.now() - 29 * 86400000);
  toKey = todayK;
  if ($("mf-from")) $("mf-from").value = fromKey;
  if ($("mf-to")) $("mf-to").value = toKey;
  load();
})();
