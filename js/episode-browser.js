/* FlickAtlas episode browser: bounded UI-only TMDB reader. Load after UI/TMDB. */
window.EpisodeBrowser = (() => {
  const REGIONS = [["all","All"],["PK","Pakistan"],["IN","India"],["KR","Korea"],["other","Other"]];
  const today = () => TMDB.today();
  const origin = x => Array.isArray(x.origin_country) ? x.origin_country : [];
  const inRegion = (d, region) => region === "all" || (region === "other" ? !["PK","IN","KR"].some(c=>origin(d).includes(c)) : origin(d).includes(region));
  const discover = async region => {
    const p={with_genres:"18|10766",sort_by:"first_air_date.desc","first_air_date.lte":today(),page:1};
    if (["PK","IN","KR"].includes(region)) p.with_origin_country=region;
    const data=await TMDB.discoverResults("tv",p);
    if (!Array.isArray(data)) throw new Error("Invalid catalog response");
    return data;
  };
  const validEpisode=e=>{if(!e||!/^\d{4}-\d{2}-\d{2}$/.test(e.air_date||""))return false;const dt=new Date(`${e.air_date}T00:00:00Z`);return dt.toISOString().slice(0,10)===e.air_date&&Number.isInteger(Number(e.season_number))&&Number(e.season_number)>=0&&Number.isInteger(Number(e.episode_number))&&Number(e.episode_number)>0};
  async function fetchRows(region="all", limit=8, {mode="latest", network=""}={}) {
    const candidates=await discover(region), seen=new Set(), list=candidates.filter(x=>x&&x.id&&!seen.has(x.id)&&seen.add(x.id)).slice(0,Math.min(8,Math.max(0,Number(limit)||0)));
    let failed=0, details=0;
    const settled=await Promise.all(list.map(async x=>{try{
      const d=await TMDB.details("tv",x.id); details++;
      if(!d||!inRegion(d,region)||!(d.genres||[]).some(g=>[18,10766].includes(g.id)))return [];
      const networks=(d.networks||[]).map(n=>n.name).filter(Boolean);
      if(network&&!networks.includes(network))return [];
      const candidates=mode==="airing"?[d.last_episode_to_air,d.next_episode_to_air]:[d.last_episode_to_air];
      return candidates.filter(validEpisode).map(ep=>({show:d,ep,source:ep===d.last_episode_to_air?"last_episode_to_air":"next_episode_to_air"}));
    }catch(_){failed++;return []}}));
    const all=settled.flat(); const rows=all.filter(r=>mode!=="airing"||r.ep.air_date===today());
    rows.sort((a,b)=>(b.ep.air_date||"").localeCompare(a.ep.air_date||""));
    const shows=settled.flatMap(xs=>xs.map(r=>r.show));
    const networkOptions=[...new Set(shows.flatMap(s=>(s.networks||[]).map(n=>n.name).filter(Boolean)))].sort();
    rows.meta={all,failed,details,networkOptions};
    return rows;
  }
  const esc=x=>UI.esc(String(x??""));
  const episodeHref=(s,e)=>`/show?id=${encodeURIComponent(s.id)}&season=${encodeURIComponent(e.season_number)}&ep=${encodeURIComponent(e.episode_number)}`;
  function card(r){const {show:s,ep:e}=r,still=e.still_path;const img=still?UI.img(still,"w300"):(s.poster_path?UI.img(s.poster_path,"w300"):(s.backdrop_path?UI.img(s.backdrop_path,"w300"):""));
    const label=still?"Episode still":(s.poster_path?"Show poster (episode still unavailable)":(s.backdrop_path?"Show backdrop (episode still unavailable)":"No image available"));
    const image=img?`<img src="${img}" alt="${esc(label)} for ${esc(UI.titleOf(s))}" loading="lazy" onerror="this.parentElement.innerHTML='<span class=&quot;eb-noimage&quot;>No image available</span>'">`:`<span class="eb-noimage">No image available</span>`;
    const network=(s.networks||[]).map(n=>n.name).filter(Boolean).join(", ");
    return `<a class="eb-card" href="${episodeHref(s,e)}"><span class="eb-image">${image}</span><span class="eb-copy"><b>${esc(UI.titleOf(s))}</b><span>Season ${esc(e.season_number)} · Episode ${esc(e.episode_number)}</span><span>${esc(UI.fmtDate(e.air_date))}</span>${network?`<span>${esc(network)}</span>`:""}<small>${esc(label)}</small></span></a>`;
  }
  function regionTabs(active){return `<div class="eb-tabs" role="group" aria-label="Filter episodes by origin">${REGIONS.map(([v,l])=>`<button type="button" data-eb-region="${v}" aria-pressed="${active===v}">${l}</button>`).join("")}</div>`}
  async function mount(target,{region="all",limit=8,compact=false,mode="latest",network="",syncUrl=false,showFilters=true}={}){
    const root=typeof target==="string"?document.querySelector(target):target;if(!root)return;
    let current=REGIONS.some(x=>x[0]===region)?region:"all", currentNetwork=network, token=0;
    const render=async()=>{const my=++token;
      root.innerHTML=`${showFilters ? regionTabs(current)+'<label class="eb-network-label">Network <select data-eb-network><option value="">All reported networks</option></select></label>' : ""}${mode==="airing"?'<p class="eb-note">Airing today means the reported episode air date exactly matches today’s date.</p>':""}<div class="eb-grid">${Array.from({length:Math.min(limit,5)}).map(()=>'<span class="eb-loading">Loading episode guides…</span>').join("")}</div>`;
      const grid=root.querySelector(".eb-grid");
      root.querySelectorAll("[data-eb-region]").forEach(b=>b.addEventListener("click",()=>{current=b.dataset.ebRegion;if(syncUrl)updateUrl();render()}));
      root.querySelector("[data-eb-network]")?.addEventListener("change",e=>{currentNetwork=e.target.value;if(syncUrl)updateUrl();render()});
      try{const result=await fetchRows(current,limit,{mode,network:currentNetwork});if(my!==token)return;const meta=result.meta;
        const select=root.querySelector("[data-eb-network]");if(select){select.innerHTML='<option value="">All reported networks</option>'+meta.networkOptions.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join("");select.value=meta.networkOptions.includes(currentNetwork)?currentNetwork:"";}
        if(mode==="airing"){
          const past=meta.all.filter(r=>r.ep.air_date<today()).sort((a,b)=>b.ep.air_date.localeCompare(a.ep.air_date)).slice(0,8), future=meta.all.filter(r=>r.ep.air_date>today()).sort((a,b)=>a.ep.air_date.localeCompare(b.ep.air_date)).slice(0,8);
          const primary=result.length?result.map(card).join(""):'<p class="eb-state">No episodes reported with an air date matching today.</p>';
          const pastCards=past.filter(r=>r.ep.air_date>=new Date(Date.now()-7*86400000).toISOString().slice(0,10)).map(card).join("");
          const futureCards=future.filter(r=>r.ep.air_date<=new Date(Date.now()+7*86400000).toISOString().slice(0,10)).map(card).join("");
          grid.innerHTML=primary+`<h2 class="eb-subheading">Recently aired (past 7 days)</h2>${pastCards||'<p class="eb-state">No episodes reported in the past 7 days.</p>'}<h2 class="eb-subheading">Coming up (next 7 days)</h2>${futureCards||'<p class="eb-state">No upcoming episodes reported.</p>'}`;
        }else grid.innerHTML=result.length?result.map(card).join(""):meta.failed===meta.details&&meta.details>0?'<p class="eb-state">Could not load episode details. Please try again.</p>':'<p class="eb-state">No matching dated episodes are available for this region and network in the reported data.</p>';
      }catch(_){if(my===token)grid.innerHTML='<p class="eb-state">Could not load episode data from TMDB. Please try again.</p>'}
    };
    const updateUrl=()=>{const u=new URL(location.href);u.searchParams.set("f",current);if(currentNetwork)u.searchParams.set("network",currentNetwork);else u.searchParams.delete("network");history.replaceState(null,"",u)};
    await render();
  }
  return {REGIONS,fetchRows,mount,episodeHref};
})();
