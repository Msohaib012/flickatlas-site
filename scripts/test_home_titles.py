#!/usr/bin/env python3
"""Tests for the homepage titles subset (scripts/home_titles.py).

The homepage loads js/home-titles-data.js INSTEAD of the full
js/published-titles.js (slow-connection fix, 2026-11-07). The subset
must carry EVERY published title with exactly the fields the
homepage reads — a missing kept field breaks a rail silently, and a
dropped title disappears from every homepage pool.

Run: python3 scripts/test_home_titles.py
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import home_titles

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FULL_RECORD = {
    "id": 123, "type": "movie", "title": "Example",
    "poster_path": "/p.jpg", "backdrop_path": "/b.jpg",
    "vote_average": 7.5, "vote_count": 900, "overview": "A synopsis.",
    "industry": "bollywood", "original_language": "hi",
    "origin_country": ["IN"], "published_at": "2026-11-01T00:00:00Z",
    "date_kind": "release", "status": "Released",
    "production_countries": ["IN"], "spoken_languages": ["hi"],
    "providers": [{"name": "Netflix", "logo_path": "/n.png",
                   "region": "IN", "type": "flatrate"}],
    "release_date": "2026-10-30", "popularity": 42.5,
    # Detail-page-only payload that must NOT survive the projection:
    "trailer": "https://youtube.example/x", "genres": ["Drama"],
    "budget": 1000, "revenue": 2000, "tagline": "t",
    "certification": "UA", "categories": ["x"], "source": "tmdb",
    "runtime": 120, "seasons": [{"season_number": 1}],
}


class TestProjection(unittest.TestCase):
    def test_keeps_every_kept_field_drops_detail_payload(self):
        out = home_titles.build_home_titles({"123": dict(FULL_RECORD)})
        rec = out["123"]
        for field in home_titles.HOME_FIELDS:
            if field in FULL_RECORD:
                self.assertEqual(rec[field], FULL_RECORD[field], field)
        for dropped in ("trailer", "genres", "budget", "revenue",
                        "tagline", "certification", "categories",
                        "source", "runtime", "seasons"):
            self.assertNotIn(dropped, rec)

    def test_absent_fields_stay_absent(self):
        out = home_titles.build_home_titles(
            {"9": {"id": 9, "type": "tv", "title": "Sparse"}})
        self.assertEqual(out["9"],
                         {"id": 9, "type": "tv", "title": "Sparse"})

    def test_never_subsets_the_catalogue(self):
        src = {str(i): dict(FULL_RECORD, id=i) for i in range(50)}
        self.assertEqual(len(home_titles.build_home_titles(src)), 50)

    def test_non_dict_records_skipped(self):
        out = home_titles.build_home_titles(
            {"1": dict(FULL_RECORD), "2": None})
        self.assertEqual(list(out), ["1"])


class TestAgainstLiveCatalogue(unittest.TestCase):
    """The committed subset must mirror the committed full file."""

    def test_subset_matches_full_file(self):
        full_path = os.path.join(ROOT, "js", "published-titles.js")
        slim_path = os.path.join(ROOT, "js", "home-titles-data.js")
        if not (os.path.exists(full_path) and os.path.exists(slim_path)):
            self.skipTest("catalogue files not present")
        full = home_titles.read_js_map(full_path, "FA_PUBLISHED")
        slim = home_titles.read_js_map(slim_path, "FA_PUBLISHED")
        self.assertEqual(set(full), set(slim))
        for tid, rec in slim.items():
            for key, value in rec.items():
                self.assertIn(key, home_titles.HOME_FIELDS)
                self.assertEqual(value, full[tid][key], f"{tid}.{key}")


class TestWrite(unittest.TestCase):
    def test_write_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.mkdir(os.path.join(tmp, "js"))
            src = {"1": dict(FULL_RECORD)}
            self.assertTrue(home_titles.write_home_titles(tmp, src))
            self.assertFalse(home_titles.write_home_titles(tmp, src))
            written = home_titles.read_js_map(
                os.path.join(tmp, "js", "home-titles-data.js"),
                "FA_PUBLISHED")
            self.assertEqual(written["1"]["title"], "Example")
            self.assertNotIn("trailer", written["1"])


if __name__ == "__main__":
    unittest.main()
