#!/usr/bin/env python3
"""Apply the auto-pipeline Gemini batch to the live site files.

Reads out/gemini-batch.json (from scripts/gemini_batch.py) and:
  1. Appends each article to js/articles-data.js (window.FA_ARTICLES),
     id = FNV-1a of the source link, base-36 — the same id the site's
     news-item page and feed use. Skips ids already present.
  2. Merges box-office rows into js/daywise-data.js (window.FA_DAYWISE):
     keyed by TMDB id; a row for the same film+day is UPDATED (a correction
     replaces the old number, it never creates a second post/row), otherwise
     appended. Collection is USD (converted in gemini_batch.py at 94.65).
     Rows come from out/gemini-batch.json ("box_office") and, when present,
     out/boxoffice-backfill.json (one-time backfill over old articles).
     Every row passes boxoffice_extract.validate_box_row() before it is
     merged (advance/pre-sales, invalid date, future date, unreleased
     film) — the merge is the last gate; every rejection is logged.
  3. Writes out/auto-feed.json — feed entries for the new articles, which
     scripts/convert-news.py merges into api-news.json (same shape as the
     panel's publish-export feed).
  4. Fills the article_id back into out/processed.json for the fingerprints
     this batch processed.

Usage: apply-auto.py
Exits 0; prints what it did. Writes files only when something changed.
"""
import json
import os
import re
import sys
import time

# Sibling module: the shared box-office row gate (validate_box_row).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import boxoffice_extract

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "out")


def fnv1a(text):
    h = 0x811C9DC5
    for ch in str(text or ""):
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    if h == 0:
        return "0"
    out = ""
    while h:
        h, r = divmod(h, 36)
        out = digits[r] + out
    return out


def read_js_map(path, var):
    """Parse `window.VAR = {...};` into a dict. Returns {} if missing."""
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    start = raw.index("{")
    end = raw.rindex("}")
    return json.loads(raw[start:end + 1])


def write_js_map(path, var, data, header):
    content = (header + f"\nwindow.{var} = " +
               json.dumps(data, ensure_ascii=False, indent=2) + ";\n")
    existing = ""
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            existing = f.read()
    if existing == content:
        return False
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return True


def parse_ts(published):
    from datetime import datetime, timezone
    if not published:
        return int(time.time() * 1000)
    s = str(published).strip()
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return int(time.time() * 1000)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def main():
    batch_path = os.path.join(OUT_DIR, "gemini-batch.json")
    if os.path.exists(batch_path):
        with open(batch_path, encoding="utf-8") as f:
            batch = json.load(f)
    else:
        batch = {}
        print("apply-auto: no gemini-batch.json, batch empty")
    articles = batch.get("articles") or []
    box_rows = batch.get("box_office") or []
    # One-time backfill (scripts/backfill_boxoffice.py): rows extracted
    # from articles already published. Merged by the same section-2 rules
    # below (same film+day updates, never duplicated, never zero).
    bf_path = os.path.join(OUT_DIR, "boxoffice-backfill.json")
    if os.path.exists(bf_path):
        with open(bf_path, encoding="utf-8") as f:
            bf_rows = json.load(f).get("box_office") or []
        if bf_rows:
            print(f"box office: +{len(bf_rows)} backfill rows from {bf_path}")
            box_rows = box_rows + bf_rows
    if not articles and not box_rows:
        print("apply-auto: batch empty, nothing to do")
        return 0

    # ---- 1. articles -> js/articles-data.js
    art_path = os.path.join(ROOT, "js", "articles-data.js")
    existing = read_js_map(art_path, "FA_ARTICLES")
    feed = []
    added, skipped = 0, 0
    for a in articles:
        url = (a.get("source_url") or "").strip()
        if not url:
            skipped += 1
            continue
        aid = fnv1a(url)
        if aid in existing:
            skipped += 1
            continue
        body = a.get("body") or []
        # body must be [{h, p:[...]}]; drop malformed sections
        body = [{"h": s.get("h", ""), "p": [str(x) for x in (s.get("p") or [])]}
                for s in body if isinstance(s, dict) and s.get("h")]
        if not body:
            skipped += 1
            continue
        existing[aid] = {
            "id": aid,
            "type": "news",
            "headline": a.get("headline") or "",
            "dek": a.get("dek") or "",
            "body": body,
            "facts": [str(x) for x in (a.get("facts") or [])],
            "entities": a.get("entities") or {"titles": [], "people": []},
            # spec §5: carry the pipeline's images through verbatim
            # (url/caption/source only); articles without one get [].
            "images": [{"url": str(im.get("url") or ""),
                        "caption": str(im.get("caption") or ""),
                        "source": str(im.get("source") or "")}
                       for im in (a.get("images") or [])
                       if isinstance(im, dict) and im.get("url")],
            "published": a.get("published") or time.strftime(
                "%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        feed.append({
            "id": aid,
            "title": a.get("headline") or "",
            "link": url,
            "source": a.get("source") or "",
            "ts": parse_ts(a.get("published")),
        })
        # record the article id against this batch's processed fingerprints
        a["_article_id"] = aid
        added += 1
    art_changed = write_js_map(
        art_path, "FA_ARTICLES", existing,
        "/* FlickAtlas — published articles. GENERATED by the auto-pipeline "
        "(scripts/gemini_batch.py + scripts/apply-auto.py) and the panel "
        "publish-export — do not edit by hand. */")
    print(f"articles: +{added} new, {skipped} skipped (already present/malformed)")

    # ---- 2. box office -> js/daywise-data.js
    # Published titles (for the row guard): tmdb_id -> entry, and
    # source_url -> batch article (for the advance/pre-sales check).
    # The merge is the LAST gate before daywise-data.js: a bogus row
    # must never be written here even if the producer let it through.
    # Two bogus rows went live 2026-10-26 that way (Ramayana Day 1
    # pre-sales for an unreleased film; Drishyam Day 24 with date
    # "2026-00-00"). Every rejection is logged, never silent.
    published = boxoffice_extract.load_published(ROOT)
    by_tmdb = {e["tmdb_id"]: e for e in published.values()}
    by_url = {}
    for a in articles:
        u = (a.get("source_url") or "").strip()
        if u:
            by_url[u] = a
    day_path = os.path.join(ROOT, "js", "daywise-data.js")
    daywise = read_js_map(day_path, "FA_DAYWISE")
    bo_added, bo_updated = 0, 0
    for row in box_rows:
        tid = str(row.get("tmdb_id") or "").strip()
        day = row.get("day")
        if not tid or not day:
            continue
        pub = by_tmdb.get(tid)
        if pub is None:
            print(f"box office: row rejected ({tid} Day {day}): "
                  f"film not published")
            continue
        art = by_url.get((row.get("article_url") or "").strip())
        ok, reason = boxoffice_extract.validate_box_row(row, pub,
                                                        article=art)
        if not ok:
            print(f"box office: row rejected ({pub['title']} "
                  f"Day {day}): {reason}")
            continue
        rows = daywise.setdefault(tid, [])
        entry = {"date": row.get("date") or "",
                 "day": f"Day {int(day)}",
                 "collection": int(row.get("collection_usd") or 0)}
        hit = None
        for r in rows:
            if r.get("day") == entry["day"]:
                hit = r
                break
        if hit is not None:
            if hit.get("collection") != entry["collection"]:
                hit["collection"] = entry["collection"]
                hit["date"] = entry["date"]
                bo_updated += 1
        else:
            rows.append(entry)
            rows.sort(key=lambda r: int(re.sub(r"\D", "", r.get("day", "0")) or 0))
            bo_added += 1
    day_changed = write_js_map(
        day_path, "FA_DAYWISE", daywise,
        "/* FlickAtlas — day-wise box office data. GENERATED by the "
        "auto-pipeline (scripts/gemini_batch.py + scripts/apply-auto.py) "
        "from reconciled post data — do not edit by hand. Keyed by TMDB "
        "movie id; collection = USD for the day. */")
    print(f"box office: +{bo_added} new rows, {bo_updated} updated rows")

    # ---- 3. feed entries for convert-news.py
    feed_path = os.path.join(OUT_DIR, "auto-feed.json")
    if feed:
        with open(feed_path, "w", encoding="utf-8") as f:
            json.dump({"feed": feed}, f, ensure_ascii=False, indent=1)
        print(f"auto-feed: {len(feed)} entries -> {feed_path}")

    # ---- 4. fill article ids back into processed.json
    proc_path = os.path.join(OUT_DIR, "processed.json")
    if os.path.exists(proc_path) and added:
        with open(proc_path, encoding="utf-8") as f:
            processed = json.load(f)
        changed = False
        for a in articles:
            aid = a.get("_article_id")
            url = (a.get("source_url") or "").strip()
            if not aid or not url:
                continue
            for fp, rec in processed.items():
                if rec.get("url") == url and not rec.get("article_id"):
                    rec["article_id"] = aid
                    changed = True
        if changed:
            with open(proc_path, "w", encoding="utf-8") as f:
                json.dump(processed, f, ensure_ascii=False, indent=1)
            print("processed.json: article ids filled in")

    print(f"articles file changed: {art_changed} | daywise changed: {day_changed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

