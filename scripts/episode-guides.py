#!/usr/bin/env python3
"""YouTube episode tracker (Track B of the two-track seeder).

Pakistani dramas air ~3-4 episodes per channel daily (HUM TV, ARY Digital,
Har Pal Geo, Green TV = ~12-20 new episodes/day). This script picks each
new full episode up from YouTube and posts it the SAME DAY, then adds an
AI story summary in ROMAN URDU to EVERY episode, in the same run that
detects it (owner order 2026-10-28: however many episodes arrive in one
day, all of them get a summary, instantly).

TIERED (owner-approved 2026-10-26):
  1. INFO POST (every episode, same day, NO AI): title, episode number,
     air date, channel, YouTube link, cast/channel facts. Written into
     js/articles-data.js in the EXACT article format scripts/apply-auto.py
     writes (id = FNV-1a of the YouTube URL, type "news"). Feed entries
     go to out/episode-feed.json (kept for the tracker's own record;
     no longer merged into the news feed — owner order 2026-10-27:
     episodes are not news).
  2. STORY SUMMARY (EVERY episode, same run — owner order 2026-10-28):
     ROMAN URDU, 2-4 sentences, grounded ONLY in the episode's YouTube
     title + description (model gemini-3.5-flash-lite, keys
     GEMINI_API_KEY_1..6, same rotation as scripts/gemini_batch.py).
     A thin description (cast list / promo only) gets a minimal
     factual line instead of an invented plot — never re-summarize.
     No functional cap: safety ceiling 50/day, 50/run (observed max
     16 detected in one run, 7 posted/day — the ceiling never binds;
     it only stops a runaway loop from burning keys). (fileData
     video-watching was the old route, ~218K VIDEO tokens/episode;
     superseded 2026-10-27 — the function is kept in the file for
     manual use only.)

DETECTION (spike-proven 2026-10-26):
  - Channel RSS feeds WORK but list ZERO full episodes in their 15-item
    window (clips/Shorts/promos/teasers crowd them out). RSS is a
    FALLBACK only, never the primary detector.
  - PRIMARY: YouTube Data API search.list per channel (channelId +
    q="Episode" + videoDuration=long + order=date) returns the full
    episodes; filter to the official channelId (excludes reuploads),
    confirm duration >= 20 min + read viewCount via videos.list.
  - The 4 official full-episode channels (verified via videos.list
    channelId; PK 2026-10-26):
      HUM TV               UCEeEQxm6qc_qaTE7qTV5aLQ  (TMDB network 1204)
      ARY Digital HD       UC4JCksJF76g_MdzPVBJoC3Q  (TMDB network 815)
      HAR PAL GEO          UCe9JSDmyqNgA_l2BzGHq1Ug  (TMDB networks 751/1843)
      Green TV Entertainment UCF2ltLX1dnPa6-L1paPaMzw (TMDB network 7134)
    DISABLED 2026-10-26 (user's bar: official channels whose episodes
    regularly pass 1M views — all three were far below it: StarPlus
    42-8,085, StarPlus Classics 10-16,332, Rtv 597-39,225):
      StarPlus (IN)        UC-LPIU24bQXVljUXivKEeRQ  (Hindi classics)
      StarPlus Classics (IN) UC-0Rh4XQdw2jV8N7rqDJj0Q (Hindi classics)
      Rtv Drama Serial (BD) UCLRgwoSpvgFGuzMeSzWG6xQ (Bengali serials)
    Per-channel search query (q): PK titles say "Episode", StarPlus
    titles say "Full Ep.", Rtv titles say "Ep" — q="Episode" does NOT
    match the abbreviations, so each channel carries its own query.
  - Episode titles parse cleanly (11/11 in the spike): "<Drama> Episode
    <N>", "<Drama> - Episode <N>", "<Drama> - Last Episode" (finale),
    "EP.<N> - <Drama>". Teasers/promos/Best Scene/Best Moment/Shorts/
    OST/review titles are excluded by keyword.

STATE (out/episodes.json): one record per video_id (drama, episode,
channel, url, published, views, duration, article_id, summary,
summary_at, posted_at). Dedup by video_id AND drama+episode — an
episode is never posted twice. The summary backlog is derived:
episodes with summary == null, ordered by views desc.

GATE (user order 2026-10-26): only episodes of dramas on the site's
published Pakistani TV list (js/published-titles.js, FA_PUBLISHED)
are posted — aliases Dar -> Dar-E-Nijaat, Zehar -> Zehar-e-Mohabbat.
Anything else (Bulbulay Season 2, an interview, an unlisted drama)
is skipped and stays out of state, so a later run posts it if the
drama gets listed. If the published file is unreadable the gate is
OFF (never block every post on a data-file failure).

Env:
  YOUTUBE_DATA_API_KEY  (required for primary detection; without it the
                         script falls back to RSS and says so clearly)
  TMDB_API_KEY          (optional; falls back to js/config.js TMDB_KEY,
                         same as scripts/title-seed.py — builds the
                         drama pool for name matching + popularity)
  GEMINI_API_KEY_1..6   (at least one required for summaries; without
                         them the script still posts info posts and
                         skips summaries)
  SUMMARY_PER_RUN       (default 50; safety ceiling 50/day — never binds
                         in practice; owner order 2026-10-28)
  EPISODE_LOOKBACK_HOURS (default 48; how far back to search)

Usage: episode-guides.py [--dry-run]
  --dry-run detects + matches + reports, writes nothing, calls no
  Gemini. Exits 0; prints what it did.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

try:
    # Per-run record for the stats dashboard (out/step-runs.json).
    # A missing/broken helper must never break this script.
    import step_runs
except Exception:  # noqa: BLE001 - record helper is best-effort
    step_runs = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "out")
CONFIG_JS = os.path.join(ROOT, "js", "config.js")
ARTICLES_JS = os.path.join(ROOT, "js", "articles-data.js")
EPISODES_JSON = os.path.join(OUT_DIR, "episodes.json")
EPISODE_FEED_JSON = os.path.join(OUT_DIR, "episode-feed.json")
PUBLISHED_JS = os.path.join(ROOT, "js", "published-titles.js")
# Tracker-name -> published-name aliases (same drama, different name on
# YouTube vs the site's Pakistani Dramas list).
DRAMA_ALIASES = {"dar": "Dar-E-Nijaat", "zehar": "Zehar-e-Mohabbat"}

MODEL = "gemini-3.5-flash-lite"
# Safety ceiling only (owner order 2026-10-28: every episode gets its
# summary in the run that detects it). Observed max 16 detected in one
# run, 7 posted/day — 50 never binds; it only stops a runaway loop
# from burning Gemini keys.
SUMMARY_MAX_PER_DAY = 50
MIN_FULL_EPISODE_SEC = 20 * 60  # PK full episodes are 35-45 min; clips < 15
# International channels: StarPlus full episodes run 18-19 min, so
# their floor is 15 min (clips are still < 15 min on every channel).
# PK keeps the 20-min floor — its detection is untouched.
MIN_FULL_EPISODE_SEC_INTL = 15 * 60
# Minimum views for a NON-Pakistani channel's episode to be posted
# (user's bar, 2026-10-26): only official verified channels whose
# episodes regularly pass 1M views. PK channels are exempt — their
# episodes grow to 1M+ over days and the 48h lookback catches them.
MIN_VIEWS_INTL = 1_000_000

# (display name, YouTube channel id, TMDB network ids, news-feed
# category, search.list query). Feed category must be one the news feed
# can display (convert-news.py + js/page-news.js): "pakistan" (PK),
# "bollywood" (Indian/Hindi — StarPlus is Hindi TV, the Bollywood chip
# is the closest existing filter), "international" (everything else —
# the news page shows it as World Cinema). Search query is per-channel
# (see docstring): PK "Episode", StarPlus "Full Ep", Rtv "Ep".
# Intl channels are DISABLED as of 2026-10-26 (below the 1M-view bar);
# the "bollywood"/"international" categories and per-channel queries
# stay for any future intl channel that passes MIN_VIEWS_INTL.
CHANNELS = [
    ("HUM TV", "UCEeEQxm6qc_qaTE7qTV5aLQ", [1204], "pakistan", "Episode"),
    ("ARY Digital", "UC4JCksJF76g_MdzPVBJoC3Q", [815], "pakistan", "Episode"),
    ("Geo TV", "UCe9JSDmyqNgA_l2BzGHq1Ug", [751, 1843], "pakistan", "Episode"),
    ("Green TV", "UCF2ltLX1dnPa6-L1paPaMzw", [7134], "pakistan", "Episode"),
    # DISABLED 2026-10-26 — user's bar: only official verified channels
    # whose episodes regularly pass 1M views. All three were far below
    # (StarPlus 42-8,085; StarPlus Classics 10-16,332; Rtv 597-39,225),
    # so their 54 posted episodes were removed from the site the same day.
    # Re-enable ONLY if the channel's episodes regularly pass MIN_VIEWS_INTL.
    # ("StarPlus", "UC-LPIU24bQXVljUXivKEeRQ", [], "bollywood", "Full Ep"),
    # ("StarPlus Classics", "UC-0Rh4XQdw2jV8N7rqDJj0Q", [], "bollywood", "Full Ep"),
    # ("Rtv Drama Serial", "UCLRgwoSpvgFGuzMeSzWG6xQ", [], "international", "Ep"),
]
CHANNEL_BY_YT_ID = {c[1]: c[0] for c in CHANNELS}
RSS_URL = "https://www.youtube.com/feeds/videos.xml?channel_id={cid}"

# Title patterns for full episodes (spike: 11/11 parse, 0 fail).
TITLE_PATTERNS = [
    ("A", re.compile(r"^(?P<drama>.+?)\s+Episode\s+(?P<ep>\d+)\b", re.I)),
    ("B", re.compile(r"^(?P<drama>.+?)\s*-\s*Episode\s+(?P<ep>\d+)\b", re.I)),
    ("C", re.compile(r"^(?P<drama>.+?)\s*-\s*Last Episode\b", re.I)),
    ("D", re.compile(r"^EP\.?\s*(?P<ep>\d+)\s*-\s*(?P<drama>.+?)\s*(?:\||$)", re.I)),
]
# Title patterns for the international channels (added 2026-10-26).
# StarPlus / StarPlus Classics: "<hook> | Full Ep. NNN | <Show>" —
# show name is the text AFTER the final "|".
# Rtv Drama Serial: "<Show> | <Bengali name> | Ep - NNN" — show name is
# the text BEFORE the first "|". Tried FIRST in parse_episode_title:
# their formats never match the Pakistani patterns, and their
# story-hook titles legitimately contain words the Pakistani exclusion
# list blocks ("romantic", "emotional", "moment", "scene").
INTL_PATTERNS = [
    ("E", re.compile(r"Full Ep\.?\s*(?P<ep>\d+)\s*\|\s*(?P<drama>[^|]+)", re.I)),
    ("F", re.compile(r"^(?P<drama>[^|]+?)\s*\|.*?\bEp\s*-?\s*(?P<ep>\d+)\b", re.I)),
]
# Narrow exclusion for the international patterns: strong clip markers
# only. The number pattern itself ("Full Ep. NNN" / "Ep - NNN") plus
# the 15-min duration floor are the primary guards — clips do not
# carry those markers.
INTL_EXCLUDE_RE = re.compile(
    r"teaser|promo|best scene|best moment|clip|highlights|"
    r"shorts?\b|ost\b|behind the scenes|review|trailer",
    re.I)
# Anything matching these is NOT a full episode (teaser/promo/clip/...).
# Matched AFTER NFKD normalisation (see parse_episode_title), so the
# channels' stylised Unicode ("𝐁𝐞𝐬𝐭 𝐒𝐜𝐞𝐧𝐞", "𝐁𝐞𝐬𝐭 𝐌𝐨𝐦𝐞𝐧𝐭")
# is caught too. "moment"/"scene" are clip words — a full episode title
# never contains them; "couple moment" is a clip format.
EXCLUDE_RE = re.compile(
    r"teaser|promo|best scene|best moment|moment|scene|couple|clip|"
    r"emotional|romantic|funny|comedy|dialogue|status|song|highlights|"
    r"shorts?\b|ost\b|behind the scenes|review|trailer",
    re.I)
# Junk that trails a drama name inside a title (cast lists, dates, ...).
NAME_STRIP_RE = re.compile(r"\s*[\|\-\(\[]\s*.*$", re.S)


# ---------------------------------------------------------------- helpers
def fnv1a(text):
    """FNV-1a 32-bit, base-36 — the same id apply-auto.py uses."""
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
    """ISO 8601 -> epoch ms, or None."""
    if not published:
        return None
    s = str(published).strip()
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def iso_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def norm_name(name):
    """Normalise a drama name for matching: lowercase, collapse space,
    drop punctuation that differs between TMDB and YouTube titles."""
    s = (name or "").strip().lower()
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def load_published_pk_dramas():
    """Published Pakistani dramas (js/published-titles.js, FA_PUBLISHED):
    norm_name -> display name, type tv + industry pakistani. Returns {}
    when the file is missing/unreadable — the caller treats an empty
    map as 'gate disabled' rather than blocking every post."""
    try:
        data = read_js_map(PUBLISHED_JS, "FA_PUBLISHED")
    except Exception as e:
        print(f"published list unreadable ({e}) — drama gate disabled")
        return {}
    out = {}
    for t in (data or {}).values():
        if not isinstance(t, dict):
            continue
        if t.get("type") != "tv" or (t.get("industry") or "") != "pakistani":
            continue
        name = (t.get("title") or "").strip()
        if name:
            out[norm_name(name)] = name
    return out


def canonical_pk_drama(name, pk_dramas):
    """Published name for a detected drama, or None when it is NOT a
    listed Pakistani drama. Aliases first (Dar -> Dar-E-Nijaat,
    Zehar -> Zehar-e-Mohabbat), then exact normalized match."""
    n = norm_name(name)
    if not n:
        return None
    if n in DRAMA_ALIASES:
        target = DRAMA_ALIASES[n]
        return target if norm_name(target) in pk_dramas else None
    return pk_dramas.get(n)


def parse_iso_duration(dur):
    """ISO 8601 duration (PT38M12S) -> seconds."""
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$", dur or "")
    if not m:
        return 0
    h, mi, s = (int(x) if x else 0 for x in m.groups())
    return h * 3600 + mi * 60 + s


def parse_episode_title(title):
    """Extract (drama, episode_number|None, is_finale) from a video title.
    Returns None when the title is not a full episode."""
    if not title:
        return None
    # NFKD: the channels style "Best Scene" in mathematical-bold Unicode
    # ("𝐁𝐞𝐬𝐭 𝐒𝐜𝐞𝐧𝐞") which ASCII regexes miss — normalise to ASCII
    # first so the exclusion below catches it.
    import unicodedata
    title = unicodedata.normalize("NFKD", title)
    title = "".join(c for c in title if not unicodedata.combining(c))
    # International formats FIRST (StarPlus "Full Ep. NNN | Show",
    # Rtv "Show | ... | Ep - NNN"): narrow exclusion only — the
    # story-hook titles legitimately contain words the Pakistani
    # exclusion list blocks ("romantic", "emotional", "moment", "scene").
    for _tag, pat in INTL_PATTERNS:
        m = pat.search(title)
        if not m:
            continue
        if INTL_EXCLUDE_RE.search(title):
            return None
        gd = m.groupdict()
        drama = (gd.get("drama") or "").strip().strip("-").strip()
        drama = NAME_STRIP_RE.sub("", drama).strip()
        if not drama or len(drama) < 2:
            continue
        if "|" in drama or "—" in drama:
            continue
        if any(ord(c) > 127 for c in drama):
            continue
        ep = gd.get("ep")
        if ep is not None:
            return drama, int(ep), False
    # Pakistani formats (unchanged): full exclusion, then A-D.
    if EXCLUDE_RE.search(title):
        return None
    for _tag, pat in TITLE_PATTERNS:
        m = pat.search(title)
        if not m:
            continue
        gd = m.groupdict()
        drama = (gd.get("drama") or "").strip().strip("-").strip()
        drama = NAME_STRIP_RE.sub("", drama).strip()
        if not drama or len(drama) < 2:
            continue
        # A real drama name is plain text. If it still holds "|" or an
        # em-dash, the title was a dialogue-line clip ("Usay Bhool Jao |
        # Izzat Episode 35") — the "drama" is a scene line, not a title.
        if "|" in drama or "—" in drama:
            continue
        # Emoji / non-ASCII in the drama name = a clip title, not a
        # clean "Drama Episode N" title.
        if any(ord(c) > 127 for c in drama):
            continue
        ep = gd.get("ep")
        if ep is not None:
            return drama, int(ep), False
        # Pattern C: "Last Episode" (finale) — episode number resolved
        # from TMDB later; None here means "finale, number unknown".
        return drama, None, True
    return None


# ---------------------------------------------------------------- keys
def read_tmdb_key():
    """TMDB key: TMDB_API_KEY, then js/config.js TMDB_KEY (same as
    scripts/title-seed.py). Never hardcoded, never printed."""
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


def gemini_keys():
    """GEMINI_API_KEY_1..6 (then GEMINI_API_KEY) — same as gemini_batch.py."""
    keys = []
    for i in range(1, 7):
        k = os.environ.get(f"GEMINI_API_KEY_{i}", "").strip()
        if k:
            keys.append(k)
    if not keys:
        k = os.environ.get("GEMINI_API_KEY", "").strip()
        if k:
            keys.append(k)
    return keys


# ---------------------------------------------------------------- TMDB pool
def tmdb_get(key, path, params):
    qs = urllib.parse.urlencode(params)
    url = f"https://api.themoviedb.org/3{path}?api_key={key}&{qs}"
    req = urllib.request.Request(url, headers={"User-Agent": "FlickAtlas/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def build_drama_pool(tmdb_key):
    """Current Pakistani dramas: per-network discovers (popularity) +
    an air-date window (episodes airing in the last 90 days). Returns a
    dict norm_name -> {tmdb_id, name, channel, popularity}. Lighter than
    js/pk-dramas.js (no per-title details calls) — this is matching, not
    rendering. Empty dict when no TMDB key (matching falls back to the
    YouTube title alone)."""
    pool = {}
    if not tmdb_key:
        print("tmdb: no key — drama pool empty (matching by title only)")
        return pool
    today = datetime.now(timezone.utc).date()
    cutoff = (today - timedelta(days=90)).isoformat()
    queries = []
    for _name, _cid, nids, _cat, _q in CHANNELS:
        for nid in nids:
            queries.append((f"network:{nid}",
                            {"with_networks": nid, "with_origin_country": "PK",
                             "sort_by": "popularity.desc", "page": 1}))
    queries.append(("airwin", {"with_origin_country": "PK",
                               "air_date.gte": cutoff,
                               "air_date.lte": today.isoformat(),
                               "sort_by": "popularity.desc", "page": 1}))
    net_to_channel = {}
    for name, _cid, nids, _cat, _q in CHANNELS:
        for nid in nids:
            net_to_channel[nid] = name
    for label, params in queries:
        try:
            d = tmdb_get(tmdb_key, "/discover/tv", params)
        except Exception as e:
            print(f"tmdb discover {label} failed: {e}")
            continue
        for x in d.get("results") or []:
            nid = x.get("id")
            name = (x.get("name") or "").strip()
            if not nid or not name:
                continue
            key = norm_name(name)
            if key in pool:
                continue
            # Channel: the network we queried (airwin results get "" and
            # are matched by name only).
            channel = ""
            if label.startswith("network:"):
                channel = net_to_channel.get(int(label.split(":")[1]), "")
            pool[key] = {"tmdb_id": nid, "name": name, "channel": channel,
                         "popularity": x.get("popularity") or 0,
                         "first_air_date": x.get("first_air_date") or ""}
    print(f"tmdb pool: {len(pool)} current PK dramas")
    return pool


def resolve_finale_episode(tmdb_key, tmdb_id):
    """Finale ("Last Episode") number from TMDB last_episode_to_air."""
    if not tmdb_key or not tmdb_id:
        return None
    try:
        d = tmdb_get(tmdb_key, f"/tv/{tmdb_id}", {"language": "en-US"})
        le = d.get("last_episode_to_air") or {}
        return le.get("episode_number")
    except Exception:
        return None


# ---------------------------------------------------------------- YouTube
def yt_get(key, path, params):
    params = dict(params)
    params["key"] = key
    qs = urllib.parse.urlencode(params)
    url = f"https://www.googleapis.com/youtube/v3{path}?{qs}"
    req = urllib.request.Request(url, headers={"User-Agent": "FlickAtlas/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def detect_via_api(yt_key, lookback_hours):
    """Primary detection: search.list per channel (long videos, newest
    first) + videos.list to confirm duration and read viewCount.
    Returns a list of candidate dicts (unfiltered by dedup)."""
    since = (datetime.now(timezone.utc) -
             timedelta(hours=lookback_hours)).isoformat().replace("+00:00", "Z")
    candidates = []
    for ch_name, ch_id, _nids, feed_cat, query in CHANNELS:
        try:
            res = yt_get(yt_key, "/search", {
                "part": "snippet", "channelId": ch_id, "q": query,
                "type": "video", "videoDuration": "long", "order": "date",
                "publishedAfter": since, "maxResults": 25})
        except Exception as e:
            print(f"youtube search {ch_name} failed: {e}")
            continue
        ids = []
        meta = {}
        for it in res.get("items") or []:
            vid = (it.get("id") or {}).get("videoId")
            sn = it.get("snippet") or {}
            if not vid or sn.get("channelId") != ch_id:
                continue  # reupload on another channel — not official
            title = sn.get("title") or ""
            parsed = parse_episode_title(title)
            if not parsed:
                continue
            drama, ep, is_finale = parsed
            ids.append(vid)
            meta[vid] = {"video_id": vid, "title": title, "drama": drama,
                         "episode": ep, "is_finale": is_finale,
                         "channel": ch_name, "channel_id": ch_id,
                         "cats": [feed_cat],
                         "published": sn.get("publishedAt") or "",
                         "url": f"https://www.youtube.com/watch?v={vid}"}
        if not ids:
            print(f"youtube {ch_name}: 0 episode candidates in search")
            continue
        # Confirm duration + read viewCount (1 unit per call, up to 50 ids).
        for i in range(0, len(ids), 50):
            chunk = ids[i:i + 50]
            try:
                det = yt_get(yt_key, "/videos", {
                    "part": "snippet,contentDetails,statistics",
                    "id": ",".join(chunk)})
            except Exception as e:
                print(f"youtube videos {ch_name} failed: {e}")
                continue
            for it in det.get("items") or []:
                vid = it.get("id")
                m = meta.get(vid)
                if not m:
                    continue
                dur = parse_iso_duration(
                    (it.get("contentDetails") or {}).get("duration") or "")
                floor = (MIN_FULL_EPISODE_SEC if feed_cat == "pakistan"
                         else MIN_FULL_EPISODE_SEC_INTL)
                if dur < floor:
                    continue  # short clip, not a full episode
                st = it.get("statistics") or {}
                try:
                    views = int(st.get("viewCount") or 0)
                except ValueError:
                    views = 0
                m["duration_sec"] = dur
                m["views"] = views
                m["published"] = (it.get("snippet") or {}).get("publishedAt") \
                    or m["published"]
                candidates.append(m)
        print(f"youtube {ch_name}: {len([c for c in candidates if c['channel'] == ch_name])} full episodes")
    return candidates


def detect_via_rss():
    """Fallback detection (no YouTube key): the 4 channel RSS feeds.
    Proven insufficient — the 15-item window holds ZERO full episodes
    (clips/Shorts/promos crowd them out) — but it costs nothing and
    catches whatever surfaces. No viewCount / duration available."""
    NS = {"atom": "http://www.w3.org/2005/Atom",
          "yt": "http://www.youtube.com/xml/schemas/2015",
          "media": "http://search.yahoo.com/mrss/"}
    candidates = []
    for ch_name, ch_id, _nids, feed_cat, _q in CHANNELS:
        url = RSS_URL.format(cid=ch_id)
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                root = ET.fromstring(r.read())
        except Exception as e:
            print(f"rss {ch_name} failed: {e}")
            continue
        n = 0
        for e in root.findall("atom:entry", NS):
            title = (e.findtext("atom:title", "", NS) or "").strip()
            vid = (e.findtext("yt:videoId", "", NS) or "").strip()
            pub = (e.findtext("atom:published", "", NS) or "").strip()
            if not vid:
                continue
            parsed = parse_episode_title(title)
            if not parsed:
                continue
            drama, ep, is_finale = parsed
            candidates.append({"video_id": vid, "title": title,
                               "drama": drama, "episode": ep,
                               "is_finale": is_finale, "channel": ch_name,
                               "channel_id": ch_id, "cats": [feed_cat],
                               "published": pub,
                               "url": f"https://www.youtube.com/watch?v={vid}",
                               "duration_sec": 0, "views": 0})
            n += 1
        print(f"rss {ch_name}: {n} episode candidates")
    return candidates


# ---------------------------------------------------------------- articles
def build_article(ep):
    """Info post in the EXACT article format apply-auto.py writes."""
    drama = ep["drama"]
    epno = ep["episode"]
    ep_label = f"Episode {epno}" if epno else "Final Episode"
    air = (ep.get("published") or "")[:10]
    headline = f"{drama} {ep_label} — Watch on {ep['channel']}"
    dek = (f"{drama} {ep_label.lower()} aired on {air or 'YouTube'} — "
           f"watch the full episode on {ep['channel']}."
           if air else
           f"{drama} {ep_label.lower()} — watch the full episode on "
           f"{ep['channel']}.")
    body = [{
        "h": "Episode Details",
        "p": [
            f"{drama} {ep_label} aired on {air or 'YouTube'} on "
            f"{ep['channel']}. The full episode is available on the "
            f"channel's official YouTube page.",
            f"Watch the full episode here: {ep['url']}",
        ],
    }]
    if ep.get("drama_overview"):
        body.append({"h": f"About {drama}",
                     "p": [ep["drama_overview"]]})
    facts = [f"{drama} {ep_label} aired on {air or 'YouTube'}.",
             f"Channel: {ep['channel']}.",
             f"Watch the full episode: {ep['url']}"]
    if ep.get("views"):
        facts.append(f"YouTube views: {ep['views']:,}.")
    if ep.get("drama_tmdb_id"):
        facts.append(f"TMDB: {drama} (id {ep['drama_tmdb_id']}).")
    people = []
    if ep.get("drama_cast"):
        people = ep["drama_cast"][:5]
    thumb = f"https://i.ytimg.com/vi/{ep['video_id']}/hqdefault.jpg"
    return {
        "id": fnv1a(ep["url"]),
        "type": "news",
        "headline": headline,
        "dek": dek,
        "body": body,
        "facts": facts,
        "entities": {"titles": [drama], "people": people},
        "images": [{"url": thumb,
                    "caption": f"{drama} {ep_label}",
                    "source": ep["channel"]}],
        "published": ep.get("published") or iso_now(),
    }


def enrich_from_tmdb(tmdb_key, ep, pool):
    """Attach the drama's TMDB id / overview / top cast (for the info
    post). Best-effort — a missing TMDB match never blocks the post."""
    key = norm_name(ep["drama"])
    hit = pool.get(key)
    if not hit:
        return
    ep["drama_tmdb_id"] = hit["tmdb_id"]
    if not ep.get("channel") or ep["channel"] == hit.get("channel"):
        pass
    if not tmdb_key:
        return
    try:
        d = tmdb_get(tmdb_key, f"/tv/{hit['tmdb_id']}", {"language": "en-US"})
        if d.get("overview"):
            ep["drama_overview"] = d["overview"]
        try:
            cr = tmdb_get(tmdb_key, f"/tv/{hit['tmdb_id']}/credits", {})
            cast = [(c.get("name") or "") for c in (cr.get("cast") or [])[:5]]
            ep["drama_cast"] = [c for c in cast if c]
        except Exception:
            pass
    except Exception as e:
        print(f"tmdb details {ep['drama']} failed: {e}")


# ---------------------------------------------------------------- Gemini
def call_gemini_filedata(keys, video_url, drama, epno):
    """Watch the episode (fileData, YouTube URL) and write a ~180-word
    story summary in our own words. Proven spike 2026-10-25: fileData
    on gemini-3.5-flash-lite, ~217K VIDEO tokens/episode. Returns the
    summary text or None. Tries each key in turn (rotation).

    SUPERSEDED 2026-10-27: the backlog now uses
    call_gemini_text_summary (Roman Urdu, title+description grounded);
    this function is kept for manual use only."""
    prompt = (
        f"Watch this Pakistani drama episode and write a story summary "
        f"in your own words, about 180 words.\n\n"
        f"Drama: {drama}, Episode {epno if epno else '(final episode)'}.\n\n"
        f"Cover what actually happens in the episode: the main plot "
        f"beats in order, the key character moments, and how it ends "
        f"(including any cliffhanger). Do NOT invent events, dialogue or "
        f"names that are not in the episode. Do NOT copy the video "
        f"description. Write in clear, engaging English, as a magazine "
        f"episode guide.\n\n"
        f"Return ONLY the summary text — no headings, no preamble, no "
        f"bullet list.")
    for key in keys:
        try:
            body = json.dumps({
                "contents": [{"parts": [
                    {"fileData": {"mimeType": "video/mp4",
                                  "fileUri": video_url}},
                    {"text": prompt},
                ]}],
                "generationConfig": {"maxOutputTokens": 1024},
            }).encode("utf-8")
            req = urllib.request.Request(
                f"https://generativelanguage.googleapis.com/v1beta/models/"
                f"{MODEL}:generateContent",
                data=body,
                headers={"x-goog-api-key": key,
                         "Content-Type": "application/json"})
            # Video ingestion takes a while — 5 min timeout.
            with urllib.request.urlopen(req, timeout=300) as r:
                resp = json.load(r)
            text = resp["candidates"][0]["content"]["parts"][0]["text"]
            text = (text or "").strip()
            if len(text) < 50:
                print("  gemini summary too short, treating as failure")
                continue
            return text
        except Exception as e:
            print(f"  gemini key ...{key[-4:]} fileData failed: {e}")
            continue
    print("  gemini: all keys failed for this episode")
    return None


def air_date(ep):
    """'25 October 2026' from the episode's published timestamp."""
    try:
        return datetime.fromisoformat(
            (ep.get("published") or "").replace("Z", "+00:00")
            ).strftime("%d %B %Y")
    except Exception:
        return (ep.get("published") or "")[:10]


def story_text_from_description(desc, title=""):
    """Strip YouTube boilerplate from a video description; keep the
    story-ish prose a summary may be grounded in. Returns '' when the
    description holds no story (cast list / promo only)."""
    if not desc:
        return ""
    lines = desc.split("\n")
    out = []
    title_norm = re.sub(r"\W+", " ", (title or "").lower()).strip()
    for ln in lines:
        s = ln.strip()
        if not s:
            continue
        low = s.lower()
        if any(k in low for k in [
                "thanks for watching", "click here", "subscribe",
                "bell icon", "download", "visit 👉", "aryplus",
                "is now available in the us", "share the news",
                "watch all the episode", "playlist?list=", "timing :",
                "http://", "https://", "director :", "writer :",
                "cast :", "digitally presented by"]):
            continue
        if s.startswith("#"):
            continue
        if title_norm and re.sub(r"\W+", " ", low).strip() == title_norm:
            continue
        # Bare cast-name lines: <=3 words, no sentence punctuation.
        words = s.split()
        if len(words) <= 3 and not re.search(r"[.!?,;:]", s):
            continue
        out.append(s)
    text = " ".join(out)
    text = re.split(
        r"(Pakistani Drama Industry's biggest Platform|"
        r"Subscribe to the YouTube channel)", text)[0]
    return re.sub(r"\s+", " ", text).strip()


def minimal_summary(ep):
    """Factual one-liner for episodes whose description carries no
    story (never invent plot)."""
    n = ep.get("episode")
    ep_label = f"Episode {n}" if n else "Aakhri episode"
    return (f"{ep.get('drama') or 'Drama'} ki {ep_label.lower()}, "
            f"{air_date(ep)} ko {ep.get('channel') or 'TV'} par nashar hui.")


def call_gemini_text_summary(keys, title, story, drama, epno):
    """Write a 2-4 sentence story summary in ROMAN URDU, grounded only
    in the episode's YouTube title + description story text. Returns
    the summary text or None. Tries each key in turn (rotation)."""
    prompt = (
        "Neeche ek Pakistani drama ki YouTube description se li gayi "
        "kahani ki tafseel hai. Isay Roman Urdu (Latin script) mein 2-4 "
        "jumlon mein dobara likho — natural, aam bol-chaal wali Roman "
        "Urdu, jaisay Pakistan mein log likhte hain. Sirf wohi likho jo "
        "tafseel mein maujood hai; episode ke khaas waqiyat, dialogue ya "
        "naam invent mat karo. Yeh drama ki overall kahani ka khulasa "
        "hai, kisi ek episode ke waqiyat nahi — is liye 'is episode "
        "mein' likh kar koi waqiya mat batao. Koi heading, bullet ya "
        "English jumla mat likho — sirf Roman Urdu summary.\n\n"
        f"Drama: {drama}, Episode {epno if epno else '(final episode)'}.\n"
        f"Video title: {title}\nTafseel: {story}")
    for key in keys:
        try:
            body = json.dumps({
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"maxOutputTokens": 512},
            }).encode("utf-8")
            req = urllib.request.Request(
                f"https://generativelanguage.googleapis.com/v1beta/models/"
                f"{MODEL}:generateContent",
                data=body,
                headers={"x-goog-api-key": key,
                         "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as r:
                resp = json.load(r)
            text = resp["candidates"][0]["content"]["parts"][0]["text"]
            text = (text or "").strip()
            if len(text) < 30:
                print("  gemini summary too short, treating as failure")
                continue
            return text
        except Exception as e:
            print(f"  gemini key ...{key[-4:]} text summary failed: {e}")
            continue
    print("  gemini: all keys failed for this episode")
    return None


def summarise_episode(keys, yt_key, ep):
    """Roman Urdu summary for one episode (backlog path). Fetches the
    video description via videos.list (1 quota unit); a thin/no-story
    description -> minimal factual line (no Gemini call, never
    invented plot). Returns the summary text, or None only when
    Gemini fails (so the episode stays in the backlog)."""
    desc = ""
    title = ep.get("title") or ""
    if yt_key:
        try:
            det = yt_get(yt_key, "/videos",
                         {"part": "snippet", "id": ep["video_id"]})
            items = det.get("items") or []
            if items:
                desc = (items[0].get("snippet") or {}).get("description") or ""
                title = (items[0].get("snippet") or {}).get("title") or title
        except Exception as e:
            print(f"  videos.list for summary failed: {e}")
    story = story_text_from_description(desc, title)
    if len(story) < 200:
        return minimal_summary(ep)
    summary = call_gemini_text_summary(keys, title, story[:3000],
                                       ep["drama"], ep.get("episode"))
    if not summary:
        return None
    n = ep.get("episode")
    ep_label = f"Episode {n}" if n else "Aakhri episode"
    return (summary + f" {ep_label}, {air_date(ep)} ko "
            f"{ep.get('channel') or 'TV'} par nashar hui.")


# ---------------------------------------------------------------- state
def load_state():
    if os.path.exists(EPISODES_JSON):
        with open(EPISODES_JSON, encoding="utf-8") as f:
            return json.load(f)
    return {"episodes": {}}


def save_state(state):
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(EPISODES_JSON, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)


def summaries_today(state):
    today = datetime.now(timezone.utc).date().isoformat()
    n = 0
    for ep in (state.get("episodes") or {}).values():
        if (ep.get("summary_at") or "")[:10] == today:
            n += 1
    return n


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="detect + match + report, no writes, no Gemini")
    args = ap.parse_args()
    dry = args.dry_run
    per_run = int(os.environ.get("SUMMARY_PER_RUN", "50") or "50")
    per_run = max(0, min(per_run, SUMMARY_MAX_PER_DAY))
    lookback = int(os.environ.get("EPISODE_LOOKBACK_HOURS", "48") or "48")

    tmdb_key = read_tmdb_key()
    yt_key = os.environ.get("YOUTUBE_DATA_API_KEY", "").strip()
    gkeys = gemini_keys()

    pool = build_drama_pool(tmdb_key)
    # Pakistani Dramas only (user order 2026-10-26): the gate list is
    # the site's published Pakistani TV list. Empty map = the published
    # file was unreadable, so the gate is OFF (never block every post
    # on a data-file failure).
    pk_dramas = load_published_pk_dramas()
    gate_on = bool(pk_dramas)
    if gate_on:
        print(f"drama gate: {len(pk_dramas)} published Pakistani dramas")
    else:
        print("drama gate: OFF (published list empty/unreadable — "
              "posting ungated)")
    state = load_state()
    known = state.get("episodes") or {}

    # ---- 1. detect
    if yt_key:
        print("detection: YouTube Data API (primary)")
        candidates = detect_via_api(yt_key, lookback)
    else:
        print("detection: RSS fallback — YOUTUBE_DATA_API_KEY is not set. "
              "RSS lists ZERO full episodes in its 15-item window (spike), "
              "so most episodes will be missed until the key is added as "
              "a flickatlas-site repo secret.")
        candidates = detect_via_rss()

    # ---- 2. match + dedup (video_id AND drama+episode)
    seen_drama_ep = set()
    for vid, rec in known.items():
        if rec.get("drama") and rec.get("episode"):
            seen_drama_ep.add((norm_name(rec["drama"]), rec["episode"]))
    new_eps = []
    skipped_dup = 0
    for c in candidates:
        if c["video_id"] in known:
            skipped_dup += 1
            continue
        if c.get("episode") and (norm_name(c["drama"]), c["episode"]) in seen_drama_ep:
            skipped_dup += 1
            continue
        # Resolve a finale number from TMDB when we can.
        if c.get("is_finale") and c.get("episode") is None:
            hit = pool.get(norm_name(c["drama"]))
            if hit:
                c["episode"] = resolve_finale_episode(
                    tmdb_key, hit.get("tmdb_id"))
        new_eps.append(c)
        if c.get("episode"):
            seen_drama_ep.add((norm_name(c["drama"]), c["episode"]))
    # Newest first (so the newest episode is posted first).
    new_eps.sort(key=lambda e: e.get("published") or "", reverse=True)
    print(f"detect: {len(candidates)} candidates, {len(new_eps)} new, "
          f"{skipped_dup} already posted")

    # ---- 3. info posts (no AI, every new episode, same day)
    articles = read_js_map(ARTICLES_JS, "FA_ARTICLES")
    feed_entries = []
    if os.path.exists(EPISODE_FEED_JSON):
        try:
            with open(EPISODE_FEED_JSON, encoding="utf-8") as f:
                feed_entries = (json.load(f).get("feed") or [])
        except Exception:
            feed_entries = []
    feed_have = {e.get("id") for e in feed_entries}
    posted = 0
    posted_names = []
    for ep in new_eps:
        # Pakistani Dramas only (user order 2026-10-26): the episode's
        # drama must be on the site's published Pakistani TV list
        # (aliases applied — Dar -> Dar-E-Nijaat, Zehar ->
        # Zehar-e-Mohabbat — and the article is written under the
        # published name). Anything else (Bulbulay Season 2, an
        # interview, an unlisted drama) is skipped and stays out of
        # `known`, so a later run posts it if the drama gets listed.
        if gate_on:
            canon = canonical_pk_drama(ep["drama"], pk_dramas)
            if canon is None:
                print(f"  skip (not a listed Pakistani drama): {ep['drama']} "
                      f"Ep {ep['episode']} ({ep['channel']})")
                continue
            ep["drama"] = canon
        # Non-PK channels: only post episodes with 1M+ views (see
        # MIN_VIEWS_INTL). Skipped episodes stay out of `known`, so a
        # later run posts them once they cross 1M within the lookback.
        if (ep.get("cats") or ["pakistan"]) != ["pakistan"] and \
                (ep.get("views") or 0) < MIN_VIEWS_INTL:
            print(f"  skip (intl below 1M views): {ep['drama']} "
                  f"Ep {ep['episode']} ({ep['channel']}, "
                  f"{ep.get('views', 0):,} views)")
            continue
        enrich_from_tmdb(tmdb_key, ep, pool)
        art = build_article(ep)
        aid = art["id"]
        if aid in articles:
            print(f"  skip (article exists): {ep['drama']} Ep {ep['episode']}")
            continue
        ep["article_id"] = aid
        ep["posted_at"] = iso_now()
        ep["summary"] = None
        ep["summary_at"] = None
        if not dry:
            articles[aid] = art
            known[ep["video_id"]] = ep
            ts = parse_ts(ep.get("published"))
            if aid not in feed_have:
                feed_entries.append({
                    "id": aid, "title": art["headline"],
                    "link": ep["url"], "source": ep["channel"],
                    "cats": ep.get("cats") or ["pakistan"],
                    "ts": ts if ts is not None else int(time.time() * 1000)})
                feed_have.add(aid)
        posted += 1
        posted_names.append(f"{ep['drama']} Ep {ep['episode']}")
        print(f"  + {ep['drama']} Ep {ep['episode']} ({ep['channel']}, "
              f"{ep.get('views', 0):,} views) -> {aid}")
    if dry:
        print(f"dry-run: would post {posted} new episode(s)")
    else:
        changed = write_js_map(
            ARTICLES_JS, "FA_ARTICLES", articles,
            "/* FlickAtlas — published articles. GENERATED by the auto-pipeline "
            "(scripts/gemini_batch.py + scripts/apply-auto.py) and the panel "
            "publish-export — do not edit by hand. */")
        print(f"articles: +{posted} new episode posts (file changed: {changed})")
        if feed_entries:
            with open(EPISODE_FEED_JSON, "w", encoding="utf-8") as f:
                json.dump({"feed": feed_entries}, f, ensure_ascii=False, indent=1)
            print(f"episode-feed: {len(feed_entries)} entries")

    # ---- 4. summary backlog: EVERY episode without a summary, same run
    # (owner order 2026-10-28); backlog ordered by views desc, never redo
    made = 0
    summary_names = []
    if dry:
        pending = [e for e in known.values() if not e.get("summary")]
        pending.sort(key=lambda e: e.get("views") or 0, reverse=True)
        print(f"dry-run: backlog {len(pending)} episode(s) awaiting a "
              f"summary; top by views: " +
              ", ".join(f"{e['drama']} Ep {e['episode']} "
                        f"({e.get('views', 0):,} views)"
                        for e in pending[:3]))
        print("dry-run: no writes, no Gemini calls")
        return 0
    if not gkeys:
        print("summaries: no Gemini keys — backlog kept for a later run")
    else:
        done_today = summaries_today(state)
        budget = min(per_run, SUMMARY_MAX_PER_DAY - done_today)
        if budget <= 0:
            print(f"summaries: daily cap reached ({done_today} today)")
        else:
            pending = [e for e in known.values() if not e.get("summary")]
            pending.sort(key=lambda e: e.get("views") or 0, reverse=True)
            print(f"summaries: backlog {len(pending)}, budget {budget} "
                  f"this run ({done_today} already today)")
            made = 0
            for ep in pending[:budget]:
                print(f"  summarising {ep['drama']} Ep {ep['episode']} "
                      f"({ep.get('views', 0):,} views)…")
                # Roman Urdu summary (title+description grounded;
                # thin description -> minimal factual line, never
                # invented). None only when Gemini fails: stays queued.
                summary = summarise_episode(
                    gkeys, yt_key, ep)
                if not summary:
                    print("  summary failed — stays in backlog")
                    continue
                # Append the summary to the live article (same id, no dup).
                art = articles.get(ep.get("article_id") or "")
                if isinstance(art, dict):
                    body = art.get("body") or []
                    if not any((s.get("h") or "") == "Story Summary"
                               for s in body if isinstance(s, dict)):
                        body.append({"h": "Story Summary", "p": [summary]})
                        art["body"] = body
                    art["facts"] = (art.get("facts") or []) + [
                        f"Story summary added {iso_now()[:10]}."]
                ep["summary"] = summary
                ep["summary_at"] = iso_now()
                made += 1
                summary_names.append(
                    f"{ep['drama']} Ep {ep['episode']}")
                print(f"  summary done ({len(summary)} chars)")
            if made:
                write_js_map(
                    ARTICLES_JS, "FA_ARTICLES", articles,
                    "/* FlickAtlas — published articles. GENERATED by the auto-pipeline "
                    "(scripts/gemini_batch.py + scripts/apply-auto.py) and the panel "
                    "publish-export — do not edit by hand. */")

    if not dry:
        save_state({"episodes": known})
    print("episode-guides: done")
    if step_runs is not None and not dry:
        reason = None
        if posted == 0 and made == 0:
            reason = "no-new-data"
        step_runs.record(
            "episode_guides", status="success",
            checked={"candidates": len(candidates),
                     "detail": "YouTube episodes on the 4 official PK "
                               "channels (+ intl 1M+ views); "
                               "%d new detected" % len(new_eps)},
            changed={"added": posted_names,
                     "updated": summary_names,
                     "count": posted + made},
            reason=reason)
    return 0


if __name__ == "__main__":
    sys.exit(main())




