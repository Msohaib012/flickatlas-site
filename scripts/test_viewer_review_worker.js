const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { webcrypto } = require("node:crypto");
const { TextEncoder } = require("node:util");

const workerPath = path.join(__dirname, "worker.mjs");
const source = fs.readFileSync(workerPath, "utf8");
assert.equal((source.match(/export default \{/g) || []).length, 1, "expected one default Worker export");
const context = {
  crypto: webcrypto,
  TextEncoder,
  Request,
  Response,
  Headers,
  URL,
  console,
};
vm.runInNewContext(source.replace("export default {", "globalThis.__worker = {"), context, { filename: workerPath });
const worker = context.__worker;
assert.ok(worker && typeof worker.fetch === "function", "Worker fetch handler should load for the fixture");

const kvData = new Map();
const kv = {
  async get(key) { return kvData.has(key) ? kvData.get(key) : null; },
  async put(key, value) { kvData.set(key, String(value)); },
  async delete(key) { kvData.delete(key); },
};
const env = {
  REVIEWS: kv,
  ASSETS: {
    async fetch() {
      return new Response('window.FA_PUBLISHED = {"123":{"id":123,"type":"movie"}};', {
        status: 200,
        headers: { "content-type": "application/javascript" },
      });
    },
  },
};
const base = "https://flickatlas.co.uk";
const token1 = "1".repeat(64);
const token2 = "2".repeat(64);
const token3 = "3".repeat(64);

async function call(method, path, body, ip, extraHeaders = {}) {
  const headers = { "CF-Connecting-IP": ip, ...extraHeaders };
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const request = new Request(base + path, { method, headers, body: payload });
  const response = await worker.fetch(request, env);
  let data = null;
  try { data = await response.json(); } catch (_) {}
  return { response, data };
}

(async () => {
  const badStars = await call("POST", "/api/review", { tmdb: "123", stars: 0, comment: "" }, "203.0.113.9");
  assert.equal(badStars.response.status, 400, "star rating remains required");
  const longComment = await call("POST", "/api/review", { tmdb: "123", stars: 3, comment: "x".repeat(501) }, "203.0.113.9");
  assert.equal(longComment.response.status, 400, "comments remain capped at 500 characters");
  const linkedComment = await call("POST", "/api/review", { tmdb: "123", stars: 3, comment: "visit www.example.com" }, "203.0.113.9");
  assert.equal(linkedComment.response.status, 400, "existing link/markup moderation remains active");

  const first = await call("POST", "/api/review", { tmdb: "123", stars: 4, comment: "", ownerToken: token1 }, "203.0.113.1");
  assert.equal(first.response.status, 200);
  assert.equal(first.data.review.c, "", "a stars-only review is accepted");
  assert.equal(first.data.review.mine, true);
  assert.match(first.data.review.rid, /^[a-f0-9]{32}$/);
  assert.equal(Object.hasOwn(first.data.review, "owner_hash"), false, "the owner hash is not returned");

  const second = await call("POST", "/api/review", { tmdb: "123", stars: 2, comment: "Second public review", ownerToken: token2 }, "203.0.113.2");
  assert.equal(second.response.status, 200);
  assert.notEqual(first.data.review.rid, second.data.review.rid, "each review receives a distinct opaque ID");

  const publicGet = await call("GET", "/api/reviews?tmdb=123", undefined, "203.0.113.3");
  assert.equal(publicGet.response.status, 200);
  assert.equal(publicGet.data.count, 2);
  assert.equal(publicGet.data.average, 3);
  assert.equal(Object.hasOwn(publicGet.data.items[0], "owner_hash"), false);
  assert.equal(Object.hasOwn(publicGet.data.items[0], "mine"), false, "public visitors cannot see ownership markers");
  const ownGet = await call("GET", "/api/reviews?tmdb=123", undefined, "203.0.113.1", {
    "x-review-owner-tokens": token1,
  });
  assert.equal(ownGet.data.items.find(item => item.rid === first.data.review.rid).mine, true);
  assert.equal(ownGet.data.items.find(item => item.rid === second.data.review.rid).mine, undefined);
  const otherGet = await call("GET", "/api/reviews?tmdb=123", undefined, "203.0.113.2", {
    "x-review-owner-tokens": token2,
  });
  assert.equal(otherGet.data.items.find(item => item.rid === second.data.review.rid).mine, true);
  assert.equal(otherGet.data.items.find(item => item.rid === first.data.review.rid).mine, undefined);

  const wrongOwner = await call("DELETE", "/api/review", {
    tmdb: "123", rid: first.data.review.rid, ownerToken: token2,
  }, "203.0.113.2");
  assert.equal(wrongOwner.response.status, 404, "another owner's token cannot delete the review");
  const wrongReviewId = await call("DELETE", "/api/review", {
    tmdb: "123", rid: second.data.review.rid, ownerToken: token1,
  }, "203.0.113.1");
  assert.equal(wrongReviewId.response.status, 404, "the matching owner token is required for that specific review");

  const removed = await call("DELETE", "/api/review", {
    tmdb: "123", rid: first.data.review.rid, ownerToken: token1,
  }, "203.0.113.1");
  assert.equal(removed.response.status, 200);
  assert.equal(removed.data.count, 1);
  assert.equal(removed.data.average, 2, "deleting one rating keeps the other review's score");
  const storedAfterDelete = JSON.parse(kvData.get("rev:123"));
  assert.equal(storedAfterDelete.items.length, 1);
  assert.equal(storedAfterDelete.items[0].rid, second.data.review.rid);

  const resubmit = await call("POST", "/api/review", { tmdb: "123", stars: 5, comment: "Updated rating", ownerToken: token3 }, "203.0.113.1");
  assert.equal(resubmit.response.status, 200, "author may submit again after deleting");
  assert.equal(resubmit.data.count, 2);
  assert.equal(resubmit.data.average, 3.5);

  const invalidDelete = await call("DELETE", "/api/review", {
    tmdb: "123", rid: resubmit.data.review.rid, ownerToken: "not-a-token",
  }, "203.0.113.1");
  assert.equal(invalidDelete.response.status, 400);

  console.log("viewer review Worker fixture: PASS (in-memory KV only; no production requests)");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
