/* FlickAtlas — Celebrities hub: people browse with a .fa-select in-page
   dropdown (All · Bollywood · World Cinema · Pakistani · Actors ·
   Actresses · Directors) + a sampled Star Power comparison — never a
   native <select> popup. PUBLISHED-ONLY: the people
   pool comes from published titles only — one credits call per published
   title (single-title, same as the detail pages) plus the fresh
   FA_CELEBRITY_TODAY feed. Never a live people catalogue (no popularPeople,
   no discover, no Korean filter). Star Power compares recorded FlickAtlas
   collections for published titles only — no live revenue, no unpublished
   links. Birthdays use single-entity TMDB.person lookups for pool people
   only (same as the person page). */
(async function () {
  UI.mountChrome("/celebrities");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Celebrities — Actor Biographies, Photos & Filmographies | FlickAtlas",
    desc: "Meet the celebrities of FlickAtlas published titles. Open a profile for biography, photos, known-for titles and the complete filmography.",
    path: "/celebrities"
  });

  const FILTERS = [["all", "All"], ["bollywood", "Bollywood"], ["world", "World Cinema"],
    ["pakistani", "Pakistani"], ["actors", "Actors"],
    ["actresses", "Actresses"], ["directors", "Directors"]];
  let f = UI.getParam("f", "all");
  if (!FILTERS.some(([k]) => k === f)) f = "all";

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Celebrities</h1>
      <p>Celebrity profiles with biographies, photos and screen credits.</p></div>
    <div id="bdayHost"></div>
    <div id="chipHost"><div class="listing-select-row listing-select-row--single">
      <div class="filter-select" role="group" aria-labelledby="celSelectLabel"><span class="filter-select-label" id="celSelectLabel">Filter</span><div class="fa-select"><button type="button" class="fa-select-trigger" id="celTrigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="celOptions" aria-labelledby="celSelectLabel celValue"><span class="fa-select-value" id="celValue"></span><span class="fa-select-chevron" aria-hidden="true"></span></button><div class="fa-select-menu" id="celOptions" role="listbox" aria-labelledby="celSelectLabel" hidden></div></div></div>
    </div></div>
    <p class="fcount" id="fcount"></p>
    <div class="people-grid" id="grid">${UI.skelCards(12)}</div>
    <div id="emptyHost"></div>
    <div id="spWrap"></div>
  </div>`;
  const grid = main.querySelector("#grid");
  const fcount = main.querySelector("#fcount");
  const emptyHost = main.querySelector("#emptyHost");
  const spWrap = main.querySelector("#spWrap");

  /* Industry of a published title — canonical UI.industryOf() (owner
     order 2026-10-28): Bollywood = ALL Indian titles, World Cinema =
     only international. A person's _inds follow their titles, so a
     Tamil/Telugu star now counts as Bollywood, not World. */
  const indOf = t => UI.industryOf(t);

  let pool = [];
  function render() {
    const items = pool.filter(p => {
      if (["bollywood", "world", "pakistani"].includes(f)) return (p._inds || []).includes(f);
      if (f === "actors") return p.gender === 2 && p.known_for_department === "Acting";
      if (f === "actresses") return p.gender === 1 && p.known_for_department === "Acting";
      if (f === "directors") return p.known_for_department === "Directing";
      return true;
    });
    grid.innerHTML = items.map(p => `<div class="fcell" data-fitem>${UI.personCard(p, p.known_for_department || "")}</div>`).join("");
    fcount.textContent = items.length ? `${items.length} celebrit${items.length === 1 ? "y" : "ies"}` : "";
    emptyHost.innerHTML = items.length ? "" : UI.stateMsg("No celebrities match this filter among published titles yet.", false);
  }
  const celDd = UI.mountFaSelect(main.querySelector("#chipHost .filter-select"),
    FILTERS.map(([value, label]) => ({ value, label })),
    f, (v) => { f = v; UI.setParam("f", f === "all" ? "" : f); render(); });
  window.addEventListener("popstate", () => {
    f = UI.getParam("f", "all");
    if (!FILTERS.some(([k]) => k === f)) f = "all";
    celDd.setValue(f);
    render();
  });

  /* ---------- Star Power: recorded FlickAtlas collections, published titles only ----------
     A star's total is the sum of the recorded day-wise collections of the
     published titles they are credited in; the top title is the published
     title with the highest recorded sum. No live TMDB calls, no unpublished links. */
  function starPower(people) {
    const dw = window.FA_DAYWISE || {};
    const sum = rows => (rows || []).reduce((a, r) => a + (r.collection || 0), 0);
    const rows = [];
    for (const p of people.slice(0, 8)) {
      const films = (p._titles || []).map(t => ({ title: t, total: sum(dw[String(t.id)]) }))
        .filter(x => x.total > 0);
      if (!films.length) continue;
      films.sort((a, b) => b.total - a.total);
      rows.push({ p, total: films.reduce((a, x) => a + x.total, 0), biggest: films[0], count: films.length });
    }
    rows.sort((a, b) => b.total - a.total);
    if (!rows.length) return;
    spWrap.innerHTML = `<section class="section"><div class="section-head"><h2>Star Power — Recorded Collections</h2></div>
      <div class="content-card" style="margin:0"><div class="table-scroll"><table class="data">
      <thead><tr><th>#</th><th></th><th>Star</th><th>Combined Recorded Collections — Published Titles</th><th>Top Published Title</th></tr></thead>
      <tbody>${rows.map((rw, i) => `<tr>
        <td class="rank">${i + 1}</td>
        <td><a href="/person?id=${rw.p.id}"><img class="sp-photo" src="${UI.img(rw.p.profile_path, "w185")}" alt="" loading="lazy" onerror="this.remove()"></a></td>
        <td><a href="/person?id=${rw.p.id}"><b>${UI.esc(rw.p.name)}</b></a></td>
        <td><b>${UI.fmtMoney(rw.total)}</b> <span class="muted">(${rw.count} published title${rw.count === 1 ? "" : "s"})</span></td>
        <td><a href="/${rw.biggest.title.type === "tv" ? "show" : "movie"}?id=${rw.biggest.title.id}">${UI.esc(UI.titleOf(rw.biggest.title))}</a> (${UI.fmtMoney(rw.biggest.total)})</td></tr>`).join("")}
      </tbody></table></div>
      <p class="prov-note">Recorded day-wise collections on FlickAtlas among published titles only. It is not a worldwide gross ranking; figures cover only the days recorded here.</p></div></section>`;
  }

  /* Birthdays are drawn only from the current pool, and exclude deceased or future-dated records.
     Single-entity TMDB.person lookups for pool people only — never a people catalogue. */
  async function birthdaysToday(poolPeople) {
    const host = document.getElementById("bdayHost");
    if (!host) return;
    const today = TMDB.today(), md = today.slice(5), yearNow = Number(today.slice(0, 4));
    const found = [], queue = poolPeople.filter(p => p.profile_path);
    for (let i = 0; i < queue.length; i += 12) {
      const chunk = queue.slice(i, i + 12);
      const dets = await Promise.all(chunk.map(p => TMDB.person(p.id).catch(() => null)));
      dets.forEach((d, j) => {
        if (d && !d.deathday && d.birthday && d.birthday <= today && d.birthday.slice(5) === md)
          found.push({ p: chunk[j], born: d.birthday, age: yearNow - Number(d.birthday.slice(0, 4)) });
      });
      if (found.length >= 6) break;
    }
    if (!found.length) return;
    host.innerHTML = `<section class="section" style="margin-top:22px">
      <div class="section-head"><h2>Celebrity Birthdays Today</h2></div>
      <div class="people-row">${found.map(({ p, born, age }) => UI.personCard(p, `Turns ${age} today · Born ${UI.fmtDate(born)}`)).join("")}</div>
    </section>`;
  }

  /* People come only from published titles: one credits call per published
     title (single-title, same as the detail pages), plus fresh feed people
     from FA_CELEBRITY_TODAY (same <24h freshness rule as UI.celebTodaySection). */
  async function buildPool() {
    const pub = window.FA_PUBLISHED || {};
    const titles = Object.values(pub).filter(t => t && t.id);
    const byId = new Map();
    const addPerson = (person, ind, title) => {
      if (!person || !person.id || !person.name) return;
      let p = byId.get(person.id);
      if (!p) {
        p = { id: person.id, name: person.name, profile_path: person.profile_path || null,
          gender: person.gender, known_for_department: person.known_for_department || (person.job ? "Directing" : "Acting"),
          _inds: [], _titles: [] };
        byId.set(person.id, p);
      }
      if (ind && !p._inds.includes(ind)) p._inds.push(ind);
      if (title && !p._titles.some(t => t.id === title.id)) p._titles.push(title);
      if (person.job === "Director") p.known_for_department = "Directing";
    };
    const jobs = titles.map(async t => {
      try {
        const credits = await TMDB.api(`/${t.type === "tv" ? "tv" : "movie"}/${t.id}/credits`);
        if (!credits) return;
        const ind = indOf(t);
        [...(credits.cast || []), ...(credits.crew || [])].forEach(person => addPerson(person, ind, t));
      } catch (e) { /* one title's credits failing must not break the hub */ }
    });
    await Promise.all(jobs);
    const feed = window.FA_CELEBRITY_TODAY || {};
    const now = Date.now();
    (feed.items || []).forEach(it => {
      if (!it || !it.celebrity || !it.tmdb_person_id || !it.when) return;
      const when = Date.parse(it.when);
      if (isNaN(when) || when > now + 3600 * 1000 || (now - when) >= 24 * 3600 * 1000) return;
      addPerson({ id: it.tmdb_person_id, name: it.celebrity }, null, null);
    });
    return [...byId.values()];
  }

  try {
    pool = await buildPool();
    render();
    starPower(pool);
    birthdaysToday(pool.slice(0, 60));
  } catch (e) {
    grid.innerHTML = UI.stateMsg("Could not load celebrities. Please try again.");
  }
})();


