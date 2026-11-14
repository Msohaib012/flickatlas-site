#!/usr/bin/env node
// Regression coverage for the homepage OTT "Coming to OTT" World fallback
// (owner order 2026-11-14): when the Bollywood Coming set is empty, the
// rail shows World Cinema Coming titles instead of standing empty.
// Display fill only — World titles are NOT reclassified as Bollywood.
// Offline tests only: no source fetches, workflow dispatches, or writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pageSource = fs.readFileSync(path.join(__dirname, '..', 'js/page-index.js'), 'utf8');
const today = '2026-11-14';

// Extract the REAL ottFor + ottComingFor from page-index.js (not a copy).
// ottFor closes over ottInIndustry, defined just above it.
const start = pageSource.indexOf('    const ottInIndustry = (x, industry) => industry === "international"');
const end = pageSource.indexOf('    /* Keep the honest fallback note in sync', start);
assert(start >= 0 && end > start, 'homepage OTT Coming fallback anchors changed');
const code = pageSource.slice(start, end) + '\n({ ottFor, ottComingFor, OTT_COMING_FALLBACK_NOTE });';

const provider = { name: 'Netflix', logo_path: '/netflix.png' };
const movie = (id, date, extra = {}) => ({ id, type: 'movie', poster_path: '/p.jpg', release_date: date, providers: [provider], popularity: 10, ...extra });
const tv = (id, date, extra = {}) => ({ id, type: 'tv', poster_path: '/p.jpg', first_air_date: date, providers: [provider], popularity: 10, ...extra });

function loadFns(groups, pub) {
  const pubMap = {};
  Object.values(pub).forEach(x => { if (x && x.id != null) pubMap[String(x.id)] = x; });
  const context = {
    ottGroups: groups, pubMap, today,
    UI: { industryOf: x => x?.industry || 'bollywood' },
    typeOf: x => x.type || 'movie',
    dateOf: x => x.release_date || x.first_air_date || '',
    HOME_LIMITS: { ott: 20 },
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
  const { ottComingFor, ottFor, OTT_COMING_FALLBACK_NOTE } = loadFns(groups, pub);
  const res = ottComingFor('bollywood', 'movie');
  assert.deepEqual(ids(res.items), [3, 4], 'empty Bollywood Coming fills with World titles, date order');
  assert.equal(res.fallback, true, 'fallback flag is set');
  assert(res.items.every(p => p.x.industry === 'world'), 'World titles are NOT reclassified as Bollywood');
  assert(OTT_COMING_FALLBACK_NOTE.includes('World Cinema'), 'honest note names World Cinema');
  assert(OTT_COMING_FALLBACK_NOTE.includes('Bollywood'), 'honest note names Bollywood');
  const world = ottComingFor('international', 'movie');
  assert.deepEqual(ids(world.items), [3, 4], 'World tab shows the same titles');
  assert.equal(world.fallback, false, 'World tab never falls back');
  // Now rail is untouched by the Coming fallback.
  assert.deepEqual(ids(ottFor('now', 'bollywood', 'movie')), [1], 'Now rail still Bollywood-only');
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
  const { ottComingFor } = loadFns(groups, pub);
  const res = ottComingFor('bollywood', 'movie');
  assert.deepEqual(ids(res.items), [2], 'Bollywood title wins when present');
  assert.equal(res.fallback, false, 'no fallback when Bollywood is non-empty');
}

// Scenario C — both empty: no fallback, honest empty state (no misleading note).
{
  const { ottComingFor } = loadFns({ now: [], coming: [] }, {});
  const res = ottComingFor('bollywood', 'movie');
  assert.deepEqual(res.items, [], 'both empty stays empty');
  assert.equal(res.fallback, false, 'no fallback flag when World is empty too');
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
  const { ottComingFor } = loadFns(groups, pub);
  const resTv = ottComingFor('bollywood', 'tv');
  assert.deepEqual(ids(resTv.items), [5], 'Bollywood TV Coming falls back to World TV');
  assert.equal(resTv.fallback, true, 'TV fallback flag is set');
  const resMovie = ottComingFor('bollywood', 'movie');
  assert.deepEqual(resMovie.items, [], 'movie type does not borrow the TV fallback');
  assert.equal(resMovie.fallback, false, 'movie type stays unfilled when no World movie is coming');
}

// Note sync: the honest note is inserted once after the <h3> and removed
// when the fallback turns off. Minimal fake DOM — no browser needed.
class FakeEl {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.className = ''; this.textContent = ''; this.children = []; this.parent = null; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  querySelector(sel) {
    for (const c of this.children) {
      if (sel.startsWith('.') && c.className.split(' ').includes(sel.slice(1))) return c;
      if (sel === c.tagName.toLowerCase()) return c;
      const deep = c.querySelector(sel);
      if (deep) return deep;
    }
    return null;
  }
  closest(sel) {
    let el = this;
    while (el) {
      if (sel.startsWith('.') && el.className.split(' ').includes(sel.slice(1))) return el;
      el = el.parent;
    }
    return null;
  }
  after(node) { const p = this.parent, i = p.children.indexOf(this); node.parent = p; p.children.splice(i + 1, 0, node); }
  prepend(node) { node.parent = this; this.children.unshift(node); }
  remove() { if (!this.parent) return; const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); this.parent = null; }
}
{
  const syncStart = pageSource.indexOf('    const syncOttComingNote = (comingHost, fallback) => {');
  const syncEnd = pageSource.indexOf('    const ottCardHtml = ', syncStart);
  assert(syncStart >= 0 && syncEnd > syncStart, 'syncOttComingNote anchors changed');
  const syncCode = pageSource.slice(syncStart, syncEnd) + '\n({ syncOttComingNote });';
  const group = new FakeEl('div'); group.className = 'ott-group';
  const h3 = new FakeEl('h3'); group.appendChild(h3);
  const scroller = new FakeEl('div'); scroller.className = 'scroller'; group.appendChild(scroller);
  const noteText = 'No Bollywood titles are coming to OTT yet — showing World Cinema titles.';
  const { syncOttComingNote } = vm.runInNewContext(syncCode, {
    document: { createElement: tag => new FakeEl(tag) },
    OTT_COMING_FALLBACK_NOTE: noteText,
  });
  syncOttComingNote(scroller, true);
  let note = group.querySelector('.ott-group-note');
  assert(note, 'note is inserted when fallback is on');
  assert.equal(note.textContent, noteText, 'note text is the honest fallback note');
  assert.equal(group.children.indexOf(note), group.children.indexOf(h3) + 1, 'note sits right after the <h3>');
  syncOttComingNote(scroller, true);
  assert.equal(group.children.filter(c => c.className === 'ott-group-note').length, 1, 're-sync does not duplicate the note');
  syncOttComingNote(scroller, false);
  assert.equal(group.querySelector('.ott-group-note'), null, 'note is removed when fallback turns off');
  syncOttComingNote(null, true);
}

console.log('test_ott_coming_fallback: OK');
