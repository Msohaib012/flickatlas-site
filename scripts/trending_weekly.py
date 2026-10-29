#!/usr/bin/env python3
"""Reconcile cached Google RSS trend evidence with recently published site articles."""
import json
import os
import re
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone

try:
    import step_runs
except Exception:
    step_runs = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
TOP_N = 8
ARTICLE_DAYS = 7
FEED_HOURS = 3
TREND_HOURS = 24
HEADER = "/* FlickAtlas Trending Topics: current Google search trends intersected with published news. */"
GENERIC = set("movie movies film films news today box office collection collections latest trending trend viral breaking entertainment cinema update updates".split())
STOP = set("a an the and or of to in on for with at by from is are was were be been this that these those his her its their has have had".split())
FEEDS = {"US": "https://trends.google.com/trending/rss?geo=US", "IN": "https://trends.google.com/trending/rss?geo=IN"}


def log(s): print("trending-weekly: " + str(s))
def parse_dt(value):
    if not value: return None
    try:
        d = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d.astimezone(timezone.utc)
    except Exception: return None

def iso(dt): return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
def cache_path(root): return os.path.join(root, "out", "google-trends-evidence.json")
def output_path(root): return os.path.join(root, "js", "trending-topics.js")
def read_cache(root):
    try:
        with open(cache_path(root), encoding="utf-8") as f: return json.load(f)
    except Exception: return None

def load_js_window(path, varname):
    with open(path, encoding="utf-8") as f: src = f.read()
    m = re.search(re.escape("window." + varname) + r"\s*=\s*(\{.*\}|\[.*\]);?\s*$", src, re.S)
    if not m: return None
    return json.loads(m.group(1))

def words(s): return {w for w in re.findall(r"[a-z0-9]+", str(s or "").lower()) if len(w) > 2 and w not in STOP}
def external_url(url):
    try:
        from urllib.parse import urlparse
        u = urlparse(str(url)); h = (u.hostname or "").lower().rstrip(".")
        if u.scheme not in ("http", "https") or not h: return False
        return not (h == "flickatlas.co.uk" or h.endswith(".flickatlas.co.uk") or h == "flickatlas.com" or h.endswith(".flickatlas.com") or (h.startswith("flickatlas") and h.endswith(".hidden-decodes.workers.dev")))
    except Exception: return False

def valid_related(items):
    return [r for r in (items if isinstance(items, list) else []) if isinstance(r, dict) and str(r.get("title") or "").strip() and external_url(r.get("url"))]

def subject_match(term, headline, related):
    term = str(term or "").strip()
    tw = words(term); hw = words(headline)
    if not tw or tw & GENERIC: return False
    # Require whole word/phrase occurrence, not loose token overlap alone.
    pattern = r"(?<![a-z0-9])" + re.escape(term.lower()).replace(r"\ ", r"\s+") + r"(?![a-z0-9])"
    if not re.search(pattern, str(headline or "").lower()): return False
    contexts = [str(x.get("title") or "") for x in related]
    context_words = set().union(*(words(x) for x in contexts)) if contexts else set()
    shared = len((hw - GENERIC) & context_words)
    if len(tw) == 1:
        # Ambiguous single-token names need independent related-news context.
        context = " ".join(contexts).lower()
        entertainment = bool(re.search(r"\b(movie|film|box office|cinema|actor|actress|release|trailer|collection)\b", context))
        return shared >= 2 and entertainment and bool(re.search(r"(?<![a-z0-9])" + re.escape(term.lower()) + r"(?![a-z0-9])", context))
    return shared >= 1 or len(tw & context_words) >= 2

def published_articles(root, clock):
    try: data = load_js_window(os.path.join(root, "js", "articles-data.js"), "FA_ARTICLES")
    except Exception as e: log("could not read articles: " + str(e)); return []
    items = list(data.values()) if isinstance(data, dict) else data if isinstance(data, list) else []
    out, seen = [], set()
    for a in items:
        if not isinstance(a, dict): continue
        aid = str(a.get("id") or "").strip(); title = str(a.get("headline") or a.get("title") or "").strip(); dt = parse_dt(a.get("published"))
        if not aid or aid in seen or not title or not dt or dt > clock or dt < clock - timedelta(days=ARTICLE_DAYS): continue
        seen.add(aid); out.append({"id": aid, "headline": title, "date": iso(dt), "_dt": dt})
    return out

def feed_state(cache, clock):
    if not isinstance(cache, dict): return "missing", None, []
    checked = parse_dt(cache.get("checked_at")); status = cache.get("status")
    if cache.get("source") != "google-rss" or status != "ok" or not checked: return ("stale" if cache else "missing"), cache.get("checked_at"), []
    if checked > clock or clock - checked > timedelta(hours=FEED_HOURS): return "stale", cache.get("checked_at"), []
    items = cache.get("items")
    if not isinstance(items, list): return "stale", cache.get("checked_at"), []
    return "ok", cache.get("checked_at"), items

def build_topics(items, articles, clock):
    selected = []
    for item in items:
        if not isinstance(item, dict): continue
        geo = item.get("geo"); term = str(item.get("q") or "").strip(); source_url = FEEDS.get(geo)
        observed, started = parse_dt(item.get("observed_at")), parse_dt(item.get("trending_started_at"))
        if not source_url or item.get("feed_url") != source_url or not term or not observed or not started: continue
        if observed > clock or clock - observed > timedelta(hours=FEED_HOURS) or started > clock or clock - started > timedelta(hours=TREND_HOURS): continue
        related = valid_related(item.get("news"))
        if not related: continue
        for article in articles:
            if not subject_match(term, article["headline"], related): continue
            # Related headlines must substantiate the same subject, not merely the trend token.
            rel_ok = any(len((words(article["headline"]) - GENERIC) & words(r["title"])) >= (1 if len(words(term)) == 1 else 1) for r in related)
            if not rel_ok: continue
            selected.append({"title": article["headline"], "article_id": article["id"], "url": "/news-item?id=" + urllib.parse.quote(article["id"], safe=""), "date": article["date"], "trend_proof": {"source": "google-rss", "term": term, "geo": geo, "started_at": iso(started), "observed_at": iso(observed), "source_url": source_url, "related": related}})
    # A story can match multiple feed items; keep a deterministic proof and unique story.
    unique = {}
    for t in selected:
        key = t["article_id"]
        if key not in unique or (t["trend_proof"]["geo"], t["trend_proof"]["term"]) < (unique[key]["trend_proof"]["geo"], unique[key]["trend_proof"]["term"]): unique[key] = t
    return sorted(unique.values(), key=lambda t: (-parse_dt(t["date"]).timestamp(), t["article_id"]))[:TOP_N]

def write_change(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        with open(path, encoding="utf-8") as f:
            if f.read() == content: return False
    except OSError: pass
    with open(path, "w", encoding="utf-8") as f: f.write(content)
    return True

def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv); root = ROOT
    if "--root" in argv: root = argv[argv.index("--root") + 1]
    clock = datetime.now(timezone.utc)
    cache = read_cache(root); state, checked_at, items = feed_state(cache, clock)
    articles = published_articles(root, clock)
    topics = build_topics(items, articles, clock) if state == "ok" else []
    payload = {"source": "google-rss", "status": "ok" if state == "ok" else state, "checked_at": checked_at, "topics": topics}
    content = HEADER + "\nwindow.FA_TRENDING_TOPICS = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n"
    changed = write_change(output_path(root), content)
    log(f"local reconcile status={payload['status']} topics={len(topics)} changed={changed}")
    if step_runs is not None:
        if state == "ok":
            step_runs.record("trending_weekly", status="success", checked={"candidates": len(items), "detail": "cached Google RSS trend/article intersection"}, changed={"added": [t["article_id"] for t in topics] if changed else [], "updated": [], "count": len(topics) if changed else 0}, reason=None if changed else "no-new-data")
        else:
            step_runs.record("trending_weekly", status="failed", checked={"candidates": 0, "detail": "Google RSS cache missing or stale"}, changed={"added": [], "updated": [], "count": 0}, reason="source-fail")
    return 0

if __name__ == "__main__": raise SystemExit(main())
def words(s): return {w for w in re.findall(r"[a-z0-9]+", str(s or "").lower()) if (len(w) > 2 or w.isdigit()) and w not in STOP}
