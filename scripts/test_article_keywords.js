#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const keywords = require(path.join(root, "js/article-keywords.js"));

assert.deepEqual(keywords.normalize([
  "  Tiger   Shroff  ", "tiger shroff", "A & B <film>", "", null,
  ...Array.from({ length: 14 }, (_, i) => `Term ${i}`),
]), ["Tiger Shroff", "A & B <film>", ...Array.from({ length: 10 }, (_, i) => `Term ${i}`)]);
assert.equal(keywords.render(null), "");
const html = keywords.render(["A & <B>"]);
assert.match(html, /<h2[^>]*>Keywords<\/h2>/);
assert.match(html, /<span class="kw-chip">A &amp; &lt;B&gt;<\/span>/);
assert.doesNotMatch(html, /<script/i);

const page = fs.readFileSync(path.join(root, "js/page-news-item.js"), "utf8");
const shell = fs.readFileSync(path.join(root, "news-item/index.html"), "utf8");
assert.match(page, /FAArticleKeywords\.normalize\(article\.keywords\)/);
assert.equal((page.match(/\$\{articleKeywordsHtml\}/g) || []).length, 2,
  "stored keyword chips must render in both standard and episode layouts");
assert.match(page, /"keywords": articleKeywordList\.join\("\, "\)/,
  "the same saved terms should be present in the client NewsArticle JSON-LD");
assert.ok(shell.indexOf("/js/article-keywords.js?") < shell.indexOf("/js/page-news-item.js?"),
  "keyword helper must load before the article renderer");

const sandbox = { window: {}, console };
vm.runInNewContext(fs.readFileSync(path.join(root, "js/articles-data.js"), "utf8"), sandbox);
const records = Object.values(sandbox.window.FA_ARTICLES || {});
const saved = records.find(x => Array.isArray(x.keywords) && x.keywords.length);
assert.ok(saved, "current catalog fixture should include a saved article keyword list");
assert.ok(keywords.render(saved.keywords).includes("class=\"kw-chip\""));
console.log("article keywords: normalization, escaping, saved-data rendering and both page layouts passed");
