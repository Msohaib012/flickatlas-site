#!/usr/bin/env python3
"""Offline regressions for the theatrical Day 30 SEO boundary."""
from datetime import date, timedelta
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import scripts.seo_assets as seo  # noqa: E402

rows = [
    {
        "day": f"Day {n}",
        "date": (date(2026, 1, 1) + timedelta(days=n - 1)).isoformat(),
        "collection": n,
        "overseas": n * 2,
    }
    for n in range(1, 36)
]

valid = seo._valid_day_rows(rows)
assert [n for n, _ in valid] == list(range(1, 31)), "only Days 1–30 may have individual URLs"

seo.PUBLISHED = {
    "123": {
        "id": "123", "title": "Boundary Fixture", "type": "movie",
        "year": 2026, "release_date": "2026-01-01", "industry": "bollywood",
    }
}
seo.ARTICLES = {}
seo.DAYWISE = {"123": rows}
xml, url_count = seo.build_sitemap({"max": "2026-02-04"})
root = ET.fromstring(xml)
locs = [node.text for node in root.findall("{http://www.sitemaps.org/schemas/sitemap/0.9}url/{http://www.sitemaps.org/schemas/sitemap/0.9}loc")]
day_urls = [loc for loc in locs if "/box-office-day?title=123&day=" in loc]
days = sorted(int(re.search(r"[?&]day=(\d+)$", loc).group(1)) for loc in day_urls)
assert days == list(range(1, 31)), f"sitemap day URLs must be 1–30 only, got {days}"
assert url_count == len(locs)
assert len(seo.DAYWISE["123"]) == 35, "post-30 source rows must remain available for aggregate totals"

meta = seo.daywise_meta(seo.PUBLISHED["123"])
assert meta["days"] == 35
assert meta["total_in"] == sum(range(1, 36)) == 630
assert meta["total_ov"] == sum(n * 2 for n in range(1, 36)) == 1260
assert "Day 30" in meta["d"] and "later days affect totals only" in meta["d"]

news = seo.news_meta({
    "id": "fixture-news", "headline": "Fixture headline",
    "keywords": ["Stored keyword", "stored keyword", "Another term"],
})
assert news["ld"]["keywords"] == "Stored keyword, Another term"

page = (ROOT / "js/page-boxoffice-day.js").read_text(encoding="utf-8")
worker = (ROOT / "scripts/worker.mjs").read_text(encoding="utf-8")
assert "if (day > 30)" in page and "UI.dailyCollectionCard(clean, String(titleId))" in page
assert "UI.setSEO" in page and "noindex: true" in page
assert "if (selectedDay > 30)" in worker and 'm2.robots = "noindex,follow"' in worker
assert "else if (requestedDay)" in worker and '" box office Day " + requestedDay' in worker
assert "Box Office Totals After Day 30" in worker
print("Day 30 policy: sitemap excludes later days; totals retain all rows; client/Worker apply totals-only/noindex; day descriptions are unique; news keywords enter JSON-LD")
