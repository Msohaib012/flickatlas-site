/* FlickAtlas homepage Box Office — source-backed worldwide metric resolution.
   India Net and Overseas remain separate on each movie's inner daywise page.
   The homepage may add them only for exact-date, same-currency, provenance-
   complete pairs; otherwise it requires an explicit worldwide report. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FAHomeBoxOffice = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const CURRENCY_RE = /^[A-Z]{3}$/;
  const WINDOWS = { today: "today", last_7_days: "last_7_days", cumulative_total: "cumulative_total" };
  const DAYWISE_MAX = 30;
  const STORED_SELECTION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

  function validDate(value) {
    if (typeof value !== "string" || !DATE_RE.test(value)) return false;
    const d = new Date(value + "T00:00:00Z");
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }
  function shiftDate(date, days) {
    if (!validDate(date)) return "";
    const d = new Date(date + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function dayDistance(from, to) {
    if (!validDate(from) || !validDate(to)) return null;
    return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000);
  }
  function number(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  }
  function currencyCode(value, fallback) {
    const code = String(value || fallback || "USD").trim().toUpperCase();
    return CURRENCY_RE.test(code) ? code : "";
  }
  function secureUrl(value) {
    if (typeof value !== "string") return "";
    try {
      const u = new URL(value);
      return u.protocol === "https:" ? u.href : "";
    } catch (_) { return ""; }
  }
  function emptySnapshot() {
    return { schema_version: 1, timezone: "Asia/Karachi", updated_at: null,
      selected_at: null, selections: { bollywood: [], world: [] }, reports: {} };
  }
  function safeSnapshot(value) {
    if (!value || typeof value !== "object" || value.schema_version !== 1) return emptySnapshot();
    return {
      schema_version: 1,
      timezone: "Asia/Karachi",
      updated_at: typeof value.updated_at === "string" ? value.updated_at : null,
      selected_at: typeof value.selected_at === "string" ? value.selected_at : null,
      selections: {
        bollywood: Array.isArray(value.selections && value.selections.bollywood) ? value.selections.bollywood.map(String).slice(0, 8) : [],
        world: Array.isArray(value.selections && value.selections.world) ? value.selections.world.map(String).slice(0, 8) : [],
      },
      reports: value.reports && typeof value.reports === "object" && !Array.isArray(value.reports) ? value.reports : {},
    };
  }
  async function loadSnapshot(fetcher) {
    try {
      const request = fetcher || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
      if (!request) return emptySnapshot();
      const response = await request("/api/home-boxoffice-worldwide", { method: "GET", cache: "no-store", credentials: "same-origin" });
      if (!response || !response.ok) return emptySnapshot();
      return safeSnapshot(await response.json());
    } catch (_) { return emptySnapshot(); }
  }
  function directMetric(metric, windowKey, todayIST) {
    if (!metric || metric.scope !== "worldwide" || metric.window !== WINDOWS[windowKey]) return null;
    const amount = number(metric.amount);
    const currency = currencyCode(metric.currency);
    const sourceUrl = secureUrl(metric.source_url);
    if (amount === null || !currency || !sourceUrl || !String(metric.source_name || "").trim()
        || !String(metric.evidence_quote || "").trim() || metric.reviewed_by !== "Gemini"
        || !validDate(metric.as_of) || metric.as_of > todayIST
        || typeof metric.observed_at !== "string" || !Number.isFinite(Date.parse(metric.observed_at))) return null;
    if (windowKey === "today" && (metric.period_start !== todayIST || metric.period_end !== todayIST || metric.as_of !== todayIST)) return null;
    if (windowKey === "last_7_days" && (metric.period_start !== shiftDate(todayIST, -6)
        || metric.period_end !== todayIST || metric.as_of !== todayIST)) return null;
    if (windowKey === "cumulative_total" && metric.period_end !== metric.as_of) return null;
    return { ...metric, amount, currency, source_url: sourceUrl, method: "tavily_gemini" };
  }
  function rowDay(row) {
    const m = String(row && row.day != null ? row.day : "").match(/\d+/);
    return m ? Number(m[0]) : null;
  }
  function rowWorldAmount(row) {
    if (!row || !validDate(row.date)) return null;
    const scope = String(row.scope || "").trim().toLowerCase();
    if (scope !== "worldwide") return null;
    const mainCurrency = currencyCode(row.currency || row.collection_currency || row.currency_code, "USD");
    if (!mainCurrency) return null;
    const amount = number(row.amount != null ? row.amount : row.collection);
    if (amount === null) return null;
    const sourceUrl = secureUrl(row.source_url || row.source);
    const sourceName = String(row.source_name || (sourceUrl ? new URL(sourceUrl).hostname.replace(/^www\./, "") : "")).trim();
    if (!sourceUrl || !sourceName) return null;
    return { date: row.date, day: rowDay(row), amount, currency: mainCurrency,
      scope: "worldwide", method: "explicit_worldwide_day",
      source_name: sourceName, source_url: sourceUrl,
      observed_date: validDate(row.observed_date) ? row.observed_date : row.date,
      observed_at: typeof row.observed_at === "string" ? row.observed_at : null };
  }
  const SOURCE_LABELS = {
    sacnilk: "Sacnilk", filmibeat: "Filmibeat", bollybourse: "BollyBourse",
    bollymoviereviewz: "Bolly Movie Reviewz", filmynewsnetwork: "Filmy News Network",
    moviemint: "MovieMint", flickonclick: "Flickonclick",
    "overseas-ai": "Overseas AI", "overseas-backfill": "Overseas Backfill",
    tavily: "Tavily",
  };
  function sourceNames(value) {
    const ids = Array.isArray(value) ? value
      : value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
    return Array.from(new Set(ids.map(id => {
      const key = String(id || "").trim();
      if (!key) return "";
      return SOURCE_LABELS[key.toLowerCase()] || key.replace(/(^|-)([a-z])/g,
        (_, sep, ch) => (sep ? " " : "") + ch.toUpperCase());
    }).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }
  function pairDay(row, proof, expectedDate, expectedDay, dailyOnly) {
    if (!row || !proof || !validDate(expectedDate) || row.date !== expectedDate
        || proof.date !== expectedDate || proof.date_disagreed !== false
        || proof.india !== true || proof.collection_scope !== "india_net"
        || proof.collection_currency !== "USD") return null;
    const day = rowDay(row);
    if (!Number.isInteger(day) || day < 1 || (expectedDay && day !== expectedDay)
        || (dailyOnly && day > DAYWISE_MAX) || row.date > expectedDate) return null;
    const overseas = proof.extras && proof.extras.overseas;
    if (!overseas || overseas.scope !== "overseas_gross" || overseas.currency !== "USD"
        || overseas.date !== expectedDate || overseas.date_disagreed !== false) return null;
    const indiaAmount = number(row.collection);
    const proofIndiaAmount = number(proof.collection_usd);
    const overseasAmount = number(row.overseas);
    const proofOverseasAmount = number(overseas.value);
    if (indiaAmount === null || proofIndiaAmount === null || indiaAmount !== proofIndiaAmount
        || overseasAmount === null || proofOverseasAmount === null || overseasAmount !== proofOverseasAmount) return null;
    const indiaSources = sourceNames(proof.sources);
    const overseasSources = sourceNames(overseas.sources);
    if (!indiaSources.length || !overseasSources.length) return null;
    return { date: expectedDate, day, indiaAmount, overseasAmount, indiaSources, overseasSources };
  }
  function makePairedMetric(windowKey, pairs, periodStart, periodEnd, asOf, observedDate, observedAt, throughDay) {
    if (!Array.isArray(pairs) || !pairs.length) return null;
    const sum = field => pairs.reduce((total, pair) => total + pair[field], 0);
    const unique = field => Array.from(new Set(pairs.flatMap(pair => pair[field]))).sort((a, b) => a.localeCompare(b));
    const dates = pairs.map(pair => pair.date);
    const days = pairs.map(pair => pair.day);
    const india = sum("indiaAmount"), overseas = sum("overseasAmount");
    if (!Number.isFinite(india) || !Number.isFinite(overseas)) return null;
    const indiaNames = unique("indiaSources"), overseasNames = unique("overseasSources");
    return { scope: "worldwide", method: "paired_components", window: WINDOWS[windowKey],
      amount: india + overseas, currency: "USD", period_start: periodStart,
      period_end: periodEnd, as_of: asOf, observed_date: observedDate,
      observed_at: typeof observedAt === "string" && Number.isFinite(Date.parse(observedAt)) ? observedAt : null,
      source_name: "India Net + Overseas (same-date, source-backed components)",
      pair_dates: dates, day_numbers: days, reported_days: pairs.length,
      expected_report_days: pairs.length, through_day: throughDay || null,
      components: {
        india_net: { scope: "india_net", amount: india, currency: "USD",
          source_names: indiaNames, dates: dates.slice(), day_numbers: days.slice() },
        overseas_gross: { scope: "overseas_gross", amount: overseas, currency: "USD",
          source_names: overseasNames, dates: dates.slice(), day_numbers: days.slice() },
      } };
  }
  function pairedMetric(record, windowKey, todayIST, releaseDate) {
    if (!record || record.scope !== "worldwide" || record.method !== "paired_components"
        || record.window !== WINDOWS[windowKey] || !validDate(todayIST) || !validDate(releaseDate)) return null;
    const amount = number(record.amount), currency = currencyCode(record.currency);
    const india = record.components && record.components.india_net;
    const overseas = record.components && record.components.overseas_gross;
    const validComponent = (component, scope) => component && component.scope === scope
      && currencyCode(component.currency) === currency && number(component.amount) !== null
      && Array.isArray(component.source_names) && component.source_names.length > 0
      && component.source_names.every(name => typeof name === "string" && name.trim())
      && Array.isArray(component.dates) && Array.isArray(component.day_numbers);
    if (amount === null || !currency || !validDate(record.as_of) || record.as_of > todayIST
        || !validDate(record.period_start) || !validDate(record.period_end)
        || !validDate(record.observed_date) || record.observed_date > todayIST
        || typeof record.observed_at !== "string" || !Number.isFinite(Date.parse(record.observed_at))
        || !validComponent(india, "india_net") || !validComponent(overseas, "overseas_gross")
        || amount !== india.amount + overseas.amount) return null;
    const dates = record.pair_dates;
    const days = record.day_numbers;
    if (!Array.isArray(dates) || !Array.isArray(days) || !dates.length
        || dates.length !== days.length || dates.length !== record.reported_days
        || record.expected_report_days !== dates.length
        || dates.some((date, i) => !validDate(date) || (i > 0 && date <= dates[i - 1]))
        || days.some((day, i) => !Number.isInteger(day) || day !== i + 1 && windowKey === "cumulative_total")
        || JSON.stringify(india.dates) !== JSON.stringify(dates)
        || JSON.stringify(overseas.dates) !== JSON.stringify(dates)
        || JSON.stringify(india.day_numbers) !== JSON.stringify(days)
        || JSON.stringify(overseas.day_numbers) !== JSON.stringify(days)) return null;
    if (windowKey === "today") {
      if (record.period_start !== todayIST || record.period_end !== todayIST || record.as_of !== todayIST
          || dates.length !== 1 || dates[0] !== todayIST
          || days[0] !== dayDistance(releaseDate, todayIST) + 1 || days[0] > DAYWISE_MAX) return null;
    } else if (windowKey === "last_7_days") {
      const start = shiftDate(todayIST, -6);
      const expected = [];
      for (let d = start < releaseDate ? releaseDate : start; d <= todayIST; d = shiftDate(d, 1)) expected.push(d);
      if (record.period_start !== start || record.period_end !== todayIST || record.as_of !== todayIST
          || JSON.stringify(dates) !== JSON.stringify(expected)
          || days.some((day, i) => day !== dayDistance(releaseDate, dates[i]) + 1 || day > DAYWISE_MAX)) return null;
    } else if (windowKey === "cumulative_total") {
      if (record.period_start !== releaseDate || record.period_end !== record.as_of
          || record.as_of !== dates[dates.length - 1] || dates[0] !== releaseDate
          || record.through_day !== days.length) return null;
      for (let i = 0; i < dates.length; i++) {
        if (dates[i] !== shiftDate(releaseDate, i)) return null;
      }
    } else return null;
    return { ...record, amount, currency };
  }
  function pairedMetrics(entry, rows, provenanceDays, todayIST, observedAt) {
    const releaseDate = entry && entry.release_date;
    if (!validDate(releaseDate) || !validDate(todayIST) || releaseDate > todayIST
        || !provenanceDays || typeof provenanceDays !== "object") return {};
    const dayRows = Array.isArray(rows) ? rows : [];
    const byDay = new Map(), duplicateDays = new Set();
    for (const row of dayRows) {
      const day = rowDay(row);
      if (!Number.isInteger(day) || day < 1) continue;
      if (byDay.has(day)) duplicateDays.add(day);
      else byDay.set(day, row);
    }
    const getPair = (row, expectedDate, expectedDay, dailyOnly) => {
      if (duplicateDays.has(expectedDay) || !row || row.date > todayIST) return null;
      const proof = provenanceDays[String(expectedDay)] || provenanceDays[expectedDay];
      return pairDay(row, proof, expectedDate, expectedDay, dailyOnly);
    };
    const out = {};
    const todayRow = dayRows.filter(row => row && row.date === todayIST);
    if (todayRow.length === 1) {
      const day = rowDay(todayRow[0]);
      const expectedDay = dayDistance(releaseDate, todayIST) + 1;
      const pair = getPair(todayRow[0], todayIST, expectedDay, true);
      const metric = pair && makePairedMetric("today", [pair], todayIST, todayIST, todayIST,
        todayIST, observedAt, expectedDay);
      if (metric && pairedMetric(metric, "today", todayIST, releaseDate)) out.today = metric;
    }
    const weekStart = shiftDate(todayIST, -6);
    const weekPairs = [];
    let completeWeek = true;
    for (let d = weekStart < releaseDate ? releaseDate : weekStart; d <= todayIST; d = shiftDate(d, 1)) {
      const matching = dayRows.filter(row => row && row.date === d);
      if (matching.length !== 1) { completeWeek = false; break; }
      const expectedDay = dayDistance(releaseDate, d) + 1;
      const pair = getPair(matching[0], d, expectedDay, true);
      if (!pair) { completeWeek = false; break; }
      weekPairs.push(pair);
    }
    if (completeWeek && weekPairs.length) {
      const metric = makePairedMetric("last_7_days", weekPairs, weekStart, todayIST, todayIST,
        todayIST, observedAt);
      if (metric && pairedMetric(metric, "last_7_days", todayIST, releaseDate)) out.last_7_days = metric;
    }
    const totalPairs = [];
    for (let day = 1; byDay.has(day); day++) {
      const expectedDate = shiftDate(releaseDate, day - 1);
      const pair = getPair(byDay.get(day), expectedDate, day, false);
      if (!pair) break;
      totalPairs.push(pair);
    }
    if (totalPairs.length) {
      const asOf = totalPairs[totalPairs.length - 1].date;
      const metric = makePairedMetric("cumulative_total", totalPairs, releaseDate, asOf, asOf,
        todayIST, observedAt, totalPairs[totalPairs.length - 1].day);
      if (metric && pairedMetric(metric, "cumulative_total", todayIST, releaseDate)) out.cumulative_total = metric;
    }
    return out;
  }
  function sameMetric(a, b) { return a && b && a.amount === b.amount && a.currency === b.currency && a.method === b.method; }
  function worldwideRows(rows, dailyOnly) {
    const grouped = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const metric = rowWorldAmount(row);
      if (!metric || (dailyOnly && (!Number.isInteger(metric.day) || metric.day < 1 || metric.day > DAYWISE_MAX))) continue;
      const current = grouped.get(metric.date);
      if (!current) { grouped.set(metric.date, metric); continue; }
      if (current.ambiguous) continue;
      if (current.method !== "explicit_worldwide_day" && metric.method === "explicit_worldwide_day") {
        grouped.set(metric.date, metric); // an explicit worldwide figure is not added to its components
      } else if (current.method === "explicit_worldwide_day" && metric.method !== "explicit_worldwide_day") {
        continue;
      } else if (sameMetric(current, metric)) {
        continue;
      } else {
        grouped.set(metric.date, { ambiguous: true });
      }
    }
    for (const [date, metric] of grouped) if (metric && metric.ambiguous) grouped.delete(date);
    return grouped;
  }
  function provenanceFor(metrics) {
    const unique = new Map();
    for (const metric of metrics) {
      const sourceUrl = secureUrl(metric.source_url);
      if (!sourceUrl) continue;
      const key = `${sourceUrl}\t${metric.source_name || ""}`;
      if (!unique.has(key)) unique.set(key, {
        source_name: String(metric.source_name || "Worldwide source"), source_url: sourceUrl,
        date: metric.date || metric.as_of || null,
      });
    }
    const sources = Array.from(unique.values());
    const observedDates = metrics.map(m => m.observed_date || m.date || m.as_of || "").filter(validDate).sort();
    const observedAt = metrics.map(m => m.observed_at || "").filter(x => Number.isFinite(Date.parse(x))).sort().pop() || null;
    const names = Array.from(new Set(sources.map(s => s.source_name)));
    return { sources, source_url: sources.length === 1 ? sources[0].source_url : "",
      source_name: names.length === 1 ? names[0] : names.length ? `${names.length} worldwide sources` : "",
      observed_date: observedDates[observedDates.length - 1] || null, observed_at: observedAt };
  }
  function localDailyMetric(rows, windowKey, releaseDate, todayIST) {
    if (!validDate(releaseDate) || !validDate(todayIST) || releaseDate > todayIST) return null;
    const periodStart = windowKey === "today" ? todayIST : shiftDate(todayIST, -6);
    const periodEnd = todayIST;
    const byDate = worldwideRows(rows, true);
    const amounts = [];
    for (let d = periodStart; d <= periodEnd; d = shiftDate(d, 1)) {
      if (d < releaseDate) continue; // no theatrical collection before release
      const metric = byDate.get(d);
      if (!metric || !metric.currency) return null; // no partial worldwide window
      amounts.push(metric);
    }
    if (!amounts.length) return null;
    const currency = amounts[0].currency;
    if (amounts.some(m => m.currency !== currency)) return null;
    const provenance = provenanceFor(amounts);
    return { scope: "worldwide", window: WINDOWS[windowKey], amount: amounts.reduce((sum, m) => sum + m.amount, 0),
      currency, period_start: periodStart, period_end: periodEnd, as_of: periodEnd,
      ...provenance, evidence_quote: "", method: "explicit_worldwide_day",
      reported_days: amounts.length, expected_report_days: dayDistance(periodStart < releaseDate ? releaseDate : periodStart, periodEnd) + 1 };
  }
  function explicitWorldwideTotal(record, todayIST) {
    if (!record || record.scope !== "worldwide") return null;
    const amount = number(record.total_usd != null ? record.total_usd : record.amount);
    const currency = currencyCode(record.currency, "USD");
    const asOf = String(record.as_of || "");
    if (amount === null || !currency || !validDate(asOf) || asOf > todayIST) return null;
    const sourceUrl = secureUrl(record.source_url || record.source);
    const src = String(record.source_name || (sourceUrl ? new URL(sourceUrl).hostname.replace(/^www\./, "") : "")).trim();
    if (!sourceUrl || !src) return null;
    return { scope: "worldwide", window: WINDOWS.cumulative_total, amount, currency,
      period_start: null, period_end: asOf, as_of: asOf, observed_at: null,
      observed_date: validDate(record.observed_date) ? record.observed_date : asOf,
      source_name: src, source_url: sourceUrl, sources: [{ source_name: src, source_url: sourceUrl, date: asOf }],
      evidence_quote: "", method: "published_worldwide_total" };
  }
  function localDerivedTotal(rows, releaseDate, todayIST) {
    if (!validDate(releaseDate) || releaseDate > todayIST) return null;
    const byDay = new Map();
    const byDate = worldwideRows(rows, false);
    for (const metric of byDate.values()) {
      if (!Number.isInteger(metric.day) || metric.day < 1) continue;
      if (byDay.has(metric.day)) return null;
      byDay.set(metric.day, metric);
    }
    if (!byDay.size || !byDay.has(1)) return null;
    const maxDay = Math.max(...byDay.keys());
    if (byDay.size !== maxDay || byDay.get(1).date !== releaseDate) return null;
    const elapsed = dayDistance(releaseDate, todayIST) + 1;
    if (maxDay !== elapsed) return null; // never call a stale/partial sum a current cumulative total
    let total = 0, currency = "";
    for (let day = 1; day <= maxDay; day++) {
      const metric = byDay.get(day);
      if (!metric || metric.date !== shiftDate(releaseDate, day - 1)) return null;
      if (!currency) currency = metric.currency;
      if (metric.currency !== currency) return null;
      total += metric.amount;
    }
    const provenance = provenanceFor(Array.from(byDay.values()));
    return { scope: "worldwide", window: WINDOWS.cumulative_total, amount: total, currency,
      period_start: releaseDate, period_end: todayIST, as_of: todayIST,
      ...provenance, evidence_quote: "", method: "explicit_worldwide_total", through_day: maxDay };
  }
  function localMetric(entry, rows, explicitTotal, windowKey, todayIST) {
    if (windowKey === "today" || windowKey === "last_7_days")
      return localDailyMetric(rows, windowKey, entry && entry.release_date, todayIST);
    if (windowKey !== "cumulative_total") return null;
    // Never add an explicit worldwide total to India Net/Overseas components.
    return explicitWorldwideTotal(explicitTotal, todayIST)
      || localDerivedTotal(rows, entry && entry.release_date, todayIST);
  }
  function resolveMetric(entry, rows, explicitTotal, report, windowKey, todayIST) {
    const paired = pairedMetric(report && report[windowKey], windowKey, todayIST, entry && entry.release_date);
    const base = localMetric(entry, rows, explicitTotal, windowKey, todayIST);
    const direct = directMetric(report && report[windowKey], windowKey, todayIST);
    if (paired) {
      if (windowKey !== "cumulative_total") return paired;
      const options = [{ metric: paired, priority: 3 }, { metric: direct, priority: 2 },
        { metric: base, priority: 1 }].filter(option => option.metric);
      options.sort((a, b) => String(b.metric.as_of || "").localeCompare(String(a.metric.as_of || ""))
        || b.priority - a.priority);
      return options[0].metric;
    }
    if (!direct) return base;
    if (!base) return direct;
    const directObserved = Date.parse(direct.observed_at || "");
    const baseObserved = Date.parse(base.observed_at || "");
    const directObservedLater = Number.isFinite(directObserved)
      && (!Number.isFinite(baseObserved) || directObserved >= baseObserved);
    if (windowKey === "cumulative_total" && direct.as_of > base.as_of) return direct;
    return directObservedLater ? direct : base;
  }
  function needsDirectRefresh(entry, rows, explicitTotal, report, windowKey, todayIST) {
    // This selector is used by the four-slot refresh workflow, not a one-time
    // backfill. Worldwide values can change during the same day, so each
    // selected title's combined query refreshes all three windows once per
    // slot; cached records remain a display fallback if new evidence fails.
    const paired = pairedMetric(report && report[windowKey], windowKey, todayIST, entry && entry.release_date);
    if (!paired) return true;
    return windowKey === "cumulative_total" && paired.as_of < todayIST;
  }
  function rankUsd(metric, rates) {
    if (!metric) return null;
    const currency = currencyCode(metric.currency);
    const rate = rates && Number(rates[currency]);
    if (Number.isFinite(rate) && rate > 0) return metric.amount / rate;
    return null;
  }
  function positiveRankValue(item, field) {
    const value = Number(item && item[field]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
  function popularSort(a, b, ui) {
    // Prefer actual popularity/reach over a high rating from very few votes.
    // A release date is only a tie-break when at least one real signal exists;
    // two unscored titles use a stable title/ID order, not release recency.
    const aPopularity = positiveRankValue(a, "popularity");
    const bPopularity = positiveRankValue(b, "popularity");
    const aVotes = positiveRankValue(a, "vote_count");
    const bVotes = positiveRankValue(b, "vote_count");
    const aRating = aVotes > 0 ? positiveRankValue(a, "vote_average") : 0;
    const bRating = bVotes > 0 ? positiveRankValue(b, "vote_average") : 0;
    const titleA = String(ui.titleOf ? ui.titleOf(a) : a.title || "");
    const titleB = String(ui.titleOf ? ui.titleOf(b) : b.title || "");
    const titleOrder = titleA.localeCompare(titleB);
    const idOrder = String(a.id == null ? "" : a.id).localeCompare(String(b.id == null ? "" : b.id));
    const popularityOrder = bPopularity - aPopularity || bVotes - aVotes || bRating - aRating;
    if (popularityOrder) return popularityOrder;
    if (!aPopularity && !aVotes && !bPopularity && !bVotes) return titleOrder || idOrder;
    return String(b.release_date || "").localeCompare(String(a.release_date || ""))
      || String(b.published_at || "").localeCompare(String(a.published_at || ""))
      || titleOrder || idOrder;
  }
  function candidatePools(catalog, daywise, worldwide, snapshot, todayPKT, todayIST, ui, rates, limit) {
    const cap = Number.isInteger(limit) && limit > 0 ? limit : 8;
    const cutoff = shiftDate(todayPKT, -13); // exactly 14 calendar dates, including today
    const pools = { bollywood: [], world: [] };
    for (const x of Array.isArray(catalog) ? catalog : []) {
      if (!x || x.id == null || !x.poster_path || (x.type || x.media_type || "movie") !== "movie"
          || !validDate(x.release_date) || x.release_date > todayPKT || x.date_kind === "festival") continue;
      if (ui && typeof ui.isStreamingOnly === "function" && ui.isStreamingOnly(x)) continue;
      const kind = ui && typeof ui.industryOf === "function" ? ui.industryOf(x) : x.industry;
      const bucket = kind === "bollywood" ? "bollywood" : kind === "world" ? "world" : "";
      if (!bucket) continue;
      const id = String(x.id);
      const report = snapshot && snapshot.reports && snapshot.reports[id];
      const weekly = resolveMetric(x, (daywise || {})[id], (worldwide || {})[id], report, "last_7_days", todayIST);
      pools[bucket].push({ item: x, id, recent: x.release_date >= cutoff, weekly,
        weeklyUsd: rankUsd(weekly, rates), weeklyAsOf: weekly && weekly.as_of || "" });
    }
    for (const bucket of ["bollywood", "world"]) {
      pools[bucket].sort((a, b) => {
        if (a.recent !== b.recent) return a.recent ? -1 : 1;
        if (!!a.weekly !== !!b.weekly) return a.weekly ? -1 : 1;
        if (a.weeklyUsd !== null && b.weeklyUsd !== null && a.weeklyUsd !== b.weeklyUsd) return b.weeklyUsd - a.weeklyUsd;
        if (a.weekly && b.weekly && a.weeklyUsd === null && b.weeklyUsd === null
            && a.weekly.currency === b.weekly.currency && a.weekly.amount !== b.weekly.amount) return b.weekly.amount - a.weekly.amount;
        return String(b.weeklyAsOf).localeCompare(String(a.weeklyAsOf)) || popularSort(a.item, b.item, ui);
      });
      pools[bucket] = pools[bucket].slice(0, cap);
    }
    return pools;
  }
  function selectHomeTitles(catalog, daywise, worldwide, snapshotValue, todayPKT, todayIST, ui, rates, limit) {
    const snapshot = safeSnapshot(snapshotValue);
    const pools = candidatePools(catalog, daywise, worldwide, snapshot, todayPKT, todayIST, ui, rates, limit);
    return { bollywood: pools.bollywood.map(x => x.item), world: pools.world.map(x => x.item) };
  }
  function selectionForDisplay(catalog, daywise, worldwide, snapshotValue, todayPKT, todayIST, ui, rates, limit) {
    const snapshot = safeSnapshot(snapshotValue);
    const cap = Number.isInteger(limit) && limit > 0 ? limit : 8;
    const computed = candidatePools(catalog, daywise, worldwide, snapshot, todayPKT, todayIST, ui, rates, cap);
    const byId = {
      bollywood: new Map(computed.bollywood.map(x => [x.id, x.item])),
      world: new Map(computed.world.map(x => [x.id, x.item])),
    };
    const selectedAt = Date.parse(snapshot.selected_at || "");
    const age = Date.now() - selectedAt;
    const fresh = Number.isFinite(selectedAt) && age >= 0 && age <= STORED_SELECTION_MAX_AGE_MS;
    const out = { bollywood: [], world: [] };
    for (const bucket of ["bollywood", "world"]) {
      if (fresh) {
        for (const rawId of snapshot.selections[bucket]) {
          const id = String(rawId), item = byId[bucket].get(id);
          if (item && !out[bucket].some(x => String(x.id) === id)) out[bucket].push(item);
        }
      }
      for (const rec of computed[bucket]) {
        if (out[bucket].length >= cap) break;
        if (!out[bucket].some(x => String(x.id) === rec.id)) out[bucket].push(rec.item);
      }
    }
    return out;
  }
  function formatCurrency(amount, currency) {
    const code = currencyCode(currency);
    if (number(amount) === null || !code) return "";
    try {
      return new Intl.NumberFormat(code === "INR" ? "en-IN" : "en-US", {
        style: "currency", currency: code, notation: "compact", maximumFractionDigits: 1,
      }).format(amount);
    } catch (_) { return `${amount.toLocaleString("en-US")} ${code}`; }
  }
  return { DATE_RE, WINDOWS, DAYWISE_MAX, emptySnapshot, safeSnapshot, loadSnapshot, directMetric,
    rowWorldAmount, pairedMetric, pairedMetrics, worldwideRows, localDailyMetric, explicitWorldwideTotal,
    localDerivedTotal, localMetric, resolveMetric, needsDirectRefresh,
    selectHomeTitles, selectionForDisplay, formatCurrency, shiftDate, validDate, secureUrl };
});
