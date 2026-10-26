/* FlickAtlas — News article page (MASTER §6.6, Sacnilk pattern): every
   feed headline opens OUR OWN article page. The page is SELF-CONTAINED
   (user rule, correction round): NO outbound source links anywhere — the
   detail lives here. Articles follow the §6.6 contract
   { id, type, headline, dek, body: [{h, p[]}], facts, published }:
   engine-written articles (window.FA_ARTICLES, when the data engine
   ships them) render in full; until then BRIEF MODE composes the same
   shape from the feed item (headline + feed summary + facts), in our
   layout, with related posts and a more-headlines rail. */
(async function () {
  UI.mountChrome("/news");
  const main = document.getElementById("app");
  const id = UI.pageQuery().get("id") || "";
  if (!id) {
    main.innerHTML = `<div class="wrap">${UI.stateMsg("Invalid news story link.", false)}
      <p style="text-align:center"><a class="btn btn-teal" href="/news">Open Trending News</a></p></div>`;
    UI.setSEO({ title: "Invalid News Story Link | FlickAtlas", desc: "Open the News hub to browse current entertainment headlines.", path: "/news-item", noindex: true });
    return;
  }
  main.innerHTML = `<div class="wrap"><div class="sk" style="height:200px;border-radius:14px;margin-top:26px"></div></div>`;

  const CATLABEL = { bollywood: "Bollywood", international: "International", pakistan: "Pakistan", celebrity: "Celebrity", viral: "Viral" };
  const newsRow = (it) => `
    <a class="news-item" href="${UI.newsItemPath(it)}">
      <span class="news-txt"><b>${UI.esc(it.title)}</b>
      <span>${it.ts ? UI.relTime(it.ts) : ""}</span></span>
    </a>`;

  /* A published article (FA_ARTICLES) is the first source of truth:
     it must render even after the story has rolled off the live feed.
     The feed is only needed for the "More Headlines" rail and for
     brief-mode items, so a failed feed no longer kills a published
     article. */
  const fullArt = (window.FA_ARTICLES || {})[id] || null;

  let items = [];
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 9000);
    const r = await fetch("/api/news", { signal: ctl.signal });
    clearTimeout(to);
    if (!r.ok) throw new Error("news http " + r.status);
    const j = await r.json();
    items = j.items || [];
  } catch (e) {
    if (!fullArt) {
      main.innerHTML = `<div class="wrap">${UI.stateMsg("Could not load the news feed right now. Please try again.")}
      <p style="text-align:center"><a class="btn btn-teal" href="/news">Open Trending News</a></p></div>`;
      return;
    }
    items = [];
  }

  let it = items.find(x => UI.newsId(x) === id);
  if (!it && fullArt) {
    /* Published article, no longer in the live feed window — render it
       from the article itself (headline + publish date, no feed
       categories). The "More Headlines" rail below is empty. */
    it = { id, title: fullArt.headline, ts: fullArt.published || null, cats: [] };
  }
  if (!it) {
    /* The story has rolled off the live feed window — still a real page:
       say so plainly and hand over the current headlines. */
    main.innerHTML = `<div class="wrap">
      <p class="article-crumb"><a href="/news">← Trending News</a></p>
      <div class="article-head"><h1>This story has moved on</h1></div>
      <p style="color:var(--muted);max-width:65ch">News pages on FlickAtlas are built from the live
      entertainment feeds, and this headline is no longer in the current feed window. Here are the
      latest headlines instead:</p>
      <section class="section"><div class="news-list">${items.slice(0, 8).map(newsRow).join("")}</div></section>
    </div>`;
    UI.setSEO({ title: "Story no longer in the live feed | FlickAtlas", desc: "This headline has rolled off the live news feed. See the latest entertainment headlines on FlickAtlas.", path: "/news" });
    return;
  }

  const isBollywood = (it.cats || []).some(c => String(c).toLowerCase() === "bollywood");
  if (isBollywood) UI.setIndustryContext("bollywood");
  const headline = String(it.title || "");
  const when = it.ts && Number.isFinite(new Date(it.ts).getTime()) ? new Date(it.ts) : null;
  const whenText = when ? `${UI.fmtDate(when.toISOString().slice(0, 10))} · ${UI.relTime(it.ts)}` : "";
  const catChips = (it.cats || []).map(c =>
    `<a class="kw-chip" href="/news?f=${encodeURIComponent(c)}">${UI.esc(CATLABEL[c] || c)}</a>`).join("");

  /* ---------- Article (contract §6.6): full engine article if one
     exists for this id, else BRIEF MODE. (fullArt was resolved at the
     top, before the feed fetch, so a published article renders even
     when the story has rolled off the live feed.) ORIGINALITY DOCTRINE
     (correction 10): every word on this page is our own writing — brief
     mode composes its text from FACTS only (the headline's factual core,
     the story's category and date, and structured facts about the
     connected titles and people). Feed summary text is data-only and is
     NEVER rendered. */

  /* Entity resolution (fix round 2, Bug C): one search on the raw
     headline almost never resolves anything — headlines are sentences.
     Resolution now tries, in order: the headline's quoted title, its
     first segment, and its first six words (TMDB multi-search), keeping
     only titles whose name genuinely overlaps the headline; then, if no
     person surfaced, the headline's Capitalized name sequences go to
     TMDB person search and must match exactly. Only validated entities
     reach the article + related rail. */
  let relatedHtml = "";
  let relTitles = [], relPeople = [];
  try {
    const headline = String(it.title || "").replace(/\s+/g, " ").trim();
    const quoted = (headline.match(/['"“]([^'"”]{3,60})['"”]/) || [])[1] || "";
    const sig = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4);
    const headToks = new Set(sig(headline));
    const titleFits = (x) => {
      const tt = sig(x.title || x.name);
      if (!tt.length) return false;
      const hit = tt.filter(w => headToks.has(w)).length;
      return hit / tt.length >= 0.5;
    };
    const seenT = new Set(), seenP = new Set();
    /* Name matching is punctuation-insensitive: TMDB writes
       "Ahn Hyo-seop" where headlines write "Ahn Hyo Seop". */
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const headNorm = norm(headline);
    const takeMulti = (res) => {
      for (const x of res || []) {
        if ((x.media_type === "movie" || x.media_type === "tv") && x.poster_path && !seenT.has(x.id) && titleFits(x)) {
          seenT.add(x.id); relTitles.push(x);
        } else if (x.media_type === "person" && x.profile_path && !seenP.has(x.id) &&
          norm(x.name).length >= 4 && headNorm.includes(norm(x.name))) {
          seenP.add(x.id); relPeople.push(x);
        }
      }
    };
    const firstSeg = headline.split(/\s[:|]\s|\s—\s|\s–\s/)[0].trim();
    const queries = [];
    if (quoted) queries.push(quoted);
    if (firstSeg && firstSeg !== quoted && firstSeg.length >= 4 && firstSeg !== headline) queries.push(firstSeg);
    queries.push(headline.split(/\s+/).slice(0, 6).join(" "));
    for (const q of queries) {
      if (relTitles.length && relPeople.length) break;
      takeMulti(await TMDB.searchMulti(q, 1).then(d => d.results || []).catch(() => []));
    }
    if (!relPeople.length) {
      const seqs = [...new Set([...headline.matchAll(/\b([A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|De|Di|Da|Van|Von)){1,2})\b/g)].map(m => m[1]))].slice(0, 4);
      for (const nm of seqs) {
        const res = await TMDB.api("/search/person", { query: nm }).then(d => d.results || []).catch(() => []);
        const hit = (res || []).find(p => p.name && norm(p.name) === norm(nm) && p.profile_path);
        if (hit && !seenP.has(hit.id)) { seenP.add(hit.id); relPeople.push(hit); }
        if (relPeople.length >= 2) break;
      }
    }
    relTitles.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    relTitles = relTitles.slice(0, 4);
    relPeople.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    relPeople = relPeople.slice(0, 4);
    /* Published-only related titles: a related card must open a real
       published post. A live TMDB hit that was never published would
       link to a "hasn't been published yet" page — drop it, and render
       the survivors from the published entry itself (correct type,
       title and poster). People are fine as-is: a person page is a
       single-record profile, not a catalogue listing. */
    const PUB = window.FA_PUBLISHED || {};
    relTitles = relTitles
      .map(x => PUB[String(x.id)])
      .filter(x => x && (x.type === "movie" || x.type === "tv"))
      .slice(0, 4);
    if (relTitles.length || relPeople.length) {
      relatedHtml = `<section class="section"><div class="section-head"><h2>Related on FlickAtlas</h2></div>
        ${relTitles.length ? `<div class="scroller">${relTitles.map(x => UI.posterCard(x, x.type === "tv" ? "tv" : "movie", UI.industryTag(x))).join("")}</div>` : ""}
        ${relPeople.length ? `<div class="people-row" style="margin-top:10px">${relPeople.map(p => UI.personCard(p, p.known_for_department || "")).join("")}</div>` : ""}
        <p class="img-credit">Images: TMDB</p>
      </section>`;
    }
  } catch (e) {}

  /* ---------- Entity enrichment (fix round 2, Bug C): brief mode was
     ~3 lines — the user: "100% ke page me sirf 5% likha hai". Brief mode
     now builds a RICH ORIGINAL article from structured data only: the
     story's own fields, plus the connected title's full TMDB record
     (story, cast, director, dates, rating, budget/gross, our day-wise
     tracking) and the connected person's latest + next work from their
     TMDB credits. Every sentence is composed here from those facts —
     feed summary text is NEVER rendered, and no source is named. ----- */
  const enrich = { td: null, pd: null, latest: null, next: null, knownFor: [], daywise: null };
  try {
    /* The connected title is a PUBLISHED entry (see the filter above):
       its story, genres, budget/gross, status and dates are baked in,
       so no TMDB.details call is needed. Cast/director still come from
       one single-title credits call for that published title. */
    const t0 = relTitles[0];
    if (t0) {
      const tType = t0.type === "tv" ? "tv" : "movie";
      const credits = await TMDB.api(`/${tType}/${t0.id}/credits`).catch(() => null);
      enrich.td = { ...t0, credits: credits || null, media_type: tType };
      if (tType === "movie" && window.FA_DAYWISE && window.FA_DAYWISE[t0.id]) {
        enrich.daywise = window.FA_DAYWISE[t0.id];
      }
    }
    const p0 = relPeople[0];
    if (p0) {
      enrich.pd = await TMDB.person(p0.id).catch(() => null);
      const credits = await TMDB.personCredits(p0.id).catch(() => null);
      /* Published-only work: a person's latest/next/known-for titles
         are named only when they are published — otherwise the page
         would claim "its own full post on FlickAtlas" for titles that
         have no post. */
      const PUB2 = window.FA_PUBLISHED || {};
      const isPublishedCredit = (c) => {
        const pub = PUB2[String(c.id)];
        return !!pub && pub.type === c.media_type;
      };
      const cast = ((credits && credits.cast) || []).filter(c => (c.release_date || c.first_air_date) && isPublishedCredit(c));
      const todayS = TMDB.today();
      const dated = cast.map(c => ({ c, dt: c.release_date || c.first_air_date }));
      enrich.latest = dated.filter(x => x.dt <= todayS).sort((a, b) => b.dt.localeCompare(a.dt))[0] || null;
      enrich.next = dated.filter(x => x.dt > todayS).sort((a, b) => a.dt.localeCompare(b.dt))[0] || null;
      const kfSeen = new Set();
      enrich.knownFor = cast.slice()
        .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0))
        .filter(c => (c.title || c.name) && !kfSeen.has(c.id) && kfSeen.add(c.id))
        .slice(0, 3);
    }
  } catch (e) {}

  const CATCONTEXT = {
    bollywood: "Bollywood leads FlickAtlas coverage, and this story is part of today's Indian cinema developments.",
    international: "This story is part of today's international entertainment developments.",
    pakistan: "This story is part of today's Pakistani entertainment coverage — cinema, television and drama.",
    celebrity: "Celebrity coverage tracks what the stars are doing today — appearances, announcements and milestones.",
    viral: "This is a viral-stream story: the inventions, records and moments people are sharing most right now.",
  };
  /* A category is the only reliable industry signal on a feed item. Do not
     infer Bollywood from a person's name, a headline, or a matched TMDB title. */
  const quotedTitle = (it.title.match(/['"“]([^'"”]{3,60})['"”]/) || [])[1] || "";
  const briefArticle = () => {
    /* Headline-only Bollywood records do not support a story narrative.
       Keep the promised article contract, but state the evidence limit rather
       than padding it with unrelated biography, filmography, or RSS copy. */
    if (isBollywood) {
      const facts = [
        ...(whenText ? [{ k: "Published", v: whenText }] : []),
        { k: "Coverage", v: "Bollywood" },
        ...(relTitles.length ? [{ k: "Related title", v: UI.titleOf(relTitles[0]) }] : []),
        ...(relPeople.length ? [{ k: "Related person", v: relPeople[0].name }] : []),
      ];
      return {
        id, type: "news", headline: it.title,
        dek: "A brief listing based on the available headline; additional story details have not been verified for this page.",
        body: [{ h: "Available details", p: [
          `The available record places this headline in Bollywood coverage${when ? ` and dates it ${UI.fmtDate(when.toISOString().slice(0, 10))}` : ""}.`,
          "The record contains no independently structured account of what happened. FlickAtlas is not adding further claims or reproducing a feed summary.",
        ] }],
        facts,
        published: it.ts || null,
      };
    }
    const body = [];
    const facts = [
      ...(whenText ? [{ k: "Published", v: whenText }] : []),
      ...((it.cats || []).length ? [{ k: "Coverage", v: (it.cats || []).map(c => CATLABEL[c] || c).join(", ") }] : []),
    ];
    const lead = `Here is the development as it stands today${when ? ` (${UI.fmtDate(when.toISOString().slice(0, 10))})` : ""}: ${it.title}`;
    const ctx = CATCONTEXT[(it.cats || [])[0]] || CATCONTEXT.international;
    body.push({ h: "The Story So Far", p: [lead, ctx] });

    /* --- the connected title, in depth --- */
    const t0 = relTitles[0];
    const td = enrich.td;
    if (t0 && td) {
      const name = UI.titleOf(td);
      const yr = UI.yearOf(td);
      const rt = UI.rating(td);
      const dt = td.release_date || td.first_air_date;
      const isTv = (t0.type || td.media_type) === "tv";
      const paras = [];
      if (td.overview) paras.push(td.overview);
      const bits = [];
      bits.push(`${name}${yr ? ` (${yr})` : ""} is the ${isTv ? "series" : "film"} at the centre of this story`);
      if (dt) bits.push(`${dt > TMDB.today() ? "it is set to release" : `it ${isTv ? "premiered" : "released"}`} on ${UI.fmtDate(dt)}`);
      if (rt) bits.push(`audiences rate it ${rt}/10${td.vote_count ? ` from ${td.vote_count.toLocaleString("en-US")} votes` : ""}`);
      /* Genres are baked-in strings on a published entry (TMDB details
         carry objects) — read the name either way. */
      const genreNames = (td.genres || []).map(g => typeof g === "string" ? g : g.name).filter(Boolean);
      if (genreNames.length) bits.push(`it belongs to the ${genreNames.join(", ")} ${isTv ? "genre" : "genres"}`);
      if (td.status) bits.push(`its current status is listed as ${td.status}`);
      paras.push(bits.join("; ") + ".");
      if (!isTv && (td.budget || td.revenue)) {
        const bp = [];
        if (td.budget) bp.push(`a reported production budget of ${UI.fmtMoneyWords(td.budget)}`);
        if (td.revenue) bp.push(`worldwide box office collections of ${UI.fmtMoneyWords(td.revenue)}`);
        paras.push(`${name} was made on ${bp.join(" and ")}${td.budget && td.revenue ? ` — a ${UI.verdict(td.budget, td.revenue) ? UI.verdict(td.budget, td.revenue).label.toLowerCase() : "notable"} run by the usual budget-versus-gross measure, and an estimate as always with reported figures` : ""}.`);
      }
      if (enrich.daywise && enrich.daywise.length) {
        const rows = enrich.daywise;
        const total = rows.reduce((s, r) => s + (r.collection || 0), 0);
        const last = rows[rows.length - 1];
        paras.push(`In the FlickAtlas day-wise box office tracking, ${name} has collected ${UI.fmtMoney(total)} across its first ${rows.length} tracked day${rows.length === 1 ? "" : "s"} — its latest tracked day (${last.day || "Day " + rows.length}${last.date ? `, ${UI.fmtDate(last.date)}` : ""}) brought in ${UI.fmtMoney(last.collection)}. The full day-by-day table sits on the film's own FlickAtlas post.`);
        facts.push({ k: "Box Office So Far", v: `${UI.fmtMoney(total)} in ${rows.length} tracked days` });
        facts.push({ k: "Latest Tracked Day", v: `${UI.fmtMoney(last.collection)}${last.date ? ` (${UI.fmtDate(last.date)})` : ""}` });
      }
      body.push({ h: `About ${name}`, p: paras });
      facts.push({ k: isTv ? "Series" : "Film", v: `${name}${yr ? ` (${yr})` : ""}` });
      if (dt) facts.push({ k: dt > TMDB.today() ? "Release Date" : (isTv ? "Premiered" : "Released"), v: UI.fmtDate(dt) });
      if (rt) facts.push({ k: "Audience Rating", v: `${rt}/10${td.vote_count ? ` (${td.vote_count.toLocaleString("en-US")} votes)` : ""}` });
      if (!isTv && td.revenue) facts.push({ k: "Worldwide Box Office", v: UI.fmtMoneyWords(td.revenue) });
      if (!isTv && td.budget) facts.push({ k: "Budget", v: UI.fmtMoneyWords(td.budget) });

      /* cast & director of the connected title */
      const cast = ((td.credits && td.credits.cast) || []).slice(0, 5);
      const crew = (td.credits && td.credits.crew) || [];
      const dirs = crew.filter(c => c.job === "Director").map(c => c.name);
      /* Creators are baked-in names on a published entry (TMDB details
         carry objects) — read the name either way. */
      const creators = (td.created_by || []).map(c => typeof c === "string" ? c : c.name).filter(Boolean);
      const leadNames = isTv ? creators : dirs;
      if (cast.length || leadNames.length) {
        const cp = [];
        if (leadNames.length) cp.push(`${name} is ${isTv ? "created by" : "directed by"} ${leadNames.join(", ")}.`);
        if (cast.length) cp.push(`The cast is led by ${cast.map(c => c.character ? `${c.name} (as ${c.character})` : c.name).join(", ")} — the full credited cast, with photos and filmographies, is on the title's FlickAtlas post.`);
        body.push({ h: `The ${isTv ? "Cast & Creators" : "Cast & Director"} of ${name}`, p: cp });
      }
    } else if (t0) {
      const yr = UI.yearOf(t0);
      const rt = UI.rating(t0);
      const dt = t0.release_date || t0.first_air_date;
      body.push({ h: `About ${UI.titleOf(t0)}`, p: [
        `${UI.titleOf(t0)}${yr ? ` (${yr})` : ""} is the ${t0.media_type === "tv" ? "series" : "film"} at the centre of this story${rt ? `, rated ${rt}/10 by audiences` : ""}${dt ? `, ${dt > TMDB.today() ? "set to release" : "released"} ${UI.fmtDate(dt)}` : ""}. Its full post on FlickAtlas carries the complete cast, story, budget and box office record.`,
      ] });
    }

    /* --- the connected person: latest + next work --- */
    const p0 = relPeople[0];
    if (p0) {
      const paras = [];
      const dept = (enrich.pd && enrich.pd.known_for_department) || p0.known_for_department || "";
      paras.push(`${p0.name} is the name at the centre of this story${dept ? ` — known for work in ${dept === "Acting" ? "acting" : dept.toLowerCase()}` : ""}. Their complete profile on FlickAtlas carries the full biography and filmography.`);
      const bioPara = enrich.pd && enrich.pd.biography
        ? enrich.pd.biography.split(/\n+/).filter(Boolean)[0].slice(0, 520) : "";
      if (bioPara) paras.push(bioPara);
      if (enrich.knownFor && enrich.knownFor.length) {
        paras.push(`${p0.name} is best known for ${enrich.knownFor.map(c =>
          `${c.title || c.name}${(c.release_date || c.first_air_date) ? ` (${(c.release_date || c.first_air_date).slice(0, 4)})` : ""}`).join(", ")} — the performances that made the name, each with its own full post on FlickAtlas.`);
      }
      if (enrich.latest) {
        const c = enrich.latest.c;
        const nm = c.title || c.name;
        paras.push(`On screen, ${p0.name}'s most recent work is ${nm}${c.character ? `, appearing as ${c.character}` : ""}, which ${c.media_type === "tv" || c.name ? "premiered" : "released"} on ${UI.fmtDate(enrich.latest.dt)}${c.vote_average ? ` and holds an audience rating of ${Math.round(c.vote_average * 10) / 10}/10` : ""}.`);
        facts.push({ k: `${p0.name} — Latest Work`, v: `${nm} (${UI.fmtDate(enrich.latest.dt)})` });
      }
      if (enrich.next) {
        const c = enrich.next.c;
        const nm = c.title || c.name;
        paras.push(`Next up, ${p0.name} is credited in ${nm}${c.character ? ` as ${c.character}` : ""}, currently scheduled for ${UI.fmtDate(enrich.next.dt)} — one reason this story matters: it lands in the middle of an active run of work.`);
        facts.push({ k: `${p0.name} — Next Work`, v: `${nm} (${UI.fmtDate(enrich.next.dt)})` });
      }
      if (relPeople.length > 1) {
        paras.push(`Also connected to this story: ${relPeople.slice(1).map(p => p.name).join(", ")} — each name opens a full profile on FlickAtlas.`);
      }
      body.push({ h: `${p0.name} — Latest & Next`, p: paras });
    }

    /* --- what we know so far / what happens next --- */
    const known = [];
    known.push(`The headline development is confirmed as of ${when ? UI.fmtDate(when.toISOString().slice(0, 10)) : "today"} and is tracked under ${(it.cats || []).map(c => CATLABEL[c] || c).join(" and ") || "entertainment"} coverage on FlickAtlas.`);
    if (t0 && td) {
      const dt = td.release_date || td.first_air_date;
      if (dt && dt > TMDB.today()) known.push(`The next fixed date in this story is ${UI.fmtDate(dt)}, when ${UI.titleOf(td)} ${t0.media_type === "tv" ? "premieres" : "releases"} — expect the coverage to build as that date approaches.`);
      else if (enrich.daywise) known.push(`With the film in its theatrical run, the next developments to watch are its daily collections — FlickAtlas updates the day-wise table on the film's post as each day's figures are reported.`);
      else known.push(`The title at the centre of the story is fully documented on its FlickAtlas post — cast, story, dates and figures — linked below.`);
    } else if (p0 && enrich.next) {
      known.push(`The next fixed date in this story is ${UI.fmtDate(enrich.next.dt)}, when ${enrich.next.c.title || enrich.next.c.name} is scheduled to arrive.`);
    } else {
      known.push(`This page is updated as further confirmed details are published; unconfirmed claims are never added.`);
    }
    body.push({ h: "What We Know So Far", p: known });

    return {
      id, type: "news", headline: it.title,
      dek: quotedTitle
        ? `The confirmed details on ${quotedTitle} — what happened, the key facts, and the titles and people connected to the story.`
        : `The confirmed facts on this ${(it.cats || []).map(c => CATLABEL[c] || c).join(" and ") || "entertainment"} story — what happened, and the titles and people connected to it.`,
      body,
      facts,
      published: it.ts || null,
    };
  };
  const brief = briefArticle();
  let article = brief;
  if (fullArt && isBollywood) {
    article = fullArt;
  } else if (fullArt) {
    /* Full article + enrichment stack (fix round 3): the engine article
       carries the story; beneath it, the brief builder's entity
       sections — the connected title in depth, cast & director, the
       person's Latest & Next, What We Know So Far — and its gathered
       facts still render, so a full-article page is never thinner than
       a brief-mode one. The brief's lead section is skipped: the
       article itself tells the story. */
    const extraSecs = (brief.body || []).filter(s => s.h !== "The Story So Far");
    const seenK = new Set((fullArt.facts || []).map(f => String(f.k || "").toLowerCase()));
    article = {
      ...fullArt,
      body: [...(fullArt.body || []), ...extraSecs],
      facts: [...(fullArt.facts || []),
              ...(brief.facts || []).filter(f => !seenK.has(String(f.k || "").toLowerCase()))],
    };
  }

  const more = items.filter(x => UI.newsId(x) !== id)
    .sort((a, b) => ((b.cats || []).some(c => (it.cats || []).includes(c)) ? 1 : 0) -
                    ((a.cats || []).some(c => (it.cats || []).includes(c)) ? 1 : 0) || b.ts - a.ts)
    .slice(0, 6);
  const displayFacts = (article.facts || []).filter(f =>
    !(whenText && String(f.k || "").toLowerCase() === "published") &&
    !((it.cats || []).length && String(f.k || "").toLowerCase() === "coverage"));

  /* Article images (spec §5): each entry renders as a figure with the
     image and a small muted credit line under it, "Image: <source>".
     The credit uses the existing .img-credit class; the image sits in
     the existing .content-card. Articles with no images render exactly
     as today — this block is empty. A failed image removes its whole
     figure (no broken image, no orphan credit). */
  const imagesHtml = (article.images || []).filter(im => im && im.url).map(im => `
    <figure class="content-card" style="margin-top:14px">
      <img src="${UI.esc(im.url)}" alt="${UI.esc(im.caption || article.headline || "")}" loading="lazy" decoding="async" style="max-width:100%;border-radius:12px" onerror="this.closest('figure').remove()">
      ${im.caption ? `<p class="article-summary" style="margin-top:8px">${UI.esc(im.caption)}</p>` : ""}
      <p class="img-credit">Image: ${UI.esc(im.source || "TMDB")}</p>
    </figure>`).join("");

  main.innerHTML = `<div class="wrap">
    <p class="article-crumb"><a href="/news">← Trending News</a>${(it.cats || []).length ? ` · ${UI.esc(CATLABEL[it.cats[0]] || it.cats[0])}` : ""}</p>
    <header class="content-card article-header-card">
      <div class="article-head"><h1>${UI.esc(article.headline || it.title)}</h1></div>
      <div class="article-meta">
        ${whenText ? `<span>${UI.esc(whenText)}</span>` : ""}
        ${catChips}
      </div>
      ${article.dek ? `<p class="article-dek">${UI.esc(article.dek)}</p>` : ""}
    </header>
    ${imagesHtml}
    <div class="article-body">
      ${(article.body || []).map(sec => `<div class="content-card" style="margin-top:14px"><h2>${UI.esc(sec.h)}</h2>
        ${(sec.p || []).map(p => `<p class="article-summary">${UI.escRich(p)}</p>`).join("")}</div>`).join("")}
    </div>
    ${displayFacts.length ? `<div class="content-card" style="margin-top:14px"><h2>Story Details</h2>
      <dl class="facts-table">${displayFacts.map(f =>
        (typeof f === "string" || !f.k)
          ? `<div class="fact-row"><dd>${UI.escRich(typeof f === "string" ? f : (f.v || ""))}</dd></div>`
          : `<div class="fact-row"><dt>${UI.esc(f.k)}</dt><dd>${UI.escRich(f.v)}</dd></div>`).join("")}</dl></div>` : ""}
    ${relatedHtml}
    ${more.length ? `<section class="section"><div class="section-head"><h2>More Headlines</h2>
      <a class="see-all" href="/news">See All →</a></div>
      <div class="news-list">${more.map(newsRow).join("")}</div></section>` : ""}
  </div>`;

  if (isBollywood && !fullArt) {
    const robots = document.createElement("meta");
    robots.name = "robots"; robots.content = "noindex, follow";
    document.head.appendChild(robots);
  }
  UI.setSEO({
    title: `${article.headline || it.title} | FlickAtlas`,
    desc: (article.dek || it.title).slice(0, 160),
    path: `/news-item?id=${encodeURIComponent(id)}`, type: "article",
    jsonld: { "@context": "https://schema.org", "@type": isBollywood && !fullArt ? "WebPage" : "NewsArticle",
      "headline": article.headline || it.title,
      "url": CONFIG.BASE + `/news-item?id=${encodeURIComponent(id)}`,
      ...(when ? { "datePublished": when.toISOString() } : {}),
      "author": { "@type": "Organization", "name": "FlickAtlas" },
      "publisher": { "@type": "Organization", "name": "FlickAtlas" },
      ...(article.dek ? { "description": article.dek.slice(0, 200) } : {}) }
  });

  /* Top Searches (audit round, ORDER H): phrases built only from the
     entities this story actually resolved to (or, failing that, the
     headline's own capitalized subject) — never random keywords. */
  {
    const tsEntities = [], tsTemplates = [];
    const pName = (enrich.pd && enrich.pd.name) || (relPeople[0] && relPeople[0].name) || "";
    const tName = enrich.td ? UI.titleOf(enrich.td) : (relTitles[0] ? UI.titleOf(relTitles[0]) : "");
    if (pName) {
      tsEntities.push(pName);
      tsTemplates.push(`${pName} latest news`, `${pName} upcoming movies`, `${pName} biography`, `${pName} new movie`);
    }
    if (tName) {
      tsEntities.push(tName);
      tsTemplates.push(`${tName} box office collection`, `${tName} release date`, `${tName} cast`, `${tName} budget`);
    }
    if (!tsTemplates.length) {
      const seq = [...headline.matchAll(/\b([A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|De|Di|Da|Van|Von)){1,2})\b/g)].map(m => m[1])[0];
      if (seq) { tsEntities.push(seq); tsTemplates.push(`${seq} latest news`, `${seq} news`, `${seq} biography`, `${seq} latest`); }
    }
    if (tsTemplates.length) {
      /* mountTopSearches only takes (main, entities) — a third templates
         argument is silently dropped, so the phrase links are rendered
         here as their own section instead of being passed to it. */
      const topHtml = `<section class="section"><div class="section-head"><h2>Top Searches</h2></div>
        <p>${tsTemplates.map(t => `<a class="kw-chip" href="/search?q=${encodeURIComponent(t)}">${UI.esc(t)}</a>`).join(" ")}</p></section>`;
      main.querySelector(".wrap").insertAdjacentHTML("beforeend", topHtml);
      UI.mountTopSearches(main, tsEntities);
    }
  }
})();

