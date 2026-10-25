#!/usr/bin/env python3
"""Build js/stats-health.json — the site-health half of the FlickAtlas stats page.

Daily check (06:00 UTC = 11:00 PKT) of everything that can silently break:
  (a) latest Vercel deploy (Vercel API; needs VERCEL_TOKEN secret, else
      the deploy is recorded as "not checked")
  (b) DMCA / copyright inbox — "not checked" unless a status blob is
      injected via DMCA_STATUS_JSON env (JSON: {"status": "ok"|"attention",
      "detail": "..."}). There is no Gmail API wired in yet; the blob is
      how a future inbox check (or a manual note) feeds this page.
  (c) Search Console — same pattern via SEARCH_CONSOLE_STATUS_JSON env
      (JSON: {"status": ..., "detail": ..., "indexed_pages": N}).
  Plus a roll-up of the pipeline status copied from js/stats-pipeline.json.

Nothing here is ever faked: anything not actually checked is recorded as
"not checked" and the page says so.

Usage: stats-health.py
Env (all optional): VERCEL_TOKEN, VERCEL_PROJECT_ID (default: the
flickatlas project), DMCA_STATUS_JSON, SEARCH_CONSOLE_STATUS_JSON.
Exits 0 in every case; writes js/stats-health.json only when changed.
"""
import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERCEL_PROJECT_ID = os.environ.get(
    "VERCEL_PROJECT_ID", "prj_2TgsZrPavD20OB4P8xbMhYzFVBBl")


def iso_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def env_blob(name):
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return None
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except ValueError:
        print(f"stats-health: {name} is not valid JSON, ignoring")
        return None


def check_deploy():
    token = (os.environ.get("VERCEL_TOKEN") or "").strip()
    if not token:
        return {"status": "not checked",
                "detail": "VERCEL_TOKEN secret not set"}
    url = ("https://api.vercel.com/v6/deployments"
           f"?projectId={VERCEL_PROJECT_ID}&limit=1")
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.load(r)
    except (urllib.error.URLError, urllib.error.HTTPError,
            ValueError, OSError) as e:
        return {"status": "not checked", "detail": f"Vercel API error: {e}"}
    deps = data.get("deployments") or []
    if not deps:
        return {"status": "not checked",
                "detail": "no deployments returned"}
    d = deps[0]
    state = (d.get("state") or "").upper()
    created = d.get("createdAt")
    when = None
    if created:
        try:
            when = datetime.fromtimestamp(int(created) / 1000,
                                          tz=timezone.utc).strftime(
                                              "%Y-%m-%dT%H:%M:%SZ")
        except (ValueError, TypeError):
            when = None
    status = {"READY": "ready", "ERROR": "error",
              "BUILDING": "building", "QUEUED": "building",
              "CANCELED": "error"}.get(state, "unknown")
    return {
        "status": status,
        "time": when,
        "url": d.get("url"),
        "target": d.get("target"),
        "commit": (d.get("meta") or {}).get("githubCommitSha"),
        "detail": f"latest deploy is {state.lower()}" if state else None,
    }


def main():
    now = iso_now()

    deploy = check_deploy()

    dmca = env_blob("DMCA_STATUS_JSON")
    dmca_out = {
        "status": (dmca or {}).get("status", "not checked"),
        "detail": (dmca or {}).get("detail",
                   "No inbox check wired in yet — check mkdrivedata@gmail.com"),
    }

    sc = env_blob("SEARCH_CONSOLE_STATUS_JSON")
    sc_out = {
        "status": (sc or {}).get("status", "not checked"),
        "detail": (sc or {}).get("detail",
                   "No Search Console check wired in yet"),
        "indexed_pages": (sc or {}).get("indexed_pages"),
    }

    pipe = load_json(os.path.join(ROOT, "js", "stats-pipeline.json"), {})
    statuses = [((pipe.get(k) or {}).get("status") or "unknown")
                for k in ("fetch", "gemini", "publish")]
    if all(s == "success" for s in statuses):
        pipe_status = "ok"
    elif any(s in ("failure", "error", "failed") for s in statuses):
        pipe_status = "degraded"
    elif all(s == "unknown" for s in statuses):
        pipe_status = "unknown"
    else:
        pipe_status = "degraded"
    pipeline = {
        "status": pipe_status,
        "fetch": statuses[0],
        "gemini": statuses[1],
        "publish": statuses[2],
        "generated": pipe.get("generated"),
    }

    out = {
        "generated": now,
        "deploy": deploy,
        "pipeline": pipeline,
        "dmca": dmca_out,
        "search_console": sc_out,
    }
    out_path = os.path.join(ROOT, "js", "stats-health.json")
    # Compare WITHOUT the generated timestamp (see stats-pipeline.py).
    existing = load_json(out_path, {})
    old = {k: v for k, v in existing.items() if k != "generated"}
    new = {k: v for k, v in out.items() if k != "generated"}
    if old != new:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
        print(f"stats-health: wrote {out_path} (changed)")
    else:
        print("stats-health: no change")
    print(f"deploy={deploy['status']} pipeline={pipe_status} "
          f"dmca={dmca_out['status']} search_console={sc_out['status']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
