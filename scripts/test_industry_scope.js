#!/usr/bin/env node
// Regression coverage for the site-wide Bollywood / World Cinema boundary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const uiSource = read('js/ui.js');
const start = uiSource.indexOf('  const INDIAN_LANGS =');
const end = uiSource.indexOf('  function monthLabel', start);
assert(start >= 0 && end > start, 'shared industry and news classifiers should exist');
const sandbox = {};
vm.runInNewContext(
  uiSource.slice(start, end).replace(/^  /gm, '') +
    '\nthis.classifiers = { industryOf, isIndian, isPakistani, deriveNewsTags, INDIAN_LANGS };',
  sandbox
);
const { industryOf, deriveNewsTags, INDIAN_LANGS } = sandbox.classifiers;

// India country/origin is decisive regardless of language or a stale baked tag.
assert.equal(industryOf({ original_language: 'en', origin_country: ['IN'], industry: 'world' }), 'bollywood');
assert.equal(industryOf({ original_language: 'ta', origin_country: ['IN'], industry: 'world' }), 'bollywood');
assert.equal(industryOf({ original_language: 'te', production_countries: [{ iso_3166_1: 'IN' }], industry: 'world' }), 'bollywood');
assert.equal(industryOf({ original_language: 'ur', origin_country: ['IN'] }), 'bollywood');

// Language-only and spoken-language fallback covers major and additional Indian cinema languages.
const expectedIndianLangs = ['hi', 'ta', 'te', 'ml', 'kn', 'pa', 'bn', 'mr', 'gu', 'or', 'as',
  'sa', 'ks', 'sd', 'kok', 'mni', 'mai', 'sat', 'doi', 'brx', 'bho', 'awa', 'mag', 'mwr', 'hne', 'tcy'];
for (const lang of expectedIndianLangs) {
  assert(INDIAN_LANGS.includes(lang), `language ${lang} should be in the Indian fallback set`);
  assert.equal(industryOf({ original_language: lang }), 'bollywood', `language ${lang}`);
}
assert.equal(industryOf({ spoken_languages: [{ iso_639_1: 'kok' }] }), 'bollywood');

// Pakistan is never World Cinema; Indian Urdu remains Indian; international examples remain World.
assert.equal(industryOf({ original_language: 'en', origin_country: ['PK'] }), 'pakistani');
assert.equal(industryOf({ original_language: 'ur' }), 'pakistani');
assert.equal(industryOf({ original_language: 'pa', origin_country: ['PK', 'IN'] }), 'pakistani');
assert.equal(industryOf({ original_language: 'en', origin_country: ['US'] }), 'world');
assert.equal(industryOf({ original_language: 'es', origin_country: ['ES'] }), 'world');
assert.equal(industryOf({ original_language: 'ja', origin_country: ['JP'] }), 'world');

const newsTags = item => Array.from(deriveNewsTags(item));
let tags = newsTags({ cats: ['international'], title: 'Tamil and Telugu cinema updates' });
assert(tags.includes('bollywood') && tags.includes('kollywood'));
assert(!tags.includes('world'), 'Indian regional cinema must not appear under World Cinema');
tags = newsTags({ cats: ['international'], title: 'Odia film wins a new award' });
assert(tags.includes('bollywood') && !tags.includes('world'));
tags = newsTags({ cats: ['international'], title: 'Spanish cinema festival in Spain' });
assert(tags.includes('world') && !tags.includes('bollywood') && !tags.includes('pakistan'));
tags = newsTags({ cats: ['international'], title: "Pakistan's film industry announces a new release" });
assert(tags.includes('pakistan') && !tags.includes('world'));
tags = newsTags({ cats: ['bollywood', 'celebrity'], title: 'Korean K-drama star visits Seoul' });
assert(!tags.includes('bollywood'), 'the Korean misclassification guard must remain');

// Existing catalogue examples with stale `industry: world` values must resolve by country/language at runtime.
const publishedSource = read('js/published-titles.js');
const publishedStart = publishedSource.indexOf('window.FA_PUBLISHED =') + 'window.FA_PUBLISHED ='.length;
const published = JSON.parse(publishedSource.slice(publishedStart).replace(/;\s*$/, ''));
for (const title of ['Jailer 2', 'Ranabaali', 'Dreamboat']) {
  const entry = Object.values(published).find(x => x.title === title);
  assert(entry, `published fixture ${title} should exist`);
  assert.equal(industryOf(entry), 'bollywood', `${title} should classify as Bollywood`);
}

// All public title filters use the shared rule; both news views use the shared news tagger.
for (const file of ['js/page-index.js', 'js/page-movies.js', 'js/page-tv.js', 'js/page-category.js',
  'js/page-upcoming.js', 'js/page-most-awaited.js', 'js/page-ott.js', 'js/page-boxoffice.js',
  'js/page-boxoffice-day.js']) {
  assert.match(read(file), /UI\.industryOf\(/, `${file} should use the canonical title classifier`);
}
for (const file of ['js/page-news.js', 'js/page-index.js']) {
  assert.match(read(file), /UI\.deriveNewsTags/, `${file} should use shared news classification`);
}
assert.match(read('js/page-movie.js'), /UI\.industryOf\(pub\) === "bollywood"/);
console.log('Industry scope and cross-view filter fixtures passed.');
