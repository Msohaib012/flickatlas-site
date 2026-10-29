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
assert.match(yesterdayOnly, /<dt>7 Days<\/dt><dd><span class="fa-box-unavailable">Not reported<\/span><\/dd>/);
assert.match(yesterdayOnly, /<dt>Worldwide total<\/dt><dd><span class="fa-box-unavailable">Not reported<\/span><\/dd>/);
assert.doesNotMatch(yesterdayOnly, /\$2/, 'unscoped India Net data must not appear on homepage');
const worldwideDay = card(entry, [{ date: today, collection: 42, scope: 'worldwide' }]);
assert.match(worldwideDay, /<dt>Today · 29 Oct<\/dt><dd>\$42<\/dd>/, 'only explicit worldwide daily rows may display');
assert.match(worldwideDay, /<dt>7 Days<\/dt><dd>\$42/);
assert.match(worldwideDay, /<dt>Worldwide total<\/dt><dd><span class="fa-box-unavailable">Not reported<\/span><\/dd>/);
const domesticDay = card(entry, [{ date: today, collection: 999, scope: 'domestic-only-so-far' }]);
assert.match(domesticDay, /<dt>Today · 29 Oct<\/dt><dd><span class="fa-box-unavailable">Not reported<\/span><\/dd>/);
const worldwideTotalWithIndiaRows = vm.runInNewContext(cardCode, {
  UI, todayIST: today, window: { FA_WORLDWIDE: { '1': { total_usd: 12345, scope: 'worldwide', source: 'Fixture', as_of: today } } },
})(entry, [{ date: today, collection: 999999 }]);
assert.match(worldwideTotalWithIndiaRows, /<dt>Worldwide total<\/dt><dd>\$12345<\/dd>/, 'India day rows cannot mask the explicit worldwide total');
assert.doesNotMatch(worldwideTotalWithIndiaRows, /\$999999/, 'India day rows cannot appear in the worldwide card');
const listingSource = fs.readFileSync(path.join(__dirname, '..', 'js/page-boxoffice.js'), 'utf8');
const listingStart = listingSource.indexOf('  const boCardHtml = (entry, rows) => {');
const listingEnd = listingSource.indexOf('\n  };', listingStart);
assert(listingStart >= 0 && listingEnd > listingStart, 'Box Office listing card anchor changed');
const listingCardCode = listingSource.slice(listingStart, listingEnd + '\n  };'.length) + '\nboCardHtml;';
for (const [scope, label] of [
  ['domestic-only-so-far', 'Domestic reported to date'],
  ['domestic-opening-weekend', 'Domestic opening weekend'],
  ['worldwide', 'Worldwide total'],
  ['unknown-scope', 'Reported figure'],
]) {
  const world = { '1': { total_usd: 12345, scope, source: 'Fixture', as_of: today } };
  const homeHtml = vm.runInNewContext(cardCode, { UI, todayIST: today, window: { FA_WORLDWIDE: world } })(entry, []);
  const listingHtml = vm.runInNewContext(listingCardCode, { UI, todayIST: today, window: { FA_WORLDWIDE: world } })(entry, []);
  assert.match(listingHtml, new RegExp(`<dt>${label}<\\/dt>`), `listing label for ${scope}`);
  if (scope === 'worldwide') {
    assert.match(homeHtml, /<dt>Worldwide total<\/dt><dd>\$12345<\/dd>/, 'homepage shows explicit worldwide total');
  } else {
    assert.match(homeHtml, /<dt>Worldwide total<\/dt><dd><span class="fa-box-unavailable">Not reported<\/span><\/dd>/, `homepage hides non-worldwide scope ${scope}`);
    assert.doesNotMatch(homeHtml, /\$12345/, `homepage must not show domestic or unknown amount for ${scope}`);
    assert.doesNotMatch(homeHtml, /Domestic reported to date|Domestic opening weekend|Reported figure/);
    assert.doesNotMatch(listingHtml, /<dt>Worldwide total<\/dt>/, `listing must not imply worldwide scope for ${scope}`);
  }
}

// Homepage Box Office ranking: <=14-day releases first; within each age
// group, source-backed 14-day report sums first, then existing Popular order.
const rankingStart = source.indexOf('    const boxOfficeReleaseCutoffDate =');
const rankingEnd = source.indexOf('    const boHasKind =', rankingStart);
assert(rankingStart >= 0 && rankingEnd > rankingStart, 'homepage 14-day ranking anchors changed');
const rankingCode = source.slice(rankingStart, rankingEnd) + '\nboPoolFor;';
const rankingUI = {
  industryOf: x => x.industry || 'world',
  isStreamingOnly: x => !!x.streamingOnly,
  titleOf: x => x.title || String(x.id),
  esc: x => String(x ?? ''), img: x => x, fmtDate: x => x, fmtMoney: n => String(n),
};
const makeCandidate = (id, release, industry, dailyRows, extra = {}) => ({
  id, title: String(id), type: 'movie', poster_path: '/poster.jpg', release_date: release,
  industry, dailyRows, vote_average: 0, vote_count: 0, ...extra,
});
const worldwideRows = rows => rows.map(row => ({ ...row, scope: 'worldwide' }));
const rankHome = (fixtures, industry = 'bollywood') => {
  const dwData = Object.fromEntries(fixtures.map(x => [String(x.id), x.dailyRows || []]));
  const choose = vm.runInNewContext(rankingCode, {
    today: '2026-10-30', todayIST: '2026-10-30', UI: rankingUI, window: {
      FA_WORLDWIDE: { noRows: { total_usd: 999999999, scope: 'worldwide', as_of: '2026-10-30' }, old: { total_usd: 999999999, scope: 'worldwide' } },
    },
    pubAll: () => fixtures, dwData, typeOf: x => x.type || 'movie',
  });
  return normalize(choose(industry).map(x => x.id));
};
const capFixture = Array.from({ length: 10 }, (_, i) => makeCandidate(
  `b${i}`, '2026-10-23', 'bollywood', worldwideRows([{ date: '2026-10-30', collection: (i + 1) * 100 }])
));
const rankedCap = rankHome(capFixture);
assert.deepEqual(rankedCap, ['b9', 'b8', 'b7', 'b6', 'b5', 'b4', 'b3', 'b2', 'b1', 'b0']);
assert.deepEqual(rankedCap.slice(0, 8), ['b9', 'b8', 'b7', 'b6', 'b5', 'b4', 'b3', 'b2']);
assert.match(source, /const boPicks = boPoolFor\("bollywood"\)\.slice\(0, HOME_LIMITS\.boxoffice\)/);
assert.match(source, /kind === "boxoffice" \? boPoolFor\(industry\)\.slice\(0, HOME_LIMITS\.boxoffice\)/);
const boxOfficeSubtitle = '14-day releases first · worldwide collections, then popularity · older titles only if needed';
assert.equal(source.split(boxOfficeSubtitle).length - 1, 2, 'initial and tab-switched subtitles both describe worldwide collections');

const gateFixture = [
  makeCandidate('age14', '2026-10-16', 'bollywood', worldwideRows([{ date: '2026-10-17', collection: 20 }])),
  makeCandidate('age15', '2026-10-15', 'bollywood', worldwideRows([{ date: '2026-10-30', collection: 999999 }]), { vote_average: 10 }),
  makeCandidate('outside-report-window', '2026-10-30', 'bollywood', worldwideRows([{ date: '2026-10-16', collection: 999999 }]), { vote_average: 8 }),
  makeCandidate('future-report', '2026-10-30', 'bollywood', worldwideRows([{ date: '2026-10-31', collection: 999999 }]), { vote_average: 7 }),
  makeCandidate('future-release', '2026-10-31', 'bollywood', worldwideRows([{ date: '2026-10-30', collection: 999999 }]), { vote_average: 10 }),
  makeCandidate('noRows', '2026-10-30', 'bollywood', [], { vote_average: 9, vote_count: 10000 }),
  makeCandidate('zero-only', '2026-10-30', 'bollywood', worldwideRows([{ date: '2026-10-30', collection: 0 }])),
  makeCandidate('string-amount', '2026-10-30', 'bollywood', worldwideRows([{ date: '2026-10-30', collection: '999999' }]), { vote_average: 6 }),
  makeCandidate('duplicate-day', '2026-10-30', 'bollywood', worldwideRows([
    { date: '2026-10-30', collection: 400 }, { date: '2026-10-30', collection: 600 },
  ]), { vote_average: 5 }),
  makeCandidate('old-data', '2026-10-10', 'bollywood', worldwideRows([{ date: '2026-10-29', collection: 100 }])),
  makeCandidate('old-noRows', '2026-10-12', 'bollywood', [], { vote_average: 10, vote_count: 100000 }),
  makeCandidate('streaming-only', '2026-10-30', 'bollywood', worldwideRows([{ date: '2026-10-30', collection: 999999 }]), { streamingOnly: true }),
  makeCandidate('festival', '2026-10-30', 'bollywood', worldwideRows([{ date: '2026-10-30', collection: 999999 }]), { date_kind: 'festival' }),
  makeCandidate('series', '2026-10-30', 'bollywood', worldwideRows([{ date: '2026-10-30', collection: 999999 }]), { type: 'tv' }),
  makeCandidate('pakistani', '2026-10-30', 'pakistani', worldwideRows([{ date: '2026-10-30', collection: 999999 }])),
  makeCandidate('world-a', '2026-10-23', 'world', worldwideRows([{ date: '2026-10-29', collection: 100 }])),
  makeCandidate('world-b', '2026-10-25', 'world', worldwideRows([{ date: '2026-10-30', collection: 300 }])),
  makeCandidate('world-noRows', '2026-10-24', 'world', [], { vote_average: 9 }),
  makeCandidate('world-old-data', '2026-10-10', 'world', worldwideRows([{ date: '2026-10-30', collection: 500 }])),
  makeCandidate('world-old-noRows', '2026-10-12', 'world', [], { vote_average: 8 }),
];
const rankedGate = rankHome(gateFixture);
assert.deepEqual(rankedGate, [
  'age14', 'zero-only', 'noRows', 'outside-report-window', 'future-report', 'string-amount', 'duplicate-day',
  'age15', 'old-data', 'old-noRows',
], 'recent releases lead; reported rows rank first within each age group, then popularity');
assert.deepEqual(rankedGate.slice(0, 8), [
  'age14', 'zero-only', 'noRows', 'outside-report-window', 'future-report', 'string-amount', 'duplicate-day', 'age15',
], 'an older release fills the eighth slot only after recent releases are exhausted');
assert.deepEqual(rankHome(gateFixture, 'international'), [
  'world-b', 'world-a', 'world-noRows', 'world-old-data', 'world-old-noRows',
], 'World Cinema is independently ranked and uses older titles only after recent ones');
assert.deepEqual(rankHome([
  makeCandidate('tie-old-release', '2026-10-22', 'bollywood', worldwideRows([{ date: '2026-10-30', collection: 100 }])),
  makeCandidate('tie-new-release', '2026-10-23', 'bollywood', worldwideRows([{ date: '2026-10-30', collection: 100 }])),
  makeCandidate('tie-old-report', '2026-10-24', 'bollywood', worldwideRows([{ date: '2026-10-29', collection: 100 }])),
]), ['tie-new-release', 'tie-old-release', 'tie-old-report'], 'ties break by latest report, then release date');
assert.deepEqual(rankHome([
  makeCandidate('popular-tie-old', '2026-10-21', 'bollywood', [], { vote_average: 8, vote_count: 100 }),
  makeCandidate('popular-tie-new', '2026-10-22', 'bollywood', [], { vote_average: 8, vote_count: 100 }),
  makeCandidate('popular-more-votes', '2026-10-18', 'bollywood', [], { vote_average: 8, vote_count: 200 }),
  makeCandidate('popular-lower-rating', '2026-10-30', 'bollywood', [], { vote_average: 7, vote_count: 10000 }),
]), ['popular-more-votes', 'popular-tie-new', 'popular-tie-old', 'popular-lower-rating'], 'fallback uses existing rating/vote order, newest release breaks ties');

const scopeFixture = [
  makeCandidate('world-row', '2026-10-23', 'bollywood', worldwideRows([{ date: today, collection: 20 }]), { vote_average: 0 }),
  makeCandidate('india-unscoped', '2026-10-23', 'bollywood', [{ date: today, collection: 999999999 }], { vote_average: 10 }),
  makeCandidate('domestic-row', '2026-10-23', 'bollywood', [{ date: today, collection: 999999999, scope: 'domestic-only-so-far' }], { vote_average: 9 }),
  makeCandidate('other-country-row', '2026-10-23', 'bollywood', [{ date: today, collection: 999999999, scope: 'us-domestic' }], { vote_average: 8 }),
  makeCandidate('noRows', '2026-10-23', 'bollywood', [], { vote_average: 7 }),
];
assert.deepEqual(rankHome(scopeFixture), [
  'world-row', 'india-unscoped', 'domestic-row', 'other-country-row', 'noRows',
], 'only explicit 14-day worldwide rows outrank popularity; country/domestic rows and a lifetime worldwide total do not');

const picksStart = listingSource.indexOf('  const picks =');
const picksEnd = listingSource.indexOf('\n  main.innerHTML', picksStart);
assert(picksStart >= 0 && picksEnd > picksStart, 'Box Office See All selector anchor changed');
const seeAllSelector = listingSource.slice(picksStart, picksEnd);
assert.match(seeAllSelector, /\.sort\(\(a, b\) => \(b\.release_date \|\| ""\)\.localeCompare\(a\.release_date \|\| ""\)/);
assert.doesNotMatch(seeAllSelector, /\.slice\(/, 'See All remains uncapped and newest-first');

const zeroToday = card(entry, [{ date: today, collection: 0 }]);
assert.match(zeroToday, /<dt>Today · 29 Oct<\/dt><dd><span class="fa-box-unavailable">Not reported<\/span><\/dd>/, 'unscoped zero is not worldwide evidence');
const worldwideZeroToday = card(entry, [{ date: today, collection: 0, scope: 'worldwide' }]);
assert.match(worldwideZeroToday, /<dt>Today · 29 Oct<\/dt><dd>\$0<\/dd>/, 'an explicit worldwide zero remains a reported value');
const noRows = card(entry, []);
assert.match(noRows, /<dt>Today · 29 Oct<\/dt>/, 'empty cards still label the requested reporting day');
console.log('Homepage OTT fallback and homepage/listing Box Office scope fixtures passed.');
