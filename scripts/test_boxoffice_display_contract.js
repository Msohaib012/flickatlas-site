#!/usr/bin/env node
// Display contract for the box-office collection chain (2026-10-30):
//   (a) a title with India + Overseas rows renders BOTH separately on
//       the movie-page path (UI.daywiseCard — India Net column,
//       Overseas column, per-day Total = India + Overseas, and no
//       invented total for a day whose overseas is missing);
//   (c) the homepage path (home-boxoffice.js tracked fallback, the
//       exact helper page-index renders through resolveMetric) shows
//       ONE combined total equal to India + Overseas summed over the
//       same FA_DAYWISE rows.
// Offline: no fetches, no writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const dayMs = 86400000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * dayMs)
  .toISOString().slice(0, 10);

// --- (a) movie page: UI.daywiseCard --------------------------------
const uiSource = fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8');
const sandbox = {
  console, URL, JSON, Math, Date, Intl, Number, String, Array, Object,
  RegExp, Set, Map, Promise, Error, TypeError, setTimeout, clearTimeout,
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  location: { origin: 'https://flickatlas.co.uk', href: 'https://flickatlas.co.uk/', pathname: '/', search: '' },
  document: {
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }),
    documentElement: { style: {} }, body: {},
  },
  navigator: { userAgent: 'node' },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.runInNewContext(uiSource + '\nthis.__UI = UI;', sandbox, { filename: 'ui.js' });
const UI = sandbox.__UI;
assert.equal(typeof UI.daywiseCard, 'function', 'UI.daywiseCard exists');

const rows = [
  { day: 'Day 1', date: iso(2), collection: 1000, overseas: 250 },
  { day: 'Day 2', date: iso(1), collection: 2000, overseas: 500 },
  { day: 'Day 3', date: iso(0), collection: 3000 },
];
const html = UI.daywiseCard(rows, 'Day-Wise Box Office (India Net + Overseas)', {});
assert(html.includes('<th>India Net</th>'), 'India Net column shown separately');
assert(html.includes('<th>Overseas</th>'), 'Overseas column shown separately');
assert(html.includes('<th>Total</th>'), 'per-day Total column shown');
// Money cells carry the raw USD in data-usd: India, Overseas and the
// combined Total are three distinct figures on the same row.
for (const usd of ['1000', '250', '1250', '2000', '500', '2500', '3000']) {
  assert(html.includes(`data-usd="${usd}"`), `figure $${usd} rendered`);
}
// Day 3 has no overseas: its Total cell must be a dash, never the
// India figure dressed up as a total (no second 3000 total span).
const day3Row = html.split('<tr').find((part) => part.includes('Day 3'));
assert(day3Row, 'Day 3 row present');
assert(day3Row.includes('—'), 'Day 3 total is a dash when overseas is missing');

// --- (c) homepage: combined total over the same rows ---------------
const helper = require('../js/home-boxoffice.js');
const today = iso(0);
const handSum = rows.reduce(
  (s, r) => s + r.collection + (typeof r.overseas === 'number' ? r.overseas : 0), 0);
assert.equal(handSum, 6750, 'fixture hand sum');
const cumulative = helper.trackedMetric(rows, 'cumulative_total', today);
assert(cumulative, 'tracked cumulative resolves');
assert.equal(cumulative.amount, handSum,
  'homepage cumulative total = India + Overseas over the same rows');
const last2 = helper.trackedMetric(rows, 'last_2_days', today);
assert.equal(last2.amount, 2500 + 3000,
  'homepage 2-day total = (India+Overseas) of the last two tracked days');
// The exact path page-index uses: resolveMetric with no verified
// report and no explicit total falls back to the tracked combination.
const viaResolve = helper.resolveMetric(
  { release_date: iso(2) }, rows, null, {}, 'cumulative_total', today);
assert(viaResolve && viaResolve.amount === handSum,
  'resolveMetric homepage fallback combines India + Overseas');

console.log('box-office display contract: PASS');
