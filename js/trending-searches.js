/* FlickAtlas — Trending Topics, WEEKLY ONLY (rebuilt 2026-10-27).
   Rule (user order): only what is trending THIS WEEK appears here.
   An item may enter the list only if its date is within the last 7
   days; anything older is dropped even if the list gets short.
   The old module had no date window at all — it took the 8 newest
   box-office articles, so a slow news week (or a stalled pipeline)
   left month-old items on the page.

   Sources, in order:
   (1) window.FA_TRENDING_TOPICS (js/trending-topics.js, generated
       daily by scripts/trending_weekly.py from Tavily search +
       Gemini): curated topics of the week, each already dated within
       the last 7 days and linked to a site page. The client still
       re-checks the window — a stale generated file can never leak
       old items onto the page.
   (2) window.FA_ARTICLES, filtered to box-office articles dated
       within the last 7 days, newest first.
   (3) /api/news, same filter.
   If nothing is within the window, the section hides itself rather
   than showing a stale list.
   Public API is unchanged (window.FATrendingSearches.mount) so
   page-index.js needs no change. */
(function (root) {
  'use strict';
  var TOP_N = 8;
  var NEWS_TIMEOUT_MS = 8000;
  var WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

  function safe(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function articleTitle(a) {
    return String((a && (a.headline || a.title)) || '').trim();
  }

  /* A box-office topic: the headline (or type) mentions box office.
     FA_ARTICLES type is always "news", so the headline is the real
     signal; the type check covers feeds that tag it. */
  function isBoxOffice(a) {
    if (!a) return false;
    var h = articleTitle(a).toLowerCase();
    var t = String(a.type || '').toLowerCase();
    return h.indexOf('box office') !== -1 || t.indexOf('box office') !== -1 || t.indexOf('boxoffice') !== -1;
  }

  /* Numeric ms timestamp for sorting/dating. FA_ARTICLES carries
     `published` as an RFC date string (several timezone spellings);
     /api/news carries `ts` as ms; the generated topics file carries
     `date` as an ISO date string. Unparseable -> 0 (dropped by the
     window filter, never shown). */
  function articleTime(a) {
    if (!a) return 0;
    if (typeof a.ts === 'number' && isFinite(a.ts) && a.ts > 0) return a.ts;
    if (a.date) {
      var d = Date.parse(String(a.date));
      if (isFinite(d)) return d;
    }
    if (a.published) {
      var t = Date.parse(String(a.published));
      if (isFinite(t)) return t;
    }
    return 0;
  }

  /* Strict 7-day window: only items dated within the last 7 days.
     Future-dated items (clock skew / bad data) are dropped too. */
  function withinWindow(t, now) {
    if (!t || !isFinite(t)) return false;
    return t >= now - WINDOW_MS && t <= now;
  }

  function relDateMs(t) {
    var UI = root.UI || {};
    if (!t) return '';
    if (typeof UI.relTime === 'function') return UI.relTime(t);
    if (typeof UI.fmtDate === 'function') {
      try { return UI.fmtDate(new Date(t).toISOString().slice(0, 10)); } catch (_) { return ''; }
    }
    return '';
  }

  function topicPath(a) {
    var UI = root.UI || {};
    if (a && a.url) return String(a.url);
    if (UI && typeof UI.newsItemPath === 'function') return UI.newsItemPath(a);
    if (a && a.id) return '/news-item?id=' + encodeURIComponent(String(a.id));
    return '#';
  }

  /* Primary source: the generated weekly file. Entries are already
     curated + dated within the week; the window is re-checked here
     so a stale file can never leak old items. */
  function topicsFromFile(now) {
    var src = root.FA_TRENDING_TOPICS;
    if (!Array.isArray(src)) return [];
    var list = src.filter(function (t) {
      return t && articleTitle(t) && t.url && withinWindow(articleTime(t), now);
    }).map(function (t) {
      return { title: articleTitle(t), url: String(t.url), time: articleTime(t) };
    });
    list.sort(function (a, b) { return b.time - a.time; });
    return list.slice(0, TOP_N);
  }

  /* Fallback source: FA_ARTICLES, box-office only, within the week,
     newest first. */
  function topicsFromArticles(now) {
    var src = root.FA_ARTICLES;
    if (!src) return [];
    var arr = Array.isArray(src)
      ? src.slice()
      : Object.keys(src).map(function (k) { return src[k]; });
    var list = arr.filter(function (a) {
      return a && articleTitle(a) && isBoxOffice(a) &&
        withinWindow(articleTime(a), now);
    });
    list.sort(function (a, b) { return articleTime(b) - articleTime(a); });
    return list.slice(0, TOP_N).map(function (a) {
      return { title: articleTitle(a), url: topicPath(a), time: articleTime(a) };
    });
  }

  /* Fallback source: /api/news, same filter and order. */
  async function topicsFromNews(now) {
    var ctl = null;
    var timer = null;
    try {
      if (typeof AbortController === 'function') {
        ctl = new AbortController();
        timer = setTimeout(function () { ctl.abort(); }, NEWS_TIMEOUT_MS);
      }
      var r = await root.fetch('/api/news', ctl ? { signal: ctl.signal } : undefined);
      if (!r.ok) throw new Error('news http ' + r.status);
      var j = await r.json();
      var items = (j && Array.isArray(j.items)) ? j.items : [];
      var list = items.filter(function (a) {
        return a && articleTitle(a) && isBoxOffice(a) &&
          withinWindow(articleTime(a), now);
      });
      list.sort(function (a, b) { return articleTime(b) - articleTime(a); });
      return list.slice(0, TOP_N).map(function (a) {
        return { title: articleTitle(a), url: topicPath(a), time: articleTime(a) };
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* Sacnilk-style ranked list. Reuses the existing trend styles
     (.trend-groups / .trend-mixed-list / .trend-mixed-item /
     .trend-search-row / .editorial-search-card__term /
     .trend-search-meta). The rank number is forced visible with an
     inline display override: style.css hides .trend-search-rank
     inside .trend-mixed (the old design showed a decorative icon
     instead), and this module drops that icon — the rank is the
     honest marker now. */
  function render(topics) {
    var html = '<section class="trend-groups trend-mixed" aria-labelledby="trending-topics-title">'
      + '<header class="trend-groups__header"><div>'
      + '<h2 id="trending-topics-title">Trending Topics</h2>'
      + '<p>What is trending this week, newest first</p>'
      + '</div></header>'
      + '<ol class="trend-mixed-list">';
    topics.forEach(function (a, i) {
      var date = relDateMs(a.time);
      html += '<li class="trend-mixed-item">'
        + '<a class="editorial-search-card trend-search-row" href="' + safe(a.url) + '">'
        + '<span class="trend-search-rank" style="display:block" aria-hidden="true">' + (i + 1) + '</span>'
        + '<span class="editorial-search-card__body">'
        + '<span class="editorial-search-card__term">' + safe(a.title) + '</span>'
        + (date ? '<span class="trend-search-meta"><span>' + safe(date) + '</span></span>' : '')
        + '</span></a></li>';
    });
    html += '</ol></section>';
    return html;
  }

  function mount(host, options) {
    if (!host) throw new Error('TrendingTopics.mount requires a host element');
    var generation = 0;
    async function load() {
      var current = ++generation;
      var now = Date.now();
      var topics = topicsFromFile(now);
      if (!topics.length) topics = topicsFromArticles(now);
      if (!topics.length) {
        try { topics = await topicsFromNews(now); } catch (_) { topics = []; }
      }
      if (current !== generation || host.isConnected === false) return;
      if (!topics.length) {
        /* Nothing trending this week: hide the section entirely
           instead of showing a stale list. */
        if (typeof host.remove === 'function') host.remove();
        else { host.innerHTML = ''; host.style.display = 'none'; }
        return;
      }
      host.innerHTML = render(topics);
    }
    load();
    return { refresh: load };
  }

  root.FATrendingSearches = {
    mount: mount,
    helpers: { isBoxOffice: isBoxOffice, topicsFromArticles: topicsFromArticles, topicsFromFile: topicsFromFile, withinWindow: withinWindow, render: render }
  };
})(typeof window !== 'undefined' ? window : globalThis);
