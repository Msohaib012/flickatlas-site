/* FlickAtlas — stats page (INTERNAL, noindex). One well-organised view of
   the whole site: pipeline runs, published posts, live traffic, site
   health. The browser never calls a live API — everything comes from
   JSON files the GitHub workflows write:
     js/stats-pipeline.json  (hourly: fetch / Gemini / publish runs, posts)
     js/stats-traffic.json   (every 15 min: GA4 — users now, views, sources)
     js/stats-health.json    (daily: Vercel deploy, DMCA inbox, Search Console)
   Missing or unconnected data is shown as "not connected / not checked
   yet" — never a fake number and never a fake OK. All times are PKT. */
(async function () {
  UI.mountChrome("");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Site Stats — FlickAtlas",
    desc: "Internal stats for FlickAtlas: pipeline runs, published posts, traffic and site health.",
    path: "/stats",
    noindex: true
  });

  const bust = Math.floor(Date.now() / 300000); // 5-minute cache bucket
  const loadJson = async (path) => {
    try {
      const r = await fetch(`${path}?v=${bust}`);
      if (!r.ok) return null;
      return await r.json();
    } catch (_) { return null; }
  };

  /* ---------- formatting (all times PKT) ---------- */
  const dayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", day: "numeric", month: "short", year: "numeric" });
  const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const fmtDay = (iso) => { if (!iso) return "—"; const d = new Date(iso); return isNaN(d) ? "—" : dayFmt.format(d); };
  const fmtTime = (iso) => { if (!iso) return "—"; const d = new Date(iso); return isNaN(d) ? "—" : `${timeFmt.format(d)} PKT`; };
  const inMin = (iso) => {
    const ms = new Date(iso) - Date.now();
    if (isNaN(ms)) return "";
    if (ms <= 0) return "due now";
    const m = Math.round(ms / 60000);
    if (m < 60) return `in ${m} min`;
    const h = Math.floor(m / 60);
    return `in ${h}h ${m % 60}m`;
  };
  const dur = (sec) => {
    if (sec == null || isNaN(sec)) return "—";
    const s = Math.round(sec);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  };
  const num = (n) => (n == null || isNaN(n) ? "—" : Number(n).toLocaleString("en-US"));

  /* Status chip: green = good, red = bad, grey = unknown / not checked. */
  const chip = (status) => {
    const s = String(status || "unknown").toLowerCase();
    const good = ["success", "ready", "ok"].includes(s);
    const bad = ["failure", "failed", "error", "degraded", "attention"].includes(s);
    const label = { success: "Success", ready: "Ready", ok: "OK", failure: "Failed", failed: "Failed", error: "Error", degraded: "Degraded", attention: "Needs attention", building: "Building", unknown: "Unknown", "not checked": "Not checked yet" }[s] || status;
    const style = good ? "background:#E7F6EC;color:#166534" : bad ? "background:#FDECEC;color:#991B1B" : "background:#F1F5F9;color:#475569";
    return `<span class="tag-chip" style="${style}">${UI.esc(label)}</span>`;
  };

  /* Gemini category slugs (ott_streaming) -> human labels. */
  const CAT_LABELS = { movies: "Movies", box_office: "Box Office", celebrities_events: "Celebrity news & events", ott_streaming: "OTT / Streaming", tv_dramas: "TV & Dramas", upcoming_releases: "Upcoming releases", trailers: "Trailers", music_ost: "Music / OST", episodes: "Episodes", awards: "Awards", entertainment_viral: "Entertainment viral" };
  const catLabel = (c) => CAT_LABELS[c] || String(c || "—").replace(/_/g, " ").replace(/\b\w/g, (x) => x.toUpperCase());

  const factRow = (k, v) => `<div class="fact-row"><dt>${UI.esc(k)}</dt><dd>${v}</dd></div>`;
  const runLink = (run) => (run && run.run_url) ? ` <a href="${UI.esc(run.run_url)}" target="_blank" rel="noopener">Run ↗</a>` : "";

  main.innerHTML = `<div class="wrap">
    <h1 style="margin:22px 0 4px">Site Stats</h1>
    <p class="sec-sub">Internal page — pipeline, posts, traffic and site health. All times are Pakistan time (PKT). Data refreshes itself: pipeline hourly, traffic every 15 minutes, health daily.</p>
    <div id="statsPipeline"><div class="sk" style="height:180px;border-radius:14px"></div></div>
    <div id="statsPosts"><div class="sk" style="height:180px;border-radius:14px"></div></div>
    <div id="statsTraffic"><div class="sk" style="height:180px;border-radius:14px"></div></div>
    <div id="statsHealth"><div class="sk" style="height:180px;border-radius:14px"></div></div>
  </div>`;

  let pipe = null, traffic = null, health = null;
  try {
    [pipe, traffic, health] = await Promise.all([
      loadJson("/js/stats-pipeline.json"),
      loadJson("/js/stats-traffic.json"),
      loadJson("/js/stats-health.json"),
    ]);
  } catch (e) {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("Could not load the stats right now. Please check your connection and try again.")}</div>`;
    return;
  }

  /* ================= (a) PIPELINE ================= */
  const renderPipeline = () => {
    const host = document.getElementById("statsPipeline");
    if (!pipe) {
      host.innerHTML = `<section class="section"><div class="section-head"><h2>Pipeline</h2></div><div class="content-card"><p class="state-msg">Pipeline stats not available yet — the hourly stats workflow has not written its first file.</p></div></section>`;
      return;
    }
    const f = pipe.fetch || {}, g = pipe.gemini || {}, p = pipe.publish || {};
    const posts = pipe.posts || {};
    const picks = Object.entries(g.per_category || {}).map(([c, n]) => `${catLabel(c)} ×${n}`).join(", ");
    const cats = f.per_category && Object.keys(f.per_category).length ? f.per_category : (pipe.queue || {}).per_category || {};
    const catRows = Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([c, n]) => `<tr><td>${UI.esc(c)}</td><td><b>${num(n)}</b></td></tr>`).join("");
    host.innerHTML = `<section class="section"><div class="section-head"><h2>Pipeline</h2></div>
      <p class="sec-sub">Sources arrive, Gemini picks, posts go live — and when the next round runs. Updated ${fmtTime(pipe.generated)}.</p>
      <div class="content-card"><h2>Last runs</h2><dl class="facts-table">
        ${factRow("Last fetch", `${fmtTime(f.finished_at || f.started_at)} ${chip(f.status)}${runLink(f)}`)}
        ${factRow("Sources", `${num(f.sources_total)} total · ${num(f.sources_ok)} ok · ${num(f.sources_error)} error · ${num(f.sources_unchanged)} unchanged${f.sources_other ? ` · ${num(f.sources_other)} other` : ""}`)}
        ${factRow("Stories queued", `${num(f.stories_queued)}${f.stories_new ? ` · ${num(f.stories_new)} new this run` : ""}${f.duplicates_removed ? ` · ${num(f.duplicates_removed)} duplicates removed` : ""}`)}
        ${factRow("Last Gemini run", `${fmtTime(g.finished_at || g.generated_at || g.started_at)} ${chip(g.status)}${runLink(g)}`)}
        ${factRow("Gemini picked", `${num(g.picked)} stories${picks ? ` (${UI.esc(picks)})` : ""}${g.skipped ? ` · ${num(g.skipped)} skipped` : ""}`)}
        ${factRow("Posts made", g.posts_created != null ? `${num(g.posts_created)} from the last batch` : "—")}
        ${factRow("Last publish run", `${fmtTime(p.finished_at || p.started_at)} ${chip(p.status)}${runLink(p)}`)}
        ${factRow("Posts total", `${num(posts.total)} (${num(posts.articles)} articles + ${num(posts.titles)} titles) · ${num(posts.today)} today`)}
      </dl></div>
      <div class="content-card"><h2>Next rounds</h2><dl class="facts-table">
        ${factRow("Next fetch", f.next_run ? `${fmtTime(f.next_run)} · ${UI.esc(inMin(f.next_run))}` : "—")}
        ${factRow("Next Gemini", g.next_run ? `${fmtTime(g.next_run)} · ${UI.esc(inMin(g.next_run))}` : "—")}
        ${factRow("Next publish", p.next_run ? `${fmtTime(p.next_run)} · ${UI.esc(inMin(p.next_run))}` : "—")}
      </dl></div>
      ${catRows ? `<div class="content-card"><h2>Stories queued per category</h2><div class="table-scroll"><table class="data"><thead><tr><th>Category</th><th>Stories</th></tr></thead><tbody>${catRows}</tbody></table></div></div>` : ""}
    </section>`;
  };

  /* ================= (b) POSTS ================= */
  const renderPosts = () => {
    const host = document.getElementById("statsPosts");
    const arts = Object.values(window.FA_ARTICLES || {});
    const titles = Object.values(window.FA_PUBLISHED || {});
    const perPost = (traffic && traffic.connected && traffic.per_post) || {};
    const artCats = (pipe && pipe.posts && pipe.posts.article_categories) || {};
    const rows = [];
    for (const a of arts) {
      const path = `/news-item?id=${encodeURIComponent(a.id)}`;
      rows.push({ path, title: a.headline || a.id, type: "News", cat: artCats[a.id] ? catLabel(artCats[a.id]) : "News", date: a.published, views: perPost[path] });
    }
    for (const t of titles) {
      const kind = (t.type || "movie") === "tv" ? "show" : "movie";
      const path = `/${kind}?id=${encodeURIComponent(t.id)}`;
      const cat = (t.categories && t.categories.length) ? t.categories.map(catLabel).join(", ") : (t.industry ? catLabel(t.industry) : "—");
      rows.push({ path, title: UI.titleOf(t), type: (t.type || "movie") === "tv" ? "TV show" : "Movie", cat, date: t.published_at || t.release_date || t.first_air_date, views: perPost[path] });
    }
    rows.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    const connected = !!(traffic && traffic.connected);
    const body = rows.map((r) => `<tr><td><a href="${UI.esc(r.path)}">${UI.esc(r.title)}</a></td><td>${UI.esc(r.type)}</td><td>${UI.esc(r.cat)}</td><td>${fmtDay(r.date)}</td><td><b>${r.views ? num(r.views.views) : "—"}</b></td><td>${r.views && r.views.top_source ? UI.esc(r.views.top_source) : "—"}</td></tr>`).join("");
    host.innerHTML = `<section class="section"><div class="section-head"><h2>Posts (${rows.length})</h2></div>
      <p class="sec-sub">Every published post, newest first. Views are last-7-day pageviews from Google Analytics${connected ? "" : " — not connected yet, so views show “—”"}.</p>
      ${rows.length ? `<div class="content-card"><div class="table-scroll"><table class="data"><thead><tr><th>Post</th><th>Type</th><th>Category</th><th>Published</th><th>Views</th><th>Top source</th></tr></thead><tbody>${body}</tbody></table></div></div>`
        : `<div class="content-card"><p class="state-msg">No posts published yet.</p></div>`}
    </section>`;
  };

  /* ================= (c) TRAFFIC (LIVE) ================= */
  const renderTraffic = () => {
    const host = document.getElementById("statsTraffic");
    if (!traffic || !traffic.connected) {
      host.innerHTML = `<section class="section"><div class="section-head"><h2>Traffic — live</h2></div>
        <div class="content-card"><h2>Analytics not connected yet</h2>
        <p>Live users, views per post, sources, countries and devices need Google Analytics 4. Nothing is being measured right now — this section shows real numbers only after GA4 is connected.</p>
        ${traffic && traffic.error ? `<p class="prov-note">Last error: ${UI.esc(traffic.error)}</p>` : ""}
        <p class="prov-note">Setup takes about 10 minutes: create the GA4 property, add the tracking snippet, create a service account and add its two secrets to the repo. The full steps are in the repo's ga4-setup guide.</p></div></section>`;
      return;
    }
    const t = traffic.today || {}, l = traffic.last7 || {}, rt = traffic.realtime || {};
    const pageRows = (traffic.top_pages || []).map((p) => `<tr><td><a href="${UI.esc(p.path)}">${UI.esc(p.title || p.path)}</a></td><td><b>${num(p.views)}</b></td><td>${dur(p.avg_time_seconds)}</td></tr>`).join("");
    const srcRows = (traffic.sources || []).map((s) => `<tr><td>${UI.esc(s.source)}</td><td>${UI.esc(s.medium || "")}</td><td><b>${num(s.sessions)}</b></td><td>${num(s.users)}</td></tr>`).join("");
    const cRows = (traffic.countries || []).map((c) => `<tr><td>${UI.esc(c.country)}</td><td><b>${num(c.users)}</b></td></tr>`).join("");
    const dRows = (traffic.devices || []).map((d) => `<tr><td>${UI.esc(d.device)}</td><td><b>${num(d.users)}</b></td></tr>`).join("");
    host.innerHTML = `<section class="section"><div class="section-head"><h2>Traffic — live</h2></div>
      <p class="sec-sub">Google Analytics 4 · updated ${fmtTime(traffic.generated)} · “Avg. time” is the average session length for visits that viewed the page.</p>
      <div class="content-card"><h2>Right now &amp; totals</h2><dl class="facts-table">
        ${factRow("Users active now", `<b style="font-size:1.3rem">${num(rt.active_users)}</b>`)}
        ${factRow("Today", `${num(t.users)} users · ${num(t.pageviews)} pageviews · ${num(t.sessions)} sessions · avg. session ${dur(t.avg_session_seconds)}`)}
        ${factRow("Last 7 days", `${num(l.users)} users · ${num(l.pageviews)} pageviews · ${num(l.sessions)} sessions · avg. session ${dur(l.avg_session_seconds)}`)}
      </dl></div>
      ${pageRows ? `<div class="content-card"><h2>Top pages (7 days)</h2><div class="table-scroll"><table class="data"><thead><tr><th>Page</th><th>Views</th><th>Avg. time</th></tr></thead><tbody>${pageRows}</tbody></table></div></div>` : ""}
      ${srcRows ? `<div class="content-card"><h2>Where visitors come from (7 days)</h2><div class="table-scroll"><table class="data"><thead><tr><th>Source</th><th>Medium</th><th>Sessions</th><th>Users</th></tr></thead><tbody>${srcRows}</tbody></table></div></div>` : ""}
      ${cRows || dRows ? `<div class="content-card"><h2>Countries &amp; devices (7 days)</h2>
        ${cRows ? `<div class="table-scroll"><table class="data"><thead><tr><th>Country</th><th>Users</th></tr></thead><tbody>${cRows}</tbody></table></div>` : ""}
        ${dRows ? `<div class="table-scroll"><table class="data"><thead><tr><th>Device</th><th>Users</th></tr></thead><tbody>${dRows}</tbody></table></div>` : ""}
      </div>` : ""}
    </section>`;
  };

  /* ================= (d) SITE HEALTH / ALERTS ================= */
  const renderHealth = () => {
    const host = document.getElementById("statsHealth");
    const h = health || {};
    const dep = h.deploy || {}, pl = h.pipeline || {}, dm = h.dmca || {}, sc = h.search_console || {};
    const depCell = dep.status === "not checked"
      ? `${chip("not checked")}<br><span class="prov-note">${UI.esc(dep.detail || "Not checked yet")}</span>`
      : `${chip(dep.status)} ${dep.time ? fmtTime(dep.time) : ""}${dep.url ? ` · <a href="https://${UI.esc(dep.url)}" target="_blank" rel="noopener">${UI.esc(dep.url)}</a>` : ""}${dep.commit ? `<br><span class="prov-note">Commit ${UI.esc(String(dep.commit).slice(0, 7))}${dep.target ? ` · ${UI.esc(dep.target)}` : ""}</span>` : ""}`;
    const pipeCell = pl.status === "unknown" && !health
      ? `${chip("not checked")}<br><span class="prov-note">Not checked yet</span>`
      : `${chip(pl.status)}<br><span class="prov-note">Fetch ${UI.esc(pl.fetch || "—")} · Gemini ${UI.esc(pl.gemini || "—")} · Publish ${UI.esc(pl.publish || "—")}</span>`;
    host.innerHTML = `<section class="section"><div class="section-head"><h2>Site health &amp; alerts</h2></div>
      <p class="sec-sub">What would silently break the site — checked ${health ? fmtTime(health.generated) : "never yet"}. Anything not actually checked says so; nothing here is a fake OK.</p>
      <div class="content-card"><div class="table-scroll"><table class="data"><thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead><tbody>
        <tr><td><b>Last deploy</b></td><td>${depCell}</td><td>${dep.status === "not checked" ? "" : UI.esc(dep.detail || "")}</td></tr>
        <tr><td><b>Pipeline</b></td><td>${pipeCell}</td><td>Roll-up of the hourly pipeline stats above.</td></tr>
        <tr><td><b>DMCA / copyright inbox</b></td><td>${chip(dm.status)}</td><td>${UI.esc(dm.detail || "Not checked yet")}</td></tr>
        <tr><td><b>Search Console</b></td><td>${chip(sc.status)}</td><td>${UI.esc(sc.detail || "Not checked yet")}${sc.indexed_pages != null ? ` · ${num(sc.indexed_pages)} pages indexed` : ""}</td></tr>
      </tbody></table></div></div>
    </section>`;
  };

  renderPipeline();
  renderPosts();
  renderTraffic();
  renderHealth();
})();
