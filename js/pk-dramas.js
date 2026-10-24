/* FlickAtlas — Pakistani drama pool (MASTER §6.7): the current dramas of
   HUM TV, ARY Digital, Har Pal Geo / Geo TV and Green TV, shared by the
   Episode Guides hub and the Airing Today page.

   Identification (all from live TMDB data):
   - origin country is Pakistan (first listed origin = PK), and
   - the channel is attributable: the TMDB network name, or a production
     company that supplies one of the four channels (Momina Duraid / MD
     Productions → HUM TV; Six Sigma Plus / Big Bang / iDream / ARY
     Digital → ARY; 7th Sky Entertainment / Geo Entertainment → Geo TV;
     Multiverse Entertainment → Green TV — every TMDB-networked
     Multiverse title in the live data is a Green TV drama), or the
     curated watchlist below (TMDB leaves the network blank on some
     verified channel dramas — e.g. Rutba, an ARY Digital drama, carries
     no network field), and
   - the drama is CURRENT: an episode aired inside the freshness window
     (§7.6), a next episode is scheduled, or it premiered inside the window.
   Candidates come from origin-PK discovers (popularity + latest premieres
   + an air-date window of the last 3 months) AND per-channel network
   discovers (TMDB network ids: HUM TV 1204, ARY Digital 815, Har Pal Geo
   751, Geo Entertainment 1843, Green TV Entertainment 7134) — the four
   channels' catalogues are deep on TMDB (100+ titles each for HUM/ARY),
   so network-filtered discovery is what fills each channel's rail.
   Dramas that fail any gate never reach the hub — no filler, no old titles. */
const PK = (() => {
  const CHANNELS = ["HUM TV", "ARY Digital", "Geo TV", "Green TV"];

  /* Curated overrides: TMDB id -> channel (verified channel dramas whose
     TMDB record carries no network). Keep small and factual. */
  const WATCHLIST = {
    "337617": "ARY Digital",   // Rutba — ARY Digital
  };

  const NET_MATCH = [
    [/hum/i, "HUM TV"],
    [/ary/i, "ARY Digital"],
    [/geo/i, "Geo TV"],
    [/green/i, "Green TV"],
  ];
  const PROD_MATCH = [
    [/momina duraid|md productions/i, "HUM TV"],
    [/six sigma|big bang entertainment|idream|ary digital/i, "ARY Digital"],
    [/7th sky|geo entertainment/i, "Geo TV"],
    [/green tv|multiverse entertainment/i, "Green TV"],
  ];

  /* TMDB network ids of the four channels (verified live 2026-10-23
     from the dramas' own records: Hum TV #1204, ARY Digital #815,
     Har Pal Geo #751, Geo Entertainment #1843, Green TV #7134). */
  const NETWORK_IDS = [1204, 815, 751, 1843, 7134];

  function channelOf(details) {
    if (!details) return "";
    if (WATCHLIST[String(details.id)]) return WATCHLIST[String(details.id)];
    for (const n of details.networks || []) {
      for (const [re, ch] of NET_MATCH) if (re.test(n.name || "")) return ch;
    }
    for (const c of details.production_companies || []) {
      for (const [re, ch] of PROD_MATCH) if (re.test(c.name || "")) return ch;
    }
    return "";
  }

  let _poolPromise = null;
  /* pool(true) forces a fresh build — used by callers as a one-time
     retry when a transient network failure settled the pool empty. */
  function pool(force) {
    if (force) _poolPromise = null;
    if (_poolPromise) return _poolPromise;
    _poolPromise = (async () => {
      const today = TMDB.today();
      const cutoff = UI.freshCutoff();
      const cand = new Map();
      const add = (arr) => (arr || []).forEach(x => { if (x && x.poster_path) cand.set(x.id, x); });
      const netPools = await Promise.all(NETWORK_IDS.flatMap(nid => [
        TMDB.discoverResults("tv", { with_networks: nid, with_origin_country: "PK", sort_by: "popularity.desc", page: 1 }).catch(() => []),
        TMDB.discoverResults("tv", { with_networks: nid, with_origin_country: "PK", sort_by: "first_air_date.desc", "first_air_date.lte": today, page: 1 }).catch(() => []),
      ]));
      const [pop1, pop2, recent1, recent2, airwin] = await Promise.all([
        TMDB.discoverResults("tv", { with_origin_country: "PK", sort_by: "popularity.desc", page: 1 }).catch(() => []),
        TMDB.discoverResults("tv", { with_origin_country: "PK", sort_by: "popularity.desc", page: 2 }).catch(() => []),
        TMDB.discoverResults("tv", { with_origin_country: "PK", sort_by: "first_air_date.desc", "first_air_date.lte": today, page: 1 }).catch(() => []),
        TMDB.discoverResults("tv", { with_origin_country: "PK", sort_by: "first_air_date.desc", "first_air_date.lte": today, page: 2 }).catch(() => []),
        /* episodes actually airing inside the freshness window — the
           strongest "currently running" signal TMDB discover offers */
        TMDB.discoverResults("tv", { with_origin_country: "PK", "air_date.gte": cutoff, "air_date.lte": today, sort_by: "popularity.desc", page: 1 }).catch(() => []),
      ]);
      /* Candidate order = detail-check priority: the watchlist first,
         then titles with episodes airing right now, latest premieres,
         the channel-network pools, then general popularity. */
      for (const wid of Object.keys(WATCHLIST)) {
        const n = Number(wid);
        if (!cand.has(n)) cand.set(n, { id: n });
      }
      add(airwin); add(recent1); add(recent2);
      netPools.forEach(add);
      add(pop1); add(pop2);
      const out = [];
      const list = [...cand.values()].slice(0, 96);
      /* Detail checks run in small batches with one retry (fix round 2):
         firing ~100 heavy detail requests at once collapses flaky
         connections AND is needlessly heavy for a phone on mobile data —
         batching is the correct shape for real visitors too. */
      const checkOne = async (x) => {
        try {
          let d = await TMDB.details("tv", x.id).catch(() => null);
          if (!d) d = await TMDB.details("tv", x.id).catch(() => null);
          if (!d || !d.poster_path) return;
          const oc = d.origin_country || [];
          if (oc[0] !== "PK") return;
          const channel = channelOf(d);
          if (!channel) return;
          const le = d.last_episode_to_air || null;
          const ne = d.next_episode_to_air || null;
          const lastAir = (le && le.air_date) || d.last_air_date || "";
          const current = (lastAir && lastAir >= cutoff) || !!ne ||
            (d.first_air_date && d.first_air_date >= cutoff);
          if (!current) return;
          out.push({
            item: Object.assign({}, x, d),
            details: d, channel,
            lastEp: le, nextEp: ne, lastAir,
            airingToday: !!((le && le.air_date === today) || (ne && ne.air_date === today)),
          });
        } catch (e) {}
      };
      for (let i = 0; i < list.length; i += 8) {
        await Promise.all(list.slice(i, i + 8).map(checkOne));
      }
      out.sort((a, b) => (b.lastAir || "").localeCompare(a.lastAir || "") ||
        (b.item.popularity || 0) - (a.item.popularity || 0));
      return out;
    })();
    return _poolPromise;
  }

  function epHref(showId, ep) {
    if (!ep) return `/show?id=${showId}`;
    return `/show?id=${showId}&season=${ep.season_number}&ep=${ep.episode_number}`;
  }

  return { CHANNELS, WATCHLIST, channelOf, pool, epHref };
})();
window.PK = PK;
