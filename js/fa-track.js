/* FlickAtlas website visitor counter (2026-11-01, same system as the
   Arenaflix stats page). Writes under /fa/* in the shared RTDB, in the
   exact shapes the published secure rules allow:
   - fa/presence/{id} = { ts: <ms>, d: "YYYY-MM-DD", pg: page }
   - fa/daily/{date}/{id} = 1        fa/hits/{date}/{pageKey}/{id} = 1
   - fa/pv/{date}/{pageKey}/{viewId} = 1   (every page view)
   - fa/hr/{date}/{pktHour}/{id} = 1       fa/src/{date}/{source}/{id} = 1
   - fa/ref/{date}/{hostKey}/{id} = 1      fa/dev/{date}/{devKey}/{id} = 1
   - fa/geo/{date}/{countryCode}/{id} = 1  (via /api/geo)
   - fa/qs/{date}/{term}/{id} = 1          (site search terms, from ?q=)
   - fa/qz/{date}/{term}/{id} = 1          (searches with no matches)
   - fa/sess/{startDate}/{sid} = { a: startMs, b: lastMs }   (session duration)
   Ids carry the fa_web_ prefix. Dates are UTC. Best-effort and silent. */
(function () {
  /* Stats + login pages never count themselves (owner order 2026-11-02):
     a visit to /stats or /login writes nothing at all — no presence,
     no daily unique, no source/device/country record. */
  try {
    var _p0 = location.pathname.replace(/\.html$/, "");
    if (_p0 === "/stats" || _p0 === "/login") return;
  } catch (e) {}
  var DB = "https://arenaflix-53ce8-default-rtdb.firebaseio.com/fa";
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function deviceId() {
    var id = lsGet("fa_web_device_id");
    if (!id) {
      id = "fa_web_" + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 8);
      lsSet("fa_web_device_id", id);
    }
    return id;
  }
  var id = deviceId();
  function put(path) {
    try {
      fetch(DB + path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "1",
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }
  function dateKey() { return new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10); } /* PKT day (UTC+5) since 2026-11-02 */

  function pageKey() {
    var p = location.pathname.replace(/\/$/, "") || "/";
    var q = new URLSearchParams(location.search);
    if (p === "/") return "home";
    if (p === "/movie" || p === "/show" || p === "/news-item") {
      var tid = q.get("id");
      if (tid && /^\d+$/.test(tid)) return (p === "/movie" ? "m_" : p === "/show" ? "t_" : "n_") + tid;
      return p.slice(1).replace("-", "_");
    }
    var sections = {
      "/movies": "movies", "/tv": "tv", "/box-office": "boxoffice",
      "/box-office-day": "boxoffice_day", "/upcoming": "upcoming",
      "/most-awaited": "awaited", "/ott": "ott", "/trailers": "trailers",
      "/celebrities": "celebrities", "/episode-guides": "episodes",
      "/airing-today": "airing", "/dramas": "dramas",
      "/where-to-watch": "where_to_watch", "/news": "news",
      "/awards": "awards", "/category": "category", "/person": "person",
      "/search": "search", "/about": "info", "/contact": "info",
      "/privacy": "info", "/terms": "info", "/dmca": "info"
    };
    return sections[p] || null; /* /stats and anything unknown: not counted */
  }

  function beat() {
    if (window.navigator && window.navigator.onLine === false) return;
    var payload = { ts: Date.now(), d: dateKey() };
    var pk = pageKey();
    if (pk) payload.pg = pk;
    try {
      fetch(DB + "/presence/" + id + ".json", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
    put("/daily/" + dateKey() + "/" + id + ".json");
  }

  var hitDone = {};
  var pvCount = 0;
  var lastHr = -1;
  function pktHour() { return new Date(Date.now() + 5 * 3600 * 1000).getUTCHours(); }
  function hit(countView) {
    var k = pageKey();
    if (!k) return;
    if (countView !== false) {
      pvCount++;
      put("/pv/" + dateKey() + "/" + k + "/" + id + "_" + Date.now().toString(36) + pvCount + ".json");
      var hr = pktHour();
      if (hr !== lastHr) { lastHr = hr; put("/hr/" + dateKey() + "/" + hr + "/" + id + ".json"); }
    }
    if (hitDone[k]) return;
    hitDone[k] = 1;
    put("/hits/" + dateKey() + "/" + k + "/" + id + ".json");
  }

  function sourceKey() {
    var r = document.referrer || "";
    if (!r) return "direct";
    var h = "";
    try { h = new URL(r).hostname; } catch (e) { return "other"; }
    if (!h || h.indexOf("flickatlas.co.uk") >= 0) return "direct";
    if (h.indexOf("google.") >= 0) return "google";
    if (h.indexOf("t.me") >= 0 || h.indexOf("telegram") >= 0) return "telegram";
    if (h.indexOf("facebook") >= 0 || h.indexOf("fb.") >= 0) return "facebook";
    if (h.indexOf("instagram") >= 0) return "instagram";
    if (h.indexOf("bing.") >= 0) return "bing";
    if (h.indexOf("duckduckgo") >= 0) return "duckduckgo";
    return "other";
  }
  function devKey() {
    var ua = navigator.userAgent || "";
    if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return "tablet";
    if (/Mobi|iPhone|Android.*Mobile|Windows Phone/i.test(ua)) return "mobile";
    if (/Android/i.test(ua)) return "tablet";
    return "desktop";
  }
  function dailyMeta() {
    var stamp = "fa_web_meta_" + dateKey();
    if (lsGet(stamp)) return;
    lsSet(stamp, "1");
    put("/src/" + dateKey() + "/" + sourceKey() + "/" + id + ".json");
    put("/dev/" + dateKey() + "/" + devKey() + "/" + id + ".json");
    try {
      var rh = new URL(document.referrer || "").hostname.toLowerCase()
        .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
      if (rh && rh.indexOf("flickatlas_co_uk") !== 0) put("/ref/" + dateKey() + "/" + rh + "/" + id + ".json");
    } catch (e) {}
  }
  function dailyGeo() {
    var stamp = "fa_web_geo_" + dateKey();
    if (lsGet(stamp)) return;
    try {
      fetch("/api/geo", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (j) {
        var cc = (j && j.country ? String(j.country) : "xx").toLowerCase();
        if (!/^[a-z]{2}$/.test(cc)) cc = "xx";
        lsSet(stamp, "1");
        put("/geo/" + dateKey() + "/" + cc + "/" + id + ".json");
      }).catch(function () {});
    } catch (e) {}
  }

  /* Site search terms come from /search?q= (the search form is a GET). */
  function recordSearchFromUrl() {
    if ((location.pathname.replace(/\/$/, "") || "/") !== "/search") return;
    var raw = new URLSearchParams(location.search).get("q") || "";
    var term = raw.toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    if (term.length < 3) return;
    put("/qs/" + dateKey() + "/" + term + "/" + id + ".json");
    setTimeout(function () {
      var res = document.querySelector("#results");
      if (res && res.textContent.indexOf("matches in the records checked") >= 0) {
        put("/qz/" + dateKey() + "/" + term + "/" + id + ".json");
      }
    }, 3000);
  }

  /* --- session duration: one record per tab session (start + last-seen) --- */
  var sess = null;
  function sessGet() {
    if (sess) return sess;
    try {
      var raw = sessionStorage.getItem("fa_sess");
      if (raw) { var p2 = JSON.parse(raw); if (p2 && p2.sid && p2.a) { sess = p2; return sess; } }
    } catch (e) {}
    sess = { sid: "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 8), a: Date.now() };
    try { sessionStorage.setItem("fa_sess", JSON.stringify(sess)); } catch (e) {}
    return sess;
  }
  function sessBeat() {
    if (window.navigator && window.navigator.onLine === false) return;
    var s2 = sessGet();
    var dk = new Date(s2.a + 5 * 3600 * 1000).toISOString().slice(0, 10);
    try {
      fetch(DB + "/sess/" + dk + "/" + s2.sid + ".json", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ a: s2.a, b: Date.now() }),
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }

  beat();
  sessBeat();
  hit();
  dailyMeta();
  dailyGeo();
  recordSearchFromUrl();
  setInterval(function () { beat(); sessBeat(); }, 120000);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") { beat(); hit(false); sessBeat(); }
    else { sessBeat(); }
  });
  var lastHref = location.href;
  setInterval(function () {
    if (location.href !== lastHref) { lastHref = location.href; hit(); recordSearchFromUrl(); }
  }, 2500);
})();
