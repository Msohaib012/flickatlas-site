const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { webcrypto } = require("node:crypto");
const { TextEncoder } = require("node:util");

const workerPath = path.join(__dirname, "worker.mjs");
const source = fs.readFileSync(workerPath, "utf8");
assert.equal((source.match(/export default \{/g) || []).length, 1);
const context = { crypto: webcrypto, TextEncoder, Request, Response, Headers, URL, console };
vm.runInNewContext(source.replace("export default {", "globalThis.__worker = {"), context, { filename: workerPath });
const worker = context.__worker;
assert.ok(worker && typeof worker.fetch === "function");

const fixture = {
  schema_version: 1,
  timezone: "Asia/Karachi",
  updated_at: "2026-10-31T00:00:00Z",
  selected_at: "2026-10-31T00:00:00Z",
  selections: { bollywood: ["123"], world: [] },
  reports: { "123": { today: {
    scope: "worldwide", window: "today", amount: 12000000, currency: "USD",
    period_start: "2026-10-31", period_end: "2026-10-31", as_of: "2026-10-31",
    observed_date: "2026-10-31", observed_at: "2026-10-31T00:00:00Z",
    source_name: "official.example", source_url: "https://official.example/box-office",
    evidence_quote: "Fixture Film worldwide gross today was $12 million.", reviewed_by: "Gemini",
  } } },
};
const kv = {
  async get(key, type) {
    assert.equal(key, "current");
    assert.equal(type, "json");
    return fixture;
  },
};
const env = { HOME_BOXOFFICE: kv, ASSETS: { async fetch() { return new Response("", { status: 404 }); } } };

(async () => {
  const get = await worker.fetch(new Request("https://flickatlas.co.uk/api/home-boxoffice-worldwide"), env);
  assert.equal(get.status, 200);
  assert.match(get.headers.get("cache-control"), /no-store/);
  assert.match(get.headers.get("content-type"), /application\/json/);
  const data = await get.json();
  assert.equal(data.reports["123"].today.scope, "worldwide");
  assert.equal(data.reports["123"].today.currency, "USD");
  assert.equal(data.reports["123"].today.reviewed_by, "Gemini");

  const post = await worker.fetch(new Request("https://flickatlas.co.uk/api/home-boxoffice-worldwide", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }), env);
  assert.equal(post.status, 405, "public endpoint is strictly read-only");

  const missing = await worker.fetch(new Request("https://flickatlas.co.uk/api/home-boxoffice-worldwide"), {});
  assert.equal(missing.status, 503, "missing binding must fail closed");

  const malformedEnv = { HOME_BOXOFFICE: { async get() { return { schema_version: 2, reports: { bogus: {} } }; } } };
  const malformed = await worker.fetch(new Request("https://flickatlas.co.uk/api/home-boxoffice-worldwide"), malformedEnv);
  assert.equal(malformed.status, 200);
  const empty = await malformed.json();
  assert.equal(empty.schema_version, 1);
  assert.deepEqual(Array.from(empty.selections.bollywood), []);
  assert.deepEqual(Object.keys(empty.reports), []);
  console.log("home Box Office Worker endpoint: PASS (in-memory KV only; GET-only, no-store and fail-closed)");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
