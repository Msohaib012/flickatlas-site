/* FlickAtlas OTT cards: information only; theatrical dates are never streaming dates. */
window.FlickAtlasOTT = (() => {
  let pending;
  const day = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) && Number.isFinite(Date.parse(value)) ? value.slice(0,10) : "";
  const digitalDate = (detail, start, end) => ((detail.release_dates || {}).results || []).filter(r => r.iso_3166_1 === "IN").flatMap(r => r.release_dates || []).filter(r => Number(r.type) === 4).map(r => day(r.release_date)).filter(d => d && d >= start && d <= end).sort().pop() || "";
  async function load() {
    if (pending) return pending;
    pending = (async () => {
      const end = TMDB.today(), start = new Date(Date.now()-6*864e5).toISOString().slice(0,10);
      const requests = await Promise.allSettled([
        TMDB.discoverResults("movie", {region:"IN",with_release_type:4,"release_date.gte":start,"release_date.lte":end,sort_by:"popularity.desc"}),
        TMDB.discoverResults("tv", {watch_region:"IN",with_watch_monetization_types:"flatrate","first_air_date.gte":start,"first_air_date.lte":end,sort_by:"popularity.desc"})
      ]);
      if (requests.every(r => r.status === "rejected")) throw Error("OTT source unavailable");
      const candidates = requests.flatMap((result,index) => result.status === "fulfilled" ? (result.value || []).slice(0,index ? 8 : 10).map(item => ({item,type:index ? "tv" : "movie"})) : []);
      const rows = await Promise.all(candidates.map(async row => {
        try {
          const detail = await TMDB.details(row.type,row.item.id);
          const india = UI.providerLines(detail["watch/providers"]).find(([region])=>region === "India");
          return {...row,date:row.type === "movie" ? digitalDate(detail,start,end) : "",premiere:row.type === "tv" ? day(row.item.first_air_date) : "",providers:india ? india[1] : ""};
        } catch (_) { return {...row,date:"",premiere:row.type === "tv" ? day(row.item.first_air_date) : "",providers:""}; }
      }));
      return {rows:rows.sort((a,b)=>(b.date||b.premiere||"").localeCompare(a.date||a.premiere||"")),partial:requests.some(r=>r.status==="rejected")};
    })().catch(error=>{pending=null;throw error;});
    return pending;
  }
  function card(row) {
    const x=row.item, title=UI.titleOf(x), href=`/${row.type === "tv" ? "show" : "movie"}?id=${encodeURIComponent(x.id)}`;
    const dateText=row.type === "movie" ? (row.date ? `Digital release in India: ${UI.fmtDate(row.date)}` : "Digital release date unavailable") : (row.premiere ? `TV premiere: ${UI.fmtDate(row.premiere)} · Streaming arrival date unavailable` : "TV premiere and streaming arrival dates unavailable");
    const poster=`<span class="release-card__poster"><span class="release-noimage">No image available</span>${x.poster_path ? `<img src="${UI.img(x.poster_path,"w185")}" alt="${UI.esc(title)} poster" loading="lazy" onerror="this.remove()">` : ""}</span>`;
    return `<a class="release-card" href="${href}">${poster}<span class="release-card__body"><small class="release-card__meta">${row.type === "tv" ? "TV series" : "Movie"}</small><b class="release-card__title">${UI.esc(title)}</b><span class="release-card__meta">${UI.esc(dateText)}</span><span class="release-card__platform">${row.providers ? `India availability: ${UI.esc(row.providers)}` : "India platform availability unavailable"}</span>${UI.rating(x) ? `<span class="release-card__meta">TMDB rating: ${UI.rating(x)}/10</span>` : ""}</span></a>`;
  }
  async function mount(host,{heading=false,limit=18,type="all"}={}) {
    if(!host)return;
    const token=String(Date.now())+Math.random();host.dataset.ottRequest=token;
    const head=heading ? `<div class="section-head"><h2>OTT Releases This Week</h2><a class="see-all" href="/ott">See All →</a></div><p class="sec-sub">Digital releases and recent TV premieres. India platform listings do not confirm an exact streaming-arrival date.</p>` : "";
    host.innerHTML=head+`<p class="eb-note" role="status">Loading release information…</p>`;
    try {
      const {rows,partial}=await load();if(host.dataset.ottRequest!==token)return;
      const list=rows.filter(r=>type === "all" || r.type === type).slice(0,limit);
      host.innerHTML=head+(partial?`<p class="prov-note">Some source listings could not load.</p>`:"")+(list.length ? `<div class="release-list">${list.map(card).join("")}</div>` : `<p class="prov-note">No matching release records are available for this week.</p>`)+`<p class="prov-note">Platform availability is reported for India and may change. TV premiere dates are not streaming-arrival dates. FlickAtlas does not stream video.</p>`;
    } catch (_) {if(host.dataset.ottRequest===token)host.innerHTML=head+`<p class="prov-note" role="alert">Release information could not load. Please try again.</p>`;}
  }
  return {mount,load,card,digitalDate};
})();
