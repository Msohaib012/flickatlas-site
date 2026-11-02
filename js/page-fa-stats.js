/* FlickAtlas private stats page — WEBSITE visitors only.
   Reads the Firebase RTDB counters (presence, daily, hits, src, dev)
   and counts only af_web_ ids in daily/presence (hits/src/dev are
   written by the website tracker only). All headline figures are
   UNIQUE visitors; ▲▼ chips compare with the previous period.
   Days are UTC date keys. Auto-refreshes every 30 seconds. */
(function () {
  var DB = "https://arenaflix-53ce8-default-rtdb.firebaseio.com/fa";
  function $(id) { return document.getElementById(id); }
  function keyOf(ms) { return new Date(ms + 5 * 3600 * 1000).toISOString().slice(0, 10); } /* PKT day (UTC+5) since 2026-11-02 */
  function isWeb(id) { return id.indexOf("fa_web_") === 0; }
  function fmt(n) { return Number(n || 0).toLocaleString("en-US"); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function webCount(obj) {
    var t = 0;
    if (obj && typeof obj === "object") { for (var id in obj) { if (isWeb(id)) t++; } }
    return t;
  }
  function dayLabel(key, short) {
    var d = new Date(key + "T00:00:00Z");
    return d.toLocaleDateString("en-GB", short
      ? { day: "numeric", timeZone: "UTC" }
      : { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  }
  function setDelta(el, cur, prev) {
    if (!el) return;
    if (!prev || prev <= 0) { el.className = "st-delta flat"; el.textContent = "—"; return; }
    var pct = Math.round(((cur - prev) / prev) * 100);
    if (pct > 0) { el.className = "st-delta up"; el.textContent = "▲ " + pct + "%"; }
    else if (pct < 0) { el.className = "st-delta down"; el.textContent = "▼ " + Math.abs(pct) + "%"; }
    else { el.className = "st-delta flat"; el.textContent = "— 0%"; }
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

  function aggregate(root, days, now) {
    var totals = {};
    if (root && typeof root === "object") {
      for (var i = 0; i < days; i++) {
        var bucket = root[keyOf(now - i * 86400000)];
        if (bucket && typeof bucket === "object") {
          for (var k in bucket) {
            var sub = bucket[k];
            var c = sub && typeof sub === "object" ? Object.keys(sub).length : 0;
            totals[k] = (totals[k] || 0) + c;
          }
        }
      }
    }
    return totals;
  }
  /* --- Period selector for the breakdown panels (owner request 2026-11-02,
     same as the Arenaflix stats page): Today / Yesterday / Last 7 days /
     Last 30 days / All time, default Today. Panels re-render from the
     already-fetched counters; no extra reads. --- */
  var PERIOD = "today";
  var PERIOD_LABELS = { today: "Today", yesterday: "Yesterday", "7d": "Last 7 days", "30d": "Last 30 days", all: "All time" };
  var PERIOD_SHORT = { today: "today", yesterday: "yesterday", "7d": "last 7 days", "30d": "last 30 days", all: "all time" };
  var LAST = null;
  function periodKeys(root, now) {
    if (PERIOD === "all") return root && typeof root === "object" ? Object.keys(root).sort() : [];
    var n = PERIOD === "7d" ? 7 : PERIOD === "30d" ? 30 : 1;
    var from = PERIOD === "yesterday" ? 1 : 0;
    var keys = [];
    for (var i = from; i < from + n; i++) keys.push(keyOf(now - i * 86400000));
    return keys;
  }
  function aggregateKeys(root, keys) {
    var totals = {};
    if (root && typeof root === "object") {
      keys.forEach(function (kk) {
        var bucket = root[kk];
        if (bucket && typeof bucket === "object") {
          for (var k in bucket) {
            var sub = bucket[k];
            var c = sub && typeof sub === "object" ? Object.keys(sub).length : 0;
            totals[k] = (totals[k] || 0) + c;
          }
        }
      });
    }
    return totals;
  }
  async function renderPeriod() {
    if (!LAST) return;
    var now = LAST.now, hits = LAST.hits, src = LAST.src, dev = LAST.dev, geo = LAST.geo,
        qs = LAST.qs, qz = LAST.qz, ref = LAST.ref, hr = LAST.hr;
    var lbl = PERIOD_SHORT[PERIOD];
    if ($("aud-hint")) $("aud-hint").textContent = lbl + " — where visitors come from";
    if ($("content-hint")) $("content-hint").textContent = lbl + " — what visitors open most";
    if ($("search-hint")) $("search-hint").textContent = lbl + " — how visitors find titles";
    var menu = $("st-period-menu");
    if (menu) {
      var btns = menu.querySelectorAll("button[data-period]");
      for (var bi = 0; bi < btns.length; bi++) btns[bi].className = btns[bi].getAttribute("data-period") === PERIOD ? "on" : "";
    }
    var hitTotals = aggregateKeys(hits, periodKeys(hits, now));
    var titleRows = sortedRows(Object.keys(hitTotals).filter(function (k) { return /^[mtn]_\d+$/.test(k); })
      .reduce(function (o, k) { o[k] = hitTotals[k]; return o; }, {}), 15);
    var pageRows = sortedRows(Object.keys(hitTotals).filter(function (k) { return !/^[mtn]_\d+$/.test(k) && !/^w_[mt]_\d+$/.test(k); })
      .reduce(function (o, k) { o[k] = hitTotals[k]; return o; }, {}), 15);
    var names = await Promise.all(titleRows.map(function (r) { return titleName(r.key); }));
    $("pn-titles").innerHTML = panelHtml(titleRows.map(function (r, ix) { return { key: names[ix], val: r.val }; }), function (n) { return n; }, false);
    $("pn-pages").innerHTML = panelHtml(pageRows, function (k) { return PAGE_NAMES[k] || k; }, false);
    $("pn-sources").innerHTML = panelHtml(sortedRows(aggregateKeys(src, periodKeys(src, now)), 15), function (k) { return SRC_NAMES[k] || k; }, true);
    $("pn-devices").innerHTML = panelHtml(sortedRows(aggregateKeys(dev, periodKeys(dev, now)), 15), function (k) { return DEV_NAMES[k] || k; }, true);
    $("pn-countries").innerHTML = panelHtml(sortedRows(aggregateKeys(geo, periodKeys(geo, now)), 15), function (k) { return countryName(k); }, true);

    /* Google visitors: pages opened by devices whose source that
       day was Google (intersection of src.google and hits). */
    var gTotals = {};
    if (src && hits && typeof src === "object" && typeof hits === "object") {
      var gKeys = periodKeys(src, now);
      for (var gi = 0; gi < gKeys.length; gi++) {
        var gk = gKeys[gi];
        var gDay = src[gk] && src[gk].google ? src[gk].google : null;
        var hDay = hits[gk];
        if (!gDay || !hDay) continue;
        for (var pk in hDay) {
          var bucket2 = hDay[pk];
          if (!bucket2 || typeof bucket2 !== "object") continue;
          var cnt = 0;
          for (var did in bucket2) { if (gDay[did]) cnt++; }
          if (cnt > 0) gTotals[pk] = (gTotals[pk] || 0) + cnt;
        }
      }
    }
    var gTitleRows = sortedRows(Object.keys(gTotals).filter(function (k) { return /^[mtn]_\d+$/.test(k) || /^w_[mt]_\d+$/.test(k); })
      .reduce(function (o, k) { o[k] = gTotals[k]; return o; }, {}), 15);
    var gPageRows = sortedRows(Object.keys(gTotals).filter(function (k) { return !/^[mtn]_\d+$/.test(k) && !/^w_[mt]_\d+$/.test(k); })
      .reduce(function (o, k) { o[k] = gTotals[k]; return o; }, {}), 15);
    var gNames = await Promise.all(gTitleRows.map(function (r) { return titleName(r.key.replace(/^w_/, "")); }));
    var gRows = gTitleRows.map(function (r, ix) { return { key: gNames[ix], val: r.val }; })
      .concat(gPageRows.map(function (r) { return { key: PAGE_NAMES[r.key] || r.key, val: r.val }; }))
      .sort(function (a, b) { return b.val - a.val; }).slice(0, 15);
    $("pn-google").innerHTML = panelHtml(gRows, function (n) { return n; }, false);
    /* "Searched" shows only searches that FOUND something: qs counts
       every search, qz the zero-result subset, so subtract per term.
       This also self-heals the pre-2026-11-02 history, where a tracker
       bug logged most searches in BOTH nodes (fix 2026-11-02). */
    var sQs = aggregateKeys(qs, periodKeys(qs, now));
    var sQz = aggregateKeys(qz, periodKeys(qz, now));
    var sFound = {};
    for (var sK in sQs) { var sD = sQs[sK] - (sQz[sK] || 0); if (sD > 0) sFound[sK] = sD; }
    $("pn-searches").innerHTML = panelHtml(sortedRows(sFound, 15), function (k) { return k.replace(/_/g, " "); }, false);
    $("pn-zero").innerHTML = panelHtml(sortedRows(sQz, 15), function (k) { return k.replace(/_/g, " "); }, false);
    $("pn-ref").innerHTML = panelHtml(sortedRows(aggregateKeys(ref, periodKeys(ref, now)), 15), function (k) { return k.replace(/_/g, "."); }, false);
    $("pn-hours").innerHTML = panelHtml(sortedRows(aggregateKeys(hr, periodKeys(hr, now)), 15), function (k) { return hourLabel(k); }, false);
  }

  function sortedRows(totals, limit) {
    return Object.keys(totals).map(function (k) { return { key: k, val: totals[k] }; })
      .filter(function (r) { return r.val > 0; })
      .sort(function (a, b) { return b.val - a.val; }).slice(0, limit);
  }
  function panelHtml(rows, nameFn, withPct) {
    if (!rows.length) return '<p class="pn-empty">Collecting — this fills up as visitors come in.</p>';
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

  /* --- Recent logins to this page (signed records in /admlog) --- */
  var ADM_SECRET = "225500"; /* same secret the login gate uses; this file is only served after login */
  async function admSig(ts) {
    var enc = new TextEncoder();
    var key = await crypto.subtle.importKey("raw", enc.encode(ADM_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    var sig = await crypto.subtle.sign("HMAC", key, enc.encode("admlog:" + ts));
    return [...new Uint8Array(sig)].map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }
  function fmtLoginTs(ts) {
    try {
      return new Date(ts).toLocaleString("en-GB", { timeZone: "Asia/Karachi", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) + " PKT";
    } catch (e) { return new Date(ts).toString(); }
  }
  async function loadLogins() {
    var el = $("pn-logins");
    if (!el) return;
    try {
      var rs = await Promise.all([
        fetch(DB + "/admlog.json?_t=" + Date.now(), { cache: "no-store" }),
        fetch("/stats-session", { cache: "no-store" })
      ]);
      var log = rs[0].ok ? await rs[0].json() : null;
      var sess = rs[1].ok ? await rs[1].json() : null;
      var curTs = sess && sess.loginTs ? Number(sess.loginTs) : 0;
      var valid = [];
      if (log && typeof log === "object") {
        var keys = Object.keys(log).filter(function (k) { return /^[0-9]{10,16}$/.test(k) && typeof log[k] === "string"; });
        for (var i = 0; i < keys.length; i++) {
          if ((await admSig(keys[i])) === log[keys[i]]) valid.push(Number(keys[i]));
        }
      }
      valid.sort(function (a, b) { return b - a; });
      if (!valid.length) { el.innerHTML = '<p class="pn-empty">No logins recorded yet — new logins will appear here.</p>'; return; }
      var rows = [];
      var prev = valid.filter(function (t) { return t !== curTs; });
      if (curTs && valid.indexOf(curTs) >= 0) {
        rows.push('<div class="pn-row"><span class="pn-name">🟢 <b>Current login</b> — ' + esc(fmtLoginTs(curTs)) + '</span></div>');
      }
      prev.slice(0, 4).forEach(function (t, ix) {
        rows.push('<div class="pn-row"><span class="pn-name">' + (curTs ? "Previous login" : (ix === 0 ? "Latest login" : "Previous login")) + ' — ' + esc(fmtLoginTs(t)) + '</span></div>');
      });
      el.innerHTML = rows.join("");
    } catch (e) {
      el.innerHTML = '<p class="pn-empty">Could not load the login history.</p>';
    }
  }

  async function load() {
    var now = Date.now();
    try {
      var rs = await Promise.all([
        fetch(DB + "/presence.json?_t=" + now, { cache: "no-store" }),
        fetch(DB + "/daily.json?_t=" + now, { cache: "no-store" }),
        fetch(DB + "/hits.json?_t=" + now, { cache: "no-store" }),
        fetch(DB + "/src.json?_t=" + now, { cache: "no-store" }),
        fetch(DB + "/dev.json?_t=" + now, { cache: "no-store" }),
        fetch(DB + "/geo.json?_t=" + now, { cache: "no-store" }),
        fetch(DB + "/qs.json?_t=" + now, { cache: "no-store" }),
        fetch(DB + "/hr.json?_t=" + now, { cache: "no-store" }),
        fetch(DB + "/ref.json?_t=" + now, { cache: "no-store" }),
        fetch(DB + "/pv.json?_t=" + now, { cache: "no-store" }),
        fetch(DB + "/qz.json?_t=" + now, { cache: "no-store" }),
        fetch(DB + "/sess.json?_t=" + now, { cache: "no-store" })
      ]);
      var pres = rs[0].ok ? await rs[0].json() : null;
      var daily = rs[1].ok ? await rs[1].json() : null;
      var hits = rs[2].ok ? await rs[2].json() : null;
      var src = rs[3].ok ? await rs[3].json() : null;
      var dev = rs[4].ok ? await rs[4].json() : null;
      var geo = rs[5].ok ? await rs[5].json() : null;
      var qs = rs[6].ok ? await rs[6].json() : null;
      var hr = rs[7].ok ? await rs[7].json() : null;
      var ref = rs[8].ok ? await rs[8].json() : null;
      var pv = rs[9].ok ? await rs[9].json() : null;
      var qz = rs[10].ok ? await rs[10].json() : null;
      var sess = rs[11].ok ? await rs[11].json() : null;
      if (!pres && !daily) throw new Error("empty");
      LAST = { now: now, hits: hits, src: src, dev: dev, geo: geo, qs: qs, qz: qz, ref: ref, hr: hr };

      var live = 0;
      var livePages = {};
      if (pres && typeof pres === "object") {
        for (var id in pres) {
          if (!isWeb(id)) continue;
          var it = pres[id];
          var ts = it && typeof it === "object" ? it.ts : (typeof it === "number" ? it : 0);
          if (ts >= now - 5 * 60 * 1000) {
            live++;
            if (it && typeof it === "object" && it.pg) livePages[it.pg] = (livePages[it.pg] || 0) + 1;
          }
        }
      }
      function dayOff(off) { return webCount(daily ? daily[keyOf(now - off * 86400000)] : null); }
      function periodStats(fromOff, n) {
        var seen = {}, dayCount = {}, unique = 0, total = 0;
        for (var i = fromOff; i < fromOff + n; i++) {
          var bucket = daily ? daily[keyOf(now - i * 86400000)] : null;
          if (bucket && typeof bucket === "object") {
            for (var id2 in bucket) {
              if (!isWeb(id2)) continue;
              total++;
              dayCount[id2] = (dayCount[id2] || 0) + 1;
              if (!seen[id2]) { seen[id2] = 1; unique++; }
            }
          }
        }
        var repeat = 0;
        for (var k in dayCount) { if (dayCount[k] >= 2) repeat++; }
        return { unique: unique, total: total, repeat: repeat };
      }
      function newReturning(off) {
        var targetKey = keyOf(now - off * 86400000);
        var bucket = daily ? daily[targetKey] : null;
        var ids = [];
        if (bucket && typeof bucket === "object") { for (var x in bucket) { if (isWeb(x)) ids.push(x); } }
        var earlier = {};
        if (daily && typeof daily === "object") {
          for (var dk in daily) {
            if (dk < targetKey) {
              var b = daily[dk];
              if (b && typeof b === "object") { for (var y in b) { if (isWeb(y)) earlier[y] = 1; } }
            }
          }
        }
        var returning = 0;
        ids.forEach(function (z) { if (earlier[z]) returning++; });
        return { newOnes: ids.length - returning, returning: returning };
      }

      var today = dayOff(0), yest = dayOff(1), day2 = dayOff(2);
      var p7 = periodStats(0, 7), p7prev = periodStats(7, 7);
      var p30 = periodStats(0, 30), p30prev = periodStats(30, 30);
      var tSplit = newReturning(0), ySplit = newReturning(1);

      $("st-live").textContent = fmt(live);
      $("st-live-pill").textContent = fmt(live) + " live now";
      $("st-today").textContent = fmt(today);
      $("st-today-sub").textContent = "New " + fmt(tSplit.newOnes) + " · Returning " + fmt(tSplit.returning);
      setDelta($("st-today-delta"), today, yest);
      $("st-yest").textContent = fmt(yest);
      $("st-yest-sub").textContent = "New " + fmt(ySplit.newOnes) + " · Returning " + fmt(ySplit.returning);
      setDelta($("st-yest-delta"), yest, day2);
      $("st-7").textContent = fmt(p7.unique);
      $("st-7-sub").textContent = "Repeat " + fmt(p7.repeat) + " · Total " + fmt(p7.total);
      setDelta($("st-7-delta"), p7.unique, p7prev.unique);
      $("st-30").textContent = fmt(p30.unique);
      $("st-30-sub").textContent = "Repeat " + fmt(p30.repeat) + " · Total " + fmt(p30.total);
      setDelta($("st-30-delta"), p30.unique, p30prev.unique);

      /* Total views (every page open counts, not just uniques) */
      function pvDay(off) {
        var dayObj = pv ? pv[keyOf(now - off * 86400000)] : null;
        var c = 0;
        if (dayObj && typeof dayObj === "object") {
          for (var pk2 in dayObj) { var b2 = dayObj[pk2]; if (b2 && typeof b2 === "object") c += Object.keys(b2).length; }
        }
        return c;
      }
      var viewsToday = pvDay(0), viewsYest = pvDay(1);
      if ($("st-views")) {
        $("st-views").textContent = fmt(viewsToday);
        setDelta($("st-views-delta"), viewsToday, viewsYest);
        $("st-views-sub").textContent = "every page open counts";
      }
      /* All-time total views: every recorded day since counting began. */
      var viewsTotal = 0;
      if (pv && typeof pv === "object") {
        for (var vdk in pv) {
          var vdo = pv[vdk];
          if (vdo && typeof vdo === "object") {
            for (var vpk in vdo) { var vpo = vdo[vpk]; if (vpo && typeof vpo === "object") viewsTotal += Object.keys(vpo).length; }
          }
        }
      }
      if ($("st-views-total")) $("st-views-total").textContent = fmt(viewsTotal);
      /* Average time on site (session durations recorded by the tracker) */
      function fmtDur(ms) {
        var sec = Math.max(0, Math.round(ms / 1000));
        var min = Math.floor(sec / 60), hr = Math.floor(min / 60);
        if (hr > 0) return hr + "h " + (min % 60) + "m";
        if (min > 0) return min + "m " + (sec % 60) + "s";
        return sec + "s";
      }
      function avgSess(days) {
        var tot = 0, n = 0;
        if (sess && typeof sess === "object") {
          for (var si = 0; si < days; si++) {
            var bk = sess[keyOf(now - si * 86400000)];
            if (bk && typeof bk === "object") {
              for (var sk in bk) {
                var sr = bk[sk];
                if (sr && typeof sr.a === "number" && typeof sr.b === "number" && sr.b >= sr.a) { tot += sr.b - sr.a; n++; }
              }
            }
          }
        }
        return { avg: n ? tot / n : 0, n: n };
      }
      if ($("st-avg")) {
        var aT = avgSess(1), a7 = avgSess(7);
        $("st-avg").textContent = aT.n ? fmtDur(aT.avg) : "–";
        $("st-avg-sub").textContent = aT.n
          ? "across " + fmt(aT.n) + (aT.n === 1 ? " visit" : " visits") + " today · 7-day avg " + fmtDur(a7.avg)
          : "collecting — visits are being timed from today";
      }

      /* 30-day chart */
      var days = [], max = 1, i2;
      for (i2 = 29; i2 >= 0; i2--) {
        var kk = keyOf(now - i2 * 86400000);
        var vv = webCount(daily ? daily[kk] : null);
        days.push({ key: kk, val: vv, off: i2 });
        if (vv > max) max = vv;
      }
      $("st-bars").innerHTML = days.map(function (d) {
        var h = Math.max(3, Math.round((d.val / max) * 100));
        return '<div class="st-bar' + (d.off === 0 ? " today" : "") + '"><div class="st-bv">' + (d.val > 0 ? fmt(d.val) : "") +
          '</div><div class="st-bc" style="height:' + h + '%"></div><div class="st-bl">' + dayLabel(d.key, true) + "</div></div>";
      }).join("");

      await renderPeriod();

      /* Sab se wafadar log: longest run of consecutive visiting days
         in the last 30 days (website visitors only). */
      (function () {
        var el = $("pn-loyal");
        if (!el) return;
        var dayKeys = [];
        for (var di = 29; di >= 0; di--) dayKeys.push(keyOf(now - di * 86400000));
        var seenDays = {};
        dayKeys.forEach(function (dk) {
          var b = daily ? daily[dk] : null;
          if (b && typeof b === "object") { for (var uid in b) { if (isWeb(uid)) { (seenDays[uid] = seenDays[uid] || {})[dk] = 1; } } }
        });
        var buckets = { b1: 0, b2: 0, b34: 0, b56: 0, b7: 0 };
        var best = 0, loyal3 = 0;
        for (var uid2 in seenDays) {
          var run = 0, maxRun = 0;
          dayKeys.forEach(function (dk) { if (seenDays[uid2][dk]) { run++; if (run > maxRun) maxRun = run; } else { run = 0; } });
          if (maxRun > best) best = maxRun;
          if (maxRun >= 3) loyal3++;
          if (maxRun >= 7) buckets.b7++; else if (maxRun >= 5) buckets.b56++;
          else if (maxRun >= 3) buckets.b34++; else if (maxRun === 2) buckets.b2++; else buckets.b1++;
        }
        var rows = [
          { key: "Came 7+ days in a row", val: buckets.b7 },
          { key: "Came 5–6 days in a row", val: buckets.b56 },
          { key: "Came 3–4 days in a row", val: buckets.b34 },
          { key: "Came 2 days in a row", val: buckets.b2 },
          { key: "Came only 1 day", val: buckets.b1 }
        ].filter(function (r) { return r.val > 0; });
        if (!rows.length) { el.innerHTML = '<p class="pn-empty">Collecting — this fills up as visitors come in.</p>'; return; }
        var mx = Math.max.apply(null, rows.map(function (r) { return r.val; }));
        el.innerHTML = '<p class="pn-empty" style="text-align:left;margin-bottom:10px">Longest streak: <b>' + best + ' days</b> · loyal visitors (3+ days): <b>' + fmt(loyal3) + '</b></p>' +
          rows.map(function (r) {
            return '<div class="pn-row"><span class="pn-name">' + esc(r.key) + '</span><span class="pn-val">' + fmt(r.val) +
              '</span></div><div class="pn-bar"><i style="width:' + Math.max(4, Math.round((r.val / mx) * 100)) + '%"></i></div>';
          }).join("");
      })();

      /* Rising today: title views today vs yesterday */
      function dayTitleCounts(off) {
        var dayObj = hits ? hits[keyOf(now - off * 86400000)] : null;
        var out = {};
        if (dayObj && typeof dayObj === "object") {
          for (var tk in dayObj) {
            if (!/^[mtn]_\d+$/.test(tk)) continue;
            var bb = dayObj[tk];
            if (bb && typeof bb === "object") out[tk] = Object.keys(bb).filter(isWeb).length;
          }
        }
        return out;
      }
      var riseT = dayTitleCounts(0), riseY = dayTitleCounts(1);
      var riseRows = Object.keys(riseT).map(function (k) { return { key: k, val: riseT[k], delta: riseT[k] - (riseY[k] || 0) }; })
        .filter(function (r) { return r.delta > 0 && r.val >= 2; })
        .sort(function (a, b) { return (b.delta - a.delta) || (b.val - a.val); }).slice(0, 15);
      var riseNames = await Promise.all(riseRows.map(function (r) { return titleName(r.key); }));
      $("pn-rising").innerHTML = panelHtml(riseRows.map(function (r, ix) { return { key: riseNames[ix] + " (+" + r.delta + ")", val: r.val }; }), function (n) { return n; }, false);

      /* Live now — open pages */
      var liveRows = sortedRows(livePages, 15);
      var liveTitleRows = liveRows.filter(function (r) { return /^[mtn]_\d+$/.test(r.key) || /^w_[mt]_\d+$/.test(r.key); });
      var liveNames = await Promise.all(liveTitleRows.map(function (r) { return titleName(r.key.replace(/^w_/, "")); }));
      var liveNameMap = {};
      liveTitleRows.forEach(function (r, ix) { liveNameMap[r.key] = (r.key.indexOf("w_") === 0 ? "▶ " : "") + liveNames[ix]; });
      $("pn-live").innerHTML = panelHtml(liveRows, function (k) { return liveNameMap[k] || PAGE_NAMES[k] || k; }, false);

      $("st-updated").textContent = "Updated " + new Date().toLocaleTimeString("en-GB");
      $("st-status").textContent = "";
    } catch (e) {
      $("st-status").textContent = "Could not load the counters — check the connection and press Refresh.";
    }
  }
  var ddBtn = $("st-period-btn"), ddMenu = $("st-period-menu");
  if (ddBtn && ddMenu) {
    ddBtn.addEventListener("click", function (e) { e.stopPropagation(); ddMenu.hidden = !ddMenu.hidden; });
    document.addEventListener("click", function () { ddMenu.hidden = true; });
    ddMenu.addEventListener("click", function (e) {
      var t = e.target;
      if (t && t.getAttribute && t.getAttribute("data-period")) {
        PERIOD = t.getAttribute("data-period");
        if ($("st-period-cur")) $("st-period-cur").textContent = PERIOD_LABELS[PERIOD];
        ddMenu.hidden = true;
        renderPeriod();
      }
    });
  }
  var btn = $("st-refresh");
  if (btn) btn.addEventListener("click", function () { load(); loadLogins(); });
  load();
  loadLogins();
  setInterval(load, 30000);
  setInterval(loadLogins, 60000);
})();
