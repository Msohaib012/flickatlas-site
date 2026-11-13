#!/usr/bin/env python3
"""FlickAtlas credits cache — fetch TMDB credits (top cast + director)
for published titles missing from out/credits.json.

Phase 2 SSR (2026-11-14): the detail pages fetch credits live in the
browser, so the pipeline never stored them — but the server-side SEO
generator (scripts/seo_assets.py) needs cast + director at build time
to put them in the JSON-LD schema and the pre-rendered SSR facts block.
This script fills that gap, lazily: only titles absent from the cache
are fetched, capped per run (default 50, like refresh-metadata.py), so
a bad TMDB day can never stall the hourly pipeline. The cache is a
pipeline-only artifact (out/, never shipped to the browser).

Shape of out/credits.json (deterministic, sorted keys):
  {"<tmdb id>": {"cast": [{"n": name, "c": character}, ...top 10],
                  "dir": [director names]}}
TV uses /tv/{id}/credits; movies use /movie/{id}/credits. Failures are
best-effort: logged and skipped, never fatal — an entry without credits
simply gets no cast section in seo-meta.json.

TMDB key: TMDB_API_KEY env, --key, or js/config.js TMDB_KEY (same
resolution as scripts/refresh-metadata.py). Stdlib only.
"""
import argparse
import json
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_JS = os.path.join(ROOT, "js", "config.js")
PUBLISHED_JS = os.path.join(ROOT, "js", "published-titles.js")
CACHE_PATH = os.path.join(ROOT, "out", "credits.json")
TMDB_API = "https://api.themoviedb.org/3"
CAST_TOP = 10
DEFAULT_MAX = 50
DEFAULT_SLEEP = 0.3


def log(msg):
    print(msg, flush=True)


def read_key(args):
    if args.key:
        return args.key
    env = os.environ.get("TMDB_API_KEY", "").strip()
    if env:
        return env
    if os.path.exists(CONFIG_JS):
        with open(CONFIG_JS, encoding="utf-8") as f:
            raw = f.read()
        m = re.search(r'TMDB_KEY:\s*"([^"]+)"', raw)
        if m:
            return m.group(1)
    return ""


def read_js_map(path):
    with open(path, encoding="utf-8") as f:
        s = f.read()
    i = s.index("{")
    j = s.rindex("}")
    return json.loads(s[i:j + 1])


def read_cache():
    try:
        with open(CACHE_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def fetch_credits(tid, media, key):
    """(cast, directors) for one title, or None on any failure.
    Hard timeout: urllib's timeout=25 does NOT always fire on this VM —
    a stalled egress-proxy read hung one fetch in poll() for 10+ minutes
    (spike 2026-11-14, killed by hand). SIGALRM bounds every fetch to
    30s regardless of where the socket stalls."""
    url = "%s/%s/%s/credits?api_key=%s" % (TMDB_API, media, tid, key)

    def _alarm(signum, frame):
        raise TimeoutError("credits fetch timed out (SIGALRM)")

    old_handler = None
    try:
        if hasattr(signal, "SIGALRM"):
            old_handler = signal.signal(signal.SIGALRM, _alarm)
            signal.alarm(30)
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=25) as r:
            data = json.load(r)
    except (urllib.error.URLError, urllib.error.HTTPError,
            ValueError, TimeoutError, OSError) as e:
        log("  credits fetch failed for %s: %s" % (tid, e))
        return None
    finally:
        if hasattr(signal, "SIGALRM"):
            signal.alarm(0)
            if old_handler is not None:
                signal.signal(signal.SIGALRM, old_handler)
    cast = []
    for c in (data.get("cast") or [])[:CAST_TOP]:
        name = (c.get("name") or "").strip()
        if not name:
            continue
        item = {"n": name}
        character = (c.get("character") or "").strip()
        if character:
            item["c"] = character
        cast.append(item)
    directors = []
    for c in (data.get("crew") or []):
        if c.get("job") == "Director" and (c.get("name") or "").strip():
            name = c["name"].strip()
            if name not in directors:
                directors.append(name)
    return {"cast": cast, "dir": directors}


def main():
    ap = argparse.ArgumentParser(
        description="Fetch TMDB credits for published titles missing "
                    "from out/credits.json (phase-2 SSR cache).")
    ap.add_argument("--max", type=int, default=DEFAULT_MAX,
                    help="max titles to fetch this run (default %(default)s)")
    ap.add_argument("--sleep", type=float, default=DEFAULT_SLEEP,
                    help="seconds between TMDB calls (default %(default)s)")
    ap.add_argument("--key", default="",
                    help="TMDB API key (else TMDB_API_KEY or js/config.js)")
    ap.add_argument("--only", default="",
                    help="comma-separated TMDB ids to fetch (ignores --max)")
    args = ap.parse_args()

    key = read_key(args)
    if not key:
        print("fetch-credits: no TMDB key — set TMDB_API_KEY, --key, "
              "or js/config.js TMDB_KEY", file=sys.stderr)
        return 1

    published = read_js_map(PUBLISHED_JS)
    cache = read_cache()
    if args.only:
        wanted = [t.strip() for t in args.only.split(",") if t.strip()]
        todo = [(tid, published[tid].get("type")) for tid in wanted
                if tid in published]
        missing = [tid for tid in wanted if tid not in published]
        for tid in missing:
            log("  SKIP %s: not a published title" % tid)
    else:
        todo = []
        for tid in sorted(published, key=lambda x: int(x)):
            if tid in cache:
                continue
            todo.append((tid, published[tid].get("type")))
        todo = todo[:args.max]

    fetched, failed = 0, 0
    os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)

    def save_cache():
        # Incremental + atomic: a killed or hung run keeps the titles it
        # already fetched (the first spike backfill lost its in-memory
        # progress when one fetch stalled the process for 10+ minutes).
        tmp = CACHE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=1, sort_keys=True)
            f.write("\n")
        os.replace(tmp, CACHE_PATH)

    for tid, media in todo:
        media = "tv" if media == "tv" else "movie"
        result = fetch_credits(tid, media, key)
        if result is None:
            failed += 1
        else:
            cache[tid] = result
            fetched += 1
            if fetched % 10 == 0:
                save_cache()
        done = fetched + failed
        if done % 25 == 0:
            log("  ... %d/%d done (%d fetched, %d failed)"
                % (done, len(todo), fetched, failed))
        time.sleep(args.sleep)

    save_cache()
    log("fetch-credits: %d fetched, %d failed, %d total cached"
        % (fetched, failed, len(cache)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
