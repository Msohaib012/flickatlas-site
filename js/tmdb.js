/* FlickAtlas — TMDB API helpers (client-side, public key in config.js) */
const TMDB = (() => {
  const BASE = "https://api.themoviedb.org/3";
  const _cache = new Map();

  async function api(path, params = {}) {
    const url = new URL(BASE + path);
    url.searchParams.set("api_key", CONFIG.TMDB_KEY);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
    const ck = url.toString();
    const hit = _cache.get(ck);
    if (hit && Date.now() - hit.t < 300000) return hit.p;
    const p = (async () => {
      const r = await fetch(ck);
      if (!r.ok) throw new Error("TMDB_HTTP_" + r.status);
      return r.json();
    })();
    _cache.set(ck, { p, t: Date.now() });
    if (_cache.size > 150) _cache.delete(_cache.keys().next().value);
    try { return await p; } catch (e) { _cache.delete(ck); throw e; }
  }

  const results = (p) => p.then(d => d.results || []);
  const today = () => new Date().toISOString().slice(0, 10);

  const PROVIDER_REGIONS = ["IN", "US", "GB"];

  const _names = (arr) => (arr || []).map(g => (g && g.name) || "").filter(Boolean);
  const _codes = (arr, key) => (arr || []).map(x => (x && x[key]) || "").filter(Boolean);

  function _pickTrailer(d) {
    const vids = ((d && d.videos) || {}).results || [];
    for (const v of vids) {
      if (v && v.type === "Trailer" && v.official && v.site === "YouTube" && v.key) {
        return { key: v.key, name: v.name || "", site: "YouTube" };
      }
    }
    return null;
  }
  function _theatricalDates(entry) {
    const out = [];
    for (const r of ((entry || {}).release_dates || [])) {
      if (r && r.type === 3 && r.release_date) out.push(String(r.release_date).slice(0, 10));
    }
    return out.sort();
  }
  function _pickReleaseDate(d) {
    /* Same rule as the publisher (scripts/publish-titles.py): India
       theatrical first, then the earliest theatrical date anywhere,
       then the TMDB primary date. */
    const results = ((d && d.release_dates) || {}).results || [];
    const byCountry = {};
    for (const r of results) if (r && r.iso_3166_1) byCountry[String(r.iso_3166_1).toUpperCase()] = r;
    const inTh = _theatricalDates(byCountry.IN);
    if (inTh.length) return inTh[0];
    const all = [];
    for (const r of results) all.push(..._theatricalDates(r));
    all.sort();
    if (all.length) return all[0];
    return d.release_date || "";
  }
  function _isFestivalOnly(d) {
    const results = ((d && d.release_dates) || {}).results || [];
    const seen = new Set();
    for (const e of results) for (const r of (e.release_dates || [])) {
      if (r && Number.isInteger(r.type)) seen.add(r.type);
    }
    return seen.size > 0 && seen.size === 1 && seen.has(1);
  }
  function _certOf(entry) {
    if (!entry) return "";
    for (const r of (entry.release_dates || [])) {
      if (r && r.type === 3 && r.certification) return r.certification;
    }
    for (const r of (entry.release_dates || [])) {
      if (r && r.certification) return r.certification;
    }
    return "";
  }
  function _pickCertificationMovie(d) {
    const results = ((d && d.release_dates) || {}).results || [];
    const byCountry = {};
    for (const r of results) if (r && r.iso_3166_1) byCountry[String(r.iso_3166_1).toUpperCase()] = r;
    return _certOf(byCountry.IN) || _certOf(byCountry.US) ||
      results.map(_certOf).find(Boolean) || "";
  }
  function _pickCertificationTv(d) {
    const results = ((d && d.content_ratings) || {}).results || [];
    const byCountry = {};
    for (const r of results) if (r && r.iso_3166_1) byCountry[String(r.iso_3166_1).toUpperCase()] = r;
    return (byCountry.IN && byCountry.IN.rating) || (byCountry.US && byCountry.US.rating) || "";
  }
  function _providersWtw(watch) {
    /* Same rule as the catalogue builder: flatrate/rent/buy for the
       first region (IN, then US, then GB) that has ANY provider. Each
       entry is {name, logo_path, region, kind}. */
    const results = (watch && watch.results) || {};
    for (const region of PROVIDER_REGIONS) {
      const entry = results[region] || {};
      const out = [];
      for (const kind of ["flatrate", "rent", "buy"]) {
        for (const p of (entry[kind] || [])) {
          if (p && p.provider_name) {
            out.push({ name: p.provider_name, logo_path: p.logo_path || "", region, kind });
          }
        }
      }
      if (out.length) return out;
    }
    return [];
  }
  function _flatrateProviders(watch) {
    const results = (watch && watch.results) || {};
    const out = [], seen = new Set();
    for (const region of PROVIDER_REGIONS) {
      for (const p of (((results[region] || {}).flatrate) || [])) {
        if (p && p.provider_name && !seen.has(p.provider_name)) {
          seen.add(p.provider_name);
          out.push({ name: p.provider_name });
        }
      }
    }
    return out;
  }

  async function liveEntry(type, id) {
    /* Live TMDB fallback (2026-11-14, owner order): one details call
       (videos + credits + release_dates/content_ratings +
       watch/providers appended) builds a published-shaped entry for a
       title that is neither published nor catalogued, so its post
       renders full — hero/story/facts/trailer/where-to-watch/cast/
       crew — instead of the empty "not published" state. The entry is
       rendered in-memory only: nothing is written to FA_PUBLISHED or
       the catalogue, so it can never duplicate them. The AI-written
       parts (Reviews, related news) stay published-only — the page
       simply shows no such section for a live title. Returns
       { entry, credits } or null when TMDB has no such title (404)
       or the call fails/times out (8s, same discipline as the
       credits fetch). */
    const append = type === "tv"
      ? "videos,credits,content_ratings,watch/providers"
      : "videos,credits,release_dates,watch/providers";
    let d;
    try {
      d = await Promise.race([
        api(`/${type}/${id}`, { append_to_response: append }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("live timeout")), 8000)),
      ]);
    } catch (_) { return null; }
    if (!d || !d.id) return null;
    const watch = d["watch/providers"] || null;
    const entry = {
      id: d.id,
      type,
      title: d.title || d.name || "",
      poster_path: d.poster_path || null,
      backdrop_path: d.backdrop_path || null,
      vote_average: d.vote_average || 0,
      vote_count: d.vote_count || 0,
      overview: d.overview || "",
      popularity: d.popularity || 0,
      original_language: d.original_language || "",
      origin_country: d.origin_country || [],
      trailer: _pickTrailer(d),
      budget: d.budget || 0,
      revenue: d.revenue || 0,
      genres: _names(d.genres),
      tagline: d.tagline || "",
      status: d.status || "",
      production_countries: _codes(d.production_countries, "iso_3166_1"),
      spoken_languages: _codes(d.spoken_languages, "iso_639_1"),
      providers: _flatrateProviders(watch),
      providers_wtw: _providersWtw(watch),
      source: "tmdb-live",
    };
    if (type === "movie") {
      entry.release_date = _pickReleaseDate(d);
      entry.date_kind = _isFestivalOnly(d) ? "festival" : "release";
      entry.runtime = d.runtime || 0;
      entry.certification = _pickCertificationMovie(d);
    } else {
      entry.first_air_date = d.first_air_date || "";
      entry.networks = _names(d.networks);
      entry.seasons = d.seasons || [];
      entry.created_by = (d.created_by || []).map(c => (c && c.name) || "").filter(Boolean);
      entry.episode_run_time = d.episode_run_time || [];
      entry.number_of_episodes = d.number_of_episodes || 0;
      entry.number_of_seasons = d.number_of_seasons || 0;
      entry.certification = _pickCertificationTv(d);
    }
    return { entry, credits: d.credits || null };
  }

  return {
    api, today, liveEntry,
    trending: (media = "movie", win = "week") => results(api(`/trending/${media}/${win}`)),
    popular: (type, page = 1) => api(`/${type}/popular`, { page }),
    topRated: (type, page = 1) => api(`/${type}/top_rated`, { page }),
    nowPlaying: (page = 1) => api("/movie/now_playing", { page }),
    upcomingMovies: (page = 1) => api("/movie/upcoming", { page }),
    airingToday: (page = 1) => api("/tv/airing_today", { page }),
    onTheAir: (page = 1) => api("/tv/on_the_air", { page }),
    details: (type, id) => api(`/${type}/${id}`, {
      append_to_response: type === "tv"
        ? "videos,credits,similar,keywords,content_ratings,watch/providers"
        : "videos,credits,similar,keywords,release_dates,watch/providers",
    }),
    person: (id) => api(`/person/${id}`),
    personCredits: (id) => api(`/person/${id}/combined_credits`),
    popularPeople: (page = 1) => api("/person/popular", { page }),
    discover: (type, params = {}) => api(`/discover/${type}`, Object.assign({ include_adult: "false" }, params)),
    discoverResults: (type, params = {}) => results(api(`/discover/${type}`, Object.assign({ include_adult: "false" }, params))),
    searchMulti: (q, page = 1) => api("/search/multi", { query: q, include_adult: "false", page }),
  };
})();
