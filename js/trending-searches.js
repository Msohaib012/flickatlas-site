(function (root) {
  'use strict';
  const API = '/api/trends';
  const words = value => String(value || '').match(/[\p{L}\p{N}]+/gu) || [];
  function validPhrase(q) { return typeof q === 'string' && q.trim().split(/\s+/).filter(part => /[\p{L}\p{N}]/u.test(part)).length >= 2; }
  function normalized(value) { return String(value || '').normalize('NFKC').toLocaleLowerCase(); }
  function linkFor(q) { return '/search?q=' + encodeURIComponent(String(q)); }
  function fullNameMatch(q, news, name) {
    const haystack = new Set(words(normalized(q + ' ' + (news || ''))));
    const tokens = words(normalized(name));
    return tokens.length > 0 && tokens.every(token => haystack.has(token));
  }
  function metadataMatch(q, news, entry) {
    const names = [entry.title, entry.name, entry.original_name, entry.original_title].filter(Boolean);
    return names.some(name => fullNameMatch(q, news, name));
  }
  function countryLanguage(entry, country, language) {
    const countries = [].concat(entry.origin_country || [], entry.production_countries || [], entry.countries || []).map(c => typeof c === 'string' ? c : c.iso_3166_1 || c.code || '');
    if (entry._query_origin_country) countries.push(entry._query_origin_country);
    const lang = String(entry.original_language || '').toLowerCase();
    return countries.includes(country) && lang === language;
  }
  function classify(item, context) {
    const explicit = String(item.industry || item.category || item.group || item.type || '').toLowerCase();
    if (/bollywood|hindi cinema/.test(explicit)) return 'bollywood';
    if (/hollywood|us cinema/.test(explicit)) return 'hollywood';
    if (/pakistan|lollywood/.test(explicit)) return 'pakistan';
    if (/k[- ]?drama|korean drama/.test(explicit)) return 'kdrama';
    const pools = [['bollywood', context.bollywood, e => countryLanguage(e, 'IN', 'hi')], ['hollywood', context.international, e => countryLanguage(e, 'US', 'en')], ['pakistan', context.pakistan, e => countryLanguage(e, 'PK', 'ur')], ['kdrama', context.kdrama, e => countryLanguage(e, 'KR', 'ko')]];
    for (const [key, list, test] of pools) if ((list || []).some(e => e && metadataMatch(item.q, item.news, e) && test(e))) return key;
    if (item._query_origin_country === 'IN' && context._query_origin_country === 'IN') return 'bollywood';
    return 'other';
  }
  function prepare(items, context) {
    const seen = new Set();
    return (Array.isArray(items) ? items : []).filter(item => item && validPhrase(item.q)).map(item => {
      const key = normalized(item.q) + '|' + normalized(item.geo);
      if (seen.has(key)) return null;
      seen.add(key);
      return { item, group: classify(item, context || {}) };
    }).filter(Boolean);
  }
  function safe(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
  function signalFor(item) {
    const direction = String(item.direction || item.trend || '').toLowerCase();
    if (item.breakout === true || direction === 'breakout' || String(item.traffic || '').toLowerCase() === 'breakout') return '<span class="trend-signal">Breakout · source reported</span>';
    if (item.rising === true || direction === 'rising' || direction === 'up') return '<span class="trend-signal"><span aria-hidden="true">↑</span> Rising · source reported</span>';
    if (direction === 'falling' || direction === 'down') return '<span class="trend-signal"><span aria-hidden="true">↓</span> Falling · source reported</span>';
    return '';
  }
  function render(items, context, generated, overrides) {
    const rows = prepare(items, context);
    let html = '<section class="trend-groups trend-mixed" aria-labelledby="trending-searches-title"><header class="trend-groups__header"><div><h2 id="trending-searches-title">Trending Searches</h2><p>Search phrases across regions · feed order</p></div><button type="button" class="trend-groups__refresh">Refresh</button></header>';
    if (!rows.length) html += '<p class="trend-groups__empty">No trend searches are available right now. Try refreshing later.</p>';
    else {
      html += '<ol class="trend-mixed-list">';
      rows.forEach(({ item }, index) => {
        const volume = /\d/.test(String(item.traffic ?? '')) ? '<span class="trend-volume" title="Approximate source-reported search volume">' + safe(item.traffic) + ' searches (approx.)</span>' : '';
        const geo = safe(item.geo || 'Region not supplied');
        const signal = signalFor(item);
        const news = item.news ? '<span class="trend-news">' + safe(item.news) + '</span>' : '';
        // Decorative category marker, not evidence of rising search traffic.
        const marker = '<span class="trend-search-icon" aria-hidden="true"><svg class="fa-trend-mark" viewBox="0 0 48 48" width="24" height="24" focusable="false"><circle cx="24" cy="24" r="23" fill="#07332E"/><circle cx="24" cy="24" r="22" fill="none" stroke="#174C44" stroke-width="1"/><path d="m11.5 31 9-9 5.4 5.4L37 16.3" fill="none" stroke="#C7E4DB" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M29.8 16.3H37v7.2" fill="none" stroke="#C7E4DB" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
        html += '<li class="trend-mixed-item"><a class="editorial-search-card trend-search-row" href="' + safe(linkFor(item.q)) + '">' + marker + '<span class="trend-search-rank" aria-hidden="true">' + (index + 1) + '</span><span class="editorial-search-card__body"><span class="editorial-search-card__term">' + safe(item.q) + '</span><span class="trend-search-meta"><span class="trend-country">' + geo + '</span>' + volume + (signal ? '<span>' + signal + '</span>' : '') + '</span>' + news + '</span></a></li>';
      });
      html += '</ol>';
    }
    html += '<p class="trend-groups__freshness">Source: Google Trends. Refresh checks the available feed; cached source data may lag. This is not a live search counter.</p></section>';
    return html;
  }
  function listOf(value) { return Array.isArray(value) ? value : value && Array.isArray(value.results) ? value.results : []; }
  async function enrich(items, lookup, details, context) {
    const overrides = new Map();
    if (typeof lookup !== 'function' || typeof details !== 'function') return overrides;
    const targets = (items || []).filter(item => item && validPhrase(item.q) && classify(item, context || {}) === 'other').slice(0, 6);
    let cursor = 0;
    async function worker() {
      while (cursor < targets.length) {
        const item = targets[cursor++];
        try {
          let found = listOf(await lookup(item.q));
          if (!found.length) found = listOf(await lookup(words(item.q).slice(0, 2).join(' ')));
          const candidate = found.find(entry => entry && metadataMatch(item.q, item.news, entry));
          if (!candidate) continue;
          let type, id, credit;
          if (candidate.media_type === 'person' || (candidate.known_for && !candidate.media_type)) {
            const credits = candidate.known_for || [];
            credit = credits.find(e => e && (e.media_type === 'movie' || e.media_type === 'tv') && e.id != null);
            if (!credit) continue;
            type = credit.media_type; id = credit.id;
          } else { type = candidate.media_type === 'tv' ? 'tv' : candidate.media_type === 'movie' ? 'movie' : null; id = candidate.id; }
          if (!type || id == null) continue;
          const data = await details(type, id);
          const valid = type === 'movie' ? (countryLanguage(data || {}, 'US', 'en') ? 'hollywood' : countryLanguage(data || {}, 'IN', 'hi') ? 'bollywood' : countryLanguage(data || {}, 'PK', 'ur') ? 'pakistan' : null) : (countryLanguage(data || {}, 'US', 'en') ? 'hollywood' : countryLanguage(data || {}, 'IN', 'hi') ? 'bollywood' : countryLanguage(data || {}, 'PK', 'ur') ? 'pakistan' : countryLanguage(data || {}, 'KR', 'ko') ? 'kdrama' : null);
          if (valid) overrides.set(normalized(item.q) + '|' + normalized(item.geo), valid);
        } catch (_) { /* Optional enrichment never alters source data. */ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, targets.length) }, worker));
    return overrides;
  }
  function mount(host, options) {
    if (!host) throw new Error('TrendingSearches.mount requires a host element');
    options = options || {};
    const context = options.context || {};
    const limit = options.limit || null;
    let generation = 0;
    async function load() {
      const current = ++generation;
      host.innerHTML = '<section class="trend-groups"><h2>Trending Searches</h2><p role="status">Loading trend feed…</p></section>';
      try {
        const response = await root.fetch(API);
        if (!response.ok) throw new Error('Trends request failed (' + response.status + ').');
        const data = await response.json();
        if (current !== generation || host.isConnected === false) return;
        const items = (data && Array.isArray(data.items) ? data.items : []).slice(0, limit || undefined);
        host.innerHTML = render(items, context, data && data.generated);
        const button = host.querySelector('.trend-groups__refresh');
        if (button) button.addEventListener('click', load);
        enrich(items, options.lookup, options.details, context).then(overrides => {
          if (overrides.size && current === generation && host.isConnected !== false) {
            host.innerHTML = render(items, context, data && data.generated, overrides);
            const next = host.querySelector('.trend-groups__refresh');
            if (next) next.addEventListener('click', load);
          }
        });
      } catch (error) {
        if (current !== generation || host.isConnected === false) return;
        host.innerHTML = '<section class="trend-groups"><h2>Trending Searches</h2><p class="trend-groups__error" role="alert">Could not load the trend feed. ' + safe(error && error.message || '') + '</p><button type="button" class="trend-groups__refresh">Retry</button></section>';
        const button = host.querySelector('.trend-groups__refresh');
        if (button) button.addEventListener('click', load);
      }
    }
    host.innerHTML = '<section class="trend-groups"><h2>Trending Searches</h2><button type="button" class="trend-groups__refresh">Refresh</button></section>';
    const button = host.querySelector('.trend-groups__refresh');
    button.addEventListener('click', load);
    load();
    return { refresh: load };
  }
  root.FATrendingSearches = { mount, helpers: { validPhrase, linkFor, classify, prepare, render } };
})(typeof window !== 'undefined' ? window : globalThis);
