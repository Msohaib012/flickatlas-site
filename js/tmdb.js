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

  return {
    api, today,
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
