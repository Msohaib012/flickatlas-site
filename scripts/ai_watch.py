#!/usr/bin/env python3
"""FlickAtlas AI watchdog — hourly guard loop (docs/WATCHDOG-SYSTEM.md).

Runs as its OWN workflow (.github/workflows/watchdog.yml) — NOT a pipeline
step (owner rule 2026-10-28: "watchdog bhi GitHub/Gemini ki tarah so na
jaye"). Two triggers:
  PRIMARY — the hourly pipeline dispatches this workflow AFTER the deploy
    step, with the pipeline run id (WATCHDOG_PIPELINE_RUN_ID). The verdict
    covers the UTC hour that pipeline run was created in.
  BACKUP — own schedule (25 * * * * UTC). Checks whether a verdict for
    the PREVIOUS hour already exists: yes -> SKIP (no Gemini call, no
    write); no -> verdict from the (stale) state + ONE recovery re-dispatch
    of the hourly pipeline (max 1/hour; never when the pipeline failed 2
    hours in a row). In-flight checks (pipeline or another watchdog run)
    make a false "missing" impossible.
Every run:

  1. Reads the kill-switch flag (data/automation-state.json, key
     `ai_watch`; missing file = ON). If OFF, writes a skipped
     out/ai-watch.json and exits 0. The watchdog only READS this file.
  2. Builds ONE compact state summary (step-runs, daily-history, fetch
     report, gemini batch, titles, daywise, tavily) + the owner's 5
     failure-mode evidence + the failed step's log tail (only if a step
     failed this run; bounded, best-effort).
  3. Runs the SAFE auto-fixes only (missed-hour confirm, re-run of a
     failed idempotent cap-free step via workflow_dispatch, DNS-dead
     source prune after 48h of confirmations). Everything else is
     report-only.
  4. Calls Gemini (key rotation GEMINI_API_KEY_1..6, model
     gemini-3.5-flash-lite, responseSchema) with the SYSTEM SPEC doc +
     the state summary, and writes out/ai-watch.json (verdicts +
     auto-fix log + checked_at PKT).

NEVER-FAIL CONTRACT: this script exits 0 always. 429/quota, missing
state files, a bad Gemini reply, or any exception -> a minimal
out/ai-watch.json with status "check-failed"/"skipped" + the reason.
It NEVER re-runs gemini_batch, NEVER deletes published data, NEVER
changes caps, NEVER touches keys/secrets, NEVER edits site content or
code. Stdlib only.
"""
import json
import os
import re
import socket
import sys
import urllib.request
import urllib.error
import zipfile
import io
from datetime import datetime, timezone, timedelta

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO_ROOT, "out")
WATCH_PATH = os.path.join(OUT_DIR, "ai-watch.json")
SPEC_PATH = os.path.join(REPO_ROOT, "docs", "WATCHDOG-SYSTEM.md")
FLAG_PATH = os.path.join(REPO_ROOT, "data", "automation-state.json")
REGISTRY_PATH = os.path.join(REPO_ROOT, "scripts", "registry.json")

MODEL = "gemini-3.5-flash-lite"
GH_API = "https://api.github.com"
GH_REPO = os.environ.get("GITHUB_REPOSITORY", "Msohaib012/flickatlas-site")
PIPELINE_WORKFLOW = "hourly-pipeline.yml"
WATCHDOG_WORKFLOW = "watchdog.yml"
WATCHDOG_MODE = os.environ.get("WATCHDOG_MODE", "").strip().lower()
WATCHDOG_PIPELINE_RUN_ID = os.environ.get(
    "WATCHDOG_PIPELINE_RUN_ID", "").strip()
PKT = timezone(timedelta(hours=5))
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

# Gates in PKT (from docs/WATCHDOG-SYSTEM.md §7) — used by the
# deterministic fallback verdicts when Gemini is unavailable.
GATES_PKT = {
    "fetch": "har ghante",
    "gemini_batch": "har ghante (cap 40/day)",
    "apply_auto": "har ghante",
    "convert_news": "har ghante",
    "ott": "har ghante",
    "publish": "har ghante (manzoori par)",
    "stats_traffic": "har ghante",
    "multisource_boxoffice": "07:00 / 13:00 / 19:00 / 01:00 PKT",
    "episode_guides": "00:00 / 06:00 / 12:00 / 18:00 PKT",
    "title_seed": "23:00 PKT",
    "gemini_reviews": "00:00 PKT",
    "trending_weekly": "23:00 PKT",
    "overseas_ai": "13:00 PKT",
    "tavily_boxoffice": "13:00 + 23:00 PKT",
    "stats_pipeline": "har 6 ghante",
    "stats_health": "11:00 PKT",
    "metadata_refresh": "Itwaar 23:00 PKT",
    "providers_backfill": "07:00 PKT",
}

# step -> standalone workflow that may be re-dispatched on failure.
# Only idempotent + cap-free steps. gemini_batch is NEVER here (cap);
# episode_guides is NEVER here (re-run re-spends summary tokens);
# fetch / multisource / apply_auto / ott / publish have no standalone
# workflow — the hourly cadence retries them next hour by design.
SAFE_RERUN = {
    "stats_health": "stats-health.yml",
    "stats_pipeline": "stats-pipeline.yml",
    "stats_traffic": "stats-traffic.yml",
    "convert_news": "news-refresh.yml",
    "title_seed": "title-seed.yml",
}

CATEGORY_IDS = ["movies", "box_office", "celebrities", "upcoming", "ott",
                "tv_dramas", "trailers", "episodes", "awards", "music",
                "viral"]
CATEGORY_UR = {
    "movies": "Movies", "box_office": "Box Office",
    "celebrities": "Celebrity news", "upcoming": "Upcoming releases",
    "ott": "OTT / Streaming", "tv_dramas": "TV & Dramas",
    "trailers": "Trailers", "episodes": "Episodes",
    "awards": "Awards", "music": "Music / OST", "viral": "Viral",
}
# daily-history per_category display names -> slug ids
CAT_NAME_TO_ID = {
    "Movies": "movies", "Box Office": "box_office",
    "Celebrity news & events": "celebrities",
    "Upcoming releases": "upcoming", "OTT / Streaming": "ott",
    "TV & Dramas": "tv_dramas", "Trailers": "trailers",
    "Episodes": "episodes", "Awards": "awards",
    "Music / OST": "music", "Entertainment viral": "viral",
}

VERDICT_SCHEMA = {
    "type": "object",
    "properties": {
        "checked_at": {"type": "string"},
        "overall": {"type": "string", "enum": ["theek", "dhyaan-do"]},
        "verdicts": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "kind": {"type": "string", "enum": ["step", "category"]},
                "name_ur": {"type": "string"},
                "status": {"type": "string",
                           "enum": ["theek", "khaali", "purana",
                                    "update-chahiye"]},
                "modes": {"type": "array", "items": {
                    "type": "string",
                    "enum": ["a", "b", "c", "d", "e"]}},
                "evidence_ur": {"type": "string"},
                "fix": {"type": "string",
                        "enum": ["search", "dobara-chalao", "intezaar",
                                 "source", "koi-nahi"]},
                "auto_fixable": {"type": "boolean"},
                "note_ur": {"type": "string"},
            },
            "required": ["id", "kind", "name_ur", "status", "modes",
                         "evidence_ur", "fix", "auto_fixable"],
        }},
        "autofixes": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "what_ur": {"type": "string"},
                "why_ur": {"type": "string"},
            },
        }},
        "report_only": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["checked_at", "overall", "verdicts"],
}


def log(msg):
    print(f"ai-watch: {msg}", flush=True)


def load_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")


def pkt_now():
    return datetime.now(timezone.utc).astimezone(PKT)


def pkt_str(iso):
    if not iso:
        return None
    try:
        return datetime.fromisoformat(
            iso.replace("Z", "+00:00")).astimezone(PKT).strftime(
                "%Y-%m-%d %H:%M")
    except Exception:
        return None


def flag_on():
    """Kill switch: data/automation-state.json key ai_watch.
    Missing file = ON. Only READ, never written by this script."""
    data = load_json(FLAG_PATH, None)
    if data is None:
        return True
    if not isinstance(data, dict):
        return True
    return data.get("ai_watch", True) is not False


# ---------------------------------------------------------------- Gemini
def gemini_keys():
    keys = []
    for i in range(1, 7):
        k = os.environ.get(f"GEMINI_API_KEY_{i}", "").strip()
        if k:
            keys.append(k)
    if not keys:
        k = os.environ.get("GEMINI_API_KEY", "").strip()
        if k:
            keys.append(k)
    return keys


def call_gemini(keys, prompt, schema, max_tokens=8192):
    """Try each key in turn; 429/5xx moves to the next key. Dict or None."""
    last_err = None
    for key in keys:
        try:
            body = json.dumps({
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {
                    "responseMimeType": "application/json",
                    "responseSchema": schema,
                    "maxOutputTokens": max_tokens,
                },
            }).encode("utf-8")
            req = urllib.request.Request(
                f"https://generativelanguage.googleapis.com/v1beta/models/"
                f"{MODEL}:generateContent",
                data=body,
                headers={"x-goog-api-key": key,
                         "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=90) as r:
                resp = json.load(r)
            text = resp["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(text)
        except Exception as e:
            last_err = e
            log(f"gemini key ...{key[-4:]} failed: {e}")
            continue
    log(f"gemini: all keys failed ({last_err})")
    return None


def _is_nonpublic_ip(ip):
    """CGNAT / private / loopback — a real public site never resolves here.
    (The dev VM's resolver is captive and returns 198.18.x.x for
    everything, including .invalid — without this check the DNS test
    would lie in that environment.)"""
    parts = ip.split(".")
    if len(parts) != 4:
        return False
    try:
        a, b = int(parts[0]), int(parts[1])
    except ValueError:
        return False
    return (a == 10 or a == 127 or (a == 172 and 16 <= b <= 31)
            or (a == 192 and b == 168) or (a == 198 and b in (18, 19)))


def dns_dead(host):
    """True when the host does not resolve to any public address."""
    try:
        infos = socket.getaddrinfo(host, 443, socket.AF_INET)
    except Exception:
        return True
    if not infos:
        return True
    return all(_is_nonpublic_ip(info[4][0]) for info in infos)


# ------------------------------------------------------------- GitHub API
def gh_request(method, path, token, data=None):
    req = urllib.request.Request(
        GH_API + path, method=method,
        data=json.dumps(data).encode("utf-8") if data is not None else None,
        headers={"Authorization": f"Bearer {token}",
                 "Accept": "application/vnd.github+json",
                 "User-Agent": BROWSER_UA,
                 "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        if r.status == 204:
            return None
        return json.load(r)


def failed_step_log_tail(token, run_id):
    """Failed step's log tail ONLY (bounded, best-effort). Returns a
    short string or None. Never raises."""
    try:
        jobs = gh_request("GET",
                           f"/repos/{GH_REPO}/actions/runs/{run_id}/jobs"
                           "?per_page=30", token)
        failed = []
        for job in (jobs or {}).get("jobs", []):
            for st in job.get("steps", []):
                if st.get("conclusion") == "failure":
                    failed.append((job["id"], st["name"]))
        if not failed:
            return None
        job_id, step_name = failed[0]
        req = urllib.request.Request(
            f"{GH_API}/repos/{GH_REPO}/actions/jobs/{job_id}/logs",
            headers={"Authorization": f"Bearer {token}",
                     "User-Agent": BROWSER_UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read(3 * 1024 * 1024)  # cap 3 MB
        try:
            zf = zipfile.ZipFile(io.BytesIO(raw))
            names = zf.namelist()
            text = zf.read(names[0]).decode("utf-8", "replace")
        except Exception:
            text = raw.decode("utf-8", "replace")
        lines = [ln for ln in text.splitlines() if step_name in ln]
        tail = lines[-40:]
        out = "\n".join(tail)
        return out[:2000] if out else None
    except Exception as e:
        log(f"log tail unavailable: {e}")
        return None


def dispatch_workflow(token, workflow_file):
    """POST a workflow_dispatch (ref main). Returns True on accept."""
    try:
        gh_request("POST",
                   f"/repos/{GH_REPO}/actions/workflows/{workflow_file}"
                   "/dispatches",
                   token, {"ref": "main"})
        return True
    except Exception as e:
        log(f"dispatch {workflow_file} failed: {e}")
        return False


# ------------------------------------------------------- self-waking (new)
def utc_hour_iso(dt):
    """Floor a datetime to its UTC hour: '2026-10-28T08:00:00Z'."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:00:00Z")


def pipeline_run_hour(token, run_id):
    """Target hour for a PRIMARY run: the UTC hour the pipeline run was
    created in (exact, from the Actions API). None on any failure."""
    if not token or not run_id:
        return None
    try:
        run = gh_request(
            "GET", f"/repos/{GH_REPO}/actions/runs/{run_id}", token)
        created = (run or {}).get("created_at")
        if not created:
            return None
        return utc_hour_iso(
            datetime.fromisoformat(created.replace("Z", "+00:00")))
    except Exception as e:
        log(f"pipeline run hour lookup failed: {e}")
        return None


def workflow_in_flight(token, workflow_file, window_min,
                       exclude_run_id=None):
    """True when a run of this workflow is in_progress/queued and started
    within the last window_min minutes. False on any API failure
    (fail-open: the redispatch guard below still protects)."""
    if not token:
        return False
    try:
        runs = gh_request(
            "GET",
            f"/repos/{GH_REPO}/actions/workflows/{workflow_file}"
            "/runs?per_page=10", token)
        now = datetime.now(timezone.utc)
        for r in (runs or {}).get("workflow_runs", []):
            if str(r.get("id")) == str(exclude_run_id):
                continue
            if r.get("status") not in ("in_progress", "queued"):
                continue
            try:
                created = datetime.fromisoformat(
                    r["created_at"].replace("Z", "+00:00"))
            except Exception:
                continue
            if (now - created).total_seconds() <= window_min * 60:
                return True
        return False
    except Exception as e:
        log(f"in-flight check failed ({workflow_file}): {e}")
        return False


def consecutive_failures(token, workflow_file, limit=3):
    """Consecutive 'failure' conclusions among the most recent completed
    runs (0 when the latest completed run succeeded). -1 on API failure
    (fail-open: treated as 'unknown', recovery proceeds)."""
    if not token:
        return -1
    try:
        runs = gh_request(
            "GET",
            f"/repos/{GH_REPO}/actions/workflows/{workflow_file}"
            "/runs?per_page=10", token)
        count = 0
        for r in (runs or {}).get("workflow_runs", []):
            if r.get("status") != "completed":
                continue
            if r.get("conclusion") == "failure":
                count += 1
                if count >= limit:
                    return count
            else:
                return count
        return count
    except Exception as e:
        log(f"failure-count check failed ({workflow_file}): {e}")
        return -1


# ------------------------------------------------------------ state build
def build_state(now):
    """One compact state summary from the repo's own state files."""
    sr = load_json(os.path.join(OUT_DIR, "step-runs.json"), {}) or {}
    dh = load_json(os.path.join(OUT_DIR, "daily-history.json"), {}) or {}
    report = load_json(os.path.join(OUT_DIR, "report.json"), {}) or {}
    batch = load_json(os.path.join(OUT_DIR, "gemini-batch.json"), {}) or {}

    steps = []
    for key, recs in sorted((sr.get("steps") or {}).items()):
        r = recs[-1] if recs else {}
        run_at = r.get("run_at")
        age_min = None
        if run_at:
            try:
                age_min = round((datetime.now(timezone.utc) - datetime.fromisoformat(
                    run_at.replace("Z", "+00:00"))).total_seconds() / 60)
            except Exception:
                age_min = None
        det = ""
        if isinstance(r.get("checked"), dict):
            det = str(r["checked"].get("detail", ""))[:120]
        last_real = None
        for rr in reversed(recs or []):
            if rr.get("status") != "skipped":
                last_real = rr
                break
        last_real_pkt, last_real_age_h = None, None
        if last_real and last_real.get("run_at"):
            try:
                dt = datetime.fromisoformat(
                    last_real["run_at"].replace("Z", "+00:00"))
                last_real_pkt = dt.astimezone(PKT).strftime("%Y-%m-%d %H:%M")
                last_real_age_h = round(
                    (datetime.now(timezone.utc) - dt).total_seconds() / 3600, 1)
            except Exception:
                pass
        steps.append({
            "step": key,
            "gate_pkt": GATES_PKT.get(key, "?"),
            "last_check_pkt": pkt_str(run_at),
            "check_age_min": age_min,
            "last_check_status": r.get("status"),
            "reason": r.get("reason"),
            "last_real_run_pkt": last_real_pkt,
            "last_real_age_h": last_real_age_h,
            "last_real_status": last_real.get("status") if last_real else None,
            "detail": det,
        })

    days = {d["date"]: d for d in dh.get("days", [])}
    today_key = now.strftime("%Y-%m-%d")
    yday_key = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    today = days.get(today_key, {})
    yday = days.get(yday_key, {})

    pub = {}
    pub_src = os.path.join(REPO_ROOT, "js", "published-titles.js")
    try:
        with open(pub_src, encoding="utf-8") as f:
            m = re.search(r"FA_PUBLISHED\s*=\s*(\{[\s\S]*?\})\s*;",
                          f.read())
        pub = json.loads(m.group(1)) if m else {}
    except Exception:
        pub = {}
    titles = list(pub.values())
    newest_pub = max((t.get("published_at") or "" for t in titles),
                     default="")
    titles_today = sum(1 for t in titles
                       if (t.get("published_at") or "") == today_key)

    dw = {}
    dw_src = os.path.join(REPO_ROOT, "js", "daywise-data.js")
    try:
        with open(dw_src, encoding="utf-8") as f:
            m = re.search(r"FA_DAYWISE\s*=\s*(\{[\s\S]*?\})\s*;",
                          f.read())
        dw = json.loads(m.group(1)) if m else {}
    except Exception:
        dw = {}
    dw_last = {}
    for tid, rows in dw.items():
        if rows:
            dw_last[tid] = rows[-1].get("date")
    newest_row = max(dw_last.values()) if dw_last else None
    stale_rows = {tid: d for tid, d in dw_last.items()
                  if d and d < (now - timedelta(days=1)).strftime("%Y-%m-%d")}

    tavily = load_json(os.path.join(OUT_DIR, "boxoffice-staging",
                                    "tavily.json"), {}) or {}

    err_sources = [
        {"source": s.get("source"), "note": (s.get("note") or "")[:80]}
        for s in report.get("per_source", [])
        if s.get("status") == "error"
    ]
    gb = next((st for st in steps if st["step"] == "gemini_batch"), {})
    updated_at = sr.get("updated_at")
    agg_age = None
    if updated_at:
        try:
            agg_age = round((datetime.now(timezone.utc) - datetime.fromisoformat(
                updated_at.replace("Z", "+00:00"))).total_seconds() / 60)
        except Exception:
            agg_age = None

    state = {
        "checked_at_pkt": now.strftime("%Y-%m-%d %H:%M PKT"),
        "steps": steps,
        "today": {
            "date": today_key,
            "fetch_new": today.get("fetch_new"),
            "gemini_drafts": today.get("gemini_drafts"),
            "published_today": today.get("published_today"),
            "posts_total": today.get("posts_total"),
            "per_category_fetch": today.get("per_category"),
        },
        "yesterday": {
            "date": yday_key,
            "fetch_new": yday.get("fetch_new"),
            "gemini_drafts": yday.get("gemini_drafts"),
            "published_today": yday.get("published_today"),
            "posts_total": yday.get("posts_total"),
        },
        "titles": {
            "total_published": len(titles),
            "newest_published_at": newest_pub,
            "published_today_count": titles_today,
        },
        "daywise": {
            "titles_with_rows": len(dw_last),
            "newest_row_date": newest_row,
            "titles_last_row_before_yesterday": stale_rows,
        },
        "tavily": {"staging_file": json.dumps(tavily)[:200],
                   "last_run_reason": next(
                       (st.get("reason") for st in steps
                        if st["step"] == "tavily_boxoffice"), None)},
        "fetch_report": {
            "sources_total": report.get("sources"),
            "status": report.get("status"),
            "queue_total_this_run": report.get("queue_total"),
            "categories_new_this_run": report.get("categories"),
            "dropped": report.get("dropped"),
            "error_sources": err_sources,
        },
        "gemini_state": {
            "count": batch.get("count"),
            "generated": batch.get("generated"),
            "ranked": batch.get("ranked"),
            "unprocessed": batch.get("unprocessed"),
            "skipped": batch.get("skipped"),
        },
        "five_modes": {
            "a_run_hua": {
                "last_aggregate_update_pkt": pkt_str(updated_at),
                "age_min": agg_age,
            },
            "b_updates_aaye": {
                "fetch_today_vs_yesterday": [today.get("fetch_new"),
                                             yday.get("fetch_new")],
                "drafts_today_vs_yesterday": [today.get("gemini_drafts"),
                                              yday.get("gemini_drafts")],
                "published_today_vs_yesterday": [today.get("published_today"),
                                                 yday.get("published_today")],
                "posts_total_today_vs_yesterday": [today.get("posts_total"),
                                                   yday.get("posts_total")],
            },
            "c_gemini_chala": {
                "last_real_run_pkt": gb.get("last_real_run_pkt"),
                "last_real_age_h": gb.get("last_real_age_h"),
                "reason": gb.get("reason"),
                "drafts_today": today.get("gemini_drafts"),
                "cap": "40/day",
            },
            "d_github_chala": {
                "latest_run_id": os.environ.get("GITHUB_RUN_ID"),
                "failed_steps_this_run": [],
                "failed_log_tail": None,
            },
            "e_website_update_hui": {
                "note": "deploy step ka natija is run ke job steps se "
                        "dekha jata hai; live hash check agle run me",
            },
        },
    }
    return state, steps


# ------------------------------------------------------------- auto-fixes
def auto_fixes(state, steps, prev_watch, token, run_id):
    """SAFE mechanical fixes only. Returns (autofixes, report_only, prune_candidates)."""
    autofixes = []
    report_only = []
    prev_candidates = (prev_watch or {}).get("prune_candidates") or {}
    prune_candidates = dict(prev_candidates)
    now = pkt_now()

    # (a) Missed hour — CONFIRM only, never dispatch.
    age = (state["five_modes"]["a_run_hua"] or {}).get("age_min")
    if age is not None and age > 70:
        report_only.append(
            f"URGENT: pichle {age} minute se koi pipeline update nahi — "
            "ghanta missing hai. Dispatcher :50 par retry karta hai; "
            "phir bhi na aaye to manually check karo.")
        log(f"missed-hour suspected (aggregate age {age} min) — report only")
    else:
        log(f"hour coverage ok (aggregate age {age} min)")

    # (b) Re-run a FAILED idempotent cap-free step (standalone workflow).
    if token:
        for st in steps:
            if st.get("last_real_status") != "failed":
                continue
            wf = SAFE_RERUN.get(st["step"])
            if not wf:
                report_only.append(
                    f"{st['step']} fail hua (aakhri real run "
                    f"{st.get('last_real_run_pkt') or 'na-maloom'}); is ka "
                    "koi standalone workflow nahi — agla hourly run khud "
                    "retry karega.")
                continue
            if dispatch_workflow(token, wf):
                autofixes.append({
                    "what_ur": f"{st['step']} fail hua tha — {wf} dobara "
                               "chalaya gaya",
                    "why_ur": "Step idempotent aur cap-free hai; dobara "
                              "chalana mehfooz hai",
                    "run_id": run_id,
                })
                log(f"re-dispatched {wf} for failed {st['step']}")
            else:
                report_only.append(
                    f"{st['step']} fail hua aur {wf} dobara chalane ki "
                    "koshish nakam rahi — manually chalao.")
    else:
        log("no GITHUB_TOKEN — re-run auto-fix skipped")

    # (c) DNS-dead source prune (site registry only; Flickposts registry
    # is a different repo — report it, parent/agent removes it there).
    # Rule: DNS fails NOW + this run's report shows a DNS error + the
    # source is already in the prune ledger from a run >48h ago.
    try:
        registry = load_json(REGISTRY_PATH, None)
        if isinstance(registry, list):
            err_by_name = {
                e["source"]: e.get("note", "")
                for e in state["fetch_report"]["error_sources"]
            }
            kept = []
            pruned = []
            for entry in registry:
                name = entry.get("name", "")
                note = err_by_name.get(name, "")
                is_dns_err = ("Name" in note and "urlopen" in note) or \
                    "Name or service not known" in note or \
                    "Errno -2" in note
                if not is_dns_err:
                    kept.append(entry)
                    continue
                rss = entry.get("rss") or entry.get("url") or ""
                host = re.sub(r"^https?://", "", rss).split("/")[0]
                if not dns_dead(host):
                    kept.append(entry)
                    continue
                first = prune_candidates.get(name)
                if first:
                    try:
                        first_dt = datetime.fromisoformat(
                            first.replace("Z", "+00:00"))
                        age_h = (datetime.now(timezone.utc) -
                                 first_dt).total_seconds() / 3600
                    except Exception:
                        age_h = 0
                    if age_h >= 48:
                        pruned.append(name)
                        autofixes.append({
                            "what_ur": f"DNS-dead source '{name}' registry "
                                       "se hata diya gaya",
                            "why_ur": "48 ghante se lagatar DNS-dead + is "
                                      "run me bhi DNS error",
                            "run_id": run_id,
                        })
                        prune_candidates.pop(name, None)
                        log(f"pruned DNS-dead source {name}")
                        continue
                    else:
                        kept.append(entry)
                        continue
                prune_candidates[name] = now.astimezone(
                    timezone.utc).isoformat().replace("+00:00", "Z")
                kept.append(entry)
                report_only.append(
                    f"'{name}' DNS-dead lag raha hai (is run me DNS "
                    "error) — 48 ghante ki tasdeeq ke baad registry se "
                    "hataya jayega.")
            if pruned:
                save_json(REGISTRY_PATH, kept)
                report_only.append(
                    "Flickposts registry se bhi in sources ko hatana "
                    f"baaki hai: {', '.join(pruned)} (alag repo — parent "
                    "karega).")
    except Exception as e:
        log(f"prune check skipped: {e}")

    return autofixes, report_only, prune_candidates


# ------------------------------------------------------- fallback verdicts
def fallback_verdicts(state, steps):
    """Deterministic rule-based verdicts (used when Gemini is down).
    Marked verdict_source='rules' so the panel never mistakes them for
    an AI verdict."""
    verdicts = []
    for st in steps:
        status = "theek"
        fix = "koi-nahi"
        modes = []
        last = st.get("last_real_run_pkt") or "na-maloom"
        if st.get("last_real_status") == "failed":
            status = "update-chahiye"
            fix = "dobara-chalao"
            modes = ["d"]
        ev = (f"Aakhri real run {last} ({st.get('last_real_status') or '?'})"
              f"; gate {st.get('gate_pkt')}.")
        if st.get("reason") == "cap":
            ev += " Cap 40/40 poora — 05:00 PKT par reset hoga."
            modes = ["c"]
        elif st.get("reason") == "gate":
            fix = "intezaar"
        verdicts.append({
            "id": st["step"], "kind": "step",
            "name_ur": st["step"].replace("_", " ").title(),
            "status": status, "modes": modes, "evidence_ur": ev,
            "fix": fix, "auto_fixable": False,
            "note_ur": "Rule-based verdict (Gemini nahi chala).",
        })
    per_cat = (state["today"] or {}).get("per_category_fetch") or {}
    for disp, slug in CAT_NAME_TO_ID.items():
        n = per_cat.get(disp)
        verdicts.append({
            "id": slug, "kind": "category", "name_ur": CATEGORY_UR[slug],
            "status": "theek" if (n or 0) > 0 else "khaali",
            "modes": [] if (n or 0) > 0 else ["b"],
            "evidence_ur": f"Aaj {n if n is not None else 'data nahi hai'} "
                           "naye items fetch hue.",
            "fix": "koi-nahi" if (n or 0) > 0 else "intezaar",
            "auto_fixable": False,
            "note_ur": "Rule-based verdict (Gemini nahi chala).",
        })
    verdicts.append({
        "id": "titles", "kind": "step", "name_ur": "Titles",
        "status": "theek", "modes": [],
        "evidence_ur": f"Kul {state['titles']['total_published']} titles; "
                       f"aaj {state['titles']['published_today_count']} "
                       "naye (seeder 23:00 PKT).",
        "fix": "intezaar", "auto_fixable": False,
        "note_ur": "Rule-based verdict (Gemini nahi chala).",
    })
    verdicts.append({
        "id": "daywise", "kind": "step", "name_ur": "Day-wise box office",
        "status": "theek", "modes": [],
        "evidence_ur": f"{state['daywise']['titles_with_rows']} titles ke "
                       f"rows; naya row {state['daywise']['newest_row_date']}.",
        "fix": "koi-nahi", "auto_fixable": False,
        "note_ur": "Rule-based verdict (Gemini nahi chala).",
    })
    verdicts.append({
        "id": "tavily", "kind": "step", "name_ur": "Tavily gap-filler",
        "status": "theek", "modes": [],
        "evidence_ur": "Staging file khaali hai (abhi tak koi figure nahi).",
        "fix": "koi-nahi", "auto_fixable": False,
        "note_ur": "Rule-based verdict (Gemini nahi chala).",
    })
    return verdicts


def valid_verdict(v):
    try:
        if not isinstance(v, dict):
            return False
        vs = v.get("verdicts")
        if not isinstance(vs, list) or len(vs) < 20:
            return False
        ok_status = {"theek", "khaali", "purana", "update-chahiye"}
        ok_fix = {"search", "dobara-chalao", "intezaar", "source",
                  "koi-nahi"}
        for x in vs:
            if x.get("status") not in ok_status:
                return False
            if x.get("fix") not in ok_fix:
                return False
            if not isinstance(x.get("modes"), list):
                return False
            if any(m not in "abcde" for m in x["modes"]):
                return False
        return True
    except Exception:
        return False


# ------------------------------------------------------------------ main
def main():
    now = pkt_now()
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    prev_watch = load_json(WATCH_PATH, None) or {}
    token = os.environ.get("GITHUB_TOKEN", "").strip()

    # Mode: primary = dispatched by the pipeline after deploy;
    # backup = own :25 UTC schedule. Explicit env wins; otherwise a
    # pipeline run id means primary.
    mode = WATCHDOG_MODE if WATCHDOG_MODE in ("primary", "backup") else (
        "primary" if WATCHDOG_PIPELINE_RUN_ID else "backup")

    # Target hour (UTC): the hour this verdict covers.
    if mode == "primary":
        target_hour = pipeline_run_hour(token, WATCHDOG_PIPELINE_RUN_ID)
        if not target_hour:
            # Fallback heuristic: a pipeline run for hour H starts :35
            # (schedule) or :50 (dispatcher) of H and finishes by :20 of
            # H+1, so (now - 30 min) floored to the hour is H in every
            # start path.
            target_hour = utc_hour_iso(
                datetime.now(timezone.utc) - timedelta(minutes=30))
            log(f"target hour fallback: {target_hour}")
    else:
        target_hour = utc_hour_iso(
            datetime.now(timezone.utc) - timedelta(hours=1))
    log(f"watchdog mode={mode} target_hour={target_hour}")

    def history_with(entry):
        hist = list(prev_watch.get("history") or [])
        hist = [h for h in hist if h.get("pipeline_hour") != target_hour]
        hist.append(entry)
        return hist[-6:]

    def base_out(status, overall, reason=""):
        return {
            "checked_at": now.strftime("%Y-%m-%d %H:%M PKT"),
            "overall": overall,
            "status": status,
            "reason": reason,
            "pipeline_hour": target_hour,
            "mode": mode,
            "verdict_source": "none",
            "verdicts": [], "autofixes": [], "report_only": [],
            "prune_candidates": prev_watch.get("prune_candidates") or {},
            "redispatch": prev_watch.get("redispatch"),
            "history": history_with({
                "pipeline_hour": target_hour, "status": status,
                "overall": overall, "mode": mode,
                "at_pkt": now.strftime("%Y-%m-%d %H:%M PKT"),
            }),
            "run_id": run_id,
        }

    # 0. Kill switch (flag file, READ only).
    if not flag_on():
        out = base_out("skipped", "theek",
                       "AI watchdog off (data/automation-state.json: "
                       "ai_watch=false)")
        save_json(WATCH_PATH, out)
        log("AI watchdog off — skipped")
        return 0

    # Backup-only guards: never do double work, never wake a running
    # system. A primary run always writes a fresh verdict (it may
    # replace a backup recovery verdict with the real one).
    if mode == "backup":
        prev_hour = prev_watch.get("pipeline_hour")
        prev_status = prev_watch.get("status")
        if prev_hour == target_hour and prev_status in ("ok", "skipped"):
            log(f"verdict for {target_hour} already exists "
                f"({prev_status}) — skip, no Gemini call")
            return 0
        if workflow_in_flight(token, PIPELINE_WORKFLOW, 45):
            log("hourly pipeline is in flight — verdict pending, skip")
            return 0
        if workflow_in_flight(token, WATCHDOG_WORKFLOW, 30,
                              exclude_run_id=run_id):
            log("another watchdog run is in flight — skip")
            return 0
        log(f"no verdict for {target_hour} — backup recovery path")

    try:
        state, steps = build_state(now)
    except Exception as e:
        out = base_out("check-failed", "dhyaan-do",
                       f"State summary nahi ban saka: {e}")
        save_json(WATCH_PATH, out)
        log(f"state build failed: {e}")
        return 0

    state["watchdog"] = {
        "mode": mode, "pipeline_hour": target_hour,
        "pipeline_missing": mode == "backup",
    }

    # 2. Failed-step log tail (only when this run failed something).
    try:
        if token and run_id:
            tail = failed_step_log_tail(token, run_id)
            if tail:
                state["five_modes"]["d_github_chala"]["failed_log_tail"] = tail
                state["five_modes"]["d_github_chala"]["failed_steps_this_run"] = ["see log tail"]
    except Exception as e:
        log(f"log tail skipped: {e}")

    # 3. Safe auto-fixes (mechanical only).
    try:
        autofixes, report_only, prune_candidates = auto_fixes(
            state, steps, prev_watch, token, run_id)
    except Exception as e:
        log(f"auto-fix skipped: {e}")
        autofixes, report_only = [], []
        prune_candidates = prev_watch.get("prune_candidates") or {}

    # 3b. Recovery (backup only): the verdict for this hour is missing
    # and nothing is in flight, so the pipeline did not run (or failed
    # before committing). Re-dispatch it ONCE per hour — never when it
    # failed 2 hours in a row (that is a code/human problem, and a loop
    # would just burn runs).
    recovery = {"dispatched": False, "reason": ""}
    if mode == "backup":
        red = prev_watch.get("redispatch") or {}
        if red.get("hour") == target_hour:
            recovery = {"dispatched": False,
                        "reason": "Is ghante ki pipeline pehle hi ek "
                                  "dafa dobara chalayi ja chuki hai — "
                                  "dobara nahi."}
            log("recovery: already re-dispatched this hour — skip")
        else:
            fails = consecutive_failures(token, PIPELINE_WORKFLOW)
            if fails >= 2:
                recovery = {"dispatched": False,
                            "reason": "Pipeline lagatar 2 ghante se fail "
                                      "ho rahi hai — dobara dispatch nahi "
                                      "kiya. Code/human fix chahiye."}
                report_only.append(recovery["reason"])
                log("recovery: 2 consecutive failures — no dispatch")
            elif token and dispatch_workflow(token, PIPELINE_WORKFLOW):
                recovery = {"dispatched": True, "hour": target_hour,
                            "at_pkt": now.strftime("%Y-%m-%d %H:%M PKT"),
                            "reason": "Is ghante ki pipeline nahi chali "
                                      "thi — ek dafa dobara dispatch ki "
                                      "gayi."}
                log(f"recovery: re-dispatched {PIPELINE_WORKFLOW} "
                    f"for {target_hour}")
            else:
                recovery = {"dispatched": False,
                            "reason": "Pipeline dobara dispatch karne ki "
                                      "koshish nakam rahi (token/API) — "
                                      "manually chalao."}
                report_only.append(recovery["reason"])
        state["watchdog"]["recovery"] = recovery

    # 4. Gemini verdict (spec doc + state + auto-fix results).
    spec = ""
    try:
        with open(SPEC_PATH, encoding="utf-8") as f:
            spec = f.read()
    except Exception as e:
        log(f"spec doc missing: {e}")
    verdict = None
    verdict_source = "none"
    keys = gemini_keys()
    if spec and keys:
        prompt = (
            "You are the hourly watchdog for FlickAtlas. Reason like Muse: "
            "not just the status, but the REASON and the FIX. SYSTEM SPEC "
            "below, then the LIVE state (real numbers, PKT). Reply JSON ONLY.\n\n"
            "=== SYSTEM SPEC ===\n" + spec +
            "\n=== LIVE STATE ===\n" +
            json.dumps(state, ensure_ascii=False) +
            "\n=== AUTO-FIXES ALREADY DONE THIS RUN ===\n" +
            json.dumps({"autofixes": autofixes,
                        "report_only": report_only}, ensure_ascii=False) +
            "\nRULES: Use ONLY the numbers in STATE and SPEC. Never invent "
            "a figure. 'skipped / gate' = checked and correctly skipped "
            "(THEEK). Weekly step with no real run in 24 records = THEEK. "
            "'0 titles today' = THEEK (seeder 23:00 PKT). "
            "'published_today 12 vs yesterday 71' = THEEK (yesterday was "
            "catch-up; posts_total still grew). A daywise title with last "
            "row 24/25 Oct is probably a film that left cinemas — say "
            "check karo, do NOT assert broken. 16 fetch sources erroring "
            "is known (2 DNS-dead already removed, 13 bot-walled by "
            "owner's call). In BACKUP mode the state may be stale because "
            "the pipeline did not run — say so plainly with failure mode "
            "(a) and do NOT invent fresh numbers. Every verdict lists "
            "'modes' from the 5 failure modes: (a) run hua hi nahi, (b) "
            "run hua lekin updates nahi aaye, (c) Gemini nahi chala, (d) "
            "GitHub nahi chala, (e) website update nahi hui. All verdict "
            "text in Roman Urdu (Latin script), one-line evidence with "
            "exact numbers + PKT times. Output shape: {\"checked_at\": "
            "\"<state checked_at_pkt>\", \"overall\": \"theek\" or "
            "\"dhyaan-do\", \"verdicts\": [{\"id\", \"kind\": "
            "\"step\" or \"category\", \"name_ur\", \"status\": "
            "\"theek|khaali|purana|update-chahiye\", \"modes\": "
            "[\"a\"|\"b\"|\"c\"|\"d\"|\"e\"], "
            "\"evidence_ur\", \"fix\": \"search|dobara-chalao|intezaar|"
            "source|koi-nahi\", \"auto_fixable\": true|false, "
            "\"note_ur\"}], "
            "\"autofixes\": [{\"what_ur\", \"why_ur\"}], "
            "\"report_only\": []}. "
            "One verdict for EVERY step, EVERY category, and titles + "
            "daywise + tavily. auto_fixable true ONLY for mechanical safe "
            "fixes; NEVER for Gemini re-runs, deletions, caps, or owner "
            "decisions.")
        verdict = call_gemini(keys, prompt, VERDICT_SCHEMA, max_tokens=8192)
        if valid_verdict(verdict):
            verdict_source = "gemini"
        else:
            log("Gemini verdict invalid — falling back to rules")
            verdict = None
    else:
        log("no spec doc or no Gemini keys — rule-based verdicts")

    if verdict is None:
        fb = fallback_verdicts(state, steps)
        overall = "dhyaan-do" if any(
            x["status"] != "theek" for x in fb) else "theek"
        verdict = {"checked_at": state["checked_at_pkt"],
                   "overall": overall, "verdicts": fb,
                   "autofixes": [], "report_only": report_only}
        verdict_source = "rules"

    redispatch = None
    if recovery.get("dispatched"):
        redispatch = recovery
    elif (prev_watch.get("redispatch") or {}).get("hour") == target_hour:
        redispatch = prev_watch["redispatch"]
    out = {
        "checked_at": verdict.get("checked_at") or state["checked_at_pkt"],
        "overall": verdict.get("overall", "theek"),
        "status": "ok",
        "pipeline_hour": target_hour,
        "mode": mode,
        "verdict_source": verdict_source,
        "verdicts": verdict.get("verdicts", []),
        "autofixes": (verdict.get("autofixes") or []) + [
            {"what_ur": a["what_ur"], "why_ur": a["why_ur"]}
            for a in autofixes],
        "report_only": list(dict.fromkeys(
            (verdict.get("report_only") or []) + report_only)),
        "prune_candidates": prune_candidates,
        "redispatch": redispatch,
        "history": history_with({
            "pipeline_hour": target_hour, "status": "ok",
            "overall": verdict.get("overall", "theek"), "mode": mode,
            "at_pkt": now.strftime("%Y-%m-%d %H:%M PKT"),
        }),
        "run_id": run_id,
    }
    save_json(WATCH_PATH, out)
    log(f"wrote {WATCH_PATH} ({len(out['verdicts'])} verdicts, "
        f"{len(out['autofixes'])} autofixes, source={verdict_source})")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        # NEVER fail the workflow run.
        try:
            # Best-effort hour/mode (same rules as main(), no API).
            _mode = WATCHDOG_MODE if WATCHDOG_MODE in (
                "primary", "backup") else (
                "primary" if WATCHDOG_PIPELINE_RUN_ID else "backup")
            _hour = utc_hour_iso(
                datetime.now(timezone.utc) - timedelta(
                    minutes=30 if _mode == "primary" else 60))
            save_json(WATCH_PATH, {
                "checked_at": pkt_now().strftime("%Y-%m-%d %H:%M PKT"),
                "overall": "dhyaan-do", "status": "check-failed",
                "reason": f"ai-watch crashed: {e}",
                "pipeline_hour": _hour,
                "mode": _mode,
                "verdicts": [], "autofixes": [], "report_only": [],
                "prune_candidates": {},
                "verdict_source": "none",
                "redispatch": None,
                "history": [],
                "run_id": os.environ.get("GITHUB_RUN_ID", ""),
            })
        except Exception:
            pass
        print(f"ai-watch: crashed ({e}) — wrote check-failed, exit 0",
              file=sys.stderr)
        sys.exit(0)
