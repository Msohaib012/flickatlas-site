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
  published: '2026-10-30',
  modified: '',
  ld: {
    '@context': 'https://schema.org',
    '@type': 'Movie',
    name: 'Glass Lantern',
    description,
    releasedEvent: { '@type': 'PublicationEvent', startDate: '2026-09-22' },
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
const newsEntry = {
  t: 'A real story update', d: description, k: keywords, img: metaEntry.img,
  published: '2026-10-29T12:00:00.000Z', modified: '2026-10-30T09:00:00.000Z',
  ld: { '@context': 'https://schema.org', '@type': 'NewsArticle',
    headline: 'A real story update', datePublished: '2026-10-29T12:00:00.000Z',
    dateModified: '2026-10-30T09:00:00.000Z' },
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
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"FlickAtlas","description":"Homepage description"},{"@type":"WebPage","name":"Generic Movie","description":"Old page description","url":"https://flickatlas.co.uk/movie","datePublished":"2020-01-01","dateModified":"2020-01-02"}]}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[]}</script>
</head><body><main>Test shell</main></body></html>`;
const ssrFixture = '<article class="ssr-facts"><h1>Glass Lantern (2026)</h1>'
  + '<p class="ssr-lead">A fixture overview for the SSR facts block.</p></article>';
const realisticShell = `<!doctype html><html><head>
<title>Generic shell</title>
<meta name="description" content="Generic description">
</head><body><main id="app" tabindex="-1"><div class="wrap"><p class="state-msg" role="status">Loading FlickAtlas…</p></div></main></body></html>`;
const daywiseSsr = {
  t: 'Fixture Film (2026)', d: 'Fixture Film box office report.',
  k: 'Fixture Film box office collection', img: metaEntry.img,
  latest_day: 'Day 5', day_rows: [{ day: 5, d: 'Day 5 collection.' }],
  ssr: ssrFixture,
  ld: { '@context': 'https://schema.org', '@type': 'Movie', name: 'Fixture Film' },
};
// The Worker fetches shells at the directory URL WITHOUT the query
// string, so the mock cannot pick a shell by ?id=. The SSR assertions
// below flip this between the legacy bare-<main> shell and the
// realistic <main id="app"> shell instead.
let shellVariant = 'legacy';
const assetCalls = [];
const env = {
  ASSETS: {
    async fetch(request) {
      const url = new URL(request.url);
      assetCalls.push(url.pathname);
      if (url.pathname === '/movie/') {
        const content = shellVariant === 'realistic' ? realisticShell
          : url.searchParams.get('id') === '125'
            ? shell.replace('"@type":"WebPage"', '"@type":"Thing"') : shell;
        return new Response(content, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      if (url.pathname === '/box-office-day/' || url.pathname === '/news-item/') {
        return new Response(shellVariant === 'realistic' ? realisticShell : shell, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      if (url.pathname === '/js/seo-meta.json') {
        return new Response(JSON.stringify({
          'movie:123': metaEntry,
          'movie:124': { ...metaEntry, published: '', modified: '' },
          'movie:125': metaEntry,
          'movie:126': { ...metaEntry, ssr: ssrFixture },
          'movie:127': { ...metaEntry },
          'movie:128': { ...metaEntry, ssr: ssrFixture },
          'news:fixture': newsEntry,
          'daywise:456': shortDaywise,
          'daywise:789': longDaywise,
          'daywise:999': daywiseSsr,
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
assert.equal(findType('WebPage')?.datePublished, '2026-10-30');
assert.equal(findType('WebPage')?.dateModified, undefined, 'stale template edit dates must be removed');
assert.equal(findType('Movie')?.datePublished, undefined, 'film release is not page publication');
assert.equal(findType('Movie')?.releasedEvent.startDate, '2026-09-22');
assert.equal(metaEntry.ld.name, 'Glass Lantern', 'cached metadata must not be mutated');

async function pageGraph(url) {
  const response = await worker.fetch(new Request(url), env);
  assert.equal(response.status, 200);
  const text = await response.text();
  const body = text.match(/<script\b(?=[^>]*\btype=["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/i)?.[1];
  return JSON.parse(body)['@graph'];
}
const newsGraph = await pageGraph('https://flickatlas.co.uk/news-item?id=fixture');
for (const type of ['WebPage', 'NewsArticle']) {
  const node = newsGraph.find(item => item['@type'] === type);
  assert.equal(node.datePublished, newsEntry.published);
  assert.equal(node.dateModified, newsEntry.modified);
}
const undatedGraph = await pageGraph('https://flickatlas.co.uk/movie?id=124');
const undatedPage = undatedGraph.find(item => item['@type'] === 'WebPage');
assert.equal(undatedPage.datePublished, undefined, 'do not invent missing publication dates');
assert.equal(undatedPage.dateModified, undefined, 'do not retain stale template dates');
const newPageGraph = await pageGraph('https://flickatlas.co.uk/movie?id=125');
assert.equal(newPageGraph.find(item => item['@type'] === 'WebPage')?.datePublished,
  metaEntry.published, 'provide a dated WebPage node when the legacy shell has none');

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

// --- SSR facts-block injection (phase 1, 2026-11-02) ---
async function pageHtml(url) {
  const page = await worker.fetch(new Request(url), env);
  assert.equal(page.status, 200);
  return await page.text();
}
shellVariant = 'realistic';
// 1. Realistic shell + ssr payload: the block lands exactly once, inside
// <main id="app">, replacing the Loading placeholder; head stays valid.
const ssrHtml = await pageHtml('https://flickatlas.co.uk/movie?id=126');
assert.equal(ssrHtml.split(ssrFixture).length - 1, 1,
  'ssr block must be injected exactly once');
const mainOpen = ssrHtml.indexOf('<main id="app"');
const mainClose = ssrHtml.indexOf('</main>');
assert.ok(mainOpen !== -1 && ssrHtml.indexOf(ssrFixture) > mainOpen
  && ssrHtml.indexOf(ssrFixture) < mainClose,
  'ssr block must live inside <main id="app">');
assert.ok(!ssrHtml.includes('Loading FlickAtlas'),
  'the Loading placeholder is replaced by the facts block');
assert.equal([...ssrHtml.matchAll(/<title\b[^>]*>[\s\S]*?<\/title>/gi)].length, 1,
  'head injection still yields exactly one title alongside the ssr block');
assert.equal(await pageTitle('https://flickatlas.co.uk/movie?id=126'), title);
// 2. Same realistic shell, entry WITHOUT ssr: byte-level no-op for the body.
const noSsrHtml = await pageHtml('https://flickatlas.co.uk/movie?id=127');
assert.ok(!noSsrHtml.includes('ssr-facts'),
  'no ssr marker may appear without a payload');
assert.ok(noSsrHtml.includes('Loading FlickAtlas'),
  'the Loading placeholder stays untouched when there is no payload');
// 4 (daywise). Daywise entry with ssr + ?day=: per-day title logic
// unchanged AND the block is present.
const dwSsrHtml = await pageHtml('https://flickatlas.co.uk/box-office-day?title=999&day=5');
assert.ok(dwSsrHtml.includes(ssrFixture), 'daywise ssr block must be injected');
assert.equal(await pageTitle('https://flickatlas.co.uk/box-office-day?title=999&day=5'),
  'Fixture Film (2026) — Box Office Day 5 | FlickAtlas',
  'per-day daywise title composition is unchanged by ssr');
shellVariant = 'legacy';
// 3. Legacy bare-<main> shell + ssr payload: anchor missing -> no-op,
// and the legacy head behaviour is unaffected.
const bareHtml = await pageHtml('https://flickatlas.co.uk/movie?id=128');
assert.ok(!bareHtml.includes(ssrFixture),
  'anchor-missing shell must not receive the ssr block');
assert.equal(await pageTitle('https://flickatlas.co.uk/movie?id=128'), title,
  'legacy head injection is unaffected by an uninjected ssr payload');

console.log('Worker SEO: unique metadata and merged JSON-LD; genuine page dates separate from releases; compact Day 31 title; long film title preserved.');
