/* FlickAtlas — shared data for the popularity-ranked upcoming releases.
   Popularity is TMDB's recorded discovery signal, not a measured audience poll.
   The release calendar remains a separate date-first page at /upcoming. */
(function (root) {
  'use strict';

  const DEFAULT_PAGES = 3;
  const HORIZON_DAYS = 365;
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value + 'T00:00:00Z'));
  function dateAfter(days, start) {
    const date = new Date((start || TMDB.today()) + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  async function fetchIndustry(industry, options) {
    options = options || {};
    const today = TMDB.today();
    const through = dateAfter(options.horizonDays || HORIZON_DAYS, today);
    const pages = Math.max(1, Math.min(5, Number(options.pages) || DEFAULT_PAGES));
    const specs = industry === 'bollywood'
      ? [{ type: 'movie', language: 'hi', country: 'IN', label: 'bollywood' }]
      : industry === 'international'
        ? [
            { type: 'movie', language: 'en', label: 'international' },
            { type: 'tv', language: 'en', label: 'international' },
            { type: 'movie', language: 'ko', label: 'international' },
            { type: 'tv', language: 'ko', label: 'international' },
          ]
        : [
            { type: 'movie', language: 'hi', country: 'IN', label: 'bollywood' },
            { type: 'movie', language: 'en', label: 'international' },
            { type: 'tv', language: 'en', label: 'international' },
            { type: 'movie', language: 'ko', label: 'international' },
            { type: 'tv', language: 'ko', label: 'international' },
          ];

    const jobs = specs.flatMap(spec => Array.from({ length: pages }, (_, index) => {
      const params = {
        with_original_language: spec.language,
        sort_by: 'popularity.desc',
        'primary_release_date.gte': today,
        'primary_release_date.lte': through,
        page: index + 1,
      };
      if (spec.type === 'tv') {
        delete params['primary_release_date.gte'];
        delete params['primary_release_date.lte'];
        params['first_air_date.gte'] = today;
        params['first_air_date.lte'] = through;
      }
      if (spec.country) params.with_origin_country = spec.country;
      return TMDB.discoverResults(spec.type, params)
        .then(items => ({ ok: true, items: (items || []).map(item => ({ ...item, media_type: spec.type, _type: spec.type, _ind: spec.label })) }))
        .catch(() => ({ ok: false, items: [] }));
    }));

    const resultSets = await Promise.all(jobs);
    if (options.strict && resultSets.every(result => !result.ok)) throw new Error('release_data_unavailable');
    const seen = new Set();
    return resultSets.flatMap(result => result.items)
      .filter(item => {
        const date = item._type === 'tv' ? item.first_air_date : item.release_date;
        const key = item._type + ':' + item.id;
        if (!item.id || !item.poster_path || !validDate(date) || date < today || date > through || seen.has(key)) return false;
        seen.add(key);
        item._date = date;
        return true;
      })
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0) || a._date.localeCompare(b._date));
  }

  root.FAMostAwaited = {
    fetch: fetchIndustry,
    horizonDays: HORIZON_DAYS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
