#!/usr/bin/env python3
"""Daily history for the admin panel (out/daily-history.json).

Appends one day-record per PKT day so the panel can honestly render:
  - "14 din ka safar" dual-axis chart (fetch_new vs gemini_drafts per day)
  - "Khabrein kab aati hain" heatmap (weekday x hour, cumulative fetch)
  - % deltas + sparklines on the Hisab stat cards (day-over-day)
  - Tarteebat hourly usage chart + Raftaar/Khatam tiles (today's per-hour
    gemini drafts, hours_gemini)

Metric sources — all verified against the live files 2026-10-27:
  - out/report.json (fetch, hourly): sum(per_source[].new) is exactly the
    stats-pipeline "stories_new" figure the Hisab KPI card already shows,
    so the chart and the KPI card agree. report.categories is the same
    run's new items by display category. report.today_pkt is the PKT day
    the fetch run belongs to. The file has NO generated/run_id field, so
    the guard is a sha1 of its bytes: an unchanged report is never
    counted twice (a stale report after a gated/skipped fetch run).
  - out/gemini-batch.json (gemini drafts): `count` = articles drafted
    this run, `generated` = run timestamp. Guard: generated timestamp.
  - js/stats-pipeline.json: posts.today (max, only when the stats file's
    generated date IS the day record's date — it resets at midnight) and
    posts.total (max, monotonic). This is the honest "Publish hui" daily
    figure.
  - Flickposts data/admin-decisions.json via the GitHub API (needs
    PANEL_IMPORT_TOKEN, the same secret the publish step already uses):
    today's approve/reject counts from each decision's `at` timestamp
    in PKT. Optional — when the token is absent or the file is
    unreachable the counts stay null (never invented, never fatal).

Deliberately NOT used (verified why):
  - out/step-runs.json publish/gemini_batch `changed.count`: most runs
    those records are aggregate skeletons with NO counts at all, and
    when the aggregate does write a count it is "git diff added LINES
    in owned files" (e.g. publish count=55 meant 55 added lines in
    js/articles-data.js, not 55 articles). Summing it would be wrong.
  - No backfill: the file starts with today only and fills one day at
    a time. Days that do not exist are shown as honest empty states.

Guards against double counting (a rerun, a retry, a stale file):
  last_report_hash, last_gemini_generated. Publish/posts use max().

This script must NEVER fail the pipeline run: main() catches every
exception, prints a warning, and exits 0. The workflow step also has
continue-on-error: true as a second guard.

Schema (out/daily-history.json):
  {
    "updated_at": "2026-10-27T15:10:00Z",
    "days": [                          # last 30 PKT days, oldest first
      {"date": "2026-10-27", "fetch_new": 165, "gemini_drafts": 2,
       "published_today": 58, "posts_total": 204,
       "approved": 5, "rejected": 0,
       "per_category": {"Movies": 124, "Episodes": 10, ...},
       "hours_fetch": {"13": 165},     # PKT hour -> fetch_new this hour
       "hours_gemini": {"13": 2}},     # PKT hour -> drafts this hour
      ...
    ],
    "heatmap": {"0": {"13": 165}},     # weekday Mon=0 -> PKT hour -> cumulative fetch_new
    "guards": {"last_report_hash": "...", "last_gemini_generated": "..."}
  }
"""
import hashlib
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(ROOT, "out", "daily-history.json")
REPORT_PATH = os.path.join(ROOT, "out", "report.json")
BATCH_PATH = os.path.join(ROOT, "out", "gemini-batch.json")
STATS_PATH = os.path.join(ROOT, "js", "stats-pipeline.json")

PKT = timezone(timedelta(hours=5))
KEEP_DAYS = 30

DECISIONS_REPO = "Msohaib012/flickposts"
DECISIONS_PATH = "data/admin-decisions.json"
DECISIONS_REF = "cue/flickatlas-admin-review-2026-10-24"


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def pkt_now():
    return datetime.now(timezone.utc).astimezone(PKT)


def parse_iso(s):
    """Parse an ISO timestamp (with Z or offset) to an aware datetime."""
    if not s or not isinstance(s, str):
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def blank_day(date):
    return {
        "date": date,
        "fetch_new": 0,
        "gemini_drafts": 0,
        "published_today": None,
        "posts_total": None,
        "approved": None,
        "rejected": None,
        "per_category": {},
        "hours_fetch": {},
        "hours_gemini": {},
    }


def day_for(data, date):
    for d in data["days"]:
        if d.get("date") == date:
            return d
    rec = blank_day(date)
    data["days"].append(rec)
    data["days"].sort(key=lambda r: r.get("date") or "")
    del data["days"][:-KEEP_DAYS]
    return rec


def fetch_decisions_today(today_pkt):
    """Today's approve/reject counts from the panel decisions file.

    Returns (approved, rejected) or (None, None) when the file cannot
    be read (no token, API error, bad shape) — never raises.
    """
    token = os.environ.get("PANEL_IMPORT_TOKEN") or ""
    if not token:
        return None, None
    url = ("https://api.github.com/repos/%s/contents/%s?ref=%s"
           % (DECISIONS_REPO, DECISIONS_PATH, DECISIONS_REF))
    try:
        req = urllib.request.Request(
            url, headers={"Authorization": "Bearer " + token,
                          "Accept": "application/vnd.github.raw",
                          "User-Agent": "flickatlas-daily-history"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"daily-history: decisions unreadable ({e})", file=sys.stderr)
        return None, None
    items = data.get("items") or {}
    approved = rejected = 0
    for it in items.values():
        if not isinstance(it, dict):
            continue
        at = parse_iso(it.get("at"))
        if at is None or at.astimezone(PKT).date().isoformat() != today_pkt:
            continue
        if it.get("action") == "approve":
            approved += 1
        elif it.get("action") == "reject":
            rejected += 1
    return approved, rejected


def main():
    try:
        data = load_json(OUT_PATH)
        if not isinstance(data.get("days"), list):
            data["days"] = []
        if not isinstance(data.get("heatmap"), dict):
            data["heatmap"] = {}
        guards = data.setdefault("guards", {})
        now = pkt_now()
        today = now.date().isoformat()
        hour = str(now.hour)

        # ---- fetch (out/report.json) ----
        report = load_json(REPORT_PATH)
        if report:
            raw = open(REPORT_PATH, "rb").read()
            digest = hashlib.sha1(raw).hexdigest()
            if digest != guards.get("last_report_hash"):
                per_source = report.get("per_source") or []
                new_total = sum(int(s.get("new") or 0) for s in per_source
                                if isinstance(s, dict))
                day_key = report.get("today_pkt") or today
                rec = day_for(data, day_key)
                rec["fetch_new"] = int(rec.get("fetch_new") or 0) + new_total
                cats = report.get("categories") or {}
                pc = rec.setdefault("per_category", {})
                for k, v in cats.items():
                    if isinstance(v, (int, float)):
                        pc[str(k)] = int(pc.get(str(k)) or 0) + int(v)
                hf = rec.setdefault("hours_fetch", {})
                hf[hour] = int(hf.get(hour) or 0) + new_total
                # heatmap: weekday (Mon=0) x PKT hour, cumulative
                try:
                    wd = str(datetime.fromisoformat(day_key).weekday())
                except ValueError:
                    wd = str(now.weekday())
                hm = data["heatmap"].setdefault(wd, {})
                hm[hour] = int(hm.get(hour) or 0) + new_total
                guards["last_report_hash"] = digest
                print(f"daily-history: fetch +{new_total} for {day_key}")

        # ---- gemini drafts (out/gemini-batch.json) ----
        batch = load_json(BATCH_PATH)
        generated = batch.get("generated")
        if batch and generated and generated != guards.get(
                "last_gemini_generated"):
            count = int(batch.get("count") or 0)
            gen_dt = parse_iso(generated)
            day_key = (gen_dt.astimezone(PKT).date().isoformat()
                       if gen_dt else today)
            gen_hour = str(gen_dt.astimezone(PKT).hour) if gen_dt else hour
            rec = day_for(data, day_key)
            rec["gemini_drafts"] = int(rec.get("gemini_drafts") or 0) + count
            hg = rec.setdefault("hours_gemini", {})
            hg[gen_hour] = int(hg.get(gen_hour) or 0) + count
            guards["last_gemini_generated"] = generated
            print(f"daily-history: gemini +{count} for {day_key}")

        # ---- publish/posts (js/stats-pipeline.json) ----
        stats = load_json(STATS_PATH)
        posts = stats.get("posts") or {}
        gen_dt = parse_iso(stats.get("generated"))
        stats_day = (gen_dt.astimezone(PKT).date().isoformat()
                     if gen_dt else None)
        if isinstance(posts.get("total"), (int, float)):
            rec = day_for(data, today)
            cur = rec.get("posts_total")
            rec["posts_total"] = (int(posts["total"]) if cur is None
                                  else max(int(cur), int(posts["total"])))
        if isinstance(posts.get("today"), (int, float)) and stats_day == today:
            rec = day_for(data, today)
            cur = rec.get("published_today")
            rec["published_today"] = (int(posts["today"]) if cur is None
                                      else max(int(cur), int(posts["today"])))

        # ---- decisions (Flickposts admin-decisions.json) ----
        approved, rejected = fetch_decisions_today(today)
        if approved is not None:
            rec = day_for(data, today)
            rec["approved"] = approved
            rec["rejected"] = rejected
            print(f"daily-history: decisions today approve={approved} "
                  f"reject={rejected}")

        data["updated_at"] = now_iso()
        save_json(OUT_PATH, data)
        print(f"daily-history: wrote {OUT_PATH} "
              f"({len(data['days'])} day(s) kept)")
        return 0
    except Exception as e:
        # NEVER fail the pipeline run.
        print(f"daily-history: skipped ({e})", file=sys.stderr)
        return 0


if __name__ == "__main__":
    sys.exit(main())
