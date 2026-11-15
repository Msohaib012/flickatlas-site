#!/usr/bin/env node
// Regression coverage for the /ott page OTT "Coming to OTT" World fallback
// (owner order 2026-11-14, extended to /ott 2026-11-15): when the
// Bollywood Coming set is empty, the page shows World Cinema Coming
// titles instead of standing empty — the same rule as the homepage
// rail. Display fill only — World titles are NOT reclassified as
// Bollywood. Offline tests only: no source fetches, workflow
// dispatches, or writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pageSource = fs.readFileSync(path.join(__dirname, '..', 'js/page-ott.js'), 'utf8');
const today = '2026-11-15';

// Extract the REAL inFilter + entriesFor + comingFor + groupHtml from
// page-ott.js (not a copy). The slice runs from inFilter through
// groupHtml; f/t come from the vm context (the page's URL params),
// groups/pub from window.FA_OTT / window.FA_PUBLISHED.
const start = pageSource.indexOf('  const inFilter = (x, ind = f) => {');
const end = pageSource.indexOf('  const nowList = entriesFor(groups.now, "now");', start);
assert(start >= 0 && end > start, 'page-ott.js fallback anchors changed');
const code = pageSource.slice(start, end) + '\n({ entriesFor, comingFor, groupHtml, OTT_COMING_FALLBACK_NOTE });';

const provider = { name: 'Netflix', logo_path: '/netflix.png' };
const movie = (id, date, extra = {}) => ({ id, type: 'movie', poster_path: '/p.jpg', release_date: date, providers: [provider], popularity: 10, ...extra });
const tv = (id, date, extra = {}) => ({ id, type: 'tv', poster_path: '/p.jpg', first_air_date: date, providers: [provider], popularity: 10, ...extra });

function loadFns(groups, pub, f = 'bollywood', t = 'movie') {
  const pubMap = {};
  Object.values(pub).forEach(x => { if (x && x.id != null) pubMap[String(x.id)] = x; });
  const context = {
    window: { FA_OTT: groups, FA_PUBLISHED: pubMap },
    UI: {
      industryOf: x => x?.industry || 'bollywood',
      industryTag: x => x?.industry || 'bollywood',
      todayPKT: () => today,
      ottCard: (x) => `<a data-id="${x.id}">`,
    },
    f, t,
  };
  return vm.runInNewContext(code, context);
}
const ids = items => items.map(p => p.g.id);

// Scenario A — the live state: Bollywood Coming is empty, World has two.
{
  const groups = {
    now: [{ id: 1, type: 'movie', providers: [provider], date: '2026-11-01', date_kind: 'release' }],
    coming: [
      { id: 3, type: 'movie', providers: [provider], date: '2026-11-18', date_kind: 'digital' },
      { id: 4, type: 'movie', providers: [provider], date: '2026-11-25', date_kind: 'digital' },
    ],
  };
  const pub = {
    1: movie(1, '2026-11-01', { industry: 'bollywood' }),
    3: movie(3, '2026-11-18', { industry: 'world' }),
    4: movie(4, '2026-11-25', { industry: 'world' }),
  };
  const { comingFor, entriesFor, groupHtml, OTT_COMING_FALLBACK_NOTE } = loadFns(groups, pub);
  const res = comingFor();
  assert.deepEqual(ids(res.items), [3, 4], 'empty Bollywood Coming fills with World titles, date order');
  assert.equal(res.fallback, true, 'fallback flag is set');
  assert(res.items.every(p => p.x.industry === 'world'), 'World titles are NOT reclassified as Bollywood');
  assert(OTT_COMING_FALLBACK_NOTE.includes('World Cinema'), 'honest note names World Cinema');
  assert(OTT_COMING_FALLBACK_NOTE.includes('Bollywood'), 'honest note names Bollywood');
  // The rendered group shows the honest note and the real count.
  const html = groupHtml('Coming to OTT', res.items, true, res.fallback);
  assert(html.includes('ott-group-note'), 'fallback note is rendered in the group');
  assert(html.includes(OTT_COMING_FALLBACK_NOTE), 'rendered note is the honest fallback note');
  assert(html.includes('Coming to OTT (2)'), 'count reflects the titles actually shown');
  // World tab shows the same titles and never falls back.
  const world = loadFns(groups, pub, 'international', 'movie');
  const worldRes = world.comingFor();
  assert.deepEqual(ids(worldRes.items), [3, 4], 'World tab shows the same titles');
  assert.equal(worldRes.fallback, false, 'World tab never falls back');
  // Now group is untouched by the Coming fallback.
  assert.deepEqual(ids(entriesFor(groups.now, 'now')), [1], 'Now group still Bollywood-only');
}

// Scenario B — Bollywood Coming has a title: no fallback, Bollywood wins.
{
  const groups = {
    now: [],
    coming: [
      { id: 2, type: 'movie', providers: [provider], date: '2026-11-20', date_kind: 'digital' },
      { id: 3, type: 'movie', providers: [provider], date: '2026-11-18', date_kind: 'digital' },
    ],
  };
  const pub = {
    2: movie(2, '2026-11-20', { industry: 'bollywood' }),
    3: movie(3, '2026-11-18', { industry: 'world' }),
  };
  const { comingFor, groupHtml } = loadFns(groups, pub);
  const res = comingFor();
  assert.deepEqual(ids(res.items), [2], 'Bollywood title wins when present');
  assert.equal(res.fallback, false, 'no fallback when Bollywood is non-empty');
  const html = groupHtml('Coming to OTT', res.items, true, res.fallback);
  assert(!html.includes('ott-group-note'), 'no fallback note when Bollywood is non-empty');
}

// Scenario C — both empty: no fallback, honest empty state (no misleading note).
{
  const { comingFor, groupHtml } = loadFns({ now: [], coming: [] }, {});
  const res = comingFor();
  assert.deepEqual(res.items, [], 'both empty stays empty');
  assert.equal(res.fallback, false, 'no fallback flag when World is empty too');
  const html = groupHtml('Coming to OTT', res.items, true, res.fallback);
  assert(!html.includes('ott-group-note'), 'no fallback note when World is empty too');
  assert(html.includes('Coming to OTT (0)'), 'empty group still shows its count');
  assert(html.includes('No upcoming OTT releases reported for Bollywood movies yet.'), 'honest empty message names the filters');
}

// Scenario D — TV type: Bollywood TV Coming empty falls back to World TV.
{
  const groups = {
    now: [],
    coming: [
      { id: 5, type: 'tv', providers: [provider], date: '2026-11-22', date_kind: 'digital' },
    ],
  };
  const pub = {
    5: tv(5, '2026-11-22', {
      industry: 'world', ott_release_date: '2026-11-22',
      ott_release_provider: 'Netflix', ott_release_source: 'https://official.example/series',
    }),
  };
  const { comingFor } = loadFns(groups, pub, 'bollywood', 'tv');
  const resTv = comingFor();
  assert.deepEqual(ids(resTv.items), [5], 'Bollywood TV Coming falls back to World TV');
  assert.equal(resTv.fallback, true, 'TV fallback flag is set');
  const { comingFor: comingForMovie } = loadFns(groups, pub, 'bollywood', 'movie');
  const resMovie = comingForMovie();
  assert.deepEqual(resMovie.items, [], 'movie type does not borrow the TV fallback');
  assert.equal(resMovie.fallback, false, 'movie type stays unfilled when no World movie is coming');
}

console.log('test_ott_page_coming_fallback: OK');
