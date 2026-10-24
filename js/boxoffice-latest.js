/* FlickAtlas: latest releases with reported collections only. No source data is modified. */
(function (root) {
  "use strict";
  function validDate(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + "T00:00:00Z");
    return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === s;
  }
  function isBollywood(m) { return m.original_language === "hi"; }
  function selectLatest(items, industry, today, cutoff) {
    const seen = new Set();
    return (items || []).filter(m => {
      if (!m || m.id == null || seen.has(String(m.id)) || !validDate(m.release_date) || m.release_date > today || m.release_date < cutoff) return false;
      if (industry === "bollywood" && !isBollywood(m) || industry === "international" && isBollywood(m)) return false;
      seen.add(String(m.id)); return true;
    }).sort((a, b) => b.release_date.localeCompare(a.release_date) || Number(a.id) - Number(b.id)).slice(0, 8);
  }
  function sumReported(rows, start, end, release, today) {
    const dates = new Set(), days = new Set(), clean = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const day = String(r?.day || "").match(/^(?:Day\s*)?(\d+)$/i)?.[1];
      if (!r || !validDate(r.date) || r.date > today || r.date < release || r.date < start || r.date > end || typeof r.collection !== "number" || !Number.isFinite(r.collection) || r.collection < 0 || dates.has(r.date) || day && days.has(Number(day))) continue;
      dates.add(r.date); if (day) days.add(Number(day)); clean.push(r);
    }
    return { amount: clean.reduce((n, r) => n + r.collection, 0), days: clean.length };
  }
  const esc = s => UI.esc(String(s == null ? "" : s));
  function amount(n) { return n === 0 ? '<span class="fa-money" data-usd="0" data-kind="compact">' + esc(UI.moneyText(0, "compact")) + '</span>' : UI.fmtMoney(n); }
  function mount(host, options = {}) {
    if (!host) return { update() {}, destroy() {} };
    const stateKey = options.homepage ? "bo" : "f";
    let generation = 0, industry = options.industry || new URLSearchParams(location.search).get(stateKey) || "bollywood";
    if (!["bollywood", "international"].includes(industry)) industry = "bollywood";
    const labels = { bollywood: "Bollywood", international: "International" };
    const today = new Date().toISOString().slice(0, 10), cutoff = UI.freshCutoff();
    const startDate = new Date(today + "T00:00:00Z"); startDate.setUTCDate(startDate.getUTCDate() - 6);
    const start = startDate.toISOString().slice(0, 10);
    const date = s => UI.fmtDate(s);
    function shell() {
      const heading = options.heading === "h1" ? "h1" : "h2";
      const rates = typeof FA_RATES !== "undefined" ? FA_RATES : null;
      host.innerHTML = `<section class="fa-box-latest${options.homepage ? ' fa-box-latest--home' : ''}" aria-label="Latest movie collections"><div class="fa-box-latest-head"><div><p class="fa-box-latest-kicker">Latest 8 released movies</p>${options.homepage ? '' : `<${heading}>${esc(options.title || "Box Office")}</${heading}>`}<p>Newest releases first, from the available catalogue. Missing figures are marked “Not reported”.</p></div><div class="fa-box-latest-tools"><nav aria-label="Latest box office industry">${Object.entries(labels).map(([k,v]) => `<a href="/box-office?f=${k}" data-fa-ind="${k}" class="${industry === k ? "on" : ""}"${industry === k ? ' aria-current="true"' : ''}>${v}</a>`).join('')}</nav></div></div><p class="fa-box-latest-window">Today: <b>${date(today)}</b> (UTC) · Last 7 days: <b>${date(start)} – ${date(today)}</b></p><p class="fa-box-latest-status" role="status">Loading latest released movies…</p><div class="fa-box-latest-grid" aria-live="polite"></div><details class="fa-box-latest-rates"><summary>About figures &amp; currency</summary><p>Today and 7-day values sum only valid reported daily records. Missing days are excluded, not counted as zero; a partial reported sum is not a complete seven-day total. Daily-record territory and net/gross basis are not supplied. Lifetime is the separately reported worldwide gross, never a sum of incomplete daily records. Catalogue coverage is limited to available releases in the last three months; this is not an exhaustive industry ranking.</p>${rates ? `<p>Display conversion: $1 = ₹${esc(rates.INR)} / Rs ${esc(rates.PKR)} · reference rates as of ${esc(rates.asOf)}. Source amounts remain in USD.</p>` : ''}</details></section>`;
      host.querySelectorAll('[data-fa-ind]').forEach(a => a.addEventListener('click', e => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault(); update(a.dataset.faInd);
      }));
      if (options.homepage) {
        const seeAll = host.closest?.('.section')?.querySelector('.section-head .see-all');
        if (seeAll) seeAll.setAttribute('href', '/box-office?f=' + industry);
      }
    }
    async function update(next) {
      if (next && Object.hasOwn(labels, next)) {
        industry = next;
        if (options.updateUrl !== false) {
          const url = new URL(location.href); url.searchParams.set(stateKey, industry); history.replaceState(history.state, "", url.pathname + url.search + url.hash);
        }
      }
      const run = ++generation, scope = industry;
      shell();
      const status = host.querySelector('.fa-box-latest-status'), grid = host.querySelector('.fa-box-latest-grid');
      try {
        const params = { sort_by: "primary_release_date.desc", "primary_release_date.gte": cutoff, "primary_release_date.lte": today };
        if (scope === "bollywood") Object.assign(params, { with_original_language: "hi", with_origin_country: "IN" });
        let candidates = [];
        for (let page = 1; page <= 3; page++) {
          const batch = await TMDB.discoverResults("movie", { ...params, page });
          candidates.push(...batch);
          if (selectLatest(candidates, scope, today, cutoff).length >= 8 || batch.length < 20) break;
        }
        const picked = selectLatest(candidates, scope, today, cutoff);
        const records = await Promise.all(picked.map(async m => {
          try { const d = await TMDB.details("movie", m.id); return d ? { ...m, ...d, release_date: validDate(d.release_date) ? d.release_date : m.release_date } : m; } catch (_) { return m; }
        }));
        if (run !== generation || !host.isConnected) return;
        const sorted = selectLatest(records, scope, today, cutoff);
        if (!sorted.length) { status.textContent = `No released ${labels[scope]} movies are available in this catalogue window.`; return; }
        status.textContent = `${labels[scope]} · ${sorted.length} latest ${sorted.length === 1 ? "release" : "releases"} · newest first`;
        grid.innerHTML = sorted.map(m => {
          const rows = (window.FA_DAYWISE || {})[String(m.id)];
          const daily = sumReported(rows, today, today, m.release_date, today), week = sumReported(rows, start, today, m.release_date, today);
          const lifetime = typeof m.revenue === "number" && Number.isFinite(m.revenue) && m.revenue > 0 ? amount(m.revenue) : 'Not reported';
          const weekNote = week.days ? `${week.days} of 7 days reported${week.days < 7 ? ' · partial' : ''}` : 'No daily records reported for this period';
          const missing = '<span class="fa-box-unavailable">Not reported</span>';
          const poster = `<span class="fa-box-poster${m.poster_path ? '' : ' is-missing'}" role="img" aria-label="${m.poster_path ? esc(UI.titleOf(m)) + ' poster' : 'Poster unavailable'}">${m.poster_path ? `<img src="${esc(UI.img(m.poster_path, 'w92'))}" alt="" loading="lazy" onerror="this.parentElement.classList.add('is-missing');this.parentElement.setAttribute('aria-label','Poster unavailable');this.remove()">` : ''}<span aria-hidden="true">No poster</span></span>`;

          return `<a class="fa-box-latest-card" data-movie-id="${esc(m.id)}" data-release="${m.release_date}" data-industry="${isBollywood(m) ? 'bollywood' : 'international'}" href="/box-office-day?title=${encodeURIComponent(m.id)}" aria-label="${esc(UI.titleOf(m))} — box office details"><div class="fa-box-card-head">${poster}<div class="fa-box-card-labels"><span class="fa-box-latest-title" title="${esc(UI.titleOf(m))}">${esc(UI.titleOf(m))}</span><p class="fa-box-latest-meta">Released ${date(m.release_date)}</p></div><span class="fa-box-card-arrow" aria-hidden="true">›</span></div><dl aria-label="Reported box office summary"><div title="Today’s reported collection · ${esc(today)} UTC"><dt>Today</dt><dd>${daily.days ? amount(daily.amount) : missing}</dd></div><div title="${esc(weekNote)} · ${esc(start)} to ${esc(today)} UTC"><dt>7 Days</dt><dd>${week.days ? `${amount(week.amount)}${week.days < 7 ? `<abbr class="fa-box-partial" title="${esc(weekNote)}">${week.days}/7</abbr>` : ''}` : missing}</dd></div><div title="Separately reported lifetime worldwide gross"><dt>Total</dt><dd>${lifetime === 'Not reported' ? missing : lifetime}</dd></div></dl></a>`;
        }).join('');
      } catch (_) { if (run === generation && host.isConnected) status.textContent = 'Could not load latest box-office data. Please try again later.'; }
    }
    const restore = () => {
      const selected = new URLSearchParams(location.search).get(stateKey) || 'bollywood';
      const valid = Object.hasOwn(labels, selected) ? selected : 'bollywood';
      if (valid !== industry) { industry = valid; update(); }
    };
    if (typeof root.addEventListener === 'function') root.addEventListener('popstate', restore);
    update();
    return { update, destroy() { generation++; if (typeof root.removeEventListener === 'function') root.removeEventListener('popstate', restore); host.replaceChildren(); } };
  }
  root.FABoxOffice = { mount, helpers: { validDate, selectLatest, sumReported } };
})(window);
