const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../js/page-movie.js"), "utf8");
const start = source.indexOf("    const renderStars = (n) => {");
const end = source.indexOf("    const loadReviews = async () => {", start);
assert.ok(start >= 0 && end > start, "review renderer fragment should be present");
const fragment = source.slice(start, end);

const aggregate = { textContent: "" };
const list = { innerHTML: "" };
const sharedCard = { querySelector: () => null };
const main = {
  querySelector(selector) {
    if (selector === "#viewerAgg") return aggregate;
    if (selector === "#viewerList") return list;
    if (selector === "#apShared") return sharedCard;
    return null;
  }
};
const context = { main, UI: { esc: value => String(value), relTime: () => "just now" } };
vm.runInNewContext(`${fragment}\nthis.reviewHarness = { paintShared, renderList };`, context);
const { paintShared, renderList } = context.reviewHarness;
const emptyCopy = "No viewer reviews yet — be the first to rate this movie.";

paintShared(null, 0);
renderList([]);
assert.equal(aggregate.textContent, emptyCopy);
assert.equal(list.innerHTML, "");
assert.equal((aggregate.textContent + list.innerHTML).split(emptyCopy).length - 1, 1,
  "empty state should appear exactly once");

// Repeating the same empty load must not duplicate its CTA.
paintShared(null, 0);
renderList([]);
assert.equal(aggregate.textContent, emptyCopy);
assert.equal(list.innerHTML, "");
assert.equal((aggregate.textContent + list.innerHTML).split(emptyCopy).length - 1, 1);

paintShared(4.5, 2);
renderList([{ s: 5, n: "Viewer One", c: "Great film", at: "2026-10-29T00:00:00Z" }]);
assert.equal(aggregate.textContent, "4.5 ★ from 2 viewer reviews.");
assert.match(list.innerHTML, /Viewer One/);
assert.match(list.innerHTML, /Great film/);
assert.match(list.innerHTML, /content-card/);

// An empty response after populated reviews clears the old cards.
paintShared(null, 0);
renderList([]);
assert.equal(list.innerHTML, "");
assert.equal(aggregate.textContent, emptyCopy);

// Error-path copy remains unchanged (static contract; no fetch/API call).
assert.match(source, /agg\.textContent = "Could not load reviews\.";/);
assert.match(source, /list\.innerHTML = `<p class="prov-note">Could not load reviews\. Please refresh the page\.<\/p>`;/);

console.log("viewer review renderer fixture: PASS");
