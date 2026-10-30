#!/usr/bin/env python3
"""Offline validation for the one-time OTT catalogue backlog
(scripts/ott-backfill-list.json) and the seeder lane that drains it
(scripts/title-seed.py load_backlog_ids). No TMDB calls.

The list is a PRE-DRAIN artifact: it asserts every entry is a
provider-carrying 2025/2026 movie that is not yet in FA_PUBLISHED.
Once the drain has run, the file is meant to be deleted, and this
test goes with it.
"""
import importlib.util
import json
import re
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIST_PATH = ROOT / "scripts" / "ott-backfill-list.json"
PUBLISHED_PATH = ROOT / "js" / "published-titles.js"
SPEC = importlib.util.spec_from_file_location(
    "title_seed", ROOT / "scripts" / "title-seed.py")
SEED = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SEED)

DATE_MIN, DATE_MAX = "2025-01-01", "2026-10-30"
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def read_published_ids():
    raw = PUBLISHED_PATH.read_text(encoding="utf-8")
    m = re.search(r"window\.FA_PUBLISHED\s*=\s*", raw)
    start = raw.index("{", m.end())
    depth = 0
    for j in range(start, len(raw)):
        if raw[j] == "{":
            depth += 1
        elif raw[j] == "}":
            depth -= 1
            if depth == 0:
                return set(json.loads(raw[start:j + 1]).keys())
    raise AssertionError("FA_PUBLISHED object not found")


class BackfillListTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = json.loads(LIST_PATH.read_text(encoding="utf-8"))
        cls.titles = cls.doc["titles"]
        cls.published_ids = read_published_ids()

    def test_every_entry_is_complete_and_in_range(self):
        for t in self.titles:
            with self.subTest(id=t.get("id")):
                self.assertIsInstance(t["id"], int)
                self.assertGreater(t["id"], 0)
                self.assertTrue(str(t["title"]).strip())
                self.assertRegex(t["release_date"], DATE_RE)
                self.assertGreaterEqual(t["release_date"], DATE_MIN)
                self.assertLessEqual(t["release_date"], DATE_MAX)
                self.assertIn(t["set"], ("bollywood", "world"))
                prov = t["providers"]
                self.assertIn(prov["region"], ("IN", "US", "PK"))
                self.assertTrue(prov["names"],
                                "providers must be non-empty (flatrate "
                                "verified at list build time)")
                self.assertIsInstance(t["popularity"], (int, float))
                self.assertIsInstance(t["vote_count"], int)
                if t["digital"] is not None:
                    self.assertRegex(t["digital"]["date"], DATE_RE)

    def test_ids_unique(self):
        # Uniqueness is a permanent invariant of the list. The original
        # "not yet published" assertion was a PRE-DRAIN invariant only:
        # the seeder lane publishes these ids batch by batch, so once
        # draining starts the overlap must grow — treating that as a
        # failure blocked every hourly run from 2026-10-30 19:50 UTC.
        # This file is deleted together with the list when the drain
        # completes, so no published-state assertion belongs here.
        ids = [str(t["id"]) for t in self.titles]
        self.assertEqual(len(ids), len(set(ids)), "duplicate ids")

    def test_counts_match_header(self):
        counts = self.doc["counts"]
        self.assertEqual(counts["total"], len(self.titles))
        self.assertEqual(counts["bollywood"],
                         sum(1 for t in self.titles
                             if t["set"] == "bollywood"))
        self.assertEqual(counts["world"],
                         sum(1 for t in self.titles
                             if t["set"] == "world"))


class BacklogLoaderTests(unittest.TestCase):
    def test_missing_file_is_empty(self):
        self.assertEqual(
            SEED.load_backlog_ids("/nonexistent/ott-backfill-list.json"),
            [])

    def test_corrupt_file_is_empty(self):
        with tempfile.NamedTemporaryFile(
                "w", suffix=".json", delete=False) as f:
            f.write("{not json")
            path = f.name
        self.assertEqual(SEED.load_backlog_ids(path), [])

    def test_valid_file_yields_ordered_ids_and_skips_junk(self):
        doc = {"titles": [{"id": 111, "title": "A"},
                          {"id": "222", "title": "B"},
                          {"id": None}, {"title": "no id"}]}
        with tempfile.NamedTemporaryFile(
                "w", suffix=".json", delete=False) as f:
            json.dump(doc, f)
            path = f.name
        self.assertEqual(SEED.load_backlog_ids(path), ["111", "222"])

    def test_real_list_loads_fully(self):
        ids = SEED.load_backlog_ids(str(LIST_PATH))
        self.assertEqual(len(ids), len(self.titles_ids()))

    def titles_ids(self):
        doc = json.loads(LIST_PATH.read_text(encoding="utf-8"))
        return [str(t["id"]) for t in doc["titles"]]


if __name__ == "__main__":
    unittest.main()
