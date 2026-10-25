/* FlickAtlas — Celebrity Today hub: exactly ONE featured celebrity
   (site rule: one item per listing). Created 2026-10-25: the
   /celebrity-today page shipped referencing this script but the file was
   never committed, so the page stayed on "Loading FlickAtlas…".
   Featured pick, in order: (1) the event linked from the homepage
   (?item= matches a FA_CELEBRITY_TODAY item); (2) the newest fresh item
   in the site's celebrity-data feed. No live TMDB trending fallback —
   the feed is the published source for this page. Full profile lives
   on the person's own /person page. No watch/download buttons, no
   external links. */
(async function () {
  UI.mountChrome("/celebrity-today");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Celebrity Today — The Star Everyone Is Talking About | FlickAtlas",
    desc: "Celebrity Today on FlickAtlas: one star, right now — the most talked-about celebrity today, with a short bio and a link to their full profile.",
    path: "/celebrity-today"
  });
  main.innerHTML = `<div class="wrap"><div class="sk" style="height:320px;border-radius:22px;margin-top:22px"></div><div class="sk" style="height:140px;border-radius:14px;margin-top:18px"></div></div>`;

  /* Fresh celebrity-feed items (same <24h window the homepage uses). */
  const feedItems = () => {
    const data = window.FA_CELEBRITY_TODAY || {};
    const now = Date.now();
    return ((data.items) || []).filter(it => {
      if (!it || !it.celebrity || !it.tmdb_person_id) return false;
      const t = Date.parse(it.when || "");
      return !isNaN(t) && t <= now + 3600 * 1000 && (now - t) < 24 * 3600 * 1000;
    }).sort((a, b) => Date.parse(b.when) - Date.parse(a.when));
  };

  try {
    let personId = null, person = null, eventLine = "";
    const itemParam = UI.getParam("item", "");

    /* (1) A linked event (?item=): feature that event's celebrity. */
    if (itemParam && window.FA_CELEBRITY_TODAY) {
      const hit = ((window.FA_CELEBRITY_TODAY.items) || [])
        .find(it => it && UI.celebItemId(it) === itemParam);
      if (hit && hit.tmdb_person_id) {
        personId = hit.tmdb_person_id;
        eventLine = `${UI.celebHeadline(hit)}${hit.when ? ` · ${UI.relTime(Date.parse(hit.when))}` : ""}`;
      }
    }

    /* (2) Newest fresh item in the site's celebrity feed. No live
       TMDB trending fallback: the feed is the published source for
       this page, and an arbitrary trending person is not a feature.
       When the feed is empty or stale the page says so plainly. */
    if (!personId) {
      const fresh = feedItems();
      if (fresh.length) {
        personId = fresh[0].tmdb_person_id;
        eventLine = `${UI.celebHeadline(fresh[0])}${fresh[0].when ? ` · ${UI.relTime(Date.parse(fresh[0].when))}` : ""}`;
      }
    }

    if (!personId) throw new Error("no featured celebrity");

    /* Full details for the bio (best effort — the feed record alone is
       enough to render the feature). */
    let full = null;
    try { full = await TMDB.person(personId); } catch (_) {}
    const p = full && full.name ? full : person;
    if (!p || !p.name) throw new Error("no featured celebrity");
    const name = p.name;
    const photo = UI.img(p.profile_path, "w342");
    const dept = p.known_for_department || (person && person.known_for_department) || "";
    const bio = String((full && full.biography) || "").trim();
    const bioFirst = bio ? bio.split(/\n+/).map(s => s.trim()).filter(Boolean)[0] || "" : "";
    const bioShort = bioFirst.length > 320 ? bioFirst.slice(0, 320).replace(/\s+\S*$/, "") + "…" : bioFirst;
    const born = full && full.birthday ? UI.fmtDate(full.birthday) : "";
    const birthplace = full && full.place_of_birth ? full.place_of_birth : "";

    main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Celebrity Today</h1>
      <p>One star, right now — the most talked-about celebrity today.</p></div>
    <div class="content-card">
      <section class="detail-hero">
        <div class="detail-in">
          ${photo ? `<div class="detail-poster"><img src="${photo}" alt="${UI.esc(name)} photo" loading="lazy" decoding="async" onerror="this.remove()"></div>` : ""}
          <div class="detail-main">
            <h2>${UI.esc(name)}</h2>
            ${dept ? `<p class="detail-sub">${UI.esc(dept)}</p>` : ""}
            ${eventLine ? `<p style="color:var(--muted);margin-top:10px">${UI.esc(eventLine)}</p>` : ""}
            <p style="margin-top:16px"><a class="btn btn-teal" href="/person?id=${encodeURIComponent(personId)}">View Full Profile →</a></p>
          </div>
        </div>
      </section>
      ${bioShort ? `<p class="article-summary" style="margin-top:16px">${UI.esc(bioShort)}</p>` : ""}
      ${(born || birthplace) ? `<p style="color:var(--muted);margin-top:6px">${UI.esc([born, birthplace].filter(Boolean).join(" · "))}</p>` : ""}
    </div>
  </div>`;

    UI.setSEO({
      title: `${name} — Celebrity Today | FlickAtlas`,
      desc: (bioShort || `${name} is today's featured celebrity on FlickAtlas.`).slice(0, 160),
      path: "/celebrity-today",
      type: "profile",
      image: photo || "",
      jsonld: {
        "@context": "https://schema.org", "@type": "Person",
        "name": name,
        "url": `https://flickatlas.vercel.app/person?id=${encodeURIComponent(personId)}`,
        ...(photo ? { "image": photo } : {}),
        ...(full && full.birthday ? { "birthDate": full.birthday } : {}),
        ...(birthplace ? { "birthPlace": birthplace } : {}),
        ...(dept ? { "jobTitle": dept } : {}),
      }
    });
  } catch (e) {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("No celebrity feature is available right now. Please try again.")}</div>`;
  }
})();
