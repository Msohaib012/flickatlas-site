#!/usr/bin/env python3
"""FlickAtlas catalogue builder — staged data-page expansion.

SPIKE (2026-11-14): the first builder for the catalogue (data-only)
expansion. It takes TMDB list/discover pools, fetches details +
providers + credits per title, applies the AdSense quality gate, and
writes the title into its per-bucket chunk files:

  js/cat/<bb>.json  — browser data chunk: the catalogue entry per title
                      (same shape as FA_PUBLISHED entries, plus
                      source="catalogue", catalogue=true, providers,
                      cast + director). Entries are keyed "kind:id"
                      ("movie:101" / "tv:101") — a movie+TV pair sharing
                      a numeric id (movie 101 Léon vs TV 101 "Beat the
                      Geeks") must not overwrite each other. Stage-1a
                      wrote bare-id keys; the builder migrates them on
                      its next run (migrate_cat_chunks + migrate_state_keys)
                      and the detail pages try the prefixed key first,
                      bare key as fallback.
  js/seo/<bb>.json  — Worker meta chunk: the seo-meta entry per title
                      (same shape as js/seo-meta.json values, built by
                      scripts/seo_assets.title_meta with credits, so
                      cast/director land in the JSON-LD + SSR block).

Bucket: bb = tmdb id % 100, zero-padded to 2 digits. 100 buckets, so
at 45k titles each chunk holds ~450 titles: ~1.0 MB meta, ~0.5 MB
data (measured per-entry means 2,175 B meta / 1,009 B entry). Both
stay far under the 25 MB per-file Workers Assets limit, and the
Worker loads only the one chunk for the requested id — never a
~98 MB single file.

Why chunks, not KV and not on-demand TMDB:
  * Static chunks are deterministic, versioned with git, and deploy
    atomically with the site (the deploy uploader is hash-based, so
    only changed chunks upload). KV would need a separate population
    system, paid write volume, and eventual-consistency reads.
  * On-demand TMDB at the edge would need the meta/SSR builder ported
    to JS, shares the public key's rate limit, and gives crawlers a
    cold-cache latency hit on first fetch.

Determinism: chunk files carry no timestamps (the run time lives in
out/catalogue-state.json, which is never deployed), keys are sorted,
writes happen only when content changed — so the hourly pipeline
does not force spurious commits. State is resumable: a run records
done ids + the pool cursor, so the next run continues where it left
off; re-running the same ids is a no-op when nothing changed.

Quality gate (AdSense-safe, no thin pages): a title enters the
catalogue only with a poster, a real overview (>= 40 chars), at
least 20 TMDB votes, and adult=false. Titles failing the gate are
recorded in the state file as skipped with a reason, never retried
blindly (a title is re-checked only if a later pool run sees it
again with a different vote count — the state records the vote
count at skip time).

TMDB key: TMDB_API_KEY env, --key, or js/config.js TMDB_KEY (same
resolution as scripts/fetch-credits.py). Stdlib only.

Usage:
  python3 scripts/catalogue_build.py --pool top_rated --media movie --limit 100
  python3 scripts/catalogue_build.py --pool discover --media both \\
      --query "sort_by=vote_count.desc&vote_count.gte=300&vote_count.lte=999" \\
      --limit 1000 --max-pages 50
  python3 scripts/catalogue_build.py --pool top_rated --media both --limit 100 --dry-run
"""
import argparse
import importlib.util
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(ROOT, "scripts")
CONFIG_JS = os.path.join(ROOT, "js", "config.js")
CAT_DIR = os.path.join(ROOT, "js", "cat")
SEO_DIR = os.path.join(ROOT, "js", "seo")
STATE_PATH = os.path.join(ROOT, "out", "catalogue-state.json")
CREDITS_PATH = os.path.join(ROOT, "out", "credits.json")
TMDB_API = "https://api.themoviedb.org/3"
BUCKETS = 100
SLEEP = 0.3
MIN_OVERVIEW = 40
MIN_VOTES = 20
PROVIDER_REGIONS = ("IN", "US", "GB")


def log(msg):
    print(msg, flush=True)


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# publish-titles.py (hyphenated) and seo_assets.py are imported, not
# copied: one implementation of build_entry / title_meta each.
PT = load_module("fa_publish_titles", os.path.join(SCRIPTS, "publish-titles.py"))
SA = load_module("fa_seo_assets", os.path.join(SCRIPTS, "seo_assets.py"))


def read_key(args):
    if getattr(args, "key", None):
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


def tmdb_get(path, key):
    return PT.tmdb_get(path, key)


_NO_RESULTS = object()


def fetch_watch_results(tid, kind, key):
    """Raw TMDB watch/providers `results` dict (best-effort) — one call
    shared by the flatrate (OTT) and all-kinds (Where to Watch) lists."""
    try:
        d = tmdb_get("/%s/%s/watch/providers" % (kind, tid), key)
    except Exception:
        return None
    if not isinstance(d, dict):
        return None
    return d.get("results") or {}


def fetch_providers(tid, kind, key, results=_NO_RESULTS):
    """Flatrate provider names for IN, US, GB (in that priority order),
    unique by name. Returns [] on any failure (best-effort). `results`
    may be passed in (from fetch_watch_results) to share one fetch
    with fetch_providers_wtw; None means the fetch already failed."""
    if results is _NO_RESULTS:
        results = fetch_watch_results(tid, kind, key)
    if not results:
        return []
    out = []
    seen = set()
    for region in PROVIDER_REGIONS:
        flat = (results.get(region) or {}).get("flatrate") or []
        for p in flat:
            name = (p or {}).get("provider_name")
            if name and name not in seen:
                seen.add(name)
                out.append({"name": name})
    return out


def fetch_providers_wtw(tid, kind, key, results=_NO_RESULTS):
    """Where-to-Watch providers (best-effort): flatrate/rent/buy for the
    first region (IN, then US, then GB) that has ANY provider. Each
    entry is {name, logo_path, region, kind}. Kept separate from
    `providers`: the OTT page is streaming-only and depends on
    `providers` being flatrate-only."""
    if results is _NO_RESULTS:
        results = fetch_watch_results(tid, kind, key)
    if not results:
        return []
    for region in PROVIDER_REGIONS:
        entry = results.get(region) or {}
        out = []
        for kind_name in ("flatrate", "rent", "buy"):
            for p in entry.get(kind_name) or []:
                name = (p or {}).get("provider_name")
                if not name:
                    continue
                out.append({"name": name,
                            "logo_path": (p or {}).get("logo_path") or "",
                            "region": region, "kind": kind_name})
        if out:
            return out
    return []


def fetch_credits(tid, kind, key):
    """Top-10 cast + directors, in out/credits.json shape."""
    try:
        d = tmdb_get("/%s/%s/credits" % (kind, tid), key)
    except Exception:
        return None
    if not isinstance(d, dict):
        return None
    cast = []
    for c in (d.get("cast") or [])[:10]:
        name = (c or {}).get("name")
        if name:
            cast.append({"n": name, "c": (c or {}).get("character") or ""})
    directors = []
    for c in (d.get("crew") or []):
        if (c or {}).get("job") == "Director" and (c or {}).get("name"):
            directors.append(c["name"])
    return {"cast": cast, "dir": directors}


def quality_gate(details):
    """AdSense gate: poster + real overview + votes + not adult."""
    if details.get("adult"):
        return False, "adult"
    if not details.get("poster_path"):
        return False, "no-poster"
    overview = (details.get("overview") or "").strip()
    if len(overview) < MIN_OVERVIEW:
        return False, "thin-overview"
    if (details.get("vote_count") or 0) < MIN_VOTES:
        return False, "few-votes"
    return True, ""


def bucket_of(tid):
    return str(int(tid) % BUCKETS).zfill(2)


def chunk_key(kind, tid):
    """Chunk/state key for one title: "movie:101" / "tv:101". Bare
    numeric ids collide across media (movie 101 Léon vs TV 101
    "Beat the Geeks"), so no key is ever a bare id after stage 1a."""
    return "%s:%s" % (kind, tid)


def chunk_paths(bucket):
    return (os.path.join(CAT_DIR, bucket + ".json"),
            os.path.join(SEO_DIR, bucket + ".json"))


def read_chunk(path):
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get("titles"), dict):
            return d["titles"]
    except (OSError, ValueError):
        pass
    return {}


def dump_chunk(bucket, titles):
    payload = {"bucket": bucket, "count": len(titles), "titles": titles}
    return (json.dumps(payload, ensure_ascii=False, indent=1,
                       sort_keys=True) + "\n")


def write_if_changed(path, text):
    try:
        with open(path, encoding="utf-8") as f:
            if f.read() == text:
                return False
    except OSError:
        pass
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return True


def build_title(tid, kind, key, today):
    """Fetch + gate + build (entry, meta, credits) for one TMDB id.
    `kind` is pinned by the pool: PT.fetch_title() tries movie-first
    and would return movie data for a TV id sharing the numeric id
    (TV 101 "Beat the Geeks" exists alongside movie 101 "Léon"), so
    the kind is fetched directly here. Pakistani-origin TV is skipped
    (reason "pk-origin"): Pakistani content on FlickAtlas comes from
    the YouTube drama track, never TMDB — a PK TV entry would take the
    show page's isPakistani() drama path (YouTube Episodes list, no
    Seasons table). Returns (entry, meta, credits) or
    (None, None, None) with the skip reason logged by the caller via
    the second return slot."""
    append = ("videos,release_dates" if kind == "movie"
              else "videos,content_ratings")
    try:
        details = tmdb_get("/%s/%s?append_to_response=%s" % (kind, tid, append), key)
    except Exception:
        return None, None, None, "fetch-error"
    if details is None:
        return None, None, None, "not-found"
    ok, reason = quality_gate(details)
    if not ok:
        return None, None, None, reason
    if kind == "tv" and "PK" in [str(c).upper()
                                 for c in (details.get("origin_country") or [])]:
        return None, None, None, "pk-origin"
    _watch = fetch_watch_results(tid, kind, key)
    providers = fetch_providers(tid, kind, key, _watch)
    providers_wtw = fetch_providers_wtw(tid, kind, key, _watch)
    credits = fetch_credits(tid, kind, key)
    entry = PT.build_entry(details, kind, ["catalogue"], today)
    entry["source"] = "catalogue"
    entry["catalogue"] = True
    entry["catalogue_stage"] = 1
    entry["providers"] = providers
    entry["providers_wtw"] = providers_wtw
    if isinstance(credits, dict):
        entry["cast"] = credits.get("cast") or []
        entry["director"] = credits.get("dir") or []
    meta = SA.title_meta(entry, credits)
    return entry, meta, credits, ""


def pool_top_rated(key, media, limit, state_done):
    """Yield (tid, kind) from /movie/top_rated and/or /tv/top_rated,
    in rank order, until `limit` fresh ids are collected."""
    kinds = ["movie", "tv"] if media == "both" else [media]
    out = []
    for kind in kinds:
        page = 1
        while len(out) < limit:
            d = tmdb_get("/%s/top_rated?page=%d" % (kind, page), key)
            results = (d or {}).get("results") or []
            if not results:
                break
            for r in results:
                tid = str(r.get("id"))
                if (chunk_key(kind, tid) not in state_done
                        and (tid, kind) not in out):
                    out.append((tid, kind))
                    if len(out) >= limit:
                        break
            page += 1
            time.sleep(SLEEP)
            if page > 500:
                break
    return out


def pool_discover(key, media, query, limit, max_pages, state_done):
    """Yield (tid, kind) from a discover query (query string without
    api_key, e.g. sort_by=vote_count.desc&vote_count.gte=300). The
    caller splits pools so no query exceeds TMDB's 500-page window."""
    kinds = ["movie", "tv"] if media == "both" else [media]
    out = []
    for kind in kinds:
        page = 1
        while len(out) < limit and page <= max_pages:
            d = tmdb_get("/discover/%s?%s&page=%d" % (kind, query, page), key)
            results = (d or {}).get("results") or []
            if not results:
                break
            for r in results:
                tid = str(r.get("id"))
                if (chunk_key(kind, tid) not in state_done
                        and (tid, kind) not in out):
                    out.append((tid, kind))
                    if len(out) >= limit:
                        break
            page += 1
            time.sleep(SLEEP)
    return out


def load_state():
    try:
        with open(STATE_PATH, encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict):
            return d
    except (OSError, ValueError):
        pass
    return {"pools": {}, "added": {}, "skipped": {}, "updated": ""}


def load_published_keys():
    """kind:id keys of every published title (FA_PUBLISHED). A published
    title must never also live in the catalogue — its URL would appear
    in both sitemap-main.xml and a sitemap-cat-<bb>.xml, and the posting
    system (recent movies/TV) already owns it. Fail-open: an unreadable
    published file yields an empty set (old behaviour)."""
    try:
        pub = PT.read_js_map(os.path.join(ROOT, "js", "published-titles.js"),
                             "FA_PUBLISHED")
    except Exception:
        return set()
    out = set()
    for tid, entry in (pub or {}).items():
        kind = (entry or {}).get("type") or "movie"
        out.add("%s:%s" % (kind, tid))
    return out


def migrate_cat_chunks(published=None):
    """Rewrite existing js/cat chunks from stage-1a bare-id keys to
    kind:id keys. The kind comes from each entry's own "type" field
    (build_entry always sets it). A bare entry whose prefixed key
    already exists is dropped, never overwriting the newer entry.
    Entries whose kind:id is in `published` are dropped too: a title
    the posting system published since it was catalogued belongs to
    the posting system now, not the catalogue. Runs over ALL buckets
    so the migration completes in one run, whether or not the pool
    touches a bucket. Returns (buckets_rewritten, entries_renamed)."""
    if not os.path.isdir(CAT_DIR):
        return 0, 0
    rewritten, renamed, dropped_pub = 0, 0, 0
    for name in sorted(os.listdir(CAT_DIR)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(CAT_DIR, name)
        titles = read_chunk(path)
        if not titles:
            continue
        new_titles, changed = {}, False
        for key, entry in titles.items():
            key = str(key)
            if ":" in key:
                if published and key in published:
                    changed = True
                    dropped_pub += 1
                    continue
                new_titles[key] = entry
                continue
            changed = True
            kind = (entry or {}).get("type") or "movie"
            new_key = chunk_key(kind, key)
            if published and new_key in published:
                dropped_pub += 1
                continue
            if new_key not in new_titles:
                new_titles[new_key] = entry
                renamed += 1
            # else: a prefixed entry already covers this title; the
            # bare duplicate is dropped.
        if changed:
            bucket = name[:-len(".json")]
            if write_if_changed(path, dump_chunk(bucket, new_titles)):
                rewritten += 1
    if dropped_pub:
        log("catalogue_build: dropped %d published titles from cat chunks"
            % dropped_pub)
    return rewritten, renamed


def drop_published_from_seo_chunks(published):
    """Drop published titles from js/seo/<bb>.json. The seo chunks are
    keyed kind:id already, so this is a membership filter — no type
    resolution needed. Without it a stale catalogue meta would win
    over the published seo-meta.json entry in the Worker's chunk-first
    lookup. Returns (buckets_rewritten, dropped)."""
    if not os.path.isdir(SEO_DIR):
        return 0, 0
    rewritten, dropped = 0, 0
    for name in sorted(os.listdir(SEO_DIR)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(SEO_DIR, name)
        titles = read_chunk(path)
        if not titles:
            continue
        new_titles = {k: v for k, v in titles.items()
                      if str(k) not in published}
        if len(new_titles) != len(titles):
            dropped += len(titles) - len(new_titles)
            bucket = name[:-len(".json")]
            if write_if_changed(path, dump_chunk(bucket, new_titles)):
                rewritten += 1
    if dropped:
        log("catalogue_build: dropped %d published titles from seo chunks"
            % dropped)
    return rewritten, dropped


def migrate_state_keys(state):
    """Rewrite bare-id keys in state["added"]/state["skipped"] to
    kind:id keys, resolving the kind from the title's cat-chunk entry
    (chunks are migrated first, so the lookup tries the prefixed key).
    Unresolvable keys are dropped — the title is rebuilt by a later
    pool run. Returns (renamed, dropped)."""
    renamed, dropped = 0, 0
    cache = {}

    def entry_for(tid):
        bucket = bucket_of(tid)
        if bucket not in cache:
            cache[bucket] = read_chunk(os.path.join(CAT_DIR, bucket + ".json"))
        titles = cache[bucket]
        return (titles.get(tid) or titles.get("movie:" + tid)
                or titles.get("tv:" + tid))

    for section in ("added", "skipped"):
        old = state.get(section) or {}
        new = {}
        for key, val in old.items():
            key = str(key)
            if ":" in key:
                new[key] = val
                continue
            entry = entry_for(key)
            if entry and (entry.get("type") in ("movie", "tv")):
                new[chunk_key(entry["type"], key)] = val
                renamed += 1
            else:
                dropped += 1
                log("catalogue_build: dropping unresolvable state key "
                    "%s:%s" % (section, key))
        state[section] = new
    return renamed, dropped


def main():
    ap = argparse.ArgumentParser(description="Build FlickAtlas catalogue chunks")
    ap.add_argument("--pool", required=True, choices=["top_rated", "discover"],
                    help="TMDB pool to draw titles from")
    ap.add_argument("--media", default="movie", choices=["movie", "tv", "both"])
    ap.add_argument("--limit", type=int, default=100)
    ap.add_argument("--query", default="",
                    help="discover query string (no api_key) for --pool discover")
    ap.add_argument("--max-pages", type=int, default=500)
    ap.add_argument("--key", default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    key = read_key(args)
    if not key:
        print("catalogue_build: no TMDB key — set TMDB_API_KEY or --key",
              file=sys.stderr)
        return 2
    today = time.strftime("%Y-%m-%d", time.gmtime())
    state = load_state()
    # Published titles belong to the posting system, never the
    # catalogue: the same URL must not appear in both sitemap-main.xml
    # and a sitemap-cat-<bb>.xml. The published set is the filter for
    # the pool below and the cleanup of already-catalogued titles.
    published = load_published_keys()
    if published:
        log("catalogue_build: %d published titles excluded from catalogue"
            % len(published))
    # Stage-1a wrote bare-id keys; TV needs kind:id keys (a movie+TV
    # pair sharing a numeric id overwrote each other in js/cat).
    # Migrate chunks first (state resolution reads them), then state.
    # Skipped on --dry-run: a dry run must not change anything.
    if not args.dry_run:
        n_buckets, n_renamed = migrate_cat_chunks(published)
        if n_renamed:
            log("catalogue_build: migrated %d cat entries in %d buckets to "
                "kind:id keys" % (n_renamed, n_buckets))
        if published:
            drop_published_from_seo_chunks(published)
        n_state, n_dropped = migrate_state_keys(state)
        if n_state or n_dropped:
            log("catalogue_build: migrated %d state keys, dropped %d "
                "unresolvable" % (n_state, n_dropped))
        if published:
            for section in ("added", "skipped"):
                sec = state.get(section) or {}
                gone = [k for k in sec if k in published]
                for k in gone:
                    del sec[k]
                if gone:
                    log("catalogue_build: dropped %d published keys from "
                        "state[%s]" % (len(gone), section))
    done = set(state.get("added", {}).keys())
    pool_name = "%s:%s:%s" % (args.pool, args.media, args.query or "-")

    if args.pool == "top_rated":
        ids = pool_top_rated(key, args.media, args.limit, done)
    else:
        if not args.query:
            print("catalogue_build: --pool discover needs --query",
                  file=sys.stderr)
            return 2
        ids = pool_discover(key, args.media, args.query, args.limit,
                            args.max_pages, done)
    if published:
        before = len(ids)
        ids = [(t, k) for (t, k) in ids if chunk_key(k, t) not in published]
        if len(ids) != before:
            log("catalogue_build: skipped %d published ids from pool"
                % (before - len(ids)))
    log("catalogue_build: pool %s -> %d fresh ids" % (pool_name, len(ids)))
    if args.dry_run:
        for tid, kind in ids:
            log("  dry-run %s %s" % (kind, tid))
        return 0

    # Load the credits cache once; merge catalogue credits into it so
    # the hourly seo_assets run sees the same cast/director data.
    try:
        with open(CREDITS_PATH, encoding="utf-8") as f:
            credits_cache = json.load(f)
        if not isinstance(credits_cache, dict):
            credits_cache = {}
    except (OSError, ValueError):
        credits_cache = {}

    cat_chunks = {}   # bucket -> {tid: entry}
    seo_chunks = {}   # bucket -> {"movie:tid": meta}
    changed_buckets = set()
    added, skipped = 0, 0
    for tid, kind in ids:
        entry, meta, credits, reason = build_title(tid, kind, key, today)
        time.sleep(SLEEP)
        if entry is None:
            state.setdefault("skipped", {})[chunk_key(kind, tid)] = reason
            skipped += 1
            continue
        bucket = bucket_of(tid)
        if bucket not in cat_chunks:
            cat_chunks[bucket] = read_chunk(chunk_paths(bucket)[0])
            seo_chunks[bucket] = read_chunk(chunk_paths(bucket)[1])
        cat_chunks[bucket][chunk_key(kind, tid)] = entry
        seo_chunks[bucket]["%s:%s" % (kind, tid)] = meta
        state.setdefault("added", {})[chunk_key(kind, tid)] = today
        # out/credits.json is keyed by BARE id (the shared cache
        # fetch-credits.py + seo_assets read). A TV title must never
        # overwrite a movie's cached credits (or vice versa) — the
        # builder's own meta uses the fresh credits, so only write
        # when the id is not cached yet. Full fix (kind:id cache keys)
        # is a wider migration; flagged in the design doc.
        if isinstance(credits, dict) and tid not in credits_cache:
            credits_cache[tid] = credits
        changed_buckets.add(bucket)
        added += 1
        log("  + %s %s (%s)" % (kind, tid, entry.get("title") or ""))

    wrote = 0
    for bucket in sorted(changed_buckets):
        cat_path, seo_path = chunk_paths(bucket)
        if write_if_changed(cat_path, dump_chunk(bucket, cat_chunks[bucket])):
            wrote += 1
        if write_if_changed(seo_path, dump_chunk(bucket, seo_chunks[bucket])):
            wrote += 1
    if credits_cache:
        write_if_changed(CREDITS_PATH, json.dumps(
            credits_cache, ensure_ascii=False, indent=1, sort_keys=True) + "\n")
    state["pools"][pool_name] = {
        "added": added, "skipped": skipped, "at": today,
        "limit": args.limit}
    state["updated"] = datetime.now(timezone.utc).isoformat()
    write_if_changed(STATE_PATH, json.dumps(
        state, ensure_ascii=False, indent=1, sort_keys=True) + "\n")
    log("catalogue_build: added %d, skipped %d, buckets touched %d, "
        "files written %d" % (added, skipped, len(changed_buckets), wrote))
    return 0


if __name__ == "__main__":
    sys.exit(main())
