#!/usr/bin/env node
/* Offline selector shared by the scheduled worldwide fallback and tests. */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const helper = require("../js/home-boxoffice.js");
const root = path.resolve(__dirname, "..");

function readMap(relativePath, variable) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  const marker = `window.${variable}`;
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`Missing ${variable} assignment in ${relativePath}`);
  const eq = source.indexOf("=", at + marker.length);
  const start = source.indexOf("{", eq + 1);
  const end = source.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`Invalid ${variable} map`);
  return JSON.parse(source.slice(start, end + 1));
}
function readJson(relativePath, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8")); }
  catch (_) { return fallback; }
}
function loadUiAndRates() {
  const window = {};
  const document = {
    addEventListener() {}, getElementById() { return null; }, querySelector() { return null; },
    querySelectorAll() { return []; }, createElement() { return { setAttribute() {}, appendChild() {}, classList: { add() {} } }; },
    documentElement: { classList: { add() {}, remove() {} } }, body: { dataset: {} },
  };
  const context = {
    window, document, localStorage: { getItem() { return null; }, setItem() {} },
    navigator: { language: "en-US" }, location: { pathname: "/", search: "" },
    console: { log() {}, warn() {}, error() {} }, URL, URLSearchParams, Intl,
    Date, Math, Array, Object, String, Number, Set, Map, RegExp, JSON,
    encodeURIComponent, decodeURIComponent, Promise,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "js/config.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(root, "js/ui.js"), "utf8"), context);
  return { ui: vm.runInContext("UI", context), rates: vm.runInContext("FA_RATES", context) };
}
function stdinJson() {
  const input = fs.readFileSync(0, "utf8").trim();
  return input ? JSON.parse(input) : {};
}

try {
  const input = stdinJson();
  const todayPKT = input.todayPKT;
  const todayIST = input.todayIST;
  if (!helper.validDate(todayPKT) || !helper.validDate(todayIST)) throw new Error("todayPKT and todayIST must be YYYY-MM-DD");
  const snapshot = helper.safeSnapshot(input.snapshot);
  const catalogMap = readMap("js/published-titles.js", "FA_PUBLISHED");
  const daywise = readMap("js/daywise-data.js", "FA_DAYWISE");
  const worldwide = readMap("js/worldwide-data.js", "FA_WORLDWIDE");
  const provenance = readJson("out/multisource-boxoffice.json", {});
  const proofByMovie = provenance.schema_version === 2 && provenance.figures
    && typeof provenance.figures === "object" ? provenance.figures : {};
  const observedAt = typeof input.observedAt === "string" && Number.isFinite(Date.parse(input.observedAt))
    ? input.observedAt : `${todayIST}T00:00:00Z`;
  const { ui, rates } = loadUiAndRates();
  const catalog = Object.values(catalogMap);
  const pairedById = {};
  for (const item of catalog) {
    if (!item || item.id == null) continue;
    const id = String(item.id);
    const pairs = helper.pairedMetrics(item, daywise[id], proofByMovie[id], todayIST, observedAt);
    if (Object.keys(pairs).length) {
      pairedById[id] = pairs;
      snapshot.reports[id] = { ...(snapshot.reports[id] || {}), ...pairs };
    }
  }
  const selected = helper.selectHomeTitles(catalog, daywise, worldwide, snapshot,
    todayPKT, todayIST, ui, rates, 8);
  const selections = {
    bollywood: selected.bollywood.map(x => String(x.id)).slice(0, 8),
    world: selected.world.map(x => String(x.id)).slice(0, 8),
  };
  const candidates = [];
  for (const [industry, items] of [["bollywood", selected.bollywood], ["world", selected.world]]) {
    for (const item of items) {
      const id = String(item.id);
      const report = snapshot.reports[id] || {};
      const local = {};
      const windowsToRefresh = [];
      for (const windowKey of ["today", "last_7_days", "cumulative_total"]) {
        local[windowKey] = helper.resolveMetric(item, daywise[id], worldwide[id], report, windowKey, todayIST);
        if (helper.needsDirectRefresh(item, daywise[id], worldwide[id], report, windowKey, todayIST)) windowsToRefresh.push(windowKey);
      }
      candidates.push({
        id, title: String(ui.titleOf ? ui.titleOf(item) : item.title || item.name || "").trim(),
        original_title: String(item.original_title || item.original_name || "").trim(),
        release_date: item.release_date, industry, windows_to_refresh: windowsToRefresh,
        local, paired: pairedById[id] || {},
      });
    }
  }
  process.stdout.write(JSON.stringify({ selections, candidates, timezone: "Asia/Karachi", todayPKT, todayIST }));
} catch (err) {
  console.error(`home-boxoffice selector: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
}
