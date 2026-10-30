#!/usr/bin/env python3
"""Convert fetch.py out/queue.json -> api-news.json (+ trending searches -> api-trends.json).

api-trends source: Google Trends daily RSS first; Google removed that
endpoint (HTTP 404 for US and IN, verified 2026-10-28), so the feed
falls back to Tavily week search (same queries as
scripts/trending_weekly.py). Without either leg the old file is kept
and a loud WARNING is printed — the feed must never freeze silently.

api-news shape matches the site's live /api/news:
  {"generated": iso, "count": N,
   "items": [{"id", "title", "link", "source", "cats", "ts", "summary"}]}
id is the FNV-1a hash of the link, base-36 — the same id the public site's
news feed uses (UI.newsId) and the panel's newsId. cats come from the source's
registry scopes. summary is empty: the site never renders feed summary text
(brief mode composes from facts only).
"""
import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

try:
    # Per-run record for the stats dashboard (out/step-runs.json).
    # A missing/broken helper must never break this script.
    import step_runs
except Exception:  # noqa: BLE001 - record helper is best-effort
    step_runs = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "out")


def fnv1a(text):
    h = 0x811C9DC5
    for ch in str(text or ""):
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return _base36(h)


def _base36(n):
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    if n == 0:
        return "0"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return out


def scope_cats(scopes):
    cats = set()
    for s in scopes or []:
        low = s.lower()
        if "bollywood" in low:
            cats.add("bollywood")
        if "pakistan" in low or "lollywood" in low:
            cats.add("pakistan")
        if "korea" in low:
            cats.add("korea")
        if "celebrity" in low:
            cats.add("celebrity")
        if "viral" in low:
            cats.add("viral")
        if "international" in low or "hollywood" in low or low.strip() == "uk" or "us /" in low:
            cats.add("international")
    if not cats:
        cats.add("international")
    order = ["bollywood", "international", "pakistan", "korea", "celebrity", "viral"]
    return [c for c in order if c in cats]


from email.utils import parsedate_to_datetime


def parse_ts(published):
    """ISO 8601 or RFC-2822 (RSS feeds use both) -> epoch ms, or None."""
    if not published:
        return None
    s = str(published).strip()
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        try:
            dt = parsedate_to_datetime(s)
        except Exception:
            return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def published_article_ids():
    """Ids of written + published articles, from js/articles-data.js (the
    published set). Only these may appear in the public news feed: the site
    must not show auto-fetched headlines as posts without any writing.
    Returns an empty set if the articles file is missing/unreadable, so a
    broken articles file yields an empty feed rather than unwritten posts."""
    path = os.path.join(ROOT, "js", "articles-data.js")
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read()
        start = raw.index("{")
        end = raw.rindex("}")
        data = json.loads(raw[start:end + 1])
        return set(data.keys())
    except Exception as e:
        print(f"published ids: could not read articles-data.js ({e})")
        return set()


def build_news(queue_path, registry_path):
    with open(registry_path, encoding="utf-8") as f:
        registry = json.load(f)
    by_source = {}
    for entry in registry:
        by_source[entry.get("name", "")] = scope_cats(entry.get("scopes", []))
    with open(queue_path, encoding="utf-8") as f:
        queue = json.load(f)
    items = []
    seen_links = set()
    for row in queue:
        link = (row.get("url") or "").strip()
        title = (row.get("title") or "").strip()
        # The live feed carries no YouTube links: episode/video items belong to
        # the episode guides, not the news feed.
        if not link or not title or link in seen_links:
            continue
        if "youtube.com" in link or "youtu.be" in link:
            continue
        seen_links.add(link)
        ts = parse_ts(row.get("published"))
        if ts is None:
            continue
        source = row.get("source") or ""
        items.append({
            "id": fnv1a(link),
            "title": title,
            "link": link,
            "source": source,
            "cats": by_source.get(source, ["international"]),
            "ts": ts,
            "summary": "",
        })
    # Published articles' feed entries (panel publish-export): the news-item
    # page looks a story up in this feed BEFORE it checks the published
    # articles file, so an approved article whose source story aged out of
    # today's fetch would otherwise show "moved on". Merge them in so every
    # published article stays reachable; they win on id collisions.
    export_path = os.path.join(OUT_DIR, "publish-export.json")
    merged = 0
    published_ids = set()
    if os.path.exists(export_path):
        try:
            with open(export_path, encoding="utf-8") as f:
                export = json.load(f)
            for entry in export.get("feed") or []:
                link = (entry.get("link") or "").strip()
                title = (entry.get("title") or "").strip()
                entry_id = (entry.get("id") or "").strip()
                ts = entry.get("ts")
                if not link or not title or not entry_id or not isinstance(ts, int):
                    continue
                source = entry.get("source") or ""
                items = [i for i in items if i["id"] != entry_id]
                items.append({
                    "id": entry_id,
                    "title": title,
                    "link": link,
                    "source": source,
                    "cats": by_source.get(source, ["international"]),
                    "ts": ts,
                    "summary": "",
                })
                seen_links.add(link)
                published_ids.add(entry_id)
                merged += 1
        except Exception as e:
            print(f"publish-export merge skipped: {e}")
    # Auto-pipeline feed entries (out/auto-feed.json): same shape as the
    # publish-export feed. Auto-written articles reach the feed the same
    # way panel-approved ones do; they win on id collisions.
    auto_path = os.path.join(OUT_DIR, "auto-feed.json")
    if os.path.exists(auto_path):
        try:
            with open(auto_path, encoding="utf-8") as f:
                auto = json.load(f)
            for entry in auto.get("feed") or []:
                link = (entry.get("link") or "").strip()
                title = (entry.get("title") or "").strip()
                entry_id = (entry.get("id") or "").strip()
                ts = entry.get("ts")
                if not link or not title or not entry_id or not isinstance(ts, int):
                    continue
                source = entry.get("source") or ""
                items = [i for i in items if i["id"] != entry_id]
                items.append({
                    "id": entry_id,
                    "title": title,
                    "link": link,
                    "source": source,
                    "cats": by_source.get(source, ["international"]),
                    "ts": ts,
                    "summary": "",
                })
                seen_links.add(link)
                published_ids.add(entry_id)
                merged += 1
        except Exception as e:
            print(f"auto-feed merge skipped: {e}")
    # Episode-tracker feed entries are deliberately NOT merged here
    # (owner order 2026-10-27, news purity): episode info posts live
    # in Episode Guides / Drama Episodes / show pages, never in the
    # news feed. out/episode-feed.json is still written by the tracker
    # for its own record, but convert-news.py no longer reads it.
    # (Removed 2026-10-27: the merge that was here put "Bano Episode 14"
    # etc. into /api/news, where they showed as news headlines.)
    # Cumulative feed: fetch.py's queue is PER-RUN (only stories that are new
    # since the last run), so building the feed from this run alone would
    # shrink it to a handful of items an hour after a big fetch. Carry the
    # previous feed forward (items from the last 48h only, so stale stories
    # age out) and dedupe by id.
    prev_path = os.path.join(ROOT, "api-news.json")
    carried = 0
    if os.path.exists(prev_path):
        try:
            with open(prev_path, encoding="utf-8") as f:
                prev = json.load(f)
            have_ids = {i["id"] for i in items}
            cutoff = int(datetime.now(timezone.utc).timestamp() * 1000) - 48 * 3600 * 1000
            for old in prev.get("items") or []:
                oid = old.get("id")
                ots = old.get("ts")
                if not oid or oid in have_ids or not isinstance(ots, int) or ots < cutoff:
                    continue
                if not old.get("link") or not old.get("title"):
                    continue
                items.append({
                    "id": oid,
                    "title": old.get("title"),
                    "link": old.get("link"),
                    "source": old.get("source") or "",
                    "cats": old.get("cats") or ["international"],
                    "ts": ots,
                    "summary": "",
                })
                have_ids.add(oid)
                carried += 1
        except Exception as e:
            print(f"previous-feed carry skipped: {e}")
    print(f"carried {carried} items from previous feed")
    # Written-only feed: drop every item that has no published article.
    # Auto-fetched headlines must not appear on the site as posts without
    # writing. An article reaches the feed only after it is actually
    # published (present in js/articles-data.js); the publish-export merge
    # above supplies the entry, this filter enforces the gate.
    published = published_article_ids()
    before_filter = len(items)
    items = [i for i in items if i["id"] in published]
    print(f"written-only filter: kept {len(items)} of {before_filter} feed items")
    # Published entries are PINNED: they must survive even when the fresh
    # fetch alone fills the 100-item cap (their export-time ts is older than
    # today's stories, so a plain sort+truncate would drop them and the
    # news-item page would show "moved on" for a published article).
    items.sort(key=lambda x: x["ts"], reverse=True)
    if published_ids:
        pinned = [i for i in items if i["id"] in published_ids]
        fresh = [i for i in items if i["id"] not in published_ids]
        items = fresh[:max(0, 100 - len(pinned))] + pinned
        items.sort(key=lambda x: x["ts"], reverse=True)
    else:
        items = items[:100]
    print(f"merged {merged} published-article feed entries")
    return {
        "generated": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "count": len(items),
        "items": items,
    }


TAVILY_URL = "https://api.tavily.com/search"
# Same focused week queries as scripts/trending_weekly.py, split by
# geo so the items keep their US/IN split.
TREND_SEARCH_QUERIES = [
    ("IN", "trending Bollywood movies this week box office collection"),
    ("IN", "trending entertainment news India this week"),
    ("IN", "viral movie news this week India"),
    ("US", "Hollywood trending movies this week box office"),
    ("US", "trending entertainment news Hollywood this week"),
]


def _now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def trends_discovery_due(record, now):
    """Daily UTC 18:00 Tavily gate, with a 24h cooldown and 25h catch-up."""
    def parsed(value):
        try:
            dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)
        except (TypeError, ValueError):
            return None
    last_attempt = parsed(record.get("last_tavily_attempt", record.get("last_attempt")))
    if last_attempt and (now - last_attempt).total_seconds() < 24 * 3600:
        return False
    if now.astimezone(timezone.utc).hour == 18:
        return True
    last_success = parsed(record.get("last_tavily_success", record.get("last_successful_check")))
    return bool(last_success and (now - last_success).total_seconds() >= 25 * 3600)


def google_trends_due(record, now):
    """At most one RSS fetch per hour, including failed attempts."""
    value = record.get("last_google_attempt")
    try:
        last = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        return (now - last.astimezone(timezone.utc)).total_seconds() >= 3600
    except (TypeError, ValueError):
        return True


def tavily_keys():
    keys = []
    for name in ("TAVILY_API_KEY", "TAVILY_API_KEY_BACKUP"):
        k = os.environ.get(name, "").strip()
        if k:
            keys.append(k)
    return keys


GOOGLE_RSS_URL = "https://trends.google.com/trending/rss?geo={}"
GOOGLE_NAMESPACE = "https://trends.google.com/trending/rss"
GOOGLE_MAX_AGE = 24 * 3600


def _local_name(tag):
    return tag.rsplit("}", 1)[-1]


def _child_text(node, name):
    for child in node.iter():
        if _local_name(child.tag) == name and child is not node:
            return (child.text or "").strip()
    return ""


def parse_google_rss(data, geo, observed_at):
    """Parse one Google feed, preserving source timestamps and related URLs."""
    root = ET.fromstring(data)
    fresh = []
    stale_count = 0
    for item in root.iter():
        if _local_name(item.tag) != "item":
            continue
        q = _child_text(item, "title")
        raw_date = _child_text(item, "pubDate")
        if not q or not raw_date:
            continue
        try:
            started = parsedate_to_datetime(raw_date)
            if started.tzinfo is None:
                started = started.replace(tzinfo=timezone.utc)
            started = started.astimezone(timezone.utc)
        except Exception:
            continue
        age = (observed_at - started).total_seconds()
        if age < 0 or age > GOOGLE_MAX_AGE:
            stale_count += 1
            continue
        related = []
        for related_node in item.iter():
            if _local_name(related_node.tag) != "news_item":
                continue
            title = _child_text(related_node, "news_item_title")
            url = _child_text(related_node, "news_item_url")
            if title:
                related.append({"title": title, "url": url})
        official = GOOGLE_RSS_URL.format(geo)
        fresh.append({
            "q": q, "traffic": _child_text(item, "approx_traffic"), "geo": geo,
            "trending_started_at": started.isoformat().replace("+00:00", "Z"),
            "observed_at": observed_at.isoformat().replace("+00:00", "Z"),
            "feed_url": official, "news": related,
        })
    return fresh, stale_count


def fetch_trends_google(now=None, opener=None):
    """Fetch both current Google RSS feeds, returning evidence and attempt status."""
    now = now or datetime.now(timezone.utc)
    opener = opener or urllib.request.urlopen
    found, successes, stale = [], 0, 0
    errors = []
    for geo in ("US", "IN"):
        url = GOOGLE_RSS_URL.format(geo)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with opener(req, timeout=30) as response:
                data = response.read()
            items, old_count = parse_google_rss(data, geo, now)
            successes += 1
            stale += old_count
            found.extend(items)
        except Exception as exc:
            errors.append(f"{geo}: {exc}")
            print(f"trends {geo} fetch/parse failed: {exc}")
    if successes:
        status = "ok" if found or stale == 0 else "upstream-stale"
        if not found and stale:
            status = "upstream-stale"
        return {"source": "google-rss", "checked_at": now.isoformat().replace("+00:00", "Z"),
                "status": status, "items": found[:100]}, successes, errors
    return None, 0, errors


def fetch_trends_tavily():
    """Tavily week search -> [{q, traffic, geo, news}] (fallback leg).

    Shape is unchanged; traffic is "" — Tavily reports no search-volume
    numbers and no figure is invented. q is the trending story title
    (the same headline-style text Google's feed carried as the query).
    """
    keys = tavily_keys()
    if not keys:
        print("trends tavily: no TAVILY_API_KEY, skipping fallback")
        return []
    found, seen = [], set()
    for geo, query in TREND_SEARCH_QUERIES:
        results, last_err = [], None
        for key in keys:
            try:
                body = json.dumps({
                    "query": query, "search_depth": "basic",
                    "time_range": "week", "max_results": 5,
                }).encode("utf-8")
                req = urllib.request.Request(
                    TAVILY_URL, data=body, method="POST",
                    headers={"Authorization": "Bearer " + key,
                             "Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=30) as r:
                    results = json.load(r).get("results") or []
                break
            except Exception as e:
                last_err = e
                continue
        if not results:
            print(f"trends tavily {geo} failed: {last_err}")
            continue
        for r in results:
            title = (r.get("title") or "").strip()
            if not title or title.lower() in seen:
                continue
            seen.add(title.lower())
            found.append({"q": title, "traffic": "", "geo": geo,
                          "news": [title]})
            if len(found) >= 12:
                break
        if len(found) >= 12:
            break
    return found


def fetch_trends():
    """Trending searches -> {generated, items:[{q,traffic,geo,news}], source}.

    Google RSS first, Tavily week search as fallback. "source" records
    which leg produced the items ("google-rss" | "tavily" | "none").
    """
    google = fetch_trends_google()[0]
    if google and google["items"]:
        return {"generated": _now_iso(), "items": google["items"][:12],
                "source": "google-rss"}
    tavily = fetch_trends_tavily()
    if tavily:
        print(f"api-trends.json: Google RSS dead, Tavily fallback: "
              f"{len(tavily)} items")
        return {"generated": _now_iso(), "items": tavily[:12],
                "source": "tavily"}
    return {"generated": _now_iso(), "items": [], "source": "none"}


def main():
    queue_path = os.path.join(OUT_DIR, "queue.json")
    registry_path = os.path.join(ROOT, "scripts", "registry.json")
    news = build_news(queue_path, registry_path)
    news_path = os.path.join(ROOT, "api-news.json")
    old_ids = set()
    try:
        with open(news_path, encoding="utf-8") as f:
            old_ids = {it.get("id") for it in
                       json.load(f).get("items") or []}
    except Exception:
        old_ids = set()
    new_items = [it for it in (news.get("items") or [])
                 if it.get("id") not in old_ids]
    with open(news_path, "w", encoding="utf-8") as f:
        json.dump(news, f, ensure_ascii=False, indent=1)
    print(f"api-news.json: {news['count']} items")
    trends_path = os.path.join(ROOT, "api-trends.json")
    status_path = os.path.join(OUT_DIR, "trends-discovery-state.json")
    try:
        with open(status_path, encoding="utf-8") as f:
            discovery_state = json.load(f)
    except (OSError, ValueError):
        discovery_state = {}
    now_utc = datetime.now(timezone.utc)
    trends_count = 0
    google_evidence_path = os.path.join(OUT_DIR, "google-trends-evidence.json")
    google_items = []
    try:
        with open(google_evidence_path, encoding="utf-8") as f:
            google_items = json.load(f).get("items") or []
    except (OSError, ValueError):
        pass
    # A transport error preserves the last-good evidence file, but old rows
    # must not be presented as current or suppress the scheduled fallback.
    current_google_items = []
    for item in google_items:
        try:
            observed = datetime.fromisoformat(item["observed_at"].replace("Z", "+00:00"))
            if observed.tzinfo is None:
                observed = observed.replace(tzinfo=timezone.utc)
            age = (now_utc - observed.astimezone(timezone.utc)).total_seconds()
            if 0 <= age <= GOOGLE_MAX_AGE:
                current_google_items.append(item)
        except (KeyError, TypeError, ValueError):
            continue
    if google_trends_due(discovery_state, now_utc):
        discovery_state["last_google_attempt"] = now_utc.isoformat(timespec="seconds").replace("+00:00", "Z")
        evidence, successes, errors = fetch_trends_google(now_utc)
        if evidence is not None:
            # A successfully parsed empty feed is valid evidence. A fully stale
            # result deliberately replaces current items with none.
            if evidence.get("status") == "ok":
                # Rolling 24h pool: keep terms observed earlier today (still
                # inside GOOGLE_MAX_AGE) so the Trending Topics intersection
                # is not limited to whichever terms happen to sit in the
                # latest hourly snapshot. Fresh rows win on (geo, term) and
                # every kept row retains its real last-observed timestamp.
                fresh_keys = {(it.get("geo"), str(it.get("q") or "").strip().lower())
                              for it in evidence["items"]}
                kept = []
                for it in google_items:
                    key = (it.get("geo"), str(it.get("q") or "").strip().lower())
                    if key in fresh_keys:
                        continue
                    try:
                        seen = datetime.fromisoformat(str(it["observed_at"]).replace("Z", "+00:00"))
                        if seen.tzinfo is None:
                            seen = seen.replace(tzinfo=timezone.utc)
                        age = (now_utc - seen.astimezone(timezone.utc)).total_seconds()
                    except (KeyError, TypeError, ValueError):
                        continue
                    if 0 <= age <= GOOGLE_MAX_AGE:
                        kept.append(it)
                evidence["items"] = (evidence["items"] + kept)[:100]
            with open(google_evidence_path, "w", encoding="utf-8") as f:
                json.dump(evidence, f, ensure_ascii=False, indent=1)
            google_items = evidence["items"]
            current_google_items = google_items
            discovery_state["last_google_success"] = evidence["checked_at"]
            discovery_state["last_google_status"] = evidence["status"]
            discovery_state.pop("last_google_error", None)
        else:
            # Leave last-good evidence (including checked_at) intact.
            discovery_state["last_google_status"] = "error"
            discovery_state["last_google_error"] = "; ".join(errors)[:500]
    else:
        print("Google Trends RSS: hourly gate closed")

    # Public compatibility feed still caps Google items at 12. The dedicated
    # evidence file retains up to 100 rows for downstream intersection.
    if current_google_items:
        trends = {"generated": _now_iso(), "items": current_google_items[:12], "source": "google-rss"}
        with open(trends_path, "w", encoding="utf-8") as f:
            json.dump(trends, f, ensure_ascii=False, indent=1)
        trends_count = len(trends["items"])

    # Tavily is a separate, paid discovery fallback: daily UTC 18:00 only,
    # and only when Google currently supplies no items.
    if not current_google_items and trends_discovery_due(discovery_state, now_utc):
        discovery_state["last_tavily_attempt"] = now_utc.isoformat(timespec="seconds").replace("+00:00", "Z")
        try:
            tavily = fetch_trends_tavily()
            if tavily:
                trends = {"generated": _now_iso(), "items": tavily[:12], "source": "tavily"}
                with open(trends_path, "w", encoding="utf-8") as f:
                    json.dump(trends, f, ensure_ascii=False, indent=1)
                trends_count = len(trends["items"])
                discovery_state["last_tavily_success"] = now_utc.isoformat(timespec="seconds").replace("+00:00", "Z")
                print(f"api-trends.json: {len(tavily)} items (source=tavily)")
            else:
                print("Tavily fallback empty; kept existing api-trends.json")
        except Exception as e:
            print(f"Tavily fallback failed ({e}), kept existing api-trends.json")
    elif not current_google_items:
        print("Tavily fallback: daily gate closed; kept existing api-trends.json")
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(status_path, "w", encoding="utf-8") as f:
        json.dump(discovery_state, f, ensure_ascii=False, indent=1)
    if step_runs is not None:
        step_runs.record(
            "convert_news", status="success",
            checked={"candidates": news.get("count", 0),
                     "detail": "feed entries from out/queue.json"},
            changed={"added": [it.get("title") or "" for it in new_items],
                     "updated": [], "count": len(new_items),
                     "detail": "api-news.json %d items, api-trends.json "
                               "%d items" % (news.get("count", 0),
                                             trends_count)},
            reason=None if new_items else "no-new-data")


if __name__ == "__main__":
    main()
