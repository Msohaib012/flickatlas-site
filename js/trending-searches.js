/* FlickAtlas — current Google RSS trends intersected with published articles. */
(function (root) {
  'use strict';
  var TOP_N = 8, WINDOW_MS = 7 * 86400000, FEED_MAX_AGE_MS = 3 * 3600000, TREND_MAX_AGE_MS = 24 * 3600000, PROOF_MAX_AGE_MS = 24 * 3600000;
  var FEEDS = {US:'https://trends.google.com/trending/rss?geo=US', IN:'https://trends.google.com/trending/rss?geo=IN'};
  var GENERIC = {movie:1,movies:1,film:1,films:1,news:1,today:1,'box':1,'office':1,collection:1,collections:1,latest:1,trending:1,trend:1,viral:1,breaking:1,entertainment:1,cinema:1,update:1,updates:1};
  var STOP = {a:1,an:1,the:1,and:1,or:1,of:1,to:1,in:1,on:1,for:1,with:1,at:1,by:1,from:1,is:1,are:1,was:1,were:1,be:1,been:1,this:1,that:1,these:1,those:1,his:1,her:1,its:1,their:1,has:1,have:1,had:1};
  function safe(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function items(data) { return Array.isArray(data) ? data : data && typeof data === 'object' ? Object.keys(data).map(function(k){return data[k];}) : []; }
  function title(a) { return String(a && (a.headline || a.title) || '').trim(); }
  function date(a) { var t = Date.parse(a && (a.published || a.date)); return isFinite(t) ? t : 0; }
  function words(s) { var out = Object.create(null); (String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []).forEach(function(w){if((w.length>2||/^\d+$/.test(w))&&!STOP[w])out[w]=1;}); return out; }
  function countShared(a,b,excludeGeneric) { var n=0; Object.keys(a).forEach(function(w){if(b[w]&&(!excludeGeneric||!GENERIC[w]))n++;}); return n; }
  function within(t, now) { return !!t && t >= now - WINDOW_MS && t <= now; }
  function canonical(id) { return '/news-item?id=' + encodeURIComponent(String(id)); }
  function external(url) {
    try { var u = new URL(String(url)); if (!/^https?:$/.test(u.protocol)) return false; var h=u.hostname.toLowerCase().replace(/\.$/,'');
      return !(h==='flickatlas.co.uk'||h.endsWith('.flickatlas.co.uk')||h==='flickatlas.com'||h.endsWith('.flickatlas.com')||(h.indexOf('flickatlas')===0&&h.endsWith('.hidden-decodes.workers.dev')));
    } catch (_) { return false; }
  }
  function termIn(term, text) { if(!term)return false; var escaped=term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s+'); return new RegExp('(^|[^a-z0-9])'+escaped+'(?=$|[^a-z0-9])','i').test(String(text||'')); }
  function validRelated(list) { return (Array.isArray(list)?list:[]).filter(function(r){return r&&String(r.title||'').trim()&&external(r.url);}); }
  function validProof(p, headline, now) {
    if(!p||p.source!=='google-rss'||!FEEDS[p.geo]||p.source_url!==FEEDS[p.geo])return false;
    var obs=Date.parse(p.observed_at), start=Date.parse(p.started_at);
    if(!isFinite(obs)||obs>now||now-obs>PROOF_MAX_AGE_MS||!isFinite(start)||start>now||now-start>TREND_MAX_AGE_MS)return false;
    var term=String(p.term||'').trim(), tw=words(term), hw=words(headline), rel=validRelated(p.related);
    if(!Object.keys(tw).length||Object.keys(tw).some(function(w){return GENERIC[w];})||!termIn(term,headline)||!rel.length)return false;
    var rw=Object.create(null); rel.forEach(function(r){var w=words(r.title);Object.keys(w).forEach(function(k){rw[k]=1;});});
    if(Object.keys(tw).length===1){var context=rel.map(function(r){return r.title;}).join(' ');if(!termIn(term,context)||countShared(hw,rw,true)<2||!/(\bmovie\b|\bfilm\b|\bbox office\b|\bcinema\b|\bactor\b|\bactress\b|\brelease\b|\btrailer\b|\bcollection\b)/i.test(context))return false;}
    if(countShared(hw,rw,true)<1)return false;
    return true;
  }
  function validTopics(payload, articles, now) {
    if (!payload || payload.source!=='google-rss' || payload.status!=='ok' || !Array.isArray(payload.topics)) return [];
    var checked=Date.parse(payload.checked_at);
    if(!isFinite(checked)||checked>now||now-checked>FEED_MAX_AGE_MS)return [];
    var byId=Object.create(null);
    items(articles).forEach(function(a){if(a&&a.id!=null)byId[String(a.id)]=a;});
    var seen=Object.create(null), output=[];
    payload.topics.forEach(function(t){
      if(!t||!t.article_id||seen[String(t.article_id)])return;
      var id=String(t.article_id), article=byId[id], dt=article&&date(article);
      if(!article||!title(article)||!within(dt,now)||String(t.title||'').trim()!==title(article)||t.url!==canonical(id))return;
      if(!validProof(t.trend_proof,title(article),now))return;
      seen[id]=true; output.push({title:title(article),url:canonical(id),time:dt});
    });
    output.sort(function(a,b){return b.time-a.time||(a.url<b.url?-1:a.url>b.url?1:0);});
    return output.slice(0,TOP_N);
  }
  function relDate(t) { var ui=root.UI||{}; if(typeof ui.relTime==='function')return ui.relTime(t); if(typeof ui.fmtDate==='function'){try{return ui.fmtDate(new Date(t).toISOString().slice(0,10));}catch(_){}} return ''; }
  function render(topics) {
    if(!topics.length)return '';
    var html='<section class="trend-groups trend-mixed" aria-labelledby="trending-topics-title"><header class="trend-groups__header"><div><h2 id="trending-topics-title">Trending Topics</h2></div></header><ol class="trend-mixed-list">';
    topics.forEach(function(a,i){var d=relDate(a.time);html+='<li class="trend-mixed-item"><a class="editorial-search-card trend-search-row" href="'+safe(a.url)+'"><span class="trend-search-rank" style="display:block" aria-hidden="true">'+(i+1)+'</span><span class="editorial-search-card__body"><span class="editorial-search-card__term">'+safe(a.title)+'</span>'+(d?'<span class="trend-search-meta"><span>'+safe(d)+'</span></span>':'')+'</span></a></li>';});
    return html+'</ol></section>';
  }
  function mount(host) {
    if(!host)throw new Error('TrendingTopics.mount requires a host element');
    function load(){var topics=validTopics(root.FA_TRENDING_TOPICS,root.FA_ARTICLES,Date.now());if(host.isConnected===false)return;host.innerHTML=render(topics);if(!topics.length){if(typeof host.remove==='function')host.remove();else host.style.display='none';}}
    load();return {refresh:load};
  }
  root.FATrendingSearches={mount:mount,helpers:{validTopics:validTopics,validProof:validProof,render:render,withinWindow:within,canonical:canonical}};
})(typeof window!=='undefined'?window:globalThis);
  function words(s) { var out = Object.create(null); (String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []).forEach(function(w){if((w.length>2||/^\d+$/.test(w))&&!STOP[w])out[w]=1;}); return out; }
  function words(s) { var out = Object.create(null); (String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []).forEach(function(w){if((w.length>2||/^\d+$/.test(w))&&!STOP[w])out[w]=1;}); return out; }
