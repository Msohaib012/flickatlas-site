/* FlickAtlas — Awards hub (correction round, data-backed category):
   the award season on one page. Upcoming ceremonies carry ONLY dates
   verified against the organisers' own announcements (checked
   2026-10-23); shows whose next date is not yet announced say so
   plainly — no date is ever guessed. "Latest Awards News" is our own
   article stream (feed items about awards, each opening its own
   /news-item page). Winners are reported only through that verified
   news stream — never from memory. */
(async function () {
  UI.mountChrome("/awards");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Awards — Upcoming Award Shows, Dates & Latest News | FlickAtlas",
    desc: "Browse upcoming award dates and available nominations and winners news. Listings and coverage depend on the information currently shown.",
    path: "/awards"
  });

  /* Verified 2026-10-23: Golden Globes date/host from goldenglobes.com;
     Oscars + Governors dates/host from oscars.org / the Academy. */
  const SHOWS = [
    { name: "Governors Awards", org: "Academy of Motion Picture Arts and Sciences", date: "2026-11-15", venue: "Ray Dolby Ballroom, Hollywood", note: "Honorary Oscars presented ahead of the main ceremony." },
    { name: "Golden Globe Awards", org: "Golden Globes", date: "2027-01-10", venue: "Beverly Hilton, Beverly Hills", note: "84th edition · Host: Nikki Glaser · Nominations announced December 7, 2026." },
    { name: "Academy Awards — The Oscars", org: "Academy of Motion Picture Arts and Sciences", date: "2027-03-14", venue: "Dolby Theatre, Hollywood", note: "99th edition · Host: Conan O'Brien · Nominations announced January 21, 2027." },
    { name: "BAFTA Film Awards", org: "British Academy", date: "", venue: "London", note: "Date for the next edition to be announced." },
    { name: "Filmfare Awards", org: "Filmfare (India)", date: "", venue: "India", note: "Date for the next edition to be announced." },
    { name: "IIFA Awards", org: "International Indian Film Academy", date: "", venue: "To be announced", note: "Date and host city for the next edition to be announced." },
    { name: "Lux Style Awards", org: "Lux Style (Pakistan)", date: "", venue: "Pakistan", note: "Date for the next edition to be announced." },
  ];
  const todayS = TMDB.today();
  const dated = SHOWS.filter(s => s.date && s.date >= todayS).sort((a, b) => a.date.localeCompare(b.date));
  const tba = SHOWS.filter(s => !s.date || s.date < todayS);

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Awards</h1>
      <p>Upcoming dates and available nominations or winners news.</p></div>
    <section class="section"><div class="section-head"><h2>Upcoming Award Shows</h2></div>
      <div class="tl-list">${[...dated, ...tba].map(s => `
        <div class="tl-row">
          <span class="tl-date">${s.date ? `<b>${parseInt(s.date.slice(8, 10), 10)}</b>${UI.fmtDate(s.date)}` : `<b>TBA</b>Date to be announced`}</span>
          <span class="tl-info"><b>${UI.esc(s.name)}</b>
          <span>${UI.esc(s.org)} · ${UI.esc(s.venue)}</span>
          <span>${UI.esc(s.note)}</span></span>
        </div>`).join("")}</div>
    </section>
    <section class="section"><div class="section-head"><h2>Latest Awards News</h2>
      <a class="see-all" href="/news">All News →</a></div>
      <div id="awNews"><div class="sk" style="height:120px;border-radius:14px"></div></div>
    </section>
  </div>`;

  try {
    const r = await fetch("/api/news");
    if (!r.ok) throw new Error("news");
    const j = await r.json();
    const hits = (j.items || []).filter(x => /\b(award|awards|oscar|oscars|golden globe|filmfare|iifa|bafta|national film award|award winner|award winners|wins best|best actor|best actress|best film|best picture|nomination|nominated)\b/i.test(x.title || "")).slice(0, 8);
    const host = document.getElementById("awNews");
    if (host) {
      host.innerHTML = hits.length ? `<div class="news-list">${hits.map(x => `
        <a class="news-item" href="${UI.newsItemPath(x)}">
          <span class="news-txt"><b>${UI.esc(x.title)}</b>
          <span>${x.ts ? UI.relTime(x.ts) : ""}</span></span>
        </a>`).join("")}</div>`
        : UI.stateMsg("No awards news in the current feed window — ceremony coverage lands here as it is reported.", true);
    }
  } catch (e) {
    const host = document.getElementById("awNews");
    if (host) host.innerHTML = UI.stateMsg("Awards news could not load right now.", true);
  }
})();
