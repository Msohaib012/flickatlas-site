#!/usr/bin/env python3
"""Build js/stats-health.json — the site-health half of the FlickAtlas stats page.

Daily check (06:00 UTC = 11:00 PKT) of everything that can silently break:
  (a) latest Vercel deploy (Vercel API; needs VERCEL_TOKEN secret, else
      the deploy is recorded as "not checked")
  (b) DMCA / copyright inbox — "not checked" unless a status blob is
      injected via DMCA_STATUS_JSON env (JSON: {"status": "ok"|"attention",
      "detail": "..."}). There is no Gmail API wired in yet; the blob is
      how a future inbox check (or a manual note) feeds this page.
  (c) Search Console — REAL check via the webmasters API, authenticated
      with the same service account as GA4 (GA4_SERVICE_ACCOUNT_JSON
      secret). Queries searchanalytics for the last 7 days (clicks +
      impressions) and reads the indexed count from the sitemaps list.
      When no service-account secret is set, falls back to the
      SEARCH_CONSOLE_STATUS_JSON blob (manual note) if present.
  Plus a roll-up of the pipeline status copied from js/stats-pipeline.json.

Nothing here is ever faked: anything not actually checked is recorded as
"not checked" and the page says so.

Usage: stats-health.py
Env (all optional): VERCEL_TOKEN, VERCEL_PROJECT_ID (default: the
flickatlas project), DMCA_STATUS_JSON, SEARCH_CONSOLE_STATUS_JSON,
GA4_SERVICE_ACCOUNT_JSON (service-account key JSON, shared with GA4).
Requires the google-auth package (pip install google-auth) for the
Search Console check.
Exits 0 in every case; writes js/stats-health.json only when changed.
"""
import json
import os
import sys
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone


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


# ---------------------------------------------------------------- Search Console
# Real check via the Google Search Console (webmasters v3) API, authenticated
# with the same service account as GA4. The service account must be added
# as a user on the Search Console property (flickatlas.vercel.app) and the
# "Google Search Console API" must be enabled in its Cloud project —
# otherwise the API answers 403 and we report "not checked" with the fix.
SC_SITE_URL = "https://flickatlas.vercel.app/"
SC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"


def _sc_token():
    """Access token for the Search Console API from the service-account JSON.
    Returns (token, error): token is None on failure, error is one of
    'no-secret' | 'bad-json' | 'no-google-auth' | 'auth-error: ...'."""
    raw = (os.environ.get("GA4_SERVICE_ACCOUNT_JSON") or "").strip()
    if not raw:
        return None, "no-secret"
    try:
        info = json.loads(raw)
    except ValueError:
        return None, "bad-json"
    try:
        from google.oauth2 import service_account
        from google.auth.transport.requests import Request
        creds = service_account.Credentials.from_service_account_info(
            info, scopes=[SC_SCOPE])
        creds.refresh(Request())
        return creds.token, None
    except ImportError:
        return None, "no-google-auth"
    except Exception as e:
        return None, f"auth-error: {e}"


def _sc_request(token, method, url, body=None):
    """One authenticated Search Console API call. Returns the parsed JSON."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def check_search_console():
    """Real Search Console check: searchanalytics totals for the last 7 days
    (clicks + impressions) plus the indexed count from the sitemaps list.
    Never fakes a status — anything not actually verified is 'not checked'
    with a clear reason and the fix."""
    token, err = _sc_token()
    if err == "no-secret":
        return {"status": "not checked",
                "detail": "GA4_SERVICE_ACCOUNT_JSON secret not set",
                "indexed_pages": None}
    if err == "bad-json":
        return {"status": "not checked",
                "detail": "GA4_SERVICE_ACCOUNT_JSON is not valid JSON",
                "indexed_pages": None}
    if err == "no-google-auth":
        return {"status": "not checked",
                "detail": "google-auth library not installed in the workflow",
                "indexed_pages": None}
    if err:
        return {"status": "not checked",
                "detail": f"Search Console auth failed: {err}",
                "indexed_pages": None}
    site = urllib.parse.quote(SC_SITE_URL, safe="")
    # Search Console data lags ~2-3 days, so the 7-day window ends 3 days ago.
    end = datetime.now(timezone.utc).date() - timedelta(days=3)
    start = end - timedelta(days=6)
    try:
        data = _sc_request(
            token, "POST",
            f"https://www.googleapis.com/webmasters/v3/sites/{site}"
            "/searchAnalytics/query",
            {"startDate": start.isoformat(), "endDate": end.isoformat(),
             "dimensions": []})
    except urllib.error.HTTPError as e:
        if e.code == 403:
            return {"status": "not checked",
                    "detail": "403 — service account ko Search Console property (flickatlas.vercel.app) mein user banana hai (Settings → Users and permissions), aur Cloud project mein Search Console API enable karni hai",
                    "indexed_pages": None}
        if e.code == 404:
            return {"status": "not checked",
                    "detail": "Site Search Console mein add/verify nahi hai — search.google.com/search-console mein https://flickatlas.vercel.app/ property add aur verify karo",
                    "indexed_pages": None}
        return {"status": "not checked",
                "detail": f"Search Console API error: HTTP {e.code}",
                "indexed_pages": None}
    except (urllib.error.URLError, ValueError, OSError) as e:
        return {"status": "not checked",
                "detail": f"Search Console API error: {e}",
                "indexed_pages": None}
    rows = data.get("rows") or []
    clicks = sum(int(r.get("clicks") or 0) for r in rows)
    impressions = sum(int(r.get("impressions") or 0) for r in rows)
    # Indexed pages from the sitemaps list (best-effort; null when unavailable).
    indexed = None
    try:
        sm = _sc_request(
            token, "GET",
            f"https://www.googleapis.com/webmasters/v3/sites/{site}/sitemaps")
        total, found = 0, False
        for entry in sm.get("sitemap") or []:
            for c in entry.get("contents") or []:
                if c.get("type") == "web" and c.get("indexed") is not None:
                    total += int(c["indexed"])
                    found = True
        indexed = total if found else None
    except Exception:
        indexed = None
    detail = (f"Last 7 days (Google Search): {clicks} clicks · "
              f"{impressions} impressions")
    return {"status": "ok", "detail": detail, "indexed_pages": indexed}


def main():
    now = iso_now()

    deploy = check_deploy()

    dmca = env_blob("DMCA_STATUS_JSON")
    dmca_out = {
        "status": (dmca or {}).get("status", "not checked"),
        "detail": (dmca or {}).get(
            "detail",
            "No inbox check wired in yet — connect Gmail in Muse so the daily "
            "check can read mkdrivedata@gmail.com, or set the "
            "DMCA_STATUS_JSON repo secret."),
    }

    sc_out = check_search_console()
    if not (os.environ.get("GA4_SERVICE_ACCOUNT_JSON") or "").strip():
        # No service account configured: fall back to the manual blob
        # (a note the owner sets by hand). A real API error is reported
        # as-is and never masked by the blob.
        blob = env_blob("SEARCH_CONSOLE_STATUS_JSON")
        if blob:
            sc_out = {
                "status": blob.get("status", "not checked"),
                "detail": blob.get("detail",
                           "No Search Console check wired in yet"),
                "indexed_pages": blob.get("indexed_pages"),
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

