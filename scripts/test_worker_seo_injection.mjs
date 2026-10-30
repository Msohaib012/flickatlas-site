#!/usr/bin/env node
import assert from 'node:assert/strict';
import worker from './worker.mjs';

const title = 'Glass Lantern (2026) — Story & Cast | FlickAtlas';
const description = 'A city and its people face a new challenge in this reported film story.';
const keywords = 'Glass Lantern film, Glass Lantern cast, Glass Lantern release date';
const canonical = 'https://flickatlas.co.uk/movie?id=123';
const metaEntry = {
  t: title,
  d: description,
  k: keywords,
  img: 'https://image.tmdb.org/t/p/w500/glass-lantern.jpg',
  robots: 'noindex,follow',
  ld: {
    '@context': 'https://schema.org',
    '@type': 'Movie',
    name: 'Glass Lantern',
    description,
  },
};
const shortDaywise = {
  t: 'Short Film (2026)', d: 'Short Film box office totals after Day 30.',
  k: 'Short Film box office collection', img: metaEntry.img,
  latest_day: 'Day 31', day_rows: [],
  ld: { '@context': 'https://schema.org', '@type': 'Movie', name: 'Short Film' },
};
const longDaywiseTitle = 'The Extraordinary Motion Picture with a Very Long Official Title (2026)';
const longDaywise = {
  t: longDaywiseTitle, d: 'The long film title box office report.',
  k: 'long film box office collection', img: metaEntry.img,
  latest_day: 'Day 1', day_rows: [{ day: 1, d: 'Day 1 collection.' }],
  ld: { '@context': 'https://schema.org', '@type': 'Movie', name: longDaywiseTitle },
};
const shell = `<!doctype html><html><head>
<title>Generic shell</title><title>Duplicate title</title>
<meta name="description" content="Old description">
<meta name="description" content="Duplicate description">
<meta name="keywords" content="Old keywords">
<meta name="robots" content="index,follow">
<meta name="robots" content="index">
<meta name="fa-seo" content="stale">
<meta name="fa-seo" content="duplicate">
<meta property="og:title" content="Old OG title">
<meta property="og:title" content="Duplicate OG title">
<meta property="og:description" content="Old OG description">
<meta property="og:type" content="website">
<meta property="og:url" content="https://flickatlas.co.uk/movie">
<meta property="og:image" content="/old-image.jpg">
<meta property="og:site_name" content="Old site name">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="Old Twitter title">
<meta name="twitter:description" content="Old Twitter description">
<meta name="twitter:image" content="/old-image.jpg">
<link rel="canonical" href="https://flickatlas.co.uk/movie">
<link rel="canonical" href="https://flickatlas.co.uk/movie/">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"FlickAtlas","description":"Homepage description"},{"@type":"WebPage","name":"Generic Movie","description":"Old page description","url":"https://flickatlas.co.uk/movie"}]}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[]}</script>
</head><body><main>Test shell</main></body></html>`;
const assetCalls = [];
const env = {
  ASSETS: {
    async fetch(request) {
      const url = new URL(request.url);
      assetCalls.push(url.pathname);
      if (url.pathname === '/movie/') {
        return new Response(shell, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      if (url.pathname === '/box-office-day/') {
        return new Response(shell, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      if (url.pathname === '/js/seo-meta.json') {
        return new Response(JSON.stringify({
          'movie:123': metaEntry,
          'daywise:456': shortDaywise,
          'daywise:789': longDaywise,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      throw new Error(`Unexpected mocked asset request: ${url.pathname}`);
    },
  },
};

const response = await worker.fetch(new Request('https://flickatlas.co.uk/movie?id=123'), env);
assert.equal(response.status, 200);
const html = await response.text();
assert.ok(assetCalls.includes('/movie/'));
assert.ok(assetCalls.includes('/js/seo-meta.json'));

function allMatches(pattern) {
  return [...html.matchAll(pattern)].map(match => match[0]);
}
function attrValues(pattern, attribute) {
  return allMatches(pattern).map(tag => {
    const match = tag.match(new RegExp(`\\b${attribute}=["']([^"']*)["']`, 'i'));
    return match ? match[1] : null;
  });
}
function assertSingleMeta(attr, key, value) {
  const re = new RegExp(`<meta\\b(?=[^>]*\\b${attr}=["']${key}["'])[^>]*>`, 'gi');
  const values = attrValues(re, 'content');
  assert.equal(values.length, 1, `expected one ${attr}=${key} tag`);
  const escaped = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  assert.equal(values[0], escaped, `${attr}=${key} content mismatch`);
}

const titles = allMatches(/<title\b[^>]*>[\s\S]*?<\/title>/gi);
assert.equal(titles.length, 1, 'expected one title element');
assert.ok(titles[0].includes('Glass Lantern'));
assertSingleMeta('name', 'description', description);
assertSingleMeta('name', 'keywords', keywords);
assertSingleMeta('name', 'robots', 'noindex,follow');
assertSingleMeta('name', 'fa-seo', 'server');
assertSingleMeta('property', 'og:title', title);
assertSingleMeta('property', 'og:description', description);
assertSingleMeta('property', 'og:type', 'video.movie');
assertSingleMeta('property', 'og:url', canonical);
assertSingleMeta('property', 'og:image', metaEntry.img);
assertSingleMeta('property', 'og:site_name', 'FlickAtlas');
assertSingleMeta('name', 'twitter:card', 'summary_large_image');
assertSingleMeta('name', 'twitter:title', title);
assertSingleMeta('name', 'twitter:description', description);
assertSingleMeta('name', 'twitter:image', metaEntry.img);

const canonicals = allMatches(/<link\b(?=[^>]*\brel=["']canonical["'])[^>]*>/gi);
assert.equal(canonicals.length, 1, 'expected one canonical link');
assert.ok(canonicals[0].includes(canonical));
const jsonldTags = allMatches(/<script\b(?=[^>]*\btype=["']application\/ld\+json["'])[^>]*>[\s\S]*?<\/script>/gi);
assert.equal(jsonldTags.length, 1, 'expected one merged JSON-LD block');
const jsonld = JSON.parse(jsonldTags[0].replace(/^.*?>/s, '').replace(/<\/script>$/i, ''));
assert.ok(Array.isArray(jsonld['@graph']));
const graph = jsonld['@graph'];
const findType = type => graph.find(node => node['@type'] === type);
assert.equal(findType('WebSite')?.description, 'Homepage description');
assert.equal(findType('WebPage')?.description, description);
assert.equal(findType('WebPage')?.name, title);
assert.equal(findType('WebPage')?.url, canonical);
assert.ok(findType('BreadcrumbList'));
assert.equal(findType('Movie')?.name, 'Glass Lantern');
assert.equal(metaEntry.ld.name, 'Glass Lantern', 'cached metadata must not be mutated');

async function pageTitle(url) {
  const page = await worker.fetch(new Request(url), env);
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  return pageHtml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    .replace(/&amp;/g, '&');
}
const totalsTitle = await pageTitle(
  'https://flickatlas.co.uk/box-office-day?title=456&day=31');
assert.equal(totalsTitle, 'Short Film (2026) — Box Office Totals After Day 30');
assert.ok(totalsTitle.length <= 60);
const longTitle = await pageTitle(
  'https://flickatlas.co.uk/box-office-day?title=789&day=1');
assert.equal(longTitle, longDaywiseTitle,
  'a long film title must not receive boilerplate or be truncated');

console.log('Worker SEO: unique metadata and merged JSON-LD; compact Day 31 title; long film title preserved.');
