#!/usr/bin/env python3
"""Build js/ott-data.js — the OTT section's data file (owner order 2026-10-27).

Reads the published catalogue (js/published-titles.js) and classifies
titles into two groups:

  now    — streaming providers present AND release/air date is today or
           earlier (including older TV series still listed as available).
           A movie whose real digital (streaming) date is known carries
           THAT date with date_kind "digital" — the actual OTT arrival,
           which is what orders the section (owner order 2026-10-30) —
           instead of its theatrical date.
  coming — the title is arriving on streaming soon, from two honest
           sources:
           (a) DIGITAL DATE (preferred): TMDB release_dates type 4
               (Digital) within the next 30 days — the actual streaming
               premiere date. The platform comes from the type-4 note
               ("Netflix", "Prime Video", ...) matched against TMDB's
               own provider registry for the logo; a title whose note
               names no known provider shows the date with NO logo,
               never a guessed one. date_kind is "digital".
           (b) SOURCE-VERIFIED TV PREMIERE: an explicit future
               `ott_release_date`, `ott_release_provider`, and HTTPS source
               are present in the published entry, and the provider matches
               the title's provider list. A generic TV premiere date alone
               is never OTT evidence. Future movie theatrical dates are
               not shown in Coming to OTT.

Each entry is {id, type, providers: [{name, logo_path}], date,
date_kind} (+ "country" on digital entries: the country the digital
date came from). Pages label digital dates as the streaming date
("Streaming 3 November 2026") and release dates as the release date
("Released 23 October 2026" / "Releasing 29 October 2026").

Digital enrichment needs a TMDB key (env TMDB_API_KEY, --tmdb-key, or
js/config.js TMDB_KEY). Without a key — or when TMDB is unreachable —
it is skipped with a stderr note and the file is built from the old
rule alone; the script never raises for this. Digital results are
cached in out/ott-digital.json: every confirmed digital date is kept
permanently (past dates are what date the Now entries; the old rule
kept only future dates and forgot each premiere the day it happened).
Each refresh is bounded (DIGITAL_FETCH_BUDGET release_dates calls)
and prioritised — known future premieres first, then titles released
in the last 120 days, then releases due in the next 60 days, then a
rotating slice of the rest ordered by check staleness — so the whole
catalogue is re-verified within a few days at a fraction of the old
all-movies-every-12h cost. Records for titles outside a run's slice
are carried over untouched; any TMDB failure aborts the refresh and
keeps the last-good cache (use --refresh-digital to force a fetch).

Deterministic output (sorted keys, fixed entry order, no timestamps):
the file is written only when its bytes actually change, so the hourly
pipeline never makes a spurious commit. The digital fetch itself adds
no TMDB calls when the cache is fresh.

Usage:
  python3 scripts/build_ott.py [--published js/published-titles.js]
                               [--out js/ott-data.js] [--dry-run]
                               [--tmdb-key KEY] [--digital-days 30]
                               [--digital-cache out/ott-digital.json]
                               [--refresh-digital]
  --dry-run prints what it would write, writes nothing.
Imported by scripts/title-seed.py (end of main): the seeder rebuilds
ott-data.js on every run so new titles with providers join the OTT
section automatically.
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
from datetime import date, timedelta, datetime, timezone

try:
    # Per-run record for the stats dashboard (out/step-runs.json).
    # A missing/broken helper must never break this script.
    import step_runs
except Exception:  # noqa: BLE001 - record helper is best-effort
    step_runs = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PUBLISHED = os.path.join(ROOT, "js", "published-titles.js")
DEFAULT_OUT = os.path.join(ROOT, "js", "ott-data.js")
DEFAULT_DIGITAL_CACHE = os.path.join(ROOT, "out", "ott-digital.json")
DEFAULT_CONFIG = os.path.join(ROOT, "js", "config.js")
PUBLISH_TITLES = os.path.join(ROOT, "scripts", "publish-titles.py")
TMDB_BASE = "https://api.themoviedb.org/3"
DIGITAL_DAYS = 30
CACHE_TTL_SEC = 12 * 3600
# Bounded digital refresh (owner order 2026-10-30): per refresh, at
# most this many release_dates calls, spent in priority order —
# pending premieres, RECENT_DAYS releases, UPCOMING_DAYS releases,
# then the stalest of the rest. At the existing 12h cadence the whole
# catalogue is re-verified within a few days.
DIGITAL_FETCH_BUDGET = 64
RECENT_DAYS = 120
UPCOMING_DAYS = 60

HEADER = (
    "/* FlickAtlas — OTT section data. GENERATED by scripts/build_ott.py "
    "(run by scripts/title-seed.py on every seeder run) — do not edit by "
    "hand. Now = provider-listed titles already released, newest OTT "
    "date first (the confirmed digital/streaming date when TMDB reports "
    "one, else the release date). Coming = confirmed movie digital dates "
    "(a date whose platform TMDB does not name shows no logo) or "
    "source-verified TV OTT premieres with matching platforms. A cinema "
    "release date or ordinary TV premiere alone is never treated as an "
    "OTT date. Pakistani dramas never appear here. */\n"
)

# Note text (TMDB release_dates type-4 note) -> canonical TMDB provider
# name. The note names the platform in TMDB's own words ("Prime Video"
# is what TMDB writes; its provider registry calls the same service
# "Amazon Prime Video"). The logo always comes from the registry
# itself, fetched live — never hardcoded. Unknown notes get no logo.
NOTE_ALIASES = {
    "prime video": "Amazon Prime Video",
    "amazon prime video": "Amazon Prime Video",
    "amazon prime video with ads": "Amazon Prime Video with Ads",
    "netflix": "Netflix",
    "disney plus hotstar": "JioHotstar",
    "disney+ hotstar": "JioHotstar",
    "jiohotstar": "JioHotstar",
    "jiocinema": "JioCinema",
    "apple tv plus": "Apple TV Plus",
    "apple tv+": "Apple TV Plus",
    "zee5": "ZEE5",
    "sonyliv": "Sony Liv",
    "sony liv": "Sony Liv",
    "aha": "aha",
    "mx player": "MX Player",
    "hulu": "Hulu",
    "max": "Max",
    "paramount plus": "Paramount Plus",
    "peacock": "Peacock",
}


def load_publish_titles():
    """Import scripts/publish-titles.py by path (hyphenated filename)."""
    spec = importlib.util.spec_from_file_location("publish_titles",
                                                  PUBLISH_TITLES)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def resolve_tmdb_key(explicit=None):
    """TMDB key: --tmdb-key, env TMDB_API_KEY, else js/config.js TMDB_KEY."""
    if explicit:
        return explicit
    env = os.environ.get("TMDB_API_KEY") or ""
    if env.strip():
        return env.strip()
    try:
        with open(DEFAULT_CONFIG, encoding="utf-8") as f:
            m = re.search(r"TMDB_KEY\s*:\s*\"([^\"]+)\"", f.read())
        if m:
            return m.group(1)
    except OSError:
        pass
    return ""


def tmdb_get(path, key):
    """GET one TMDB endpoint (repo pattern: v3 key as ?api_key=).
    Returns parsed JSON, or None on 404. Raises on other failures."""
    url = (TMDB_BASE + path +
           ("&" if "?" in path else "?") +
           "api_key=" + urllib.parse.quote(key))
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "FlickAtlas-build-ott/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def _norm_name(name):
    return re.sub(r"[^a-z0-9]+", " ", (name or "").lower()).strip()


def _entry_countries(entry):
    """Origin + production country codes of a published entry — the
    same sources UI._titleCountries() reads at render."""
    out = []
    for c in entry.get("origin_country") or []:
        if c:
            out.append(str(c).upper())
    for c in entry.get("production_countries") or []:
        v = c if isinstance(c, str) else (c or {}).get("iso_3166_1")
        if v:
            out.append(str(v).upper())
    return out


def _is_pakistani(entry):
    """Mirror of UI.industryOf()'s Pakistani test over the fields a
    published entry carries. Pakistani dramas are a separate
    YouTube-sourced category and never belong to OTT (owner correction
    2026-10-28); the exclusion lives here in the data build, not only
    at render, because fetch_providers can hand a drama a PK-region
    provider list — the providers check alone is not protection."""
    cs = _entry_countries(entry)
    if "PK" in cs:
        return True
    if entry.get("industry") == "pakistani" and "IN" not in cs:
        return True
    return (entry.get("original_language") or "") == "ur" and "IN" not in cs


def note_to_provider(note, registry):
    """Map a TMDB type-4 note ("Netflix", "Prime Video") to a provider
    {name, logo_path} from the live TMDB provider registry. Returns
    None when the note names no known provider — the date is then
    shown with no logo, never a guessed one."""
    if not note:
        return None
    norm = _norm_name(note)
    if not norm:
        return None
    canon = NOTE_ALIASES.get(norm) or note.strip()
    # Exact (case-insensitive) registry match first, then alias result.
    for name, logo in (registry or {}).items():
        if _norm_name(name) == _norm_name(canon) and logo:
            return {"name": name, "logo_path": logo}
    return None


def _record_digital(success, detail):
    try:
        import pipeline_schedule
        pipeline_schedule.record_source("ott_digital", success, detail)
    except Exception:
        pass


def _read_digital_cache(cache_path, days):
    if not cache_path:
        return None
    try:
        with open(cache_path, encoding="utf-8") as f:
            cache = json.load(f)
        stamp = cache.get("fetched_at") or ""
        dt = datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - dt).total_seconds()
        if age < 0: age = 0
        return cache, age, cache.get("days") == days
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _digital_fetch_order(movies, prior_digital, prior_checked, prior_stamp,
                         today):
    """Order movies for a bounded digital refresh (owner order
    2026-10-30): (0) titles with a known future digital date — pending
    premieres are re-verified every refresh; (1) titles released in
    the last RECENT_DAYS days (plus dateless titles), newest first;
    (2) titles releasing in the next UPCOMING_DAYS days, soonest
    first; (3) everyone else. Inside each group the least recently
    checked title goes first, so a bounded slice rotates through the
    whole catalogue instead of re-checking the same titles forever."""
    today_s = today.isoformat()
    recent_from = (today - timedelta(days=RECENT_DAYS)).isoformat()
    upcoming_to = (today + timedelta(days=UPCOMING_DAYS)).isoformat()

    def checked_ts(tid):
        return (prior_checked.get(tid)
                or (prior_digital.get(tid) or {}).get("checked_at")
                or prior_stamp)

    def sort_key(entry):
        tid = str(entry.get("id"))
        rel = str(entry.get("release_date") or "")[:10]
        rec = prior_digital.get(tid) or {}
        if rec.get("date") and str(rec["date"]) > today_s:
            rank = 0
        elif not rel or recent_from <= rel <= today_s:
            rank = 1
        elif today_s < rel <= upcoming_to:
            rank = 2
        else:
            rank = 3
        try:
            ordinal = date.fromisoformat(rel).toordinal() if rel else 0
        except ValueError:
            ordinal = 0
        # Upcoming premieres soonest first; every other group newest
        # first (negated ordinal under an ascending sort).
        date_key = ordinal if rank == 2 else -ordinal
        return (rank, checked_ts(tid), date_key)

    return sorted(movies, key=sort_key)


def fetch_digital(published, key, today, days, cache_path, refresh=False,
                  cached_only=False, dry_run=False,
                  budget=DIGITAL_FETCH_BUDGET):
    """Return digital dates and registry, preserving last-good cache on errors.

    A real fetch is bounded (see _digital_fetch_order) and MERGES into
    the prior cache: records for published movies outside this run's
    slice are carried over, and every confirmed digital date — past or
    future — is kept, so a premiere is still known after it happens.
    Any TMDB failure aborts the whole refresh and the last-good cache
    is returned (and left on disk) untouched."""
    cached = _read_digital_cache(cache_path, days)
    if cached and cached[1] < CACHE_TTL_SEC and cached[2] and not refresh:
        return cached[0].get("digital") or {}, cached[0].get("registry") or {}
    if cached_only:
        return ((cached[0].get("digital") or {}, cached[0].get("registry") or {})
                if cached else ({}, {}))
    if not key:
        print("build-ott: no TMDB key — digital enrichment skipped", file=sys.stderr)
        return ((cached[0].get("digital") or {}, cached[0].get("registry") or {})
                if cached else ({}, {}))
    prior = cached[0] if cached else {}
    prior_digital = prior.get("digital") or {}
    prior_checked = prior.get("checked") or {}
    prior_stamp = prior.get("fetched_at") or ""
    digital, registry = {}, {}
    try:
        reg = tmdb_get("/watch/providers/movie", key)
        if not isinstance(reg, dict) or not isinstance(reg.get("results"), list):
            raise ValueError("invalid provider registry response")
        for p in reg["results"]:
            if not isinstance(p, dict): raise ValueError("invalid provider record")
            name = (p.get("provider_name") or "").strip()
            if name and p.get("logo_path"): registry[name] = p["logo_path"]
        movies = [e for e in published.values() if isinstance(e, dict)
                  and e.get("type") != "tv" and e.get("id") is not None]
        now_stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        batch = _digital_fetch_order(movies, prior_digital, prior_checked,
                                     prior_stamp, today)[:max(0, budget)]
        fetched, checked = {}, dict(prior_checked)
        for entry in batch:
            tid = str(entry.get("id"))
            data = tmdb_get(f"/movie/{tid}/release_dates", key)
            if not isinstance(data, dict) or not isinstance(data.get("results"), list):
                raise ValueError(f"invalid release_dates response for {tid}")
            found = []
            for res in data["results"]:
                if not isinstance(res, dict) or not isinstance(res.get("release_dates", []), list):
                    raise ValueError(f"invalid release_dates record for {tid}")
                for rd in res.get("release_dates") or []:
                    if not isinstance(rd, dict): raise ValueError(f"invalid date record for {tid}")
                    if rd.get("type") == 4 and rd.get("release_date"):
                        try: date.fromisoformat(rd["release_date"][:10])
                        except (ValueError, TypeError): raise ValueError(f"invalid digital date for {tid}")
                        found.append({"country": res.get("iso_3166_1") or "",
                                      "date": rd["release_date"][:10],
                                      "note": (rd.get("note") or "").strip()})
            def pick(pool): return sorted(pool, key=lambda d:d["date"])[0] if pool else None
            chosen = pick([d for d in found if d["country"] == "IN"]) or pick([d for d in found if d["country"] == "US"]) or pick(found)
            fetched[tid] = ({"country": chosen["country"], "date": chosen["date"],
                             "note": chosen["note"], "checked_at": now_stamp}
                            if chosen else None)
            checked[tid] = now_stamp
            time.sleep(0.25)
        # Merge: this run's results replace prior records; published
        # movies outside the slice keep theirs. Records for titles no
        # longer published are dropped.
        for entry in movies:
            tid = str(entry.get("id"))
            if tid in fetched:
                if fetched[tid]:
                    digital[tid] = fetched[tid]
            elif tid in prior_digital:
                digital[tid] = prior_digital[tid]
    except Exception as e:
        print(f"build-ott: digital refresh failed ({e})", file=sys.stderr)
        if not dry_run: _record_digital(False, str(e))
        return ((cached[0].get("digital") or {}, cached[0].get("registry") or {})
                if cached else ({}, {}))
    if cache_path and not dry_run:
        try:
            os.makedirs(os.path.dirname(cache_path) or ".", exist_ok=True)
            with open(cache_path, "w", encoding="utf-8") as f:
                json.dump({"fetched_at": now_stamp,
                           "days": days, "digital": digital, "registry": registry,
                           "checked": checked},
                          f, indent=1, sort_keys=True)
            _record_digital(True, f"{len(digital)} digital titles; registry {len(registry)}; checked {len(batch)} this run")
        except OSError as e:
            if not dry_run: _record_digital(False, str(e))
    return digital, registry


def classify(published, today, digital=None, registry=None, days=DIGITAL_DAYS):
    """Split provider-carrying titles into Now and Coming.

    Movies enter Coming only on a TMDB type-4 (Digital) date in the
    requested window — with the named platform when TMDB's note maps
    to one, or as a date-only entry (no logo, never a guessed one)
    when it does not. TV titles enter Coming only when the published
    entry carries an explicit source-backed `ott_release_date`, an
    `ott_release_provider`, and that provider is present in its verified
    provider list. `first_air_date` alone is never OTT evidence. Already
    released titles with current provider listings enter Now, newest
    OTT date first (a movie's confirmed digital date when one is known,
    else its release date), TMDB popularity breaking ties. Pakistani
    titles are excluded categorically (see _is_pakistani).
    """
    digital = digital or {}
    registry = registry or {}
    today_d = date.fromisoformat(today)
    last_day = (today_d + timedelta(days=max(0, days))).isoformat()
    now, coming, dateless = [], [], []

    def clean_providers(providers):
        out = []
        for p in providers or []:
            if not isinstance(p, dict):
                continue
            name = (p.get("name") or "").strip()
            if name:
                out.append({"name": name, "logo_path": p.get("logo_path") or ""})
        return out

    def valid_date(value):
        value = str(value or "")[:10]
        try:
            datetime.strptime(value, "%Y-%m-%d")
            return value
        except (ValueError, TypeError):
            return ""

    for tid, entry in published.items():
        if not isinstance(entry, dict):
            continue
        if _is_pakistani(entry):
            continue
        providers = entry.get("providers") or []
        is_tv = entry.get("type") == "tv"
        entry_id = str(entry.get("id"))
        title_date = (entry.get("first_air_date") if is_tv
                      else entry.get("release_date")) or ""
        clean = clean_providers(providers)

        if is_tv:
            # An upcoming series needs explicit release-date evidence and a
            # provider match. Never infer OTT from a generic first-air date.
            ott_date = valid_date(entry.get("ott_release_date"))
            planned_provider = (entry.get("ott_release_provider") or "").strip()
            source = entry.get("ott_release_source")
            source_urls = source if isinstance(source, list) else [source]
            has_source = any(isinstance(u, str) and u.strip().startswith("https://")
                             for u in source_urls)
            matching = [p for p in clean
                        if planned_provider and _norm_name(p["name"]) == _norm_name(planned_provider)]
            if (ott_date and today < ott_date <= last_day and has_source
                    and matching):
                coming.append({
                    "id": entry.get("id"), "type": "tv",
                    "providers": matching[:1], "date": ott_date,
                    "date_kind": "digital",
                })
                continue
            if not clean:
                continue
            if not title_date:
                dateless.append(entry.get("title") or str(tid))
                continue
            if valid_date(title_date) and title_date <= today:
                now.append({
                    "id": entry.get("id"), "type": "tv",
                    "providers": clean, "date": valid_date(title_date),
                    "date_kind": "release",
                })
            # Future first-air dates with no source-backed OTT date are
            # intentionally omitted rather than labeled Coming to OTT.
            continue

        # Digital cache keys remain numeric for backwards compatibility;
        # consult them for movies only, never across the movie/TV namespaces.
        dig = digital.get(entry_id) or {}
        digital_date = valid_date(dig.get("date"))
        pending_coming = None
        if digital_date and today < digital_date <= last_day:
            digital_provider = note_to_provider(dig.get("note"), registry)
            if digital_provider:
                coming.append({
                    "id": entry.get("id"), "type": "movie",
                    "providers": [digital_provider],
                    "date": digital_date, "date_kind": "digital",
                    "country": dig.get("country") or "",
                })
                continue
            # TMDB confirms the streaming date but its note names no
            # provider we can logo: the date is listed with NO platform
            # (never a guessed one) — unless the title already streams
            # (the Now branch below), in which case the future date is
            # another region's premiere and is not listed twice.
            pending_coming = {
                "id": entry.get("id"), "type": "movie",
                "providers": [],
                "date": digital_date, "date_kind": "digital",
                "country": dig.get("country") or "",
            }

        if not clean:
            if pending_coming:
                coming.append(pending_coming)
            continue
        if not title_date:
            dateless.append(entry.get("title") or str(tid))
            if pending_coming:
                coming.append(pending_coming)
            continue
        normalized_date = valid_date(title_date)
        if not normalized_date:
            if pending_coming:
                coming.append(pending_coming)
            continue
        if normalized_date <= today:
            if digital_date and digital_date <= today:
                # The real OTT arrival date is known: it, not the
                # theatrical date, dates and orders the Now entry.
                now.append({
                    "id": entry.get("id"), "type": "movie",
                    "providers": clean, "date": digital_date,
                    "date_kind": "digital",
                })
            else:
                now.append({
                    "id": entry.get("id"), "type": "movie",
                    "providers": clean, "date": normalized_date,
                    "date_kind": "release",
                })
        elif pending_coming:
            coming.append(pending_coming)
        # Future theatrical movie dates are not OTT confirmation.

    # Order: Now newest OTT date first, Coming nearest date first;
    # TMDB popularity breaks date ties (owner order 2026-10-30), then
    # id for determinism.
    pop = {}
    for e in published.values():
        if isinstance(e, dict) and e.get("id") is not None:
            try:
                pop[str(e.get("id"))] = float(e.get("popularity") or 0)
            except (TypeError, ValueError):
                pop[str(e.get("id"))] = 0.0
    now.sort(key=lambda x: (x["date"], pop.get(str(x["id"]), 0.0),
                            str(x["id"])), reverse=True)
    coming.sort(key=lambda x: (x["date"], -pop.get(str(x["id"]), 0.0),
                               str(x["id"])))
    return now, coming, dateless


def render(now, coming):
    payload = {"now": now, "coming": coming}
    return (HEADER + "window.FA_OTT = "
            + json.dumps(payload, indent=2, sort_keys=True) + ";\n")


def build(out_path, published_path, dry_run=False, tmdb_key=None,
          digital_days=DIGITAL_DAYS, digital_cache=DEFAULT_DIGITAL_CACHE,
          refresh_digital=False, cached_only=False):
    """Rebuild ott-data.js from the published catalogue.

    Returns (now_count, coming_count, changed_bool). Never raises for
    missing data — an empty catalogue yields empty groups. The digital
    enrichment is best-effort: no key or a TMDB failure leaves the
    file built from the old rule alone.
    """
    pt = load_publish_titles()
    try:
        published = pt.read_js_map(published_path, "FA_PUBLISHED")
    except Exception as e:
        print(f"build-ott: cannot read {published_path} ({e})",
              file=sys.stderr)
        return 0, 0, False
    today = time.gmtime()
    today_s = time.strftime("%Y-%m-%d", today)
    today_d = date(today.tm_year, today.tm_mon, today.tm_mday)
    key = resolve_tmdb_key(tmdb_key)
    digital, registry = fetch_digital(published, key, today_d,
                                      digital_days, digital_cache,
                                      refresh_digital, cached_only, dry_run)
    now, coming, dateless = classify(published, today_s, digital, registry,
                                     digital_days)
    for title in dateless:
        print(f"build-ott: skipped {title} (providers but no date)",
              file=sys.stderr)
    n_digital = sum(1 for c in coming if c.get("date_kind") == "digital")
    print(f"build-ott: digital dates in window: {len(digital)} "
          f"({n_digital} in coming)", file=sys.stderr)
    text = render(now, coming)
    if dry_run:
        print(f"build-ott (dry run): now {len(now)}, coming "
              f"{len(coming)} | file NOT written")
        return len(now), len(coming), False
    old = ""
    if os.path.exists(out_path):
        with open(out_path, encoding="utf-8") as f:
            old = f.read()
    if old == text:
        print(f"build-ott: now {len(now)}, coming {len(coming)} | "
              f"unchanged")
        return len(now), len(coming), False
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"build-ott: now {len(now)}, coming {len(coming)} | "
          f"wrote {out_path}")
    return len(now), len(coming), True


def main():
    ap = argparse.ArgumentParser(
        description="Build js/ott-data.js from js/published-titles.js")
    ap.add_argument("--published", default=DEFAULT_PUBLISHED,
                    help="published catalogue (default: "
                         "js/published-titles.js)")
    ap.add_argument("--out", default=DEFAULT_OUT,
                    help="output file (default: "
                         "js/ott-data.js)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print what it would do, do NOT write the file")
    ap.add_argument("--tmdb-key", default=None,
                    help="TMDB key (default: TMDB_API_KEY env, else "
                         "js/config.js TMDB_KEY)")
    ap.add_argument("--digital-days", type=int, default=DIGITAL_DAYS,
                    help="digital-date window in days (default: 30)")
    ap.add_argument("--digital-cache", default=DEFAULT_DIGITAL_CACHE,
                    help="digital-date cache file (default: "
                         "out/ott-digital.json)")
    ap.add_argument("--refresh-digital", action="store_true",
                    help="ignore the digital cache and re-fetch TMDB")
    ap.add_argument("--cached-only", action="store_true",
                    help="never call TMDB for digital enrichment")
    args = ap.parse_args()
    now_n, coming_n, changed = build(
        args.out, args.published, args.dry_run, args.tmdb_key,
        args.digital_days, args.digital_cache, args.refresh_digital,
        args.cached_only)
    if step_runs is not None and not args.dry_run:
        step_runs.record(
            "ott", status="success",
            checked={"candidates": now_n + coming_n,
                     "detail": "OTT now/coming titles from the published "
                               "catalogue"},
            changed={"added": [], "updated": [], "count": 0,
                     "detail": "now %d, coming %d" % (now_n, coming_n)},
            reason=None if changed else "no-new-data")
    return 0


if __name__ == "__main__":
    sys.exit(main())
