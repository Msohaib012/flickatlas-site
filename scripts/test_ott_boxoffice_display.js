#!/usr/bin/env node
// Offline tests only: no source fetches, workflow dispatches, or writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const pageSource = fs.readFileSync(path.join(__dirname, '..', 'js/page-index.js'), 'utf8');
const helper = require('../js/home-boxoffice.js');
const today = '2026-10-30';
const ottToday = '2026-10-29';
const normalize = x => JSON.parse(JSON.stringify(x));

// Keep the OTT fallback contract covered while the Box Office renderer changes.
const provider = { name: 'Netflix', logo_path: '/netflix.png' };
const movie = (id, date, extra = {}) => ({ id, type: 'movie', poster_path: '/poster.jpg', release_date: date, providers: [provider], ...extra });
const tv = (id, date, extra = {}) => ({ id, type: 'tv', poster_path: '/poster.jpg', first_air_date: date, providers: [provider], ...extra });
const items = [
  movie(1, '2026-10-20'),
  movie(2, '2026-11-01'),
  tv(3, '2026-11-02'),
  tv(4, '2026-10-30', { ott_release_date: '2026-10-30', ott_release_provider: 'Netflix', ott_release_source: 'https://official.example/series' }),
  tv(5, '2018-07-06'),
  tv(6, '2026-11-03', { ott_release_date: '2026-11-03', ott_release_provider: 'Netflix', ott_release_source: 'http://unverified.example/series' }),
  tv(7, '2026-11-04', { ott_release_date: '2026-11-04', ott_release_provider: 'Prime Video', ott_release_source: 'https://official.example/series' }),
  tv(8, '2026-10-10', { industry: 'pakistani' }),
  movie(9, '2026-10-10', { providers: [] }),
];
const fallbackStart = pageSource.indexOf('    const ottGroups = (() => {');
const fallbackEnd = pageSource.indexOf('    const pubMap = {};', fallbackStart);
assert(fallbackStart >= 0 && fallbackEnd > fallbackStart, 'homepage OTT fallback anchor changed');
const fallbackCode = pageSource.slice(fallbackStart, fallbackEnd) + '\nottGroups;';
const context = { window: {}, today: ottToday, UI: { industryOf: x => x?.industry || 'bollywood' },
  pubAll: () => items, typeOf: x => x.type || 'movie', dateOf: x => x.release_date || '' };
const groups = normalize(vm.runInNewContext(fallbackCode, context));
assert.deepEqual(groups.now.map(x => x.id), [1, 5]);
assert.deepEqual(groups.coming.map(x => x.id), [4]);
assert.equal(groups.coming[0].date_kind, 'digital');
assert.equal(groups.coming[0].date, '2026-10-30');
assert.deepEqual(groups.coming[0].providers, [provider]);
assert(!groups.coming.some(x => x.id === 2 || x.id === 3));
const baked = { now: [{ id: 99 }], coming: [] };
assert.equal(vm.runInNewContext(fallbackCode, { ...context, window: { FA_OTT: baked } }), baked,
  'valid generated OTT data remains authoritative');

// India Net + Overseas may form worldwide only with source-backed, exact-date,
// same-currency components; a lone or incompatible component never qualifies.
const pair = (day, date, collection, overseas, extra = {}) => ({ day: `Day ${day}`, date, collection, overseas, ...extra });
const worldwideDay = (day, date, amount, extra = {}) => ({ day: `Day ${day}`, date, amount, scope: 'worldwide', currency: 'USD',
  source_name: 'source.example', source_url: `https://source.example/day/${day}`, ...extra });
const pairProof = (row, extra = {}) => ({
  date: row.date, date_disagreed: false, india: true, collection_usd: row.collection,
  collection_currency: 'USD', collection_scope: 'india_net', sources: { sacnilk: 1 },
  extras: { overseas: { value: row.overseas, currency: 'USD', scope: 'overseas_gross',
    date: row.date, date_disagreed: false, sources: { 'overseas-ai': 1 } } }, ...extra,
});
assert.equal(helper.rowWorldAmount(pair(1, today, 10, 5)), null,
  'raw India Net + Overseas values are not accepted as an explicit worldwide row');
assert.equal(helper.rowWorldAmount(pair(1, today, 10, null)), null, 'missing overseas component stays missing');
assert.equal(helper.rowWorldAmount({ day: 1, date: today, collection: 20, scope: 'india_net' }), null,
  'India Net alone is never worldwide');
assert.equal(helper.rowWorldAmount({ day: 1, date: today, collection: 20, overseas: 5, scope: 'domestic-only' }), null,
  'domestic-only scope is rejected');
const explicit = helper.rowWorldAmount({ day: 1, date: today, collection: 21, overseas: 5, scope: 'worldwide', currency: 'USD',
  source_url: 'https://worldwide.example/report', source_name: 'worldwide.example' });
assert.equal(explicit.amount, 21, 'explicit worldwide total is used as-is, not added to components');
assert.equal(explicit.method, 'explicit_worldwide_day');

const pairRelease = '2026-10-24';
const sourcePairs = Array.from({ length: 7 }, (_, i) => pair(i + 1, helper.shiftDate(pairRelease, i), 11, 5));
const pairSidecar = Object.fromEntries(sourcePairs.map(row => [String(Number(row.day.match(/\d+/)[0])), pairProof(row)]));
const pairItem = { id: 'pair-fixture', release_date: pairRelease };
const paired = helper.pairedMetrics(pairItem, sourcePairs, pairSidecar, today, '2026-10-30T06:00:00Z');
assert.equal(paired.today.amount, 16);
assert.equal(paired.today.scope, 'worldwide');
assert.equal(paired.today.method, 'paired_components');
assert.equal(paired.today.currency, 'USD');
assert.deepEqual(paired.today.components.india_net.source_names, ['Sacnilk']);
assert.deepEqual(paired.today.components.overseas_gross.source_names, ['Overseas AI']);
assert.equal(paired.last_7_days.amount, 112, 'all seven exact paired dates are summed');
assert.equal(paired.last_7_days.pair_dates.length, 7);
assert.equal(paired.cumulative_total.amount, 112);
assert.equal(helper.resolveMetric(pairItem, sourcePairs, {}, paired, 'today', today).method, 'paired_components',
  'same-window pair wins over a direct worldwide report');
const invalidPair = (mutate) => {
  const proof = JSON.parse(JSON.stringify(pairSidecar));
  mutate(proof['7']);
  return helper.pairedMetrics(pairItem, sourcePairs, proof, today, '2026-10-30T06:00:00Z');
};
assert.equal(invalidPair(proof => { proof.extras.overseas.currency = 'INR'; }).today, undefined,
  'different component currencies are never added');
assert.equal(invalidPair(proof => { proof.extras.overseas.date = '2026-10-29'; }).today, undefined,
  'different component dates are never added');
assert.equal(invalidPair(proof => { proof.date_disagreed = true; }).today, undefined,
  'source date disagreement blocks a component');
assert.equal(invalidPair(proof => { proof.extras.overseas.sources = {}; }).today, undefined,
  'unprovenanced Overseas values are never added');
assert.equal(invalidPair(proof => { proof.collection_usd += 1; }).today, undefined,
  'sidecar and displayed inner-page India values must match');
assert.equal(helper.resolveMetric(pairItem, sourcePairs, {}, {}, 'today', today), null,
  'a missing pair and missing direct worldwide source stay unreported');

// Daily windows require complete dates since release, and include only Days 1–30.
const recentRelease = '2026-10-24';
const weekRows = Array.from({ length: 7 }, (_, i) => worldwideDay(i + 1, helper.shiftDate(recentRelease, i), 11));
const week = helper.localDailyMetric(weekRows, 'last_7_days', recentRelease, today);
assert.equal(week.amount, 77);
assert.equal(week.sources.length, 7, 'all source URLs for a seven-day aggregate are retained');
assert.equal(week.observed_date, today);
assert.equal(week.reported_days, 7);
assert.equal(week.period_start, '2026-10-24');
assert.equal(week.period_end, today);
assert.equal(helper.localDailyMetric(weekRows.slice(1), 'last_7_days', recentRelease, today), null,
  'a missing date blocks a partial 7-day worldwide amount');
assert.equal(helper.localDailyMetric([
  ...weekRows.slice(0, 6), worldwideDay(7, today, 11, { currency: 'INR' }),
], 'last_7_days', recentRelease, today), null, 'currency mismatch blocks the window');
assert.equal(helper.localDailyMetric([worldwideDay(31, today, 11)], 'today', today, today), null,
  'Day 31 cannot appear as a daywise homepage amount');

const day31Release = '2026-10-01';
const day31Rows = Array.from({ length: 31 }, (_, i) => pair(i + 1, helper.shiftDate(day31Release, i), 1, 2));
const day31Proof = Object.fromEntries(day31Rows.map(row => [String(Number(row.day.match(/\d+/)[0])), pairProof(row)]));
const pairAfterDay30 = helper.pairedMetrics({ id: 'older-pair', release_date: day31Release }, day31Rows,
  day31Proof, '2026-10-31', '2026-10-31T00:00:00Z');
assert.equal(pairAfterDay30.today, undefined, 'Day 31 cannot appear as a paired daily figure');
assert.equal(pairAfterDay30.last_7_days, undefined, 'a 7-day row window containing Day 31 is not shown as daywise');
assert.equal(pairAfterDay30.cumulative_total.amount, 93, 'Day 31 may contribute to cumulative total only');
assert.equal(pairAfterDay30.cumulative_total.through_day, 31);
const explicitWorldwideDay31Rows = Array.from({ length: 31 }, (_, i) => worldwideDay(i + 1, helper.shiftDate(day31Release, i), 3));
const totalDay31 = helper.localDerivedTotal(explicitWorldwideDay31Rows, day31Release, '2026-10-31');
assert.equal(totalDay31.amount, 93, 'cumulative total may include Day 31 while no Day 31 daily figure is exposed');
assert.equal(totalDay31.through_day, 31);
assert.equal(totalDay31.sources.length, 31, 'cumulative worldwide total retains its contributing source URLs');
assert.equal(helper.localDerivedTotal(day31Rows, day31Release, '2026-10-31'), null,
  'inner-page India Net + Overseas rows never create homepage totals');
assert.equal(helper.explicitWorldwideTotal({ scope: 'worldwide', total_usd: 9, as_of: today }, today), null,
  'worldwide totals without a traceable HTTPS source stay unreported');
const explicitTotal = helper.localMetric({ release_date: day31Release }, day31Rows,
  { scope: 'worldwide', total_usd: 777, currency: 'USD', source: 'https://fixture.example/worldwide', as_of: '2026-10-31' },
  'cumulative_total', '2026-10-31');
assert.equal(explicitTotal.amount, 777, 'published worldwide total is never double-counted with India/overseas');
assert.equal(explicitTotal.method, 'published_worldwide_total');
assert.equal(helper.localDerivedTotal(day31Rows.slice(1), day31Release, '2026-10-31'), null,
  'totals are not derived if Day 1 is missing');

// Direct reports are fail-closed: exact scope, period, currency, URL, quote and Gemini review are required.
const direct = (window, amount, extra = {}) => ({
  scope: 'worldwide', window, amount, currency: 'USD',
  period_start: window === 'today' ? today : '2026-10-24', period_end: today, as_of: today,
  observed_at: '2026-10-30T00:00:00Z', source_name: 'Official source',
  source_url: 'https://official.example/box-office', evidence_quote: 'Worldwide gross stated by source',
  reviewed_by: 'Gemini', ...extra,
});
assert.equal(helper.directMetric(direct('last_7_days', 500), 'last_7_days', today).amount, 500);
assert.equal(helper.directMetric(direct('last_7_days', 500, { scope: 'india_net' }), 'last_7_days', today), null);
assert.equal(helper.directMetric(direct('today', 500), 'last_7_days', today), null);
assert.equal(helper.directMetric(direct('last_7_days', 500, { currency: 'USDT' }), 'last_7_days', today), null);
assert.equal(helper.directMetric(direct('last_7_days', 500, { source_url: 'http://unsafe.example' }), 'last_7_days', today), null);
assert.equal(helper.directMetric(direct('last_7_days', 500, { reviewed_by: 'Unknown' }), 'last_7_days', today), null);

// 14 calendar dates are release-eligible; each industry has an independent 8-card cap.
const ui = { industryOf: x => x.industry || 'world', isStreamingOnly: x => !!x.streamingOnly,
  titleOf: x => x.title || String(x.id) };
const movieItem = (id, industry, release, extra = {}) => ({ id, title: String(id), type: 'movie',
  poster_path: '/poster.jpg', release_date: release, industry, vote_average: 0, vote_count: 0, ...extra });
const scheduledMovie = movieItem('scheduled', 'bollywood', today);
const scheduledRows = [worldwideDay(1, today, 100)];
const scheduledTotal = { scope: 'worldwide', total_usd: 777, currency: 'USD',
  source_url: 'https://fixture.example/current-total', as_of: today };
const scheduledReport = { today: direct('today', 200), last_7_days: direct('last_7_days', 250),
  cumulative_total: direct('cumulative_total', 900) };
for (const windowKey of ['today', 'last_7_days', 'cumulative_total']) {
  assert.equal(helper.needsDirectRefresh(scheduledMovie, scheduledRows, scheduledTotal,
    scheduledReport, windowKey, today), true,
  `${windowKey} is re-queried at every scheduled slot even when a value is cached`);
  assert.equal(helper.resolveMetric(scheduledMovie, scheduledRows, scheduledTotal,
    scheduledReport, windowKey, today).method, 'tavily_gemini',
  `fresh reviewed ${windowKey} data replaces a local value in the homepage card`);
}
const directWeekly = amount => direct('last_7_days', amount);
const bollywood = Array.from({ length: 10 }, (_, i) => movieItem(`b${i}`, 'bollywood', today));
const world = Array.from({ length: 10 }, (_, i) => movieItem(`w${i}`, 'world', today));
const reports = Object.fromEntries([...bollywood, ...world].map((x, i) => [String(x.id), { last_7_days: directWeekly((i % 10 + 1) * 100) }]));
const picks = helper.selectHomeTitles([...bollywood, ...world], {}, {},
  { schema_version: 1, reports }, today, today, ui, { USD: 1 }, 8);
assert.equal(picks.bollywood.length, 8);
assert.equal(picks.world.length, 8);
assert.deepEqual(picks.bollywood.map(x => x.id), ['b9', 'b8', 'b7', 'b6', 'b5', 'b4', 'b3', 'b2']);
assert.deepEqual(picks.world.map(x => x.id), ['w9', 'w8', 'w7', 'w6', 'w5', 'w4', 'w3', 'w2']);
const boundary = [
  movieItem('day14', 'bollywood', '2026-10-17', { vote_average: 1 }),
  movieItem('day15', 'bollywood', '2026-10-16', { vote_average: 99 }),
  movieItem('future', 'bollywood', '2026-10-31', { vote_average: 100 }),
  movieItem('streaming', 'bollywood', today, { streamingOnly: true, vote_average: 100 }),
  movieItem('festival', 'bollywood', today, { date_kind: 'festival', vote_average: 100 }),
];
const boundaryPicks = helper.selectHomeTitles(boundary, {}, {}, { schema_version: 1, reports: {} }, today, today, ui, { USD: 1 }, 8);
assert.deepEqual(boundaryPicks.bollywood.map(x => x.id), ['day14', 'day15'],
  'Day 14 is within the 14-date release window, Day 15 falls back after it; future/streaming/festival are excluded');
const fill = [
  ...Array.from({ length: 6 }, (_, i) => movieItem(`recent${i}`, 'world', '2026-10-30', { vote_average: 1 })),
  movieItem('older-high', 'world', '2026-10-10', { vote_average: 9 }),
  movieItem('older-low', 'world', '2026-10-09', { vote_average: 2 }),
];
const fillPicks = helper.selectHomeTitles(fill, {}, {}, { schema_version: 1, reports: {} }, today, today, ui, { USD: 1 }, 8);
assert.deepEqual(fillPicks.world.map(x => x.id), ['recent5', 'recent4', 'recent3', 'recent2', 'recent1', 'recent0', 'older-high', 'older-low'],
  'older popular titles fill only after eligible recent releases are exhausted');

// Frontend uses the shared selector/metric helper and does not sum a homemade worldwide amount.
assert.match(pageSource, /FAHomeBoxOffice/);
assert.match(pageSource, /selectionForDisplay/);
assert.match(fs.readFileSync(path.join(__dirname, '..', 'js/home-boxoffice.js'), 'utf8'), /api\/home-boxoffice-worldwide/);
assert.match(pageSource, /worldwide/);
assert.match(pageSource, /metric\.currency/);
assert.match(pageSource, /metric\.observed_date/);
assert.match(pageSource, /metric\.sources/);
assert.match(pageSource, /HomeBoxOffice\.formatCurrency\(metric\.amount, metric\.currency\)/);
assert.doesNotMatch(pageSource, /UI\.fmtMoney\(metric\.amount\)/,
  'worldwide reports must not be converted away from their source currency');
assert.doesNotMatch(pageSource, /const boWorldwideAmount =/,
  'homepage must not keep the old ad-hoc sum/label path');
assert.match(pageSource, /Not reported/);
console.log('OTT fallback preserved; worldwide metrics require explicit reports or strict verified pairs; direct reports fail closed; 14-day eligibility and 8-per-tab selection pass.');
