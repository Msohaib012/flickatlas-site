#!/usr/bin/env python3
"""Apply the panel publish-export payload to js/articles-data.js.

Usage: apply-publish.py <export.json> <js/articles-data.js>
- export.json is the panel's POST /api/assistant/publish-export response:
  {ok, count, migrated, ids, content} where content is the full
  window.FA_ARTICLES = {...} file.
- Writes the file only when the content changed (or the file is missing).
- When count is 0 / content is empty, leaves the existing file untouched.
- Exits 0 in all non-error cases; prints what it did.
"""
import json
import os
import sys


def main():
    export_path, target_path = sys.argv[1], sys.argv[2]
    with open(export_path, encoding="utf-8") as f:
        payload = json.load(f)
    content = payload.get("content") or ""
    count = payload.get("count") or 0
    if not payload.get("ok") or not content:
        print(f"publish export: nothing to publish (count={count})")
        return 0
    existing = ""
    if os.path.exists(target_path):
        with open(target_path, encoding="utf-8") as f:
            existing = f.read()
    if existing == content:
        print(f"publish export: no change ({count} approved articles)")
        return 0
    with open(target_path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"publish export: wrote {target_path} ({count} approved articles, "
          f"migrated={payload.get('migrated', 0)}, ids={len(payload.get('ids') or [])})")
    # Homepage subset (js/home-articles-data.js) tracks articles-data.js:
    # the homepage loads only the slim newest-120 file, never the full
    # one (scripts/home_articles.py). Best-effort — the hourly workflow
    # rebuilds the subset before commit regardless.
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import home_articles
        root = os.path.dirname(os.path.dirname(os.path.abspath(target_path)))
        home_articles.write_home_articles(root)
    except Exception as e:  # noqa: BLE001
        print(f"home-articles: WARNING subset rebuild failed: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
