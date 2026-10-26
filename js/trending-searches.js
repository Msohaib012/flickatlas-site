/* FlickAtlas — Trending Topics (rebuilt 2026-10-26, Sacnilk-style).
   The old module rendered "Trending Searches" from /api/trends, a
   Google-Trends phrase feed (api-trends.json) that went stale (last
   generated 2026-10-24) and was generic, not entertainment-focused
   ("rbny vs inter miami", "helen mirren"). It is retired: this module
   no longer fetches /api/trends at all.
   The new list is the site's OWN box-office content — the same
   articles the Trending News section shows — rendered as a simple
   ranked list like Sacnilk's Trending Topics ("Jailer 2 Box Office
   Collection Day 11", "Udta Teer Box Office Collection Day 3",
   "Ramayana First Day Advance Booking Report"). Each row is the
   article headline + a relative date, linking to the article.
   Source: (1) window.FA_ARTICLES (already loaded on the homepage),
   filtered to box-office articles, newest first; (2) if FA_ARTICLES
   is unavailable, fetch /api/news and filter the same way.
   If there are no box-office articles, the section hides itself
   (nothing rendered) rather than showing a stale or generic list.
   Public API is unchanged (window.FATrendingSearches.mount) so
   page-index.js needs no change. The `limit` / `context` options
   page-index.js passes belonged to the old trends feed and are
   ignored; the module always shows its own top 8. */
(function (root) {
  'use strict';
  var TOP_N = 8;
  var NEWS_TIMEOUT_MS = 8000;

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
     /api/news carries `ts` as ms. Unparseable -> 0 (sinks to bottom). */
  function articleTime(a) {
    if (!a) return 0;
    if (typeof a.ts === 'number' && isFinite(a.ts) && a.ts > 0) return a.ts;
    if (a.published) {
      var t = Date.parse(String(a.published));
      if (isFinite(t)) return t;
    }
    return 0;
  }

  function relDate(a) {
    var UI = root.UI || {};
    var t = articleTime(a);
    if (!t) return '';
    if (typeof UI.relTime === 'function') return UI.relTime(t);
    if (typeof UI.fmtDate === 'function') {
      try { return UI.fmtDate(new Date(t).toISOString().slice(0, 10)); } catch (_) { return ''; }
    }
    return '';
  }

  function topicPath(a) {
    var UI = root.UI || {};
    if (UI && typeof UI.newsItemPath === 'function') return UI.newsItemPath(a);
    if (a && a.id) return '/news-item?id=' + encodeURIComponent(String(a.id));
    return '#';
  }

  /* Primary source: FA_ARTICLES, already on the page. Returns the
     newest box-office articles, top TOP_N. */
  function topicsFromArticles() {
    var src = root.FA_ARTICLES;
    if (!src) return [];
    var arr = Array.isArray(src)
      ? src.slice()
      : Object.keys(src).map(function (k) { return src[k]; });
    var list = arr.filter(function (a) { return a && articleTitle(a) && isBoxOffice(a); });
    list.sort(function (a, b) { return articleTime(b) - articleTime(a); });
    return list.slice(0, TOP_N);
  }

  /* Fallback source: /api/news, same filter and order. */
  async function topicsFromNews() {
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
      var list = items.filter(function (a) { return a && articleTitle(a) && isBoxOffice(a); });
      list.sort(function (a, b) { return articleTime(b) - articleTime(a); });
      return list.slice(0, TOP_N);
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
      + '<p>Box office collections and advance booking, newest first</p>'
      + '</div></header>'
      + '<ol class="trend-mixed-list">';
    topics.forEach(function (a, i) {
      var date = relDate(a);
      html += '<li class="trend-mixed-item">'
        + '<a class="editorial-search-card trend-search-row" href="' + safe(topicPath(a)) + '">'
        + '<span class="trend-search-rank" style="display:block" aria-hidden="true">' + (i + 1) + '</span>'
        + '<span class="editorial-search-card__body">'
        + '<span class="editorial-search-card__term">' + safe(articleTitle(a)) + '</span>'
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
      var topics = topicsFromArticles();
      if (!topics.length) {
        try { topics = await topicsFromNews(); } catch (_) { topics = []; }
      }
      if (current !== generation || host.isConnected === false) return;
      if (!topics.length) {
        /* No box-office articles: hide the section entirely instead
           of showing a stale or generic list. */
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
    helpers: { isBoxOffice: isBoxOffice, topicsFromArticles: topicsFromArticles, render: render }
  };
})(typeof window !== 'undefined' ? window : globalThis);
