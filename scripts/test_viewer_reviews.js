const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../js/page-movie.js"), "utf8");
const validationStart = source.indexOf("    const reviewInputError = (stars, text) => {");
const renderStart = source.indexOf("    const renderStars = (n) => {");
const loadStart = source.indexOf("    const loadReviews = async () => {", renderStart);
assert.ok(validationStart >= 0 && renderStart > validationStart && loadStart > renderStart,
  "rating validation and review renderer fragments should be present");

const validationContext = {};
vm.runInNewContext(`${source.slice(validationStart, renderStart)}\nthis.reviewInputError = reviewInputError;`, validationContext);
const reviewInputError = validationContext.reviewInputError;
assert.equal(reviewInputError(0, ""), "Please pick a star rating first.", "stars remain required");
assert.equal(reviewInputError(5, "   \n  "), "", "a comment may be blank or whitespace only");
assert.equal(reviewInputError(3, "x".repeat(500)), "", "500-character comments are allowed");
assert.equal(reviewInputError(3, "x".repeat(501)), "Please keep comments to 500 characters or fewer.");

const aggregate = { textContent: "" };
const list = {
  innerHTML: "",
  addEventListener() {},
  querySelector: () => null,
};
const sharedCard = { querySelector: () => null };
const storage = new Map();
const main = {
  querySelector(selector) {
    if (selector === "#viewerAgg") return aggregate;
    if (selector === "#viewerList") return list;
    if (selector === "#apShared") return sharedCard;
    return null;
  }
};
const context = {
  main,
  id: "123",
  localStorage: {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  },
  window: { crypto: { getRandomValues: bytes => bytes.fill(7) } },
  UI: { esc: value => String(value), relTime: () => "just now" },
};
const fragment = source.slice(renderStart, loadStart);
vm.runInNewContext(`${fragment}\nthis.reviewHarness = { paintShared, renderList };`, context);
const { paintShared, renderList } = context.reviewHarness;
const emptyCopy = "No viewer reviews yet — be the first to rate this movie.";

paintShared(null, 0);
renderList([]);
assert.equal(aggregate.textContent, emptyCopy);
assert.equal(list.innerHTML, "");
assert.equal((aggregate.textContent + list.innerHTML).split(emptyCopy).length - 1, 1,
  "empty state should appear exactly once");

paintShared(null, 0);
renderList([]);
assert.equal(aggregate.textContent, emptyCopy);
assert.equal(list.innerHTML, "");
assert.equal((aggregate.textContent + list.innerHTML).split(emptyCopy).length - 1, 1);

const rid = "a".repeat(32);
renderList([{ s: 5, n: "Viewer One", c: "Great film", at: 1793276939000, rid, mine: false }]);
assert.match(list.innerHTML, /Viewer One/);
assert.match(list.innerHTML, /Great film/);
assert.match(list.innerHTML, /content-card/);
assert.doesNotMatch(list.innerHTML, /data-review-delete/, "another person's review never gets a delete control");

renderList([{ s: 4, n: "No comment", c: "", at: 1793276939001, rid: "b".repeat(32), mine: true }]);
assert.match(list.innerHTML, /data-review-delete/);
assert.match(list.innerHTML, /data-review-rid="b{32}"/);
assert.doesNotMatch(list.innerHTML, /<p style="margin:8px 0 0">/, "blank-comment ratings do not show an empty paragraph");

renderList([{ s: 5, n: "Viewer One", c: "Great film", at: 1793276939002, rid, mine: true }]);
assert.match(list.innerHTML, /data-review-delete/);
assert.match(list.innerHTML, new RegExp(`data-review-rid="${rid}"`));

// Static contract: one unique random token per post, exact per-review ID on
// delete, and owner-token list only on the same-origin private GET request.
assert.match(source, /window\.crypto\.getRandomValues\(bytes\)/);
assert.match(source, /new Uint8Array\(32\)/);
assert.match(source, /"x-review-owner-tokens"/);
assert.match(source, /method: "DELETE"/);
assert.match(source, /JSON\.stringify\(\{ tmdb: id, rid, ownerToken \}\)/);
assert.match(source, /window\.confirm\(confirmText\)/);
assert.match(source, /placeholder="Write a comment \(optional\)"/);
assert.match(source, /Comments are optional/);
assert.doesNotMatch(source, /if \(!text\) \{[^}]*Please write a comment/);

// Error-path copy remains unchanged (static contract; no fetch/API call).
assert.match(source, /agg\.textContent = "Could not load reviews\.";/);
assert.match(source, /list\.innerHTML = `<p class="prov-note">Could not load reviews\. Please refresh the page\.<\/p>`;/);

console.log("viewer review UI fixture: PASS");
