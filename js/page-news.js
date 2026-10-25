/* FlickAtlas — Trending News (§3 newspaper-native, §5 Soompi mechanics):
   real entertainment headlines from the live feed via /api/news, presented as
   newspaper-style rows with relative timestamps and category labels. §4 chips: All · Bollywood · World Cinema · Pakistan ·
   Celebrity. PUBLISHED-ONLY: the page renders only the feed — there is no
   live-TMDB fallback (the old fallback rendered now-playing / revenue /
   upcoming titles as "news" and linked to unpublished titles). If the feed
   is unreachable or empty, the page says so honestly. */
(async function () {
  UI.mountChrome("/news");
  const main = document.getElementById("app");
  UI.setSEO({
    title: "Trending News — Entertainment Headlines from Bollywood, World Cinema & Pakistan | FlickAtlas",
    desc: "Browse entertainment headlines by Bollywood, World Cinema, Pakistan, celebrity or viral topic. Use the category filters to narrow the feed; timestamps appear when available.",
    path: "/news"
  });

  const FILTERS = [["all", "All"], ["bollywood", "Bollywood"], ["world", "World Cinema"],
    ["pakistan", "Pakistan"], ["celebrity", "Celebrity"], ["viral", "Viral"]];
  let f = UI.getParam("f", "all");
  if (!FILTERS.some(([k]) => k === f)) f = "all";

  main.innerHTML = `<div class="wrap">
    <div class="page-hero"><h1>Trending News</h1>
      <p>Entertainment headlines across Bollywood, World Cinema, Pakistan and more; filter by category.</p></div>
    <div id="chipHost">${UI.chipRow(FILTERS, f)}</div>
    <p class="fcount" id="fcount"></p>
    <div id="newsWrap"><div class="sk" style="height:220px;border-radius:14px"></div></div>
  </div>`;
  const wrap = main.querySelector("#newsWrap");
  const fcount = main.querySelector("#fcount");

  const CATLABEL = { bollywood: "Bollywood", world: "World Cinema", pakistan: "Pakistan", celebrity: "Celebrity", viral: "Viral" };
  let items = null;

  function render() {
    const list = (items || []).filter(it => f === "all" || it.cats.includes(f)).slice(0, 48);
    fcount.textContent = list.length ? `${list.length} headline${list.length === 1 ? "" : "s"}` : "";
    if (!list.length) {
      wrap.innerHTML = UI.stateMsg("No headlines are listed in this category right now. Try another category.", false);
      return;
    }
    wrap.innerHTML = `<div class="editorial-grid">${list.map(it => {
      const categories = (Array.isArray(it.cats) ? it.cats : []).map(c => CATLABEL[c] || c);
      const meta = [categories.length ? categories.join(" · ") : "", Number.isFinite(it.ts) && it.ts > 0 ? UI.relTime(it.ts) : ""].filter(Boolean);
      return `<a class="editorial-card" href="${UI.newsItemPath(it)}">
        <span class="editorial-card__title">${UI.esc(it.title)}</span>
        ${meta.length ? `<span class="editorial-card__meta">${meta.map(UI.esc).join(" · ")}</span>` : ""}
      </a>`;
    }).join("")}</div>
      <p class="prov-note">Open any headline for its own FlickAtlas article page — with the
      story, relevant facts and related titles and people presented here.</p>`;
  }
  UI.wireChips(main.querySelector("#chipHost"), (k) => { f = k; render(); });

  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 9000);
    const r = await fetch("/api/news", { signal: ctl.signal });
    clearTimeout(to);
    if (!r.ok) throw new Error("news http " + r.status);
    const j = await r.json();
    if (!j.items || !j.items.length) throw new Error("news empty");
    /* Normalise feed categories to the page's labels: the feed still
       classifies some items "international" (shown here as World Cinema);
       Korea-only items keep no category label and appear under All. */
    items = j.items.map(it => ({
      ...it,
      cats: (Array.isArray(it.cats) ? it.cats : []).map(c => c === "international" ? "world" : c).filter(c => c !== "korea")
    }));
    render();
  } catch (e) {
    wrap.innerHTML = UI.stateMsg("The news feed is unavailable right now. Please try again later.", false);
  }
})();
