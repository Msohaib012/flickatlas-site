#!/usr/bin/env python3
"""Deploy the FlickAtlas static site to Cloudflare Workers Static Assets.

Runs on the GitHub runner as the last step of .github/workflows/
hourly-pipeline.yml, AFTER the commit step, gated on that step's
`committed` output (only runs when the run actually committed content).

Proven flow (spike-tested 2026-10-27 against worker `flickatlas-test`):
  1. POST .../workers/scripts/{name}/assets-upload-session
     body: {"manifest": {"/path": {"hash": sha256-first-16-bytes-hex,
                                   "size": n}}}
     -> {"jwt": upload_token, "buckets": [[hash, ...], ...]}
  2. For each bucket: POST .../workers/assets/upload?base64=true
     auth: Bearer <upload_token> (the JWT itself)
     multipart: one part per file, field name = hash, value = base64
     content, part Content-Type = the file's MIME type.
     -> 201 {"jwt": completion_token}
  3. PUT .../workers/scripts/{name} (multipart)
     metadata: {"main_module": "worker.mjs",
                "assets": {"jwt": completion_token,
                           "config": {"html_handling": "auto-trailing-slash", "run_worker_first": True}},
                "bindings": [{"type": "assets", "name": "ASSETS"}],
                "compatibility_date": "2026-10-27"}
     + worker.mjs part: a proxy that serves env.ASSETS.
  4. POST .../workers/scripts/{name}/subdomain {"enabled": true}
     (idempotent; API-created Workers have workers.dev disabled by
     default, so this is needed on every deploy).

Assets: every file in the local checkout EXCEPT paths under .github/
or scripts/, any dotfile/dotdir, README.md and LICENSE*.

Auth: the Cloudflare API token comes from the CLOUDFLARE_API_TOKEN
env var (set in the workflow from secrets.CLOUDFLARE_API_TOKEN).
Account ID and Worker name come from env vars with production defaults.

Exit codes:
  0  success, OR token unset/empty (warning only — the secret may not
     be set yet, and the pipeline must not fail for that).
  1  token present but the deploy errored.
Stdlib only — no third-party deps (runs on the GitHub runner).
"""
import base64
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
import uuid

ACCOUNT_ID = os.environ.get(
    "CLOUDFLARE_ACCOUNT_ID", "5bccc30e3708f9ec2ce1a31c2ca074ae")
SCRIPT_NAME = os.environ.get("CLOUDFLARE_WORKER_NAME", "flickatlas")
REPO_ROOT = os.environ.get("REPO_ROOT", os.getcwd())
COMPATIBILITY_DATE = "2026-10-27"
API_BASE = "https://api.cloudflare.com/client/v4"

MIME = {".html": "text/html", ".css": "text/css",
        ".js": "application/javascript", ".json": "application/json",
        ".svg": "image/svg+xml", ".png": "image/png",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".webp": "image/webp", ".gif": "image/gif",
        ".ico": "image/x-icon", ".txt": "text/plain",
        ".xml": "application/xml", ".webmanifest": "application/manifest+json",
        ".md": "text/markdown"}

WORKER_CODE = b'// FlickAtlas Worker: static assets + /api/* rewrites (same mapping as\n// vercel.json). /api/news -> /api-news.json, /api/trends -> /api-trends.json.\n// The JSON files are regenerated hourly by the pipeline and deployed as\n// static assets; serving their bytes unchanged keeps the frontend contract\n// exact (the frontend fetches /api/news with no query params and expects\n// {generated, count, items: [...]}). Everything else passes through to\n// the static assets. Only GET/HEAD are rewritten.\n//\n// SEO (scripts/seo_assets.py, hourly): detail pages are ONE static shell\n// each (/movie?id=, /show?id=, /news-item?id=, /box-office-day?title=&day=,\n// /category?cat=) rendered client-side from JS data, so a crawler that\n// does not run JS would see the same generic shell title for every film\n// and every article. For those routes the Worker injects the real\n// <title>/meta/OG/Twitter/canonical/JSON-LD from js/seo-meta.json\n// (regenerated hourly from the live data) into the served HTML.\n// Unknown id / missing meta file / fetch error -> the shell is served\n// unchanged (safe fallback). Listing + legal shells carry their own\n// static meta in the HTML; the Worker never injects on those routes.\n//\n// The deploy MUST set assets.config.run_worker_first=true (see\n// scripts/cloudflare_deploy.py): by default Workers Static Assets serves a\n// matching file directly WITHOUT running this Worker, so neither the SEO\n// injection nor the headers below would ever happen for /movie?id= etc.\n// Proven live on the admin panel 2026-10-28: with run_worker_first off,\n// /app.js served zero security headers even with a _headers file at the\n// asset root; with it on, the Worker wraps every response (verified).\n//\n// Security headers are set HERE, not via _headers: when a Worker script\n// runs, Cloudflare ignores _headers (verified live \xe2\x80\x94 the file was present\n// and downloadable, the headers were not served). Same policy as _headers.\nconst SEC_HEADERS = {\n  \'Content-Security-Policy\': "default-src \'self\'; script-src \'self\' \'unsafe-inline\' https://www.googletagmanager.com; style-src \'self\' \'unsafe-inline\' https://fonts.googleapis.com; img-src \'self\' data: https://image.tmdb.org https://images.weserv.nl https://www.google-analytics.com https://www.googletagmanager.com; font-src \'self\' https://fonts.gstatic.com; connect-src \'self\' https://api.themoviedb.org https://www.google-analytics.com https://www.googletagmanager.com; frame-src https://www.youtube-nocookie.com https://www.youtube.com; object-src \'none\'; base-uri \'self\'; frame-ancestors \'self\'; form-action \'self\'",\n  \'X-Content-Type-Options\': \'nosniff\',\n  \'X-Frame-Options\': \'SAMEORIGIN\',\n  \'Referrer-Policy\': \'strict-origin-when-cross-origin\',\n  \'Permissions-Policy\': \'camera=(), microphone=(), geolocation=(), payment=()\',\n  \'Strict-Transport-Security\': \'max-age=31536000; includeSubDomains\',\n};\nfunction withSecHeaders(res) {\n  const h = new Headers(res.headers);\n  for (const [k, v] of Object.entries(SEC_HEADERS)) h.set(k, v);\n  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });\n}\nconst API_REWRITES = { "/api/news": "/api-news.json", "/api/trends": "/api-trends.json" };\nconst SEO_ROUTES = { "/movie": "movie", "/show": "tv", "/news-item": "news",\n                     "/box-office-day": "daywise", "/category": "cat" };\nconst OG_TYPE = { "Movie": "video.movie", "TVSeries": "video.tv_show",\n                  "NewsArticle": "article", "CollectionPage": "website" };\nlet SEO_CACHE = null;\nlet SEO_CACHE_AT = 0;\nasync function loadSeoMeta(env, url) {\n  const now = Date.now();\n  if (SEO_CACHE && now - SEO_CACHE_AT < 600000) return SEO_CACHE;\n  try {\n    const res = await env.ASSETS.fetch(new Request(new URL("/js/seo-meta.json", url)));\n    if (!res.ok) return SEO_CACHE;\n    SEO_CACHE = await res.json();\n    SEO_CACHE_AT = now;\n    return SEO_CACHE;\n  } catch (e) {\n    return SEO_CACHE;\n  }\n}\nfunction seoKey(url) {\n  const kind = SEO_ROUTES[url.pathname];\n  if (!kind) return null;\n  if (kind === "cat") {\n    const cat = url.searchParams.get("cat");\n    return cat ? "cat:" + cat : null;\n  }\n  if (kind === "daywise") {\n    const id = url.searchParams.get("title");\n    return id ? "daywise:" + id : null;\n  }\n  const id = url.searchParams.get("id");\n  return id ? kind + ":" + id : null;\n}\nfunction esc(s) {\n  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")\n    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");\n}\nfunction injectSeo(html, meta, canonical) {\n  let out = html;\n  const title = esc(meta.t);\n  if (/<title>[^<]*<\\/title>/i.test(out)) {\n    out = out.replace(/<title>[^<]*<\\/title>/i, "<title>" + title + "</title>");\n  } else {\n    out = out.replace(/<head[^>]*>/i, function (m) { return m + "<title>" + title + "</title>"; });\n  }\n  const desc = esc(meta.d);\n  const descRe = /<meta[^>]+name=["\']description["\'][^>]*>/i;\n  if (descRe.test(out)) {\n    out = out.replace(descRe, \'<meta name="description" content="\' + desc + \'">\');\n  } else {\n    out = out.replace(/<\\/title>/i, function (m) { return m + "\\n  " + \'<meta name="description" content="\' + desc + \'">\'; });\n  }\n  const kwRe = /<meta[^>]+name=["\']keywords["\'][^>]*>/i;\n  if (kwRe.test(out)) {\n    out = out.replace(kwRe, \'<meta name="keywords" content="\' + esc(meta.k) + \'">\');\n  } else {\n    out = out.replace(/<\\/title>/i, function (m) { return m + "\\n  " + \'<meta name="keywords" content="\' + esc(meta.k) + \'">\'; });\n  }\n  const ogType = OG_TYPE[(meta.ld && meta.ld["@type"]) || ""] || "website";\n  const tags = [\n    \'<meta property="og:title" content="\' + title + \'">\',\n    \'<meta property="og:description" content="\' + desc + \'">\',\n    \'<meta property="og:type" content="\' + ogType + \'">\',\n    \'<meta property="og:url" content="\' + esc(canonical) + \'">\',\n    \'<meta property="og:image" content="\' + esc(meta.img) + \'">\',\n    \'<meta property="og:site_name" content="FlickAtlas">\',\n    \'<meta name="twitter:card" content="summary_large_image">\',\n    \'<meta name="twitter:title" content="\' + title + \'">\',\n    \'<meta name="twitter:description" content="\' + desc + \'">\',\n    \'<meta name="twitter:image" content="\' + esc(meta.img) + \'">\',\n    \'<link rel="canonical" href="\' + esc(canonical) + \'">\'\n  ];\n  if (meta.ld) {\n    tags.push(\'<script type="application/ld+json">\' +\n      JSON.stringify(meta.ld).replace(/</g, "\\\\u003c") + "</script>");\n  }\n  out = out.replace(/<\\/head>/i, function (m) { return "  " + tags.join("\\n  ") + "\\n" + m; });\n  return out;\n}\nfunction daywiseTitle(meta, day) {\n  if (day && /^\\d+$/.test(day)) {\n    return meta.t + " Box Office Collection Day " + day + " \\u2014 India Net & Overseas | FlickAtlas";\n  }\n  return meta.t + " Box Office Collection Day-Wise \\u2014 India Net & Overseas | FlickAtlas";\n}\nexport default {\n  async fetch(request, env) {\n    const url = new URL(request.url);\n    const target = API_REWRITES[url.pathname];\n    if (target && (request.method === "GET" || request.method === "HEAD")) {\n      return withSecHeaders(await env.ASSETS.fetch(new Request(new URL(target, url), request)));\n    }\n    if (request.method === "GET") {\n      const key = seoKey(url);\n      if (key) {\n        const res = await env.ASSETS.fetch(request);\n        const ctype = res.headers.get("content-type") || "";\n        if (res.ok && ctype.indexOf("text/html") !== -1) {\n          const meta = await loadSeoMeta(env, url);\n          const entry = meta ? meta[key] : null;\n          if (entry) {\n            const html = await res.text();\n            const m2 = Object.assign({}, entry);\n            if (key.indexOf("daywise:") === 0) {\n              m2.t = daywiseTitle(entry, url.searchParams.get("day"));\n            }\n            const headers = new Headers(res.headers);\n            headers.delete("content-length");\n            headers.delete("content-encoding");\n            headers.delete("etag");\n            headers.set("Cache-Control", "public, max-age=300");\n            for (const [k, v] of Object.entries(SEC_HEADERS)) headers.set(k, v);\n            return new Response(injectSeo(html, m2, url.href),\n              { status: res.status, headers: headers });\n          }\n        }\n        return withSecHeaders(res);\n      }\n    }\n    return withSecHeaders(await env.ASSETS.fetch(request));\n  }\n};\n'

# Files/dirs never deployed (site content is everything else).
EXCLUDED_TOP_DIRS = {".github", "scripts"}


def is_excluded(rel_path):
    """rel_path uses '/' separators, relative to the repo root."""
    parts = rel_path.split("/")
    if any(p.startswith(".") for p in parts):
        return True  # any dotfile / dotdir (incl. .git)
    if parts[0] in EXCLUDED_TOP_DIRS:
        return True
    base = parts[-1]
    if base == "README.md" or base.startswith("LICENSE"):
        return True
    return False


def collect_assets():
    files = {}  # url_path -> (bytes, hash32, mime)
    for root, dirs, names in os.walk(REPO_ROOT):
        dirs[:] = [d for d in dirs
                   if not d.startswith(".") and d not in EXCLUDED_TOP_DIRS]
        for name in names:
            local = os.path.join(root, name)
            rel = os.path.relpath(local, REPO_ROOT).replace(os.sep, "/")
            if is_excluded(rel):
                continue
            with open(local, "rb") as f:
                data = f.read()
            h = hashlib.sha256(data).digest()[:16].hex()
            ext = os.path.splitext(name)[1].lower()
            files["/" + rel] = (data, h, MIME.get(ext, "application/octet-stream"))
    return files


def cf_json(method, path, token, data=None):
    """Cloudflare API call with the account API token. Returns (status, body)."""
    url = API_BASE + path
    body = None
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if data is not None:
        body = json.dumps(data).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.build_opener().open(req, data=body, timeout=120) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:1000]
        print(f"ERROR: HTTP {e.code} on {method} {path}: {detail}", file=sys.stderr)
        raise


def multipart(parts):
    """parts: list of (field_name, filename_or_None, content_type, body_bytes)."""
    boundary = "----cfdeploy-" + uuid.uuid4().hex
    out = []
    for name, filename, ctype, body in parts:
        out.append(f"--{boundary}\r\n".encode())
        disp = f'Content-Disposition: form-data; name="{name}"'
        if filename:
            disp += f'; filename="{filename}"'
        out.append((disp + "\r\n").encode())
        out.append(f"Content-Type: {ctype}\r\n\r\n".encode())
        out.append(body + b"\r\n")
    out.append(f"--{boundary}--\r\n".encode())
    return b"".join(out), f"multipart/form-data; boundary={boundary}"


def main():
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not token:
        print("WARNING: CLOUDFLARE_API_TOKEN is not set — skipping "
              "Cloudflare deploy (secret not configured yet). "
              "Site still deploys via Vercel; exit 0.")
        return 0

    files = collect_assets()
    total_bytes = sum(len(v[0]) for v in files.values())
    print(f"Cloudflare deploy: worker={SCRIPT_NAME} account={ACCOUNT_ID}")
    print(f"Assets: {len(files)} files, {total_bytes} bytes")

    # --- Step 1: upload session ---
    manifest = {p: {"hash": v[1], "size": len(v[0])} for p, v in files.items()}
    try:
        st, r = cf_json(
            "POST",
            f"/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}/assets-upload-session",
            token, data={"manifest": manifest})
    except urllib.error.HTTPError:
        return 1
    if not r.get("success"):
        print("ERROR: assets-upload-session failed:",
              json.dumps(r, indent=2)[:1500], file=sys.stderr)
        return 1
    upload_jwt = r["result"]["jwt"]
    buckets = r["result"]["buckets"]
    uploaded = sum(len(b) for b in buckets)
    print(f"Upload session: HTTP {st}, {len(buckets)} bucket(s), "
          f"{uploaded} file(s) to upload "
          f"({len(files) - uploaded} already present)")
    hash_to_path = {v[1]: p for p, v in files.items()}

    # --- Step 2: upload file contents, one request per bucket ---
    completion_jwt = None
    for bucket in buckets:
        parts = []
        for h in bucket:
            p = hash_to_path[h]
            data, _, mime = files[p]
            parts.append((h, None, mime, base64.b64encode(data)))
        body, ctype = multipart(parts)
        req = urllib.request.Request(
            f"{API_BASE}/accounts/{ACCOUNT_ID}/workers/assets/upload?base64=true",
            method="POST", data=body)
        req.add_header("Content-Type", ctype)
        req.add_header("Authorization", f"Bearer {upload_jwt}")
        try:
            with urllib.request.build_opener().open(req, timeout=180) as resp:
                st2, r2 = resp.status, json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            print(f"ERROR: asset upload HTTP {e.code}: "
                  f"{e.read().decode()[:800]}", file=sys.stderr)
            return 1
        if not r2.get("success"):
            print("ERROR: asset upload failed:",
                  json.dumps(r2, indent=2)[:1500], file=sys.stderr)
            return 1
        if r2.get("result", {}).get("jwt"):
            completion_jwt = r2["result"]["jwt"]
    if completion_jwt is None:
        # Nothing needed uploading (all hashes already present): the
        # session JWT itself carries the asset set.
        completion_jwt = upload_jwt
        print("No files needed uploading; using session JWT as asset JWT.")

    # --- Step 3: deploy the Worker with the assets binding ---
    metadata = json.dumps({
        "main_module": "worker.mjs",
        "assets": {"jwt": completion_jwt,
                   "config": {"html_handling": "auto-trailing-slash", "run_worker_first": True}},
        "bindings": [{"type": "assets", "name": "ASSETS"}],
        "compatibility_date": COMPATIBILITY_DATE,
    }).encode()
    parts = [
        ("metadata", None, "application/json", metadata),
        ("worker.mjs", "worker.mjs", "application/javascript+module", WORKER_CODE),
    ]
    body, ctype = multipart(parts)
    req = urllib.request.Request(
        f"{API_BASE}/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}",
        method="PUT", data=body)
    req.add_header("Content-Type", ctype)
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.build_opener().open(req, timeout=120) as resp:
            st3, r3 = resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"ERROR: script deploy HTTP {e.code}: "
              f"{e.read().decode()[:1000]}", file=sys.stderr)
        return 1
    if not r3.get("success"):
        print("ERROR: script deploy failed:",
              json.dumps(r3, indent=2)[:2000], file=sys.stderr)
        return 1
    print(f"Worker deployed: HTTP {st3}, id={r3.get('result', {}).get('id')}")

    # --- Step 4: enable the workers.dev subdomain (idempotent) ---
    try:
        st4, r4 = cf_json(
            "POST",
            f"/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}/subdomain",
            token, data={"enabled": True})
        print(f"Subdomain enabled: HTTP {st4}, success={r4.get('success')}")
    except urllib.error.HTTPError:
        print("WARNING: subdomain enable failed — deploy itself succeeded; "
              "check the workers.dev route in the dashboard.", file=sys.stderr)

    # --- Summary ---
    subdomain = None
    try:
        _, r5 = cf_json("GET", f"/accounts/{ACCOUNT_ID}/workers/subdomain",
                        token)
        subdomain = r5.get("result", {}).get("subdomain")
    except urllib.error.HTTPError:
        pass
    url = (f"https://{SCRIPT_NAME}.{subdomain}.workers.dev"
           if subdomain else f"https://{SCRIPT_NAME}.workers.dev (subdomain unknown)")
    print("---- Cloudflare deploy summary ----")
    print(f"  worker:       {SCRIPT_NAME}")
    print(f"  files total:  {len(files)}")
    print(f"  files uploaded: {uploaded}")
    print(f"  deploy URL:   {url}")
    print("Cloudflare deploy succeeded.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

