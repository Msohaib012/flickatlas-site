/* FlickAtlas — Person detail page (?id=<tmdb_person_id>): photo,
   biography, birth details and top movie + TV credits.
   Rewritten 2026-10-25 (published-only rebuild, §3): biography and
   facts still come from the TMDB person record (a single person's
   record, not a catalogue), but the credits show ONLY published
   titles — each credit is kept only when its TMDB id is in
   window.FA_PUBLISHED with a matching medium. Unpublished work never
   appears. No watch/download buttons, no external links. */
(async function () {
  UI.mountChrome("/person");
  const main = document.getElementById("app");
  const id = UI.getParam("id", "");
  if (!id || !/^\d+$/.test(id)) {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("Person not found.", false)}
      <p style="text-align:center"><a class="btn btn-teal" href="/celebrities">Browse Celebrities</a></p></div>`;
    UI.setSEO({ title: "Person Not Found | FlickAtlas", desc: "This celebrity profile could not be found. Browse celebrities on FlickAtlas.", path: "/person", noindex: true });
    return;
  }
  UI.setSEO({
    title: "Celebrity Profile — Biography, Photos & Filmography | FlickAtlas",
    desc: "Celebrity biography on FlickAtlas: photos, birth details, known-for titles and a complete filmography.",
    path: `/person?id=${encodeURIComponent(id)}`
  });
  main.innerHTML = `<div class="wrap"><div class="sk" style="height:320px;border-radius:22px;margin-top:22px"></div><div class="sk" style="height:180px;border-radius:14px;margin-top:18px"></div></div>`;

  try {
    const [p, credits] = await Promise.all([
      TMDB.api(`/person/${id}`),
      TMDB.personCredits(id).catch(() => null),
    ]);
    if (!p || !p.name) throw new Error("TMDB_HTTP_404");
    const name = p.name;
    const photo = UI.img(p.profile_path, "w342");
    const dept = p.known_for_department || "";
    const bioParas = String(p.biography || "").trim()
      ? String(p.biography).split(/\n+/).map(s => s.trim()).filter(Boolean) : [];

    /* Published credits only: a credit renders only when its TMDB id
       is in FA_PUBLISHED and the published entry's type matches the
       credit's medium. Cards render from the published entry itself
       (correct type, title and poster); newest first, 12 per medium. */
    const PUBLISHED = window.FA_PUBLISHED || {};
    const seen = new Map();
    for (const c of ((credits && credits.cast) || [])) {
      /* The published entry supplies the poster (posterCard falls back
         to initials when it has none), so a credit must not be dropped
         just because the credit record itself carries no poster_path. */
      if (!c || !(c.title || c.name)) continue;
      const pub = PUBLISHED[String(c.id)];
      if (!pub || pub.type !== c.media_type) continue;
      const k = (c.media_type || "") + ":" + c.id;
      if (!seen.has(k)) seen.set(k, pub);
    }
    const newestFirst = (a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")) ||
      ((b.type === "tv" ? b.first_air_date : b.release_date) || "").localeCompare((a.type === "tv" ? a.first_air_date : a.release_date) || "");
    const movies = [...seen.values()].filter(x => x.type === "movie").sort(newestFirst).slice(0, 12);
    const shows = [...seen.values()].filter(x => x.type === "tv").sort(newestFirst).slice(0, 12);

    const born = p.birthday ? UI.fmtDate(p.birthday) : "";
    const factRows = [];
    if (born) factRows.push(["Born", UI.esc(born + (p.place_of_birth ? ` · ${p.place_of_birth}` : ""))]);
    if (p.deathday) factRows.push(["Died", UI.esc(UI.fmtDate(p.deathday))]);
    if (dept) factRows.push(["Known For", UI.esc(dept)]);
    if (p.popularity) factRows.push(["Popularity", UI.esc(String(Math.round(p.popularity * 10) / 10))]);
    if ((p.also_known_as || []).length) factRows.push(["Also Known As", UI.esc(p.also_known_as.slice(0, 5).join(", "))]);

    const heroFacts = [];
    if (born) heroFacts.push(`<div><span>Born</span><b>${UI.esc(born)}</b></div>`);
    if (p.place_of_birth) heroFacts.push(`<div><span>Birthplace</span><b>${UI.esc(p.place_of_birth)}</b></div>`);
    if (dept) heroFacts.push(`<div><span>Known For</span><b>${UI.esc(dept)}</b></div>`);
    if (p.popularity) heroFacts.push(`<div><span>Popularity</span><b>${UI.esc(String(Math.round(p.popularity * 10) / 10))}</b></div>`);

    /* Biography: show the first ~500 characters, the rest behind a
       Show More toggle (UI.toggleMore + .more-wrap). */
    let bioHtml = "";
    if (bioParas.length) {
      const visible = [], hidden = [];
      let len = 0;
      for (const para of bioParas) {
        if (len < 500) { visible.push(para); len += para.length; }
        else hidden.push(para);
      }
      bioHtml = `<div class="content-card"><h2>Biography</h2>
        ${visible.map(t => `<p class="article-summary">${UI.esc(t)}</p>`).join("")}
        ${hidden.length ? `<div class="more-wrap" id="bioMore">${hidden.map(t => `<p class="article-summary">${UI.esc(t)}</p>`).join("")}</div>
        <button type="button" class="btn more-btn" data-target="bioMore" data-more="Show More" data-less="Show Less" onclick="UI.toggleMore(this)">Show More</button>` : ""}
      </div>`;
    }

    main.innerHTML = `<div class="wrap">
    <p class="article-crumb"><a href="/celebrities">← Celebrities</a></p>
    <section class="detail-hero">
      <div class="detail-in">
        ${photo ? `<div class="detail-poster"><img src="${photo}" alt="${UI.esc(name)} photo" loading="lazy" decoding="async" onerror="this.remove()"></div>` : ""}
        <div class="detail-main">
          <h1>${UI.esc(name)}</h1>
          ${dept ? `<p class="detail-sub">${UI.esc(dept)}</p>` : ""}
          ${heroFacts.length ? `<div class="detail-facts">${heroFacts.join("")}</div>` : ""}
        </div>
      </div>
    </section>

    ${bioHtml}

    ${factRows.length ? `<div class="content-card"><h2>Profile Details</h2>
      <dl class="facts-table">${factRows.map(([k, v]) => `<div class="fact-row"><dt>${UI.esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl></div>` : ""}

    ${movies.length ? `<section class="section"><div class="section-head"><h2>Top Movies</h2></div>
      <div class="grid">${movies.map(x => UI.posterCard(x, "movie", UI.industryTag(x))).join("")}</div></section>` : ""}

    ${shows.length ? `<section class="section"><div class="section-head"><h2>Top TV Shows</h2></div>
      <div class="grid">${shows.map(x => UI.posterCard(x, "tv", UI.industryTag(x))).join("")}</div></section>` : ""}

    ${!movies.length && !shows.length ? `<p style="color:var(--muted)">No published movie or TV titles are listed for this person yet.</p>` : ""}
  </div>`;

    UI.setSEO({
      title: `${name} — Biography, Filmography & Known-For Titles | FlickAtlas`,
      desc: (bioParas[0] || `${name} — biography and filmography on FlickAtlas.`).slice(0, 160),
      path: `/person?id=${encodeURIComponent(id)}`,
      type: "profile",
      image: photo || "",
      jsonld: {
        "@context": "https://schema.org", "@type": "Person",
        "name": name,
        "url": `https://flickatlas.vercel.app/person?id=${encodeURIComponent(id)}`,
        ...(photo ? { "image": photo } : {}),
        ...(p.birthday ? { "birthDate": p.birthday } : {}),
        ...(p.place_of_birth ? { "birthPlace": p.place_of_birth } : {}),
        ...(p.deathday ? { "deathDate": p.deathday } : {}),
        ...(dept ? { "jobTitle": dept } : {}),
      }
    });
  } catch (e) {
    const is404 = /404/.test(String((e && e.message) || e || ""));
    main.innerHTML = `<div class="wrap">${is404
      ? UI.stateMsg("Person not found.", false)
      : UI.stateMsg("Could not load this person. Please try again.")}</div>`;
    if (is404) UI.setSEO({ title: "Person Not Found | FlickAtlas", desc: "This celebrity profile could not be found on FlickAtlas.", path: "/person", noindex: true });
  }
})();
