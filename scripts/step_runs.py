#!/usr/bin/env python3
"""Per-step run records for the FlickAtlas pipeline (out/step-runs.json).

Every pipeline step writes ONE record per run: when it was checked,
what it checked, what changed (names + counts), and — when nothing
changed — WHY, from a closed vocabulary. This file is the data model
for the admin panel's stats dashboard (owner order 2026-10-27): the
dashboard renders, per category, last-checked / what changed /
why-not from this file. It is NOT a second orchestrator state: the
orchestrator state (out/orchestrator-state.json) keeps only
last_run/last_status; this file keeps the per-run detail.

Schema — one entry per step per run:
  {
    "step": "title_seed",        # step key (matches orchestrator-state)
    "category": "Spotlight / Coming Soon / Most Awaited",
    "run_at": "2026-10-27T09:00:00Z",
    "run_id": "40475898607",     # GitHub run id when available, else ""
    "status": "success|failed|skipped",  # skipped = gate off this hour
    "checked": {"candidates": 120, "detail": "..."},   # or null
    "changed": {"added": ["Dhood (Sandstorm)", ...],
                "updated": [...], "count": 3},         # or null
    "reason": null | "gate"|"no-new-data"|"cap"|"source-fail"|"error"
  }

Reasons (closed vocabulary — the dashboard shows the reason verbatim):
  gate         — the step's time gate was off this hour (not its turn)
  no-new-data  — it ran, checked, and there was nothing new to write
  cap          — it stopped because a per-run cap was hit (pace rule)
  source-fail  — a data source (TMDB / Sacnilk / Tavily / YouTube)
                 failed, so there was nothing to check
  error        — the step itself failed (non-zero exit / exception)

Retention: the last 24 records per step (bounded; ~17 steps).
File: out/step-runs.json  {"steps": {step: [records...]}, "updated_at": ...}

Two ways to write a record (never duplicated — record() is the only
writer, called from the scripts themselves and from the workflow's
aggregate step):
  1. A script calls step_runs.record(...) at the end of main() with
     the numbers it already knows (candidates, added names, reason).
  2. The workflow's "Record step runs" step runs this file with
     --aggregate: it adds skipped/failed records for steps whose gate
     was off or whose step failed, using the decide flags + outcomes
     passed as environment variables (same pattern as the
     orchestrator-state step). Steps that already recorded this run
     (matched by run_id) are left alone.

A record write must NEVER break a pipeline step: record() swallows
its own exceptions (prints a warning) and the aggregate exits 0.
"""
import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PATH = os.path.join(ROOT, "out", "step-runs.json")

REASONS = {"gate", "no-new-data", "cap", "source-fail", "error"}
STATUSES = {"success", "failed", "skipped"}
KEEP_PER_STEP = 24

# Step key -> (dashboard category, files the step owns). The aggregate
# uses the owned files to tell "did this step change anything?" when a
# script did not write its own summary.
STEP_FILES = {
    "fetch": ("Trending News", ["out/queue.json", "out/seen.json",
                                "out/state.json"]),
    "episode_guides": ("Drama Episodes", ["js/articles-data.js",
                                          "out/episode-feed.json",
                                          "out/episodes.json"]),
    "title_seed": ("Spotlight / Coming Soon / Most Awaited",
                   ["js/published-titles.js", "js/trending-data.js",
                    "js/ott-data.js"]),
    "gemini_batch": ("Trending News", ["out/gemini-batch.json",
                                       "out/auto-feed.json"]),
    "apply_auto": ("Trending News", ["js/articles-data.js"]),
    "ott": ("OTT", ["js/ott-data.js"]),
    "trending_weekly": ("Trending Topics", ["js/trending-topics.js"]),
    "overseas_ai": ("Box Office", ["out/boxoffice-staging/overseas-ai.json"]),
    "multisource_boxoffice": ("Box Office", ["js/daywise-data.js",
                                             "js/advance-data.js",
                                             "out/multisource-boxoffice.json",
                                             "out/boxoffice-staging"]),
    "gemini_reviews": ("Reviews", ["js/reviews-data.js"]),
    "publish": ("Trending News", ["js/articles-data.js"]),
    "convert_news": ("Trending News", ["api-news.json", "api-trends.json"]),
    "stats_traffic": ("Stats / Health", ["js/stats-traffic.json"]),
    "stats_pipeline": ("Stats / Health", ["js/stats-pipeline.json"]),
    "stats_health": ("Stats / Health", ["js/stats-health.json"]),
    "metadata_refresh": ("Spotlight / Coming Soon / Most Awaited",
                         ["js/published-titles.js"]),
    "providers_backfill": ("OTT", ["js/published-titles.js"]),
}


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load(path):
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(
                    data.get("steps"), dict):
                return data
        except Exception:
            pass
    return {"steps": {}}


def save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def record(step, *, category=None, status="success", checked=None,
           changed=None, reason=None, run_id=None, run_at=None,
           path=DEFAULT_PATH):
    """Append one per-run record for `step`. Never raises (a record
    write must never break a pipeline step). Returns True on success."""
    try:
        if status not in STATUSES:
            raise ValueError(f"bad status {status!r}")
        if reason is not None and reason not in REASONS:
            raise ValueError(f"bad reason {reason!r}")
        if category is None:
            category = STEP_FILES.get(step, ("", []))[0]
        entry = {
            "step": step,
            "category": category,
            "run_at": run_at or now_iso(),
            "run_id": run_id or os.environ.get("GITHUB_RUN_ID", ""),
            "status": status,
            "checked": checked,
            "changed": changed,
            "reason": reason,
        }
        data = load(path)
        steps = data.setdefault("steps", {})
        recs = steps.setdefault(step, [])
        recs.append(entry)
        del recs[:-KEEP_PER_STEP]
        data["updated_at"] = entry["run_at"]
        save(path, data)
        return True
    except Exception as e:
        print(f"step-runs: record failed for {step!r} ({e})",
              file=sys.stderr)
        return False


def _git_changed_lines(paths):
    """Added lines in `git diff HEAD` for the given paths (0 when git
    is unavailable or nothing changed). Used by the aggregate for
    steps that did not write their own summary."""
    try:
        out = subprocess.run(
            ["git", "diff", "--numstat", "HEAD", "--"] + paths,
            capture_output=True, text=True, timeout=30, cwd=ROOT)
        added = 0
        for line in (out.stdout or "").splitlines():
            parts = line.split("\t")
            if len(parts) >= 3 and parts[0].isdigit():
                added += int(parts[0])
        return added
    except Exception:
        return 0


def aggregate(path=DEFAULT_PATH):
    """Add skipped/failed records for steps that did not record this
    run themselves. Reads the decide flags + step outcomes from the
    environment (RUN_<STEP> + <STEP>_OUTCOME, same pattern as the
    orchestrator-state step). Steps that already have a record with
    this run's id are left alone. Always exits 0."""
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    run_at = now_iso()
    data = load(path)
    steps = data.setdefault("steps", {})

    # step key -> (decide env flag, outcome env var). A flag of None
    # means the step runs every hour (no gate).
    plan = [
        ("fetch", None, "FETCH_OUTCOME"),
        ("episode_guides", "RUN_EPISODE", "EPISODE_OUTCOME"),
        ("title_seed", "RUN_TITLE", "TITLE_OUTCOME"),
        ("gemini_batch", None, "GEMINI_OUTCOME"),
        ("apply_auto", None, "APPLY_OUTCOME"),
        ("ott", None, "OTT_OUTCOME"),
        ("trending_weekly", "RUN_TRENDING", "TRENDING_OUTCOME"),
        ("overseas_ai", "RUN_OVERSEAS", "OVERSEAS_OUTCOME"),
        ("multisource_boxoffice", None, "MULTISOURCE_OUTCOME"),
        ("gemini_reviews", "RUN_REVIEWS", "REVIEWS_OUTCOME"),
        ("publish", None, "PUBLISH_OUTCOME"),
        ("convert_news", None, "FEED_OUTCOME"),
        ("stats_traffic", None, "TRAFFIC_OUTCOME"),
        ("stats_pipeline", "RUN_STATS_PIPE", "STATS_PIPE_OUTCOME"),
        ("stats_health", "RUN_HEALTH", "HEALTH_OUTCOME"),
        ("metadata_refresh", "RUN_METADATA", "METADATA_OUTCOME"),
        ("providers_backfill", "RUN_PROVIDERS", "PROVIDERS_OUTCOME"),
    ]
    for step, flag_env, outcome_env in plan:
        recs = steps.get(step) or []
        if run_id and any(r.get("run_id") == run_id for r in recs):
            continue  # the script already recorded this run
        outcome = (os.environ.get(outcome_env) or "").strip() or "unknown"
        ran = True if flag_env is None else (
            os.environ.get(flag_env) == "true")
        category = STEP_FILES.get(step, ("", []))[0]
        if not ran:
            record(step, category=category, status="skipped",
                   reason="gate", run_id=run_id, run_at=run_at, path=path)
            continue
        if outcome in ("failure", "cancelled", "timed out"):
            record(step, category=category, status="failed",
                   reason="error", run_id=run_id, run_at=run_at, path=path)
            continue
        # Ran and did not fail, but wrote no summary of its own:
        # report what the working tree shows for its owned files.
        owned = STEP_FILES.get(step, ("", []))[1]
        changed_lines = _git_changed_lines(owned)
        if changed_lines:
            record(step, category=category, status="success",
                   checked=None,
                   changed={"added": [], "updated": [],
                            "count": changed_lines,
                            "detail": "lines changed in owned files; "
                                      "no per-item summary from script"},
                   reason=None, run_id=run_id, run_at=run_at, path=path)
        else:
            record(step, category=category, status="success",
                   reason="no-new-data", run_id=run_id, run_at=run_at,
                   path=path)
    return 0


def main():
    ap = argparse.ArgumentParser(
        description="Record per-step pipeline run records "
                    "(out/step-runs.json)")
    ap.add_argument("--aggregate", action="store_true",
                    help="add skipped/failed records for steps that did "
                         "not record this run (workflow step)")
    ap.add_argument("--step", default=None)
    ap.add_argument("--category", default=None)
    ap.add_argument("--status", default="success",
                    choices=sorted(STATUSES))
    ap.add_argument("--checked-json", default=None,
                    help="JSON object for the checked field")
    ap.add_argument("--changed-json", default=None,
                    help="JSON object for the changed field")
    ap.add_argument("--reason", default=None, choices=sorted(REASONS))
    ap.add_argument("--path", default=DEFAULT_PATH)
    args = ap.parse_args()
    if args.aggregate:
        return aggregate(args.path)
    if not args.step:
        ap.error("--step is required without --aggregate")
    checked = (json.loads(args.checked_json)
               if args.checked_json else None)
    changed = (json.loads(args.changed_json)
               if args.changed_json else None)
    ok = record(args.step, category=args.category, status=args.status,
                checked=checked, changed=changed, reason=args.reason,
                path=args.path)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
