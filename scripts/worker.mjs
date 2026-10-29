// FlickAtlas Worker: static assets + /api/* rewrites (same mapping as
// vercel.json). /api/news -> /api-news.json, /api/trends -> /api-trends.json.
// The JSON files are regenerated hourly by the pipeline and deployed as
// static assets; serving their bytes unchanged keeps the frontend contract
// exact (the frontend fetches /api/news with no query params and expects
// {generated, count, items: [...]}). Everything else passes through to
// the static assets. Only GET/HEAD are rewritten.
//
// SEO (scripts/seo_assets.py, hourly): detail pages are ONE static shell
// each (/movie?id=, /show?id=, /news-item?id=, /box-office-day?title=&day=,
// /category?cat=) rendered client-side from JS data, so a crawler that
// does not run JS would see the same generic shell title for every film
// and every article. For those routes the Worker injects the real
// <title>/meta/OG/Twitter/canonical/JSON-LD from js/seo-meta.json
// (regenerated hourly from the live data) into the served HTML.
// Unknown id / missing meta file / fetch error -> the shell is served
// unchanged (safe fallback). Listing + legal shells carry their own
// static meta in the HTML; the Worker never injects on those routes.
//
// The deploy MUST set assets.config.run_worker_first=true (see
// scripts/cloudflare_deploy.py): by default Workers Static Assets serves a
// matching file directly WITHOUT running this Worker, so neither the SEO
// injection nor the headers below would ever happen for /movie?id= etc.
// Proven live on the admin panel 2026-10-28: with run_worker_first off,
// /app.js served zero security headers even with a _headers file at the
// asset root; with it on, the Worker wraps every response (verified).
//
// Security headers are set HERE, not via _headers: when a Worker script
// runs, Cloudflare ignores _headers (verified live — the file was present
// and downloadable, the headers were not served). Same policy as _headers.
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https://image.tmdb.org https://images.weserv.nl https://www.google-analytics.com https://www.googletagmanager.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://api.themoviedb.org https://www.google-analytics.com https://www.googletagmanager.com; frame-src https://www.youtube-nocookie.com https://www.youtube.com; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};
function withSecHeaders(res) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SEC_HEADERS)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
const API_REWRITES = { "/api/news": "/api-news.json", "/api/trends": "/api-trends.json" };
const SEO_ROUTES = { "/movie": "movie", "/show": "tv", "/news-item": "news",
                     "/box-office-day": "daywise", "/category": "cat" };
const OG_TYPE = { "Movie": "video.movie", "TVSeries": "video.tv_show",
                  "NewsArticle": "article", "CollectionPage": "website" };
let SEO_CACHE = null;
let SEO_CACHE_AT = 0;
async function loadSeoMeta(env, url) {
  const now = Date.now();
  if (SEO_CACHE && now - SEO_CACHE_AT < 600000) return SEO_CACHE;
  try {
    const res = await env.ASSETS.fetch(new Request(new URL("/js/seo-meta.json", url)));
    if (!res.ok) return SEO_CACHE;
    SEO_CACHE = await res.json();
    SEO_CACHE_AT = now;
    return SEO_CACHE;
  } catch (e) {
    return SEO_CACHE;
  }
}
function seoKey(url, normPath) {
  const kind = SEO_ROUTES[normPath];
  if (!kind) return null;
  if (kind === "cat") {
    const cat = url.searchParams.get("cat");
    return cat ? "cat:" + cat : null;
  }
  if (kind === "daywise") {
    const id = url.searchParams.get("title");
    return id ? "daywise:" + id : null;
  }
  const id = url.searchParams.get("id");
  return id ? kind + ":" + id : null;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function injectSeo(html, meta, canonical) {
  let out = html;
  const title = esc(meta.t);
  if (/<title>[^<]*<\/title>/i.test(out)) {
    out = out.replace(/<title>[^<]*<\/title>/i, "<title>" + title + "</title>");
  } else {
    out = out.replace(/<head[^>]*>/i, function (m) { return m + "<title>" + title + "</title>"; });
  }
  const desc = esc(meta.d);
  const descRe = /<meta[^>]+name=["']description["'][^>]*>/i;
  if (descRe.test(out)) {
    out = out.replace(descRe, '<meta name="description" content="' + desc + '">');
  } else {
    out = out.replace(/<\/title>/i, function (m) { return m + "\n  " + '<meta name="description" content="' + desc + '">'; });
  }
  const kwRe = /<meta[^>]+name=["']keywords["'][^>]*>/i;
  if (kwRe.test(out)) {
    out = out.replace(kwRe, '<meta name="keywords" content="' + esc(meta.k) + '">');
  } else {
    out = out.replace(/<\/title>/i, function (m) { return m + "\n  " + '<meta name="keywords" content="' + esc(meta.k) + '">'; });
  }
  const ogType = OG_TYPE[(meta.ld && meta.ld["@type"]) || ""] || "website";
  const tags = [
    '<meta name="fa-seo" content="server">',
    '<meta property="og:title" content="' + title + '">',
    '<meta property="og:description" content="' + desc + '">',
    '<meta property="og:type" content="' + ogType + '">',
    '<meta property="og:url" content="' + esc(canonical) + '">',
    '<meta property="og:image" content="' + esc(meta.img) + '">',
    '<meta property="og:site_name" content="FlickAtlas">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:title" content="' + title + '">',
    '<meta name="twitter:description" content="' + desc + '">',
    '<meta name="twitter:image" content="' + esc(meta.img) + '">',
    '<link rel="canonical" href="' + esc(canonical) + '">'
  ];
  if (meta.ld) {
    tags.push('<script type="application/ld+json">' +
      JSON.stringify(meta.ld).replace(/</g, "\\u003c") + "</script>");
  }
  out = out.replace(/<\/head>/i, function (m) { return "  " + tags.join("\n  ") + "\n" + m; });
  return out;
}
function daywiseTitle(meta, day) {
  if (day && /^\d+$/.test(day)) {
    return meta.t + " Box Office Collection Day " + day + " \u2014 India Net & Overseas | FlickAtlas";
  }
  return meta.t + " Box Office Collection Day-Wise \u2014 India Net & Overseas | FlickAtlas";
}

// ---------- PUBLIC VIEWER REVIEWS (2026-10-28, owner order) ----------
// Shared ratings + comments for every movie page — visible to ALL
// visitors, not stored on the reviewer's device. Store: Cloudflare KV
// namespace "flickatlas-reviews" (id 51213eb8cf6f4130b41b335111e916c8,
// created 2026-10-28, bound as env.REVIEWS in the deploy metadata).
// No GitHub token in this Worker; no IP is ever logged or returned.
// Endpoints:
//   POST /api/review  {tmdb, stars 1-5, comment? <=500 chars, name? <=30, ownerToken?}
//   GET  /api/reviews?tmdb=<id>  -> {tmdb, count, average, items[]}
//   DELETE /api/review  {tmdb, rid, ownerToken} (owner token required)
// Validation: tmdb must be a published title id (checked against
// js/published-titles.js, cached 10 min; if that file cannot load the
// check is skipped — rate limits + no-links still apply). No URLs or
// angle brackets in comment/name. Rate limit: max 5 submissions per
// IP per hour; one review per IP per movie per day. KV keys:
//   rev:<tmdb>   {count, sum, items:[{s,c,n,at,rid?,owner_hash?}]} newest-first, cap 50
//   rh:<iphash>:<hourbucket>  hourly submit count (TTL 1h)
//   rl:<iphash>:<tmdb>  last submit timestamp (TTL 24h)
// IPs are SHA-256 hashed with a fixed salt before use as key parts;
// the raw IP never reaches KV values, logs or responses. Owner tokens are
// random per-review browser secrets; only their SHA-256 hashes are stored.
const REVIEWS_MAX_COMMENT = 500;
const REVIEWS_MAX_NAME = 30;
const REVIEWS_MAX_ITEMS = 50;
const REVIEWS_HOURLY_LIMIT = 5;
const REVIEWS_DAY_MS = 86400000;
const REVIEWS_IP_SALT = "flickatlas-reviews-v1";
const REVIEWS_OWNER_SALT = "flickatlas-review-owner-v1";
function reviewsJson(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
function hasLinkOrMarkup(s) {
  return /(https?:\/\/|www\.)/i.test(s) || /[<>]/.test(s);
}
async function ipHash(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const buf = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(REVIEWS_IP_SALT + ":" + ip));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function reviewOwnerHash(token) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/i.test(token)) return null;
  const buf = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(REVIEWS_OWNER_SALT + ":" + token.toLowerCase()));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function randomReviewId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}
function publicReviewItem(item, ownerHashes) {
  const out = { s: item.s, c: item.c || "", n: item.n || null, at: item.at };
  if (typeof item.rid === "string") out.rid = item.rid;
  if (ownerHashes && item.owner_hash && ownerHashes.has(item.owner_hash)) out.mine = true;
  return out;
}
let PUB_IDS = null;
let PUB_IDS_AT = 0;
async function loadPublishedIds(env, url) {
  const now = Date.now();
  if (PUB_IDS && now - PUB_IDS_AT < 600000) return PUB_IDS;
  try {
    const res = await env.ASSETS.fetch(new Request(new URL("/js/published-titles.js", url)));
    if (!res.ok) return PUB_IDS;
    const text = await res.text();
    const body = text.slice(text.indexOf("window.FA_PUBLISHED =") + "window.FA_PUBLISHED =".length).replace(/;\s*$/, "");
    const data = JSON.parse(body);
    PUB_IDS = new Set(Object.keys(data || {}));
    PUB_IDS_AT = now;
    return PUB_IDS;
  } catch (e) {
    return PUB_IDS;
  }
}
function reviewsAverage(rec) {
  if (!rec || !rec.count) return null;
  return Math.round((rec.sum / rec.count) * 10) / 10;
}
async function handleReviewsGet(request, env, url) {
  const tmdb = url.searchParams.get("tmdb") || "";
  if (!/^\d+$/.test(tmdb)) {
    return reviewsJson({ ok: false, error: "tmdb must be a numeric movie id." }, 400);
  }
  if (!env.REVIEWS) {
    return reviewsJson({ ok: false, error: "Reviews are unavailable right now." }, 503);
  }
  try {
    const ownerHeader = request.headers.get("x-review-owner-tokens") || "";
    const ownerTokens = [...new Set(ownerHeader.split(",").filter(token => /^[a-f0-9]{64}$/i.test(token)))].slice(0, REVIEWS_MAX_ITEMS);
    const ownerHashes = new Set((await Promise.all(ownerTokens.map(reviewOwnerHash))).filter(Boolean));
    const raw = await env.REVIEWS.get("rev:" + tmdb);
    const rec = raw ? JSON.parse(raw) : null;
    return new Response(JSON.stringify({
      ok: true, tmdb,
      count: rec ? (rec.count || 0) : 0,
      average: reviewsAverage(rec),
      items: rec && Array.isArray(rec.items) ? rec.items.map(item => publicReviewItem(item, ownerHashes)) : [],
    }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": ownerHeader ? "no-store" : "public, max-age=60",
      },
    });
  } catch (e) {
    return reviewsJson({ ok: false, error: "Could not load reviews. Please try again." }, 500);
  }
}
async function handleReviewPost(request, env, url) {
  if (!env.REVIEWS) {
    return reviewsJson({ ok: false, error: "Reviews are unavailable right now." }, 503);
  }
  let body;
  try {
    const text = await request.text();
    if (!text || text.length > 2048) {
      return reviewsJson({ ok: false, error: "Review is too large." }, 400);
    }
    body = JSON.parse(text);
  } catch (e) {
    return reviewsJson({ ok: false, error: "Could not read the review. Please try again." }, 400);
  }
  if (!body || typeof body !== "object") {
    return reviewsJson({ ok: false, error: "Could not read the review. Please try again." }, 400);
  }
  const tmdb = String(body.tmdb || "");
  const stars = body.stars;
  const comment = typeof body.comment === "string" ? body.comment.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const ownerToken = typeof body.ownerToken === "string" ? body.ownerToken : "";
  if (!/^\d+$/.test(tmdb)) {
    return reviewsJson({ ok: false, error: "tmdb must be a numeric movie id." }, 400);
  }
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return reviewsJson({ ok: false, error: "Please pick a star rating from 1 to 5." }, 400);
  }
  if (comment.length > REVIEWS_MAX_COMMENT) {
    return reviewsJson({ ok: false, error: "Comment must be 500 characters or fewer." }, 400);
  }
  if (ownerToken && !/^[a-f0-9]{64}$/i.test(ownerToken)) {
    return reviewsJson({ ok: false, error: "Could not save the review. Please try again." }, 400);
  }
  if (name.length > REVIEWS_MAX_NAME) {
    return reviewsJson({ ok: false, error: "Name must be 30 characters or fewer." }, 400);
  }
  if (hasLinkOrMarkup(comment) || (name && hasLinkOrMarkup(name))) {
    return reviewsJson({ ok: false, error: "Links are not allowed in reviews." }, 400);
  }
  try {
    const ownerHash = ownerToken ? await reviewOwnerHash(ownerToken) : null;
    const ids = await loadPublishedIds(env, url);
    if (ids && !ids.has(tmdb)) {
      return reviewsJson({ ok: false, error: "This movie is not published on FlickAtlas." }, 404);
    }
    const hash = await ipHash(request);
    const bucket = Math.floor(Date.now() / 3600000);
    const hourKey = "rh:" + hash + ":" + bucket;
    const hourCount = Number((await env.REVIEWS.get(hourKey)) || "0");
    if (hourCount >= REVIEWS_HOURLY_LIMIT) {
      return reviewsJson({ ok: false, error: "Too many reviews right now. Please try again later." }, 429);
    }
    const dayKey = "rl:" + hash + ":" + tmdb;
    const last = Number((await env.REVIEWS.get(dayKey)) || "0");
    if (last && Date.now() - last < REVIEWS_DAY_MS) {
      return reviewsJson({ ok: false, error: "You already reviewed this movie today." }, 429);
    }
    const raw = await env.REVIEWS.get("rev:" + tmdb);
    const rec = raw ? JSON.parse(raw) : { count: 0, sum: 0, items: [] };
    const now = Date.now();
    const item = { s: stars, c: comment, n: name || null, at: now };
    if (ownerHash) {
      item.rid = randomReviewId();
      item.owner_hash = ownerHash;
    }
    rec.items = [item, ...(rec.items || [])].slice(0, REVIEWS_MAX_ITEMS);
    rec.count = (rec.count || 0) + 1;
    rec.sum = (rec.sum || 0) + stars;
    await env.REVIEWS.put(hourKey, String(hourCount + 1), { expirationTtl: 3600 });
    await env.REVIEWS.put(dayKey, String(now), { expirationTtl: 86400 });
    await env.REVIEWS.put("rev:" + tmdb, JSON.stringify(rec));
    return reviewsJson({
      ok: true, tmdb,
      average: reviewsAverage(rec), count: rec.count, review: publicReviewItem(item, new Set(ownerHash ? [ownerHash] : [])),
    }, 200);
  } catch (e) {
    return reviewsJson({ ok: false, error: "Could not save the review. Please try again." }, 500);
  }
}

async function handleReviewDelete(request, env) {
  if (!env.REVIEWS) {
    return reviewsJson({ ok: false, error: "Reviews are unavailable right now." }, 503);
  }
  let body;
  try {
    const text = await request.text();
    if (!text || text.length > 2048) return reviewsJson({ ok: false, error: "Invalid delete request." }, 400);
    body = JSON.parse(text);
  } catch (e) {
    return reviewsJson({ ok: false, error: "Invalid delete request." }, 400);
  }
  const tmdb = String(body && body.tmdb || "");
  const rid = String(body && body.rid || "");
  const ownerHash = await reviewOwnerHash(body && body.ownerToken);
  if (!/^\d+$/.test(tmdb) || !/^[a-f0-9]{32}$/i.test(rid) || !ownerHash) {
    return reviewsJson({ ok: false, error: "A valid review owner token is required." }, 400);
  }
  try {
    const key = "rev:" + tmdb;
    const raw = await env.REVIEWS.get(key);
    if (!raw) return reviewsJson({ ok: false, error: "Review not found or not yours." }, 404);
    const rec = JSON.parse(raw);
    const items = Array.isArray(rec.items) ? rec.items : [];
    const index = items.findIndex(item => item.rid === rid && item.owner_hash === ownerHash);
    if (index < 0) return reviewsJson({ ok: false, error: "Review not found or not yours." }, 404);
    const [removed] = items.splice(index, 1);
    const count = Math.max(0, (Number(rec.count) || 0) - 1);
    const sum = Math.max(0, Math.round(((Number(rec.sum) || 0) - (Number(removed.s) || 0)) * 10) / 10);
    if (count === 0) {
      await env.REVIEWS.delete(key);
    } else {
      rec.count = count;
      rec.sum = sum;
      rec.items = items;
      await env.REVIEWS.put(key, JSON.stringify(rec));
    }
    // Permit this author to resubmit immediately from the same IP, without
    // clearing another reviewer's daily lock on a shared address.
    const hash = await ipHash(request);
    const dayKey = "rl:" + hash + ":" + tmdb;
    if (Number(await env.REVIEWS.get(dayKey) || "0") === Number(removed.at)) await env.REVIEWS.delete(dayKey);
    const next = count ? { count, sum } : null;
    const remainingLast = Number(await env.REVIEWS.get(dayKey) || "0");
    const retryAfterMs = remainingLast
      ? Math.max(0, REVIEWS_DAY_MS - (Date.now() - remainingLast)) : 0;
    return reviewsJson({ ok: true, tmdb, count, average: reviewsAverage(next),
      canResubmit: retryAfterMs === 0, retryAfterMs }, 200);
  } catch (e) {
    return reviewsJson({ ok: false, error: "Could not delete the review. Please try again." }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // SEO audit 2026-10-28 (claude-seo): www serves the same content with
    // www canonicals on detail pages. 301 everything to the apex so there
    // is exactly one host (sitemap + canonicals all use the apex).
    if (url.hostname === "www.flickatlas.co.uk") {
      url.hostname = "flickatlas.co.uk";
      return Response.redirect(url.href, 301);
    }
    if (url.pathname === "/api/reviews" && request.method === "GET") {
      return withSecHeaders(await handleReviewsGet(request, env, url));
    }
    if (url.pathname === "/api/review") {
      if (request.method === "POST") {
        return withSecHeaders(await handleReviewPost(request, env, url));
      }
      if (request.method === "DELETE") {
        return withSecHeaders(await handleReviewDelete(request, env));
      }
      return withSecHeaders(reviewsJson({ ok: false, error: "Method not allowed." }, 405));
    }
    const target = API_REWRITES[url.pathname];
    if (target && (request.method === "GET" || request.method === "HEAD")) {
      return withSecHeaders(await env.ASSETS.fetch(new Request(new URL(target, url), request)));
    }
    if (request.method === "GET") {
      // Normalize: the asset layer 307-redirects /movie -> /movie/ (trailing
      // slash), and after the redirect the pathname no longer matches
      // SEO_ROUTES — the injection silently never ran (caught live 2026-10-28:
      // /movie?id=1654581 served the generic shell although seo-meta.json
      // had the entry). Match on the slash-stripped path and fetch the shell
      // at the DIRECTORY url (<path>/, not <path>/index.html): fetching
      // /movie/index.html 307s back to /movie/ (query dropped) — caught live
      // 2026-10-28 16:38, the first fix (4d7e170c) fetched index.html and the
      // injection still never ran although the fixed code WAS deployed
      // (verified by downloading the live Worker script). The directory url
      // serves index.html directly with no redirect, so no redirect happens
      // at all and the canonical stays the clean sitemap URL (/movie?id=X).
      const normPath = url.pathname.replace(/\/$/, "") || "/";
      const key = seoKey(url, normPath);
      if (key) {
        const assetUrl = new URL(normPath + "/", url);
        const res = await env.ASSETS.fetch(new Request(assetUrl, request));
        const ctype = res.headers.get("content-type") || "";
        if (res.ok && ctype.indexOf("text/html") !== -1) {
          const meta = await loadSeoMeta(env, url);
          const entry = meta ? meta[key] : null;
          if (entry) {
            const html = await res.text();
            const m2 = Object.assign({}, entry);
            if (key.indexOf("daywise:") === 0) {
              m2.t = daywiseTitle(entry, url.searchParams.get("day"));
            }
            const headers = new Headers(res.headers);
            headers.delete("content-length");
            headers.delete("content-encoding");
            headers.delete("etag");
            headers.set("Cache-Control", "public, max-age=300");
            for (const [k, v] of Object.entries(SEC_HEADERS)) headers.set(k, v);
            // Canonical is always the apex, slash-free detail URL —
            // never the request host (www) and never the /movie/?id= form.
            const canonical = "https://flickatlas.co.uk" + normPath + url.search;
            return new Response(injectSeo(html, m2, canonical),
              { status: res.status, headers: headers });
          }
        }
        return withSecHeaders(res);
      }
      // SEO audit 2026-10-28 (claude-seo): directory routes (/movies,
      // /news, ...) 307-redirect to the trailing-slash form while their
      // canonical + sitemap use the slash-free form. Serve the shell
      // directly at the requested URL (the same directory-URL fetch the
      // SEO routes above already use), so the canonical URL returns 200
      // with no redirect. Falls through to the normal asset fetch when
      // the shell is missing or not HTML.
      const LISTING_ROUTES = new Set(["/movies", "/tv", "/box-office",
        "/box-office/milestones", "/upcoming", "/most-awaited", "/ott",
        "/trailers", "/celebrities", "/episode-guides", "/airing-today",
        "/dramas", "/where-to-watch", "/news", "/awards", "/about",
        "/contact", "/privacy", "/terms", "/dmca", "/search", "/person"]);
      if (LISTING_ROUTES.has(normPath) && !url.pathname.endsWith("/")) {
        const res = await env.ASSETS.fetch(new Request(new URL(normPath + "/", url), request));
        const ctype = res.headers.get("content-type") || "";
        if (res.ok && ctype.indexOf("text/html") !== -1) return withSecHeaders(res);
      }
    }
    return withSecHeaders(await env.ASSETS.fetch(request));
  }
};
