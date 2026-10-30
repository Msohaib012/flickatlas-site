#!/usr/bin/env python3
"""Offline tests for source-date and currency provenance in Box Office merges."""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "multisource_boxoffice", ROOT / "scripts/multisource_boxoffice.py")
merge = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(merge)


class ProvenanceSidecarTests(unittest.TestCase):
    def setUp(self):
        self.date = "2026-10-30"
        self.india = {("123", 1): {
            "sacnilk": (10.0, self.date),
            "filmibeat": (12.0, self.date),
        }}
        self.overseas = {("123", 1): {
            "overseas-ai": ({"overseas_inr_cr": 2.0}, self.date),
            "overseas-backfill": ({"overseas_inr_cr": 4.0}, self.date),
        }}

    def test_pairable_components_keep_explicit_scope_currency_and_source_date(self):
        finalized = merge.finalize(self.india, self.overseas, "sacnilk")
        row = finalized["123"][1]
        overseas = row["extras"]["overseas"]
        self.assertEqual(row["date"], self.date)
        self.assertFalse(row["date_disagreed"])
        self.assertEqual(row["collection_scope"], "india_net")
        self.assertEqual(row["collection_currency"], "USD")
        self.assertEqual(set(row["sources"]), {"filmibeat", "sacnilk"})
        self.assertEqual(overseas["scope"], "overseas_gross")
        self.assertEqual(overseas["currency"], "USD")
        self.assertEqual(overseas["date"], self.date)
        self.assertFalse(overseas["date_disagreed"])
        self.assertEqual(set(overseas["sources"]), {"overseas-ai", "overseas-backfill"})

        sidecar = merge.make_sidecar(finalized)
        self.assertEqual(sidecar["schema_version"], 2)
        stored = sidecar["figures"]["123"]["1"]
        self.assertEqual(stored["extras"]["overseas"]["date"], self.date)
        self.assertEqual(stored["collection_currency"], "USD")

    def test_mixed_source_dates_are_flagged_for_both_components(self):
        india = {("123", 1): {
            "sacnilk": (10.0, self.date),
            "filmibeat": (12.0, "2026-10-29"),
        }}
        overseas = {("123", 1): {
            "overseas-ai": ({"overseas_inr_cr": 2.0}, self.date),
            "overseas-backfill": ({"overseas_inr_cr": 4.0}, "2026-10-29"),
        }}
        row = merge.finalize(india, overseas, "sacnilk")["123"][1]
        self.assertTrue(row["date_disagreed"])
        self.assertTrue(row["extras"]["overseas"]["date_disagreed"])

    def test_inner_daywise_values_remain_india_and_overseas_separate(self):
        finalized = merge.finalize(self.india, self.overseas, "sacnilk")
        daywise = {"123": [{"day": "Day 1", "date": self.date,
                            "collection": finalized["123"][1]["collection_usd"],
                            "overseas": finalized["123"][1]["extras"]["overseas"]["value"]}]}
        merge.merge_into_baseline(daywise, finalized)
        self.assertEqual(len(daywise["123"]), 1)
        self.assertEqual(daywise["123"][0]["collection"], finalized["123"][1]["collection_usd"])
        self.assertEqual(daywise["123"][0]["overseas"], finalized["123"][1]["extras"]["overseas"]["value"])
        self.assertNotIn("worldwide", daywise["123"][0])
        self.assertNotIn("collection_currency", daywise["123"][0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
