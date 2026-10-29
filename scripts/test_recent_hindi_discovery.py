#!/usr/bin/env python3
"""Offline regression tests for Hindi recent-title discovery; no TMDB calls."""
from datetime import date, timedelta
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "title_seed", ROOT / "scripts" / "title-seed.py")
SEED = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SEED)


class FixedDate(date):
    @classmethod
    def today(cls):
        return cls(2026, 10, 29)


class RecentHindiDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.sources = {name: (media, path)
                        for name, media, path in SEED.SOURCES}
        self.cutoff = (FixedDate.today() - timedelta(days=SEED.FRESH_DAYS)).isoformat()
        self.today = FixedDate.today().isoformat()

    def test_hindi_recent_sources_are_date_bounded_and_paginated(self):
        self.assertEqual(self.sources["hindi_recent_movies"][0], "movie")
        movie_query = self.sources["hindi_recent_movies"][1]
        self.assertIn("with_original_language=hi", movie_query)
        self.assertIn("primary_release_date.gte={cutoff}", movie_query)
        self.assertIn("primary_release_date.lte={today}", movie_query)
        self.assertIn("sort_by=primary_release_date.desc", movie_query)

        self.assertEqual(self.sources["hindi_recent_tv"][0], "tv")
        tv_query = self.sources["hindi_recent_tv"][1]
        self.assertIn("with_original_language=hi", tv_query)
        self.assertIn("first_air_date.gte={cutoff}", tv_query)
        self.assertIn("first_air_date.lte={today}", tv_query)
        self.assertIn("sort_by=first_air_date.desc", tv_query)

        self.assertEqual(SEED.SOURCE_PAGES["hindi_recent_movies"], 5)
        self.assertEqual(SEED.SOURCE_PAGES["hindi_recent_tv"], 5)

    def test_fetch_lists_builds_expected_requests_without_network(self):
        calls = []

        def fake_tmdb_get(path, _key):
            calls.append(path)
            return {"results": [{"id": str(len(calls))}],
                    "total_results": 100}

        with patch.object(SEED, "date", FixedDate), \
                patch.object(SEED.time, "sleep"), \
                patch.object(SEED, "tmdb_get", side_effect=fake_tmdb_get):
            lists = SEED.fetch_lists("offline-test-key")

        expected = {
            "hindi_recent_movies": {
                "path": "/discover/movie",
                "date_gte": "primary_release_date.gte",
                "date_lte": "primary_release_date.lte",
                "sort": "primary_release_date.desc",
            },
            "hindi_recent_tv": {
                "path": "/discover/tv",
                "date_gte": "first_air_date.gte",
                "date_lte": "first_air_date.lte",
                "sort": "first_air_date.desc",
            },
        }
        for source, spec in expected.items():
            source_calls = [urlsplit(path) for path in calls
                            if urlsplit(path).path == spec["path"]
                            and "with_original_language=hi" in urlsplit(path).query
                            and spec["date_gte"] in urlsplit(path).query]
            self.assertEqual(len(source_calls), 5, source)
            pages = []
            for parsed in source_calls:
                query = parse_qs(parsed.query)
                self.assertEqual(query["with_original_language"], ["hi"])
                self.assertEqual(query[spec["date_gte"]], [self.cutoff])
                self.assertEqual(query[spec["date_lte"]], [self.today])
                self.assertEqual(query["sort_by"], [spec["sort"]])
                pages.extend(query["page"])
            self.assertEqual(sorted(pages), ["1", "2", "3", "4", "5"], source)
            self.assertEqual(len(lists[source]), 5, source)

    def test_hindi_recent_sources_keep_fresh_slots_under_global_cap(self):
        lists = {name: [] for name, _media, _path in SEED.SOURCES}
        next_id = 2000
        for name, media, _path in SEED.SOURCES:
            count = 4 if name in SEED.HINDI_RECENT_SOURCES else 1
            for _ in range(count):
                item = {"id": str(next_id), "poster_path": "/poster.jpg"}
                next_id += 1
                if media == "movie":
                    item["release_date"] = self.today
                else:
                    item["first_air_date"] = self.today
                lists[name].append(item)

        with patch.object(SEED, "date", FixedDate):
            picked = SEED.select(lists, {}, SEED.SAFETY_CEILING)

        counts = {name: sum(source == name for _tid, _media, source in picked)
                  for name, _media, _path in SEED.SOURCES}
        self.assertLessEqual(len(picked), SEED.SAFETY_CEILING)
        for name in SEED.HINDI_RECENT_SOURCES:
            self.assertGreaterEqual(counts[name], 2, name)
        # The bounded Hindi reserve does not displace the existing sources.
        for name, _media, _path in SEED.SOURCES:
            if name not in SEED.HINDI_RECENT_SOURCES:
                self.assertGreaterEqual(counts[name], 1, name)

    def test_hindi_recent_backfill_reserve_leaves_global_slots(self):
        lists = {name: [] for name, _media, _path in SEED.SOURCES}
        next_id = 3000
        for name, media, _path in SEED.SOURCES:
            if name not in SEED.HINDI_RECENT_SOURCES:
                continue
            for days_ago in (30, 31, 32):
                item = {"id": str(next_id), "poster_path": "/poster.jpg"}
                next_id += 1
                field = "release_date" if media == "movie" else "first_air_date"
                item[field] = (FixedDate.today() - timedelta(days=days_ago)).isoformat()
                lists[name].append(item)
        # These broader all-language sources are newer than the Hindi
        # candidates, so without a bounded reserve they would consume all
        # four daily backfill slots.
        for name, media in (("world_window", "movie"), ("new_tv", "tv")):
            for days_ago in (12, 13, 14, 15):
                item = {"id": str(next_id), "poster_path": "/poster.jpg"}
                next_id += 1
                field = "release_date" if media == "movie" else "first_air_date"
                item[field] = (FixedDate.today() - timedelta(days=days_ago)).isoformat()
                lists[name].append(item)

        with patch.object(SEED, "date", FixedDate):
            picked = SEED.select(lists, {}, SEED.SAFETY_CEILING)

        counts = {name: sum(source == name for _tid, _media, source in picked)
                  for name, _media, _path in SEED.SOURCES}
        self.assertEqual(len(picked), SEED.BACKFILL_PER_DAY)
        for name in SEED.HINDI_RECENT_SOURCES:
            self.assertEqual(counts[name], 1, name)
        self.assertEqual(counts["world_window"] + counts["new_tv"], 2)

    def test_existing_all_indian_language_sources_remain(self):
        # Keep the broad existing Hindi/popularity and all-language/region
        # discovery sources; the UI's shared classifier remains untouched.
        for name in ("bollywood", "india_window", "world_window",
                     "now_playing", "upcoming", "new_tv", "trending_tv",
                     "pk_dramas", "pk_movies"):
            self.assertIn(name, self.sources)
        self.assertIn("with_original_language=hi", self.sources["bollywood"][1])
        self.assertIn("region=IN", self.sources["india_window"][1])

    def test_recent_hindi_movie_selection_keeps_newest_first_and_90_day_gate(self):
        lists = {name: [] for name, _media, _path in SEED.SOURCES}
        lists["hindi_recent_movies"] = [
            {"id": "1001", "release_date": "2026-08-01", "poster_path": "/a"},
            {"id": "1002", "release_date": "2026-10-28", "poster_path": "/b"},
            {"id": "1003", "release_date": "2026-09-01", "poster_path": "/c"},
            {"id": "1004", "release_date": "2026-06-30", "poster_path": "/d"},
        ]
        with patch.object(SEED, "date", FixedDate):
            picked = SEED.select(lists, {}, SEED.SAFETY_CEILING)
        ids = [tid for tid, media, source in picked
               if media == "movie" and source == "hindi_recent_movies"]
        self.assertEqual(ids, ["1002", "1003", "1001"])
        self.assertNotIn("1004", ids)


if __name__ == "__main__":
    unittest.main()
