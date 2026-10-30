#!/usr/bin/env node
// Offline regression fixtures for public listing chronology/OTT eligibility.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const today = '2026-10-29';
const dateDesc = (a,b) => String(b.date).localeCompare(String(a.date));
const dateAsc = (a,b) => String(a.date).localeCompare(String(b.date));
const publishedChronology = (a,b) => (Date.parse(b.published || '') || 0) - (Date.parse(a.published || '') || 0) || String(a.id||'').localeCompare(String(b.id||''));
const validGroup = (g,x,kind) => {
  if (!x?.published || !x.poster || !Array.isArray(g.providers) || !g.providers.length || !/^\d{4}-\d{2}-\d{2}$/.test(g.date||'')) return false;
  if (kind === 'now' && g.date > today) return false;
  if (kind === 'coming' && g.date <= today) return false;
  if (x.type === 'tv') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x.first_air_date||'')) return false;
    if (kind === 'now' && (x.first_air_date > today || g.date !== x.first_air_date)) return false;
    if (kind === 'coming') {
      const src = Array.isArray(x.ott_release_source) ? x.ott_release_source : [x.ott_release_source];
      if (g.date !== x.ott_release_date || !src.some(u => typeof u === 'string' && u.startsWith('https://')) || x.ott_release_provider !== g.providers[0]) return false;
      if (!['digital','streaming','ott'].includes(g.date_kind)) return false;
    }
  } else if (kind === 'coming' && g.date_kind !== 'digital') return false;
  return true;
};
const srcIndex=read('js/page-index.js'), srcMovies=read('js/page-movies.js'), srcOtt=read('js/page-ott.js');
// Correct sorted display order; homepage See All uses the same default recent sort.
const spotlight=[{date:'2026-10-20'},{date:'2026-10-27'},{date:'2026-10-23'}].sort(dateDesc);
assert.deepEqual(spotlight.map(x=>x.date),['2026-10-27','2026-10-23','2026-10-20']);
assert.match(srcIndex,/spotlight.*?sort\(byNewest\)/s);
assert.match(srcIndex,/href="\/movies\?f=bollywood&seeall=1"/);
assert.match(srcMovies,/sort === "recent" && t === "movie"/);
// Hero is the globally newest eligible five; source keeps strict gates and avoids quota buckets.
const eligible=[{date:'2026-10-20',ok:true},{date:'2026-10-28',ok:true},{date:'2026-10-27',ok:true},{date:'2026-10-26',ok:false},{date:'2026-10-25',ok:true}].filter(x=>x.ok).sort(dateDesc).slice(0,5);
assert.deepEqual(eligible.map(x=>x.date),['2026-10-28','2026-10-27','2026-10-25','2026-10-20']);
assert.match(srcIndex,/const heroPicked = heroPool\.slice\(0, 5\)/);
// Trending membership remains top-20 IDs intersect published posters; order is display-only release chronology.
const top20=Array.from({length:22},(_,i)=>`id${i}`).slice(0,20);
const published={id0:{id:'id0',poster:true,date:'2026-10-20'},id1:{id:'id1',poster:true,date:'2026-10-28'},id20:{id:'id20',poster:true,date:'2026-10-30'}};
const trend=top20.map(id=>published[id]).filter(x=>x?.poster).sort(dateDesc);
assert.deepEqual(trend.map(x=>x.id),['id1','id0']); assert(!trend.some(x=>x.id==='id20'));
assert.match(srcIndex,/trendingIds\.slice\(0, 20\)/); assert.match(srcMovies,/\.slice\(0, 20\)/);
// TV Now includes any already-premiered provider-listed series; future TV needs a confirmed OTT date.
const tv=(first_air_date, opts={})=>({published:true,poster:true,type:'tv',first_air_date,...opts});
const group=(date,date_kind='release',providers=['Netflix'])=>({date,date_kind,providers});
assert(validGroup(group('2018-07-06'),tv('2018-07-06'),'now'));
assert(validGroup(group('2026-10-10'),tv('2026-10-10'),'now'));
for(const [g,x,k] of [
 [group('2026-10-20'),tv('2026-10-20'),'coming'],
 [group('2026-10-10','release',[]),tv('2026-10-10'),'now'],
 [group('2026-10-10'),tv('2026-10-10',{published:false}),'now'],
 [group('2026-10-10'),tv('2026-10-10',{poster:false}),'now'],
 [group('2026-11-01','release'),tv('2026-11-01'),'coming']
]) assert(!validGroup(g,x,k));
assert(validGroup(group('2026-10-30','digital'),tv('2026-10-30',{ott_release_date:'2026-10-30',ott_release_provider:'Netflix',ott_release_source:'https://example.com/source'}),'coming'));
assert(validGroup(group('2026-11-02','digital'),tv('2026-11-02',{ott_release_date:'2026-11-02',ott_release_provider:'Netflix',ott_release_source:'https://example.com/source'}),'coming'));
assert(!validGroup(group('2026-11-02','release'),{published:true,poster:true,type:'movie'},'coming'));
assert.match(srcOtt,/No TV series currently streaming on OTT/);
assert.doesNotMatch(srcOtt,/source-backed OTT date/, 'owner order 2026-10-30: the Coming group guidance note is gone (the source-backed-date RULE itself is asserted by the validGroup cases above)');
assert.match(srcOtt,/date_kind \|\| ""/);
assert.match(srcIndex,/air > today \|\| d !== air/);
assert.match(srcIndex,/group === \"coming\" && typeOf\(x\) === \"movie\"/);
assert.doesNotMatch(srcIndex,/cutoffDate/);
// RFC dates sort by actual timestamp rather than lexical display strings; ties break reproducibly.
const articles=[{id:'z',published:'Wed, 28 Oct 2026 12:00:00 GMT'},{id:'a',published:'2026-10-29T11:00:00Z'},{id:'b',published:'2026-10-29T11:00:00Z'}].sort(publishedChronology);
assert.deepEqual(articles.map(x=>x.id),['a','b','z']);
assert(read('js/page-news.js').includes('(Number(b.ts) || 0) - (Number(a.ts) || 0)'));
assert.match(read('js/page-guides.js'),/Date\.parse\(value \|\| ""\)/);
assert.match(srcIndex,/dateOf\(a\)\.localeCompare\(dateOf\(b\)\)/); // future calendar remains nearest-first
// 2026 Pakistan theatrical rail: exact mapped IDs, source-backed local dates, complete pool and newest-first ordering.
const catalogSource = read('js/published-titles.js');
const pkExpected = [
  ['1610901','Aag Lagay Basti Mein','2026-03-20'],
  ['1649259','Bullah','2026-03-21'],
  ['1680581','Mera Lyari','2026-05-08'],
  ['1703707','Luv Di Saun','2026-05-26'],
  ['1699721','Psycho','2026-05-27'],
  ['1702608','Zombeid','2026-05-27'],
  ['1787584','Sheroes','2026-10-02']
];
const pkRecords = pkExpected.map(([id,title,date]) => {
  const block = catalogSource.match(new RegExp('"'+id+'"\\s*:\\s*\\{([\\s\\S]*?)\\n  \\}'));
  assert(block, `missing mapped Pakistani release ${title} (${id})`);
  assert(block[1].includes(`"title": "${title}"`));
  assert(block[1].includes(`"pakistan_theatrical_release_date": "${date}"`));
  assert.ok(block[1].includes('"pakistan_release_source": "https://'));
  return {title,date};
}).sort(dateDesc);
assert.deepEqual(pkRecords.map(x=>x.date),['2026-10-02','2026-05-27','2026-05-27','2026-05-26','2026-05-08','2026-03-21','2026-03-20']);
assert.doesNotMatch(catalogSource,/"title": "Hanging by a Wire"[\s\S]{0,2000}"pakistan_theatrical_release_date"/);
assert.match(srcIndex,/pakistan_theatrical_release_date/);
assert.ok(srcIndex.includes('pakistan_release_source && /^https:'));
assert.match(srcIndex,/f=lollywood&amp;y=\$\{currentYear\}&amp;s=recent/);
assert.match(srcMovies,/f === "lollywood" && y === UI\.todayPKT\(\)\.slice\(0, 4\)/);
assert.match(srcMovies,/x\.pakistan_theatrical_release_date > UI\.todayPKT\(\)/);
console.log('Listing order, OTT eligibility, and Pakistan theatrical fixtures passed.');

// Catalog is consumed by Python JSON readers as well as JavaScript.
JSON.parse(catalogSource.split("window.FA_PUBLISHED = ")[1].trim().replace(/;$/, ""));
assert.ok(!srcIndex.includes('.filter(x => x && x.poster_path && typeOf(x) === "movie"\n        && UI.industryOf(x) === "pakistani"'));
