#!/usr/bin/env python3
"""FlickAtlas fetch script v4 — sirf AAJ ki, LOOSE catch, ek kahani = ek post.

User ke rules (2026-10-24):
  1. Sites se SAB posts nahi — sirf us din ki posts jis din script run ho.
  2. LOOSE filter: thori si bhi milti hui ho to pakar lo. Koi keyword
     na mile to "Movies" (general bucket) mein daalo — asli category
     AI draft ke waqt admin panel ki categories se dobara tay karegi.
  3. Har category ki posts ALAG-ALAG, organized (per-category files).
  4. STORY CLUSTERING: ek hi khabar kayi sites par aaye to sirf EK post
     banegi — baqi duplicates.json mein (story_id + duplicate_of ke saath).
     Sitemap slug-kachra (<3 lafz, bina digit) drop hota hai.

Kya karta hai (sirf standard library, koi install nahi):
  1. RSS/Atom feed wali sites   -> feed parho, pubDate ko PKT date mein
                                    lao; sirf aaj ki date wali rakho.
  2. Sirf-sitemap wali sites    -> lastmod aaj ki ho to rakho (note mein
                                    likha hota hai ke ye stamp kam bharosemand
                                    hai); lastmod na ho to drop (no-date).
  3. Na-feed-na-sitemap sites   -> page ke story-links ka SET compare karo;
                                    naya link = aaj pehli dafa dikha (note mein
                                    saaf likha: asli date maloom nahi).

  Phir har item ki CATEGORY lagao (title + URL slug ke keywords se,
  priority order mein). Kisi category mein fit na ho to DROP karo —
  dropped.json mein wajah ke saath (kuch chhupa kar nahi phenka jata).

Dedupe: seen.json mein queued + permanently-irrelevant (not-today /
future-date / no-date) items ke keys. no-category-fit items seen mein
NAHI jate — rules behtar hone par usi din dobara evaluate ho sakte hain.

AI ka is script mein KOI kaam nahi: ye sirf DATA lata hai. Likhna
(Gemini draft) aur publish us ke baad, approval ke saath, alag step hai.

Usage:
  python3 fetch.py --registry registry.json --out ./out
  python3 fetch.py --registry registry.json --out ./out --only "Filmibeat,Sacnilk"
  python3 fetch.py --registry registry.json --out ./out --max-items 30

Outputs (out dir):
  queue.json              — DRAFT queue: ek kahani = ek item (representative),
                            story_id + category ke saath
  stories.json            — har story ka khulasa (representative + kitne
                            duplicates hataye + un ke sources)
  duplicates.json         — hataye hue duplicates (story_id + duplicate_of)
  categories/<slug>.json  — har category ki alag file (representatives se;
                            khaali category bhi [] ke saath likhi jati hai)
  dropped.json            — filter hui items + wajah (not-today / future-date /
                            no-date / section-page / slug-junk)
  seen.json, state.json   — ledger + ETag/link-set state (delete mat karna)
  report.json             — har source ka status + per-category + dropped counts
"""

import argparse
import gzip
import html
import json
import os
import re
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from urllib.parse import urljoin, urlparse

UA = "FlickAtlasFetch/2.0 (+https://flickatlas.co.uk) fetch-script"
TIMEOUT = 20

# "Aaj" = Asia/Karachi date (user ka timezone). Pakistan mein DST nahi,
# is liye zoneinfo na mile to fixed +5 bhi bilkul durust hai.
try:
    from zoneinfo import ZoneInfo
    PKT = ZoneInfo("Asia/Karachi")
except Exception:
    PKT = timezone(timedelta(hours=5))

LINK_BLOCK = (
    "/tag/", "/tags/", "/category/", "/categories/", "/author/",
    "/page/", "/search", "/amp", "#", "javascript:",
    ".jpg", ".jpeg", ".png", ".gif", ".css", ".js", ".svg", ".webp",
    "/privacy", "/terms", "/contact", "/about", "/advertise", "/sitemap",
)

# 11 pipeline categories — ORDER = priority (pehla match jeetta hai).
# Is liye makhsoos categories (Box Office, Awards...) aam (Movies) se pehle.
CATEGORIES = [
    ("Box Office", [r"box office", r"boxoffice", r"collection", r"day\s*\d+",
                    r"opening weekend", r"worldwide gross", r"occupancy",
                    r"nett gross", r"\bgrossed\b", r"opens at", r"opener",
                    r"\bcrore\b", r"\bcr\b", r"lakh"]),
    ("Awards", [r"\bawards?\b", r"oscar", r"bafta", r"grammy", r"emmy",
                r"nomination", r"nominated", r"filmfare awards"]),
    ("Trailers", [r"trailer", r"teaser", r"first look", r"motion poster",
                  r"trailer out"]),
    ("Music / OST", [r"\bsong\b", r"soundtrack", r"\bost\b", r"music video",
                     r"\balbum\b", r"\bsingle\b", r"tracklist", r"concert",
                     r"comeback", r"\btour\b", r"\bdebut\b", r"title track",
                     r"\bidol\b"]),
    ("Episodes", [r"episode", r"\bep\s*\d+\b", r"episode guide"]),
    ("Upcoming releases", [r"release date", r"releasing",
                           r"to release", r"in theatres",
                           r"in cinemas", r"release on", r"arrives on",
                           r"diwali.{0,30}releas", r"\beid.{0,30}releas",
                           r"christmas.{0,30}releas", r"christmas (movie|film)"]),
    ("OTT / Streaming", [r"\bott\b", r"netflix", r"prime video", r"disney",
                         r"hotstar", r"web series", r"streaming", r"sonyliv",
                         r"\bzee5\b", r"jiohotstar"]),
    ("TV & Dramas", [r"\bdrama\b", r"tv show", r"\bserial\b", r"television",
                     r"reality show", r"daily soap", r"tv series", r"new series",
                     r"\bsoap\b", r"finale", r"contestant"]),
    ("Celebrity news & events", [r"celebrity", r"spotted", r"birthday",
                                 r"wedding", r"engagement", r"dating",
                                 r"vacation", r"holiday",
                                 r"red carpet", r"funeral", r"hospitali[sz]ed"]),
    ("Movies", [r"\bfilm\b", r"movie", r"actor", r"actress", r"director",
                r"\bcast\b", r"bollywood", r"hollywood", r"cinema",
                r"shooting", r"\bwrap\b", r"sequel", r"franchise",
                r"remake", r"biopic", r"filmmaker", r"review",
                r"reportedly", r"dubbing"]),
    ("Entertainment viral", [r"\bviral\b", r"trending", r"trolled",
                             r"fans react", r"social media"]),
]


def slugify(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


# Sitemap section/archive pages — ye articles nahi hote (sirf section ke
# naam hote hain). Inhen "section-page" keh kar drop karo, queue mein nahi.
SECTION_SLUGS = {
    "news", "photos", "videos", "interviews", "magazine", "features",
    "reviews", "beauty", "fashion", "nostalgia", "south", "korean",
    "what to watch", "celeb lifestyle and fashion", "home", "latest",
    "finance and technology", "fitness", "food", "famously filmfare",
}
MONTH_YEAR_RE = re.compile(
    r"^(january|february|march|april|may|june|july|august|september|"
    r"october|november|december)\s+\d{4}$")


def is_section_slug(slug):
    s = slug.strip().lower()
    return s in SECTION_SLUGS or bool(MONTH_YEAR_RE.match(s)) or s == ""


def today_pkt():
    return datetime.now(PKT).date().isoformat()


def to_pkt_date(pub):
    """Feed/sitemap date -> PKT date (ISO) + future flag. ('', False) agar na ho."""
    if not pub:
        return "", False
    try:
        dt = parsedate_to_datetime(pub)
        if dt is None:
            dt = datetime.fromisoformat(pub.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        pkt_date = dt.astimezone(PKT).date().isoformat()
        future = dt.astimezone(PKT).date().isoformat() > today_pkt()
        return pkt_date, future
    except Exception:
        m = re.match(r"(\d{4}-\d{2}-\d{2})", pub)
        if m:
            return m.group(1), m.group(1) > today_pkt()
        return "", False


def classify(title, url):
    """Title + URL slug ke keywords se category (priority order).
    LOOSE RULE (user ka hukm): thori si bhi milti hui ho to pakar lo —
    koi keyword na mile to "Movies" (general bucket) + fallback flag.
    Asli category AI draft ke waqt admin panel ki categories se
    dobara tay karegi; script ki category sirf hint hai."""
    # SIRF title match hota hai — URL slug section-words (tv-shows, trending,
    # memes...) se category hijack ho jati thi (TheWrap politics → TV, IE
    # microreactor → Box Office). Title me lafz na ho to fallback/AI par
    # chhora jata hai, slug par kabhi nahi.
    text = title.lower()
    for name, patterns in CATEGORIES:
        for pat in patterns:
            if re.search(pat, text):
                return name, False
    return "Movies", True


TECH_SOURCE_RE = re.compile(r"tech|invention|science|engineering|gadget", re.I)

def is_non_entertainment_source(entry):
    """Tech/science ya general-viral source? In ki unmatched stories Movies fallback
    me nahi jayengi. Do nishaniyan (registry se):
    (a) data_types/scopes me tech/science lafz (Interesting Engineering, New Atlas...);
    (b) scope 'Viral' se shuru ho (UNILAD, LADbible, Bored Panda, Oddity Central...) —
    ye feeds general viral news bhi deti hain (flooding, court, crime), is liye
    in ki bina-keyword story ka entertainment se talluq sabit nahi hota.
    Entertainment keyword wali story phir bhi sahi category me jayegi — sirf
    blind fallback band hai, source band nahi."""
    scopes = entry.get("scopes") or []
    if any(str(sc).strip().startswith("Viral") for sc in scopes):
        return True
    hay = " ".join(scopes + (entry.get("data_types") or []))
    return bool(TECH_SOURCE_RE.search(hay))


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def fetch(url, etag=None, last_mod=None):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        "Accept-Encoding": "gzip",
    })
    if etag:
        req.add_header("If-None-Match", etag)
    if last_mod:
        req.add_header("If-Modified-Since", last_mod)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            body = resp.read()
            if resp.headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
            return resp.status, body, resp.headers.get("ETag"), resp.headers.get("Last-Modified")
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return 304, b"", None, None
        raise


def strip_ns(tag):
    return tag.split("}", 1)[-1] if "}" in tag else tag


def parse_feed(body):
    root = ET.fromstring(body)
    items = []
    for el in root.iter():
        if strip_ns(el.tag) not in ("item", "entry"):
            continue
        title, link, guid, pub = "", "", "", ""
        for ch in el:
            t = strip_ns(ch.tag)
            if t == "title":
                title = (ch.text or "").strip()
            elif t == "link":
                if ch.text and ch.text.strip():
                    link = ch.text.strip()
                elif ch.get("href") and ch.get("rel") in (None, "alternate") and not link:
                    link = ch.get("href")
            elif t in ("guid", "id"):
                guid = (ch.text or "").strip()
            elif t in ("pubDate", "published", "updated", "date"):
                pub = (ch.text or "").strip()
        url = link or guid
        if url:
            items.append({"title": html.unescape(title), "url": url, "published": pub})
    return items


def parse_sitemap(body, depth=0):
    root = ET.fromstring(body)
    urls, kids = [], []
    for el in root.iter():
        tag = strip_ns(el.tag)
        if tag == "url":
            loc, lm = "", ""
            for ch in el:
                if strip_ns(ch.tag) == "loc":
                    loc = (ch.text or "").strip()
                elif strip_ns(ch.tag) == "lastmod":
                    lm = (ch.text or "").strip()
            if loc:
                urls.append((loc, lm))
        elif tag == "sitemap":
            for ch in el:
                if strip_ns(ch.tag) == "loc" and ch.text:
                    kids.append(ch.text.strip())
    if not urls and kids and depth < 1:
        for k in kids[:5]:
            try:
                _, b, _, _ = fetch(k)
                urls.extend(parse_sitemap(b, depth + 1))
            except Exception:
                continue
    return urls


def extract_story_links(page_url, body):
    try:
        text = body.decode("utf-8", errors="ignore")
    except Exception:
        return set()
    host = urlparse(page_url).netloc
    links = set()
    for m in re.finditer(r'href=["\']([^"\']+)["\']', text):
        raw = html.unescape(m.group(1)).split("#")[0].strip()
        if not raw or raw.startswith(("javascript:", "mailto:", "tel:")):
            continue
        full = urljoin(page_url, raw)
        p = urlparse(full)
        if p.netloc != host or len(p.path) <= 1:
            continue
        if any(b in p.path.lower() for b in LINK_BLOCK):
            continue
        links.add(full)
    return links


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--registry", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default="")
    ap.add_argument("--max-items", type=int, default=30)
    args = ap.parse_args()
    TODAY = today_pkt()

    with open(args.registry, encoding="utf-8") as f:
        registry = json.load(f)
    only = {s.strip().lower() for s in args.only.split(",") if s.strip()} if args.only else None
    if only:
        registry = [e for e in registry if e["name"].lower() in only]

    os.makedirs(args.out, exist_ok=True)
    os.makedirs(os.path.join(args.out, "categories"), exist_ok=True)
    seen_path = os.path.join(args.out, "seen.json")
    state_path = os.path.join(args.out, "state.json")
    seen = json.load(open(seen_path, encoding="utf-8")) if os.path.exists(seen_path) else {}
    state = json.load(open(state_path, encoding="utf-8")) if os.path.exists(state_path) else {}

    queue, dropped, report = [], [], []
    for entry in registry:
        name = entry["name"]
        st = state.get(name, {})
        rec = {"source": name, "status": "", "new": 0, "total": 0, "note": ""}

        def consider(source, title, url, pub_raw, via, note, pkt_date, future):
            """Today + category filter. Returns True agar queue mein gaya."""
            if url in seen:
                return False
            if future:
                dropped.append({"source": source, "title": title, "url": url,
                                "published": pub_raw, "via": via, "reason": "future-date"})
                seen[url] = now_iso()  # dobara kabhi nahi (date kabhi aaj nahi banegi)
                return False
            if pkt_date and pkt_date != TODAY:
                dropped.append({"source": source, "title": title, "url": url,
                                "published": pub_raw, "via": via, "reason": "not-today"})
                seen[url] = now_iso()
                return False
            if not pkt_date and via != "hash-diff":
                dropped.append({"source": source, "title": title, "url": url,
                                "published": pub_raw, "via": via, "reason": "no-date"})
                seen[url] = now_iso()
                return False
            if via in ("sitemap", "hash-diff"):
                # Slug-kachra: 3 lafz se chhota slug aur koi digit bhi nahi
                # (jaise "on acorntv") — ye khabar nahi, page/section ka naam hai.
                # RSS titles par ye rule NAHI (asli chhoti headline ho sakti hai).
                words = title.split()
                if len(words) < 3 and not any(c.isdigit() for c in title):
                    dropped.append({"source": source, "title": title, "url": url,
                                    "published": pub_raw, "via": via, "reason": "slug-junk"})
                    seen[url] = now_iso()
                    return False
                # v5 slug-title: title khud URL slug ho (DNA India: "report ...
                # 3222975", Box Office Mojo: "rl1752465409") — ye headline nahi,
                # draft ke layak nahi. Sirf sitemap/hash-diff par (RSS headlines
                # asli hoti hain). "report "-rule DNA-specific hai: lowercase
                # slug + aakhir me 7-digit ID; Times Now/Metro ke readable
                # titles is se nahi pakre jate (wo "report " se shuru nahi hote).
                if re.fullmatch(r"[a-z]{1,3}\d{6,}", title) or (
                        title.startswith("report ") and title == title.lower()
                        and re.search(r"\b\d{7}\s*$", title)):
                    dropped.append({"source": source, "title": title, "url": url,
                                    "published": pub_raw, "via": via, "reason": "slug-title"})
                    seen[url] = now_iso()
                    return False
                # v6 slug-title-html: hash-diff + bina date + poora lowercase
                # title jo ".html" par khatam ho (Zee News: Faridabad jail
                # hampers "...3076967.html") — ye headline nahi, URL slug hai.
                # Sirf hash-diff + no-date par: Filmfare/Vulture ke sitemap
                # wale .html titles ke paas asli date hoti hai aur wo rehte hain.
                if via == "hash-diff" and not pkt_date and title == title.lower() \
                        and title.strip().endswith(".html"):
                    dropped.append({"source": source, "title": title, "url": url,
                                    "published": pub_raw, "via": via, "reason": "slug-title-html"})
                    seen[url] = now_iso()
                    return False
            if "/sport/" in urlparse(url).path.lower():
                dropped.append({"source": source, "title": title, "url": url,
                                "published": pub_raw, "via": via, "reason": "sports-section"})
                seen[url] = now_iso()
                return False
            low_title = title.lower()
            if "livestream" in low_title and re.search(r"ufc|boxing|wbc|\bnba\b|\bnhl\b|\bnfl\b|cricket|tennis|rugby|snooker|golf", low_title):
                dropped.append({"source": source, "title": title, "url": url,
                                "published": pub_raw, "via": via, "reason": "sports-livestream"})
                seen[url] = now_iso()
                return False
            cat, is_fallback = classify(title, url)
            if is_fallback and is_non_entertainment_source(entry):
                # Tech/viral-general source ki unmatched story: Movies fallback nahi.
                # (2026-10-24: fighter jet / EV battery / warship stories Movies
                # tag ke saath queue me aa gayi thin — isi rule se rok.)
                dropped.append({"source": source, "title": title, "url": url,
                                "published": pub_raw, "via": via,
                                "reason": "fallback-blocked-non-entertainment"})
                seen[url] = now_iso()
                return False
            if is_fallback:
                fb = ("loose fallback: keyword match nahi mila, "
                      "AI draft ke waqt dobara category tay kare")
                note = (note + " | " + fb) if note else fb
            seen[url] = now_iso()
            queue.append({"source": source, "title": title, "url": url,
                          "published": pub_raw, "via": via, "category": cat,
                          "category_source": "fallback" if is_fallback else "keyword",
                          "note": note, "detected_at": now_iso()})
            return True

        try:
            if entry.get("rss"):
                status, body, etag, lm = fetch(
                    entry["rss"], st.get("etag"), st.get("last_modified"))
                if status == 304:
                    rec.update(status="unchanged", note="304, feed badli nahi")
                    report.append(rec)
                    continue
                items = parse_feed(body)[: args.max_items]
                rec["total"] = len(items)
                for it in items:
                    pkt_date, future = to_pkt_date(it["published"])
                    consider(name, it["title"], it["url"], it["published"],
                             "rss", "", pkt_date, future)
                st["etag"], st["last_modified"] = etag, lm
                rec.update(status="ok")
            elif entry.get("sitemap"):
                _, body, _, _ = fetch(entry["sitemap"])
                urls = parse_sitemap(body)
                rec["total"] = len(urls)
                for loc, lm in urls[:200]:
                    pkt_date, future = to_pkt_date(lm)
                    slug = urlparse(loc).path.strip("/").split("/")[-1].replace("-", " ")
                    if is_section_slug(slug):
                        if loc not in seen:
                            seen[loc] = now_iso()
                        dropped.append({"source": name, "title": slug, "url": loc,
                                        "published": lm, "via": "sitemap",
                                        "reason": "section-page"})
                        continue
                    consider(name, slug, loc, lm, "sitemap",
                             "sitemap lastmod stamp — date ki tasdeeq kamzor",
                             pkt_date, future)
                rec.update(status="ok")
            else:
                _, body, _, _ = fetch(entry["url"])
                links = extract_story_links(entry["url"], body)
                prev = set(st.get("links", []))
                new_links = links - prev
                st["links"] = sorted(links)
                rec["total"] = len(links)
                if not prev:
                    rec.update(status="baseline", note="pehli run: baseline set, queue khaali")
                else:
                    for loc in sorted(new_links):
                        slug = urlparse(loc).path.strip("/").split("/")[-1].replace("-", " ")
                        consider(name, slug, loc, "", "hash-diff",
                                 "link aaj pehli dafa dikha — asli date maloom nahi",
                                 TODAY, False)
                    rec.update(status="ok")
        except urllib.error.HTTPError as e:
            rec.update(status="error", note=f"HTTP {e.code} (bot-block ho sakta hai)")
        except Exception as e:
            rec.update(status="error", note=f"{type(e).__name__}: {str(e)[:120]}")
        rec["new"] = len([q for q in queue if q["source"] == name])
        state[name] = st
        report.append(rec)

    # --- Story clustering (v4): ek kahani = ek post ---
    # URL dedupe kaafi nahi: doosri site ki wohi khabar alag URL se aati hai.
    # Rule: title ke lafz milao (Jaccard >= 0.5) AUR naam/number ka farq na ho
    # (team names, episode no, scores alag hon to wo ALAG kahani hai — warna
    # Radio Times ke alag matches ek template ki wajah se ghalat mil jate).
    # Chhoti titles (<4 content tokens) sirf exact normalized title par milengi.
    STOPWORDS = set("the a an and or of to in on for with after amid at by "
                    "from as is are was were be been has have had will would "
                    "its it this that".split())

    def content_tokens(title):
        t = re.sub(r"[^a-z0-9 ]", " ", title.lower())
        return {w for w in t.split() if w not in STOPWORDS and len(w) > 1}

    def entity_tokens(title):
        toks = set()
        for w in re.findall(r"[A-Za-z0-9][\w'\-]*", title):
            if w[0].isupper() or any(c.isdigit() for c in w):
                toks.add(w.lower())
        return toks

    def norm_title(title):
        return " ".join(re.sub(r"[^a-z0-9 ]", " ", title.lower()).split())

    def jaccard(a, b):
        return len(a & b) / len(a | b) if a and b else 0.0

    clusters = []  # [rep_tokens, rep_ents, members]
    exact_groups = {}
    for item in queue:
        toks = content_tokens(item["title"])
        if len(toks) < 4:
            key = norm_title(item["title"])
            if key in exact_groups:
                exact_groups[key].append(item)
            else:
                exact_groups[key] = [item]
            continue
        ents = entity_tokens(item["title"])
        placed = False
        for rep_toks, rep_ents, members in clusters:
            if jaccard(toks, rep_toks) >= 0.5 and not (
                    (ents - rep_ents) or (rep_ents - ents)):
                members.append(item)
                placed = True
                break
        if not placed:
            clusters.append([toks, ents, [item]])
    for members in exact_groups.values():
        if len(members) == 1:
            clusters.append([content_tokens(members[0]["title"]),
                             entity_tokens(members[0]["title"]), members])
        else:
            clusters.append([content_tokens(members[0]["title"]),
                             entity_tokens(members[0]["title"]), members])

    representatives, duplicates, stories = [], [], []
    for idx, (_, _, members) in enumerate(clusters, start=1):
        sid = f"story-{idx:04d}"
        # Representative: pehle keyword-matched category wala, warna pehla item.
        # Usi ki category story ki category banegi.
        rep = next((m for m in members if m.get("category_source") == "keyword"),
                   members[0])
        rep_url = rep["url"]
        rep = dict(rep)
        rep["story_id"] = sid
        rep["duplicate_count"] = len(members) - 1
        representatives.append(rep)
        stories.append({
            "story_id": sid, "category": rep["category"],
            "title": rep["title"], "url": rep["url"], "source": rep["source"],
            "duplicate_count": len(members) - 1,
            "duplicate_sources": [m["source"] for m in members if m["url"] != rep_url],
        })
        for m in members:
            if m["url"] != rep_url:
                dup = dict(m)
                dup["story_id"] = sid
                dup["duplicate_of"] = rep["url"]
                duplicates.append(dup)
    queue = representatives

    by_cat = {name: [] for name, _ in CATEGORIES}
    for q in queue:
        by_cat[q["category"]].append(q)
    for name, _ in CATEGORIES:
        with open(os.path.join(args.out, "categories", slugify(name) + ".json"),
                  "w", encoding="utf-8") as f:
            json.dump(by_cat[name], f, ensure_ascii=False, indent=1)

    with open(os.path.join(args.out, "queue.json"), "w", encoding="utf-8") as f:
        json.dump(queue, f, ensure_ascii=False, indent=1)
    with open(os.path.join(args.out, "duplicates.json"), "w", encoding="utf-8") as f:
        json.dump(duplicates, f, ensure_ascii=False, indent=1)
    with open(os.path.join(args.out, "stories.json"), "w", encoding="utf-8") as f:
        json.dump(stories, f, ensure_ascii=False, indent=1)
    with open(os.path.join(args.out, "dropped.json"), "w", encoding="utf-8") as f:
        json.dump(dropped, f, ensure_ascii=False, indent=1)
    with open(seen_path, "w", encoding="utf-8") as f:
        json.dump(seen, f, ensure_ascii=False, indent=1)
    with open(state_path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)

    from collections import Counter
    cat_counts = {k: len(v) for k, v in by_cat.items()}
    drop_counts = dict(Counter(d["reason"] for d in dropped))
    summary = {"today_pkt": TODAY, "sources": len(report),
               "status": dict(Counter(r["status"] for r in report)),
               "queue_total": len(queue), "stories_total": len(stories),
               "duplicates_removed": len(duplicates),
               "categories": cat_counts, "dropped": drop_counts}
    with open(os.path.join(args.out, "report.json"), "w", encoding="utf-8") as f:
        json.dump({**summary, "per_source": report}, f, ensure_ascii=False, indent=1)

    print(f"Aaj (PKT): {TODAY} | Sources: {len(report)} | Stories: {len(stories)} "
          f"| Duplicates hataye: {len(duplicates)} | Dropped: {len(dropped)}")
    for k, v in cat_counts.items():
        print(f"  {k}: {v}")
    print("Dropped:", drop_counts)
    for r in report:
        if r["status"] == "error":
            print(f"  [error] {r['source']}: {r['note']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
