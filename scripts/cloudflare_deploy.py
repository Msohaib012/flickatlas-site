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
                           "config": {"html_handling": "auto-trailing-slash"}},
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

WORKER_CODE = b"""// FlickAtlas Worker: static assets + /api/* rewrites (same mapping as
// vercel.json). /api/news -> /api-news.json, /api/trends -> /api-trends.json.
// The JSON files are regenerated hourly by the pipeline and deployed as
// static assets; serving their bytes unchanged keeps the frontend contract
// exact (the frontend fetches /api/news with no query params and expects
// {generated, count, items: [...]}). Everything else passes through to
// the static assets. Only GET/HEAD are rewritten.
const API_REWRITES = { "/api/news": "/api-news.json", "/api/trends": "/api-trends.json" };
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = API_REWRITES[url.pathname];
    if (target && (request.method === "GET" || request.method === "HEAD")) {
      return env.ASSETS.fetch(new Request(new URL(target, url), request));
    }
    return env.ASSETS.fetch(request);
  }
};
"""

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
                   "config": {"html_handling": "auto-trailing-slash"}},
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
