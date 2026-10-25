#!/usr/bin/env python3
"""Build js/stats-pipeline.json — the pipeline half of the FlickAtlas stats page.

Reads only files the auto-pipeline already writes plus the GitHub Actions
API (for run times / conclusions). No new service needed.

Sources:
  - out/report.json        last fetch run: sources ok/error, stories queued,
                           per-category counts, duplicates removed
  - out/queue.json         stories currently queued (per-category counts)
  - out/gemini-batch.json  last Gemini run: generated time, picks, per-category
                           picks, skipped count
  - out/auto-feed.json     articles the last batch actually added (posts made)
  - out/processed.json     article_id -> category (for the posts table)
  - scripts/registry.json  sources, counted per scope
  - js/articles-data.js    post totals (articles)
  - js/published-titles.js post totals (titles)
  - GitHub Actions API     latest run of news-refresh.yml (:35 fetch),
                           auto-pipeline.yml (:50 Gemini), publish.yml
                           (:10/:30/:50 publish): started/finished/conclusion

Next-run times are computed from the cron schedules (UTC) and the page
displays them in PKT.

Usage: stats-pipeline.py
Auth: GITHUB_TOKEN from env (Actions provides it; local runs may set it).
Exits 0 even when the API is unreachable — then run statuses are "unknown"
and the JSON still gets written from the repo files alone.
Writes js/stats-pipeline.json only when the content changed.
"""
import json
import os
import sys
import urllib.request
import urllib.error
from collections import Counter
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.environ.get("GITHUB_REPOSITORY", "Msohaib012/flickatlas-site")
API = "https://api.github.com"
PKT = timezone(timedelta(hours=5))

# Cron schedules (UTC minutes past the hour) of the three pipeline workflows.
FETCH_MINUTES = [35]
GEMINI_MINUTES = [50]
PUBLISH_MINUTES = [10, 30, 50]


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def read_js_map(path, var):
    """Parse `window.VAR = {...};` into a dict. Returns {} if missing."""
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    try:
        start = raw.index("{")
        end = raw.rindex("}")
        return json.loads(raw[start:end + 1])
    except ValueError:
        return {}


def parse_ts(value):
    """Parse an ISO or RFC2822 timestamp into an aware datetime (UTC)."""
    if not value:
        return None
    s = str(value).strip()
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        try:
            dt = parsedate_to_datetime(s)
        except (TypeError, ValueError):
            return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if dt else None


def next_run(minutes, now):
    """Next UTC datetime strictly after `now` whose minute is in `minutes`."""
    base = now.astimezone(timezone.utc).replace(second=0, microsecond=0)
    for add in range(0, 121):
        cand = base + timedelta(minutes=add)
        if cand > now and cand.minute in minutes:
            return cand
    return base + timedelta(hours=2)


def latest_run(workflow_file, token):
    """Latest run of a workflow file via the Actions API. None on failure."""
    url = f"{API}/repos/{REPO}/actions/workflows/{workflow_file}/runs?per_page=1"
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "flickatlas-stats-pipeline"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.load(r)
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, OSError) as e:
        print(f"stats-pipeline: Actions API failed for {workflow_file}: {e}")
        return None
    runs = data.get("workflow_runs") or []
    if not runs:
        return None
    r = runs[0]
    return {
        "status": (r.get("conclusion") or r.get("status") or "unknown"),
        "run_id": r.get("id"),
        "started_at": r.get("created_at"),
        "finished_at": r.get("updated_at"),
        "url": r.get("html_url"),
    }


def main():
    now = datetime.now(timezone.utc)
    token = os.environ.get("GITHUB_TOKEN", "")

    report = load_json(os.path.join(ROOT, "out", "report.json"), {})
    queue = load_json(os.path.join(ROOT, "out", "queue.json"), [])
    batch = load_json(os.path.join(ROOT, "out", "gemini-batch.json"), {})
    auto_feed = load_json(os.path.join(ROOT, "out", "auto-feed.json"), {})
    processed = load_json(os.path.join(ROOT, "out", "processed.json"), {})
    registry = load_json(os.path.join(ROOT, "scripts", "registry.json"), [])
    articles = read_js_map(os.path.join(ROOT, "js", "articles-data.js"),
                           "FA_ARTICLES")
    titles = read_js_map(os.path.join(ROOT, "js", "published-titles.js"),
                         "FA_PUBLISHED")

    # ---- fetch (news-refresh :35) ----
    fetch_run = latest_run("news-refresh.yml", token)
    rep_status = report.get("status") or {}
    rep_cats = report.get("categories") or {}
    queue_cats = Counter((it.get("category") or "Uncategorised")
                         for it in queue if isinstance(it, dict))
    per_source = report.get("per_source") or []
    stories_new = sum(int(s.get("new") or 0) for s in per_source
                      if isinstance(s, dict))
    scopes = Counter()
    for src in registry if isinstance(registry, list) else []:
        for sc in (src.get("scopes") or []):
            scopes[str(sc)] += 1
    fetch = {
        "status": (fetch_run or {}).get("status", "unknown"),
        "run_id": (fetch_run or {}).get("run_id"),
        "started_at": (fetch_run or {}).get("started_at"),
        "finished_at": (fetch_run or {}).get("finished_at"),
        "run_url": (fetch_run or {}).get("url"),
        "sources_total": int(report.get("sources") or len(registry) or 0),
        "sources_ok": int(rep_status.get("ok") or 0),
        "sources_error": int(rep_status.get("error") or 0),
        "sources_unchanged": int(rep_status.get("unchanged") or 0),
        "sources_other": max(0, int(report.get("sources") or len(registry) or 0)
                             - int(rep_status.get("ok") or 0)
                             - int(rep_status.get("error") or 0)
                             - int(rep_status.get("unchanged") or 0)),
        "stories_queued": int(report.get("queue_total") or len(queue) or 0),
        "stories_new": stories_new,
        "duplicates_removed": int(report.get("duplicates_removed") or 0),
        "per_category": {str(k): int(v) for k, v in rep_cats.items()},
        "per_scope": dict(scopes),
        "next_run": iso(next_run(FETCH_MINUTES, now)),
    }

    # ---- gemini (auto-pipeline :50) ----
    gem_run = latest_run("auto-pipeline.yml", token)
    batch_articles = batch.get("articles") or []
    batch_cats = Counter((a.get("category") or "movies")
                         for a in batch_articles if isinstance(a, dict))
    feed_entries = (auto_feed.get("feed") or []) if isinstance(auto_feed, dict) else []
    gemini = {
        "status": (gem_run or {}).get("status", "unknown"),
        "run_id": (gem_run or {}).get("run_id"),
        "started_at": (gem_run or {}).get("started_at"),
        "finished_at": (gem_run or {}).get("finished_at"),
        "run_url": (gem_run or {}).get("url"),
        "generated_at": batch.get("generated"),
        "picked": int(batch.get("count") or len(batch_articles)),
        "per_category": dict(batch_cats),
        "skipped": len(batch.get("skipped") or []),
        "posts_created": len(feed_entries) if feed_entries else None,
        "next_run": iso(next_run(GEMINI_MINUTES, now)),
    }

    # ---- publish (:10/:30/:50) ----
    pub_run = latest_run("publish.yml", token)
    publish = {
        "status": (pub_run or {}).get("status", "unknown"),
        "run_id": (pub_run or {}).get("run_id"),
        "started_at": (pub_run or {}).get("started_at"),
        "finished_at": (pub_run or {}).get("finished_at"),
        "run_url": (pub_run or {}).get("url"),
        "next_run": iso(next_run(PUBLISH_MINUTES, now)),
    }

    # ---- posts ----
    today_pkt = now.astimezone(PKT).date().isoformat()
    posts_today = 0
    for a in articles.values():
        dt = parse_ts(a.get("published"))
        if dt and dt.astimezone(PKT).date().isoformat() == today_pkt:
            posts_today += 1
    for t in titles.values():
        dt = parse_ts(t.get("published_at"))
        if dt and dt.astimezone(PKT).date().isoformat() == today_pkt:
            posts_today += 1
    article_categories = {}
    for rec in processed.values():
        if isinstance(rec, dict) and rec.get("article_id") and rec.get("category"):
            article_categories[str(rec["article_id"])] = str(rec["category"])
    posts = {
        "total": len(articles) + len(titles),
        "articles": len(articles),
        "titles": len(titles),
        "today": posts_today,
        "article_categories": article_categories,
    }

    out = {
        "generated": iso(now),
        "fetch": fetch,
        "gemini": gemini,
        "publish": publish,
        "posts": posts,
        "queue": {
            "total": len(queue) if isinstance(queue, list) else 0,
            "per_category": dict(queue_cats),
        },
    }

    out_path = os.path.join(ROOT, "js", "stats-pipeline.json")
    # Compare WITHOUT the generated timestamp: the file changes only when
    # the DATA changes, not once an hour just because the clock moved.
    # (Every commit to main triggers a Vercel deploy, so a timestamp-only
    # commit every hour would burn the deploy budget for nothing.)
    existing = load_json(out_path, {})
    old = {k: v for k, v in existing.items() if k != "generated"}
    new = {k: v for k, v in out.items() if k != "generated"}
    if old != new:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
        print(f"stats-pipeline: wrote {out_path} (changed)")
    else:
        print("stats-pipeline: no change")
    print(f"fetch={fetch['status']} queued={fetch['stories_queued']} "
          f"gemini={gemini['status']} picked={gemini['picked']} "
          f"posts={posts['total']} today={posts['today']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
