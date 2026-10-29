#!/usr/bin/env node
// Offline tests of the actual homepage code; no source fetches or data writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'js/page-index.js'), 'utf8');
const today = '2026-10-29';
const provider = { name: 'Netflix', logo_path: '/netflix.png' };
const movie = (id, date, extra = {}) => ({ id, type: 'movie', poster_path: '/poster.jpg', release_date: date, providers: [provider], ...extra });
const tv = (id, date, extra = {}) => ({ id, type: 'tv', poster_path: '/poster.jpg', first_air_date: date, providers: [provider], ...extra });
const items = [
  movie(1, '2026-10-20'),
  movie(2, '2026-11-01'), // A provider and future cinema date are not OTT evidence.
  tv(3, '2026-11-02'), // A normal future TV premiere is not OTT evidence either.
  tv(4, '2026-10-30', { ott_release_date: '2026-10-30', ott_release_provider: 'Netflix', ott_release_source: 'https://official.example/series' }),
  tv(5, '2018-07-06'), // Currently provider-listed old series remain eligible.
  tv(6, '2026-11-03', { ott_release_date: '2026-11-03', ott_release_provider: 'Netflix', ott_release_source: 'http://unverified.example/series' }),
  tv(7, '2026-11-04', { ott_release_date: '2026-11-04', ott_release_provider: 'Prime Video', ott_release_source: 'https://official.example/series' }),
  tv(8, '2026-10-10', { industry: 'pakistani' }),
  movie(9, '2026-10-10', { providers: [] }),
];
const fallbackStart = source.indexOf('    const ottGroups = (() => {');
const fallbackEnd = source.indexOf('    const pubMap = {};', fallbackStart);
assert(fallbackStart >= 0 && fallbackEnd > fallbackStart, 'homepage OTT fallback anchor changed');
const fallbackCode = source.slice(fallbackStart, fallbackEnd) + '\nottGroups;';
const context = {
  window: {}, today,
  UI: { industryOf: x => x?.industry || 'bollywood' },
  pubAll: () => items,
  typeOf: x => x.type || 'movie',
  dateOf: x => x.release_date || '',
};
const normalize = x => JSON.parse(JSON.stringify(x));
const groups = normalize(vm.runInNewContext(fallbackCode, context));
assert.deepEqual(groups.now.map(x => x.id), [1, 5]);
assert.deepEqual(groups.coming.map(x => x.id), [4]);
assert.equal(groups.coming[0].date_kind, 'digital');
assert.equal(groups.coming[0].date, '2026-10-30');
assert.deepEqual(groups.coming[0].providers, [provider]);
assert(!groups.coming.some(x => x.id === 2 || x.id === 3));
const baked = { now: [{ id: 99 }], coming: [] };
assert.equal(vm.runInNewContext(fallbackCode, { ...context, window: { FA_OTT: baked } }), baked, 'valid generated data must remain authoritative');

const cardStart = source.indexOf('    const boCardHtml = (entry, rows) => {');
const cardEnd = source.indexOf('    /* Box Office sort', cardStart);
const shortStart = source.indexOf('    const shortDate = (s) => {');
assert(cardStart >= 0 && cardEnd > cardStart && shortStart < cardStart, 'Box Office card anchors changed');
const cardCode = source.slice(shortStart, cardEnd) + '\nboCardHtml;';
const UI = {
  esc: x => String(x ?? ''), titleOf: x => x.title || 'Fixture',
  img: x => x, fmtDate: x => x, fmtMoney: n => '$' + n,
};
const card = vm.runInNewContext(cardCode, { UI, todayIST: today, window: {} });
const entry = { id: 1, title: 'Fixture', release_date: '2026-10-20', poster_path: '/poster.jpg' };
const yesterdayOnly = card(entry, [{ date: '2026-10-28', collection: 2 }]);
assert.match(yesterdayOnly, /<dt>Today · 29 Oct<\/dt>/);
assert.doesNotMatch(yesterdayOnly, /<dt>Today · 28 Oct<\/dt>/);
assert.match(yesterdayOnly, /<dt>Today · 29 Oct<\/dt><dd><span class="fa-box-unavailable">Not reported<\/span><\/dd>/);
assert.match(yesterdayOnly, /<dt>Recorded<\/dt><dd>\$2<\/dd>/);
const zeroToday = card(entry, [{ date: today, collection: 0 }]);
assert.match(zeroToday, /<dt>Today · 29 Oct<\/dt><dd>\$0<\/dd>/, 'reported zero is not missing data');
const noRows = card(entry, []);
assert.match(noRows, /<dt>Today · 29 Oct<\/dt>/, 'empty cards still label the requested reporting day');
console.log('Homepage OTT fallback and Box Office reporting-day display fixtures passed.');
