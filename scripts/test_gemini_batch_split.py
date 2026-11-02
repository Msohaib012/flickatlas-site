#!/usr/bin/env python3
"""Offline unit tests for the gemini_batch industry split.

Owner order 2026-11-02: news pace 4 posts per hourly run, split
2 Indian + 2 World. Covers load_source_buckets() (registry scopes ->
industry bucket) and split_attempt_order() (the pure reordering that
makes draft attempts alternate Indian / World). No network, no Gemini
keys, no queue files needed.
"""
import importlib.util
import json
import os
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(ROOT, "scripts", filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


batch = load_module("gemini_batch", "gemini_batch.py")


def _buckets_for(rows):
    fd, path = tempfile.mkstemp(suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(rows, f)
        return batch.load_source_buckets(path)
    finally:
        os.unlink(path)


def _item(source, title):
    return {"source": source, "title": title,
            "url": "https://example.invalid/" + title}


class BucketMappingTests(unittest.TestCase):
    def test_scope_families(self):
        rows = [
            {"name": "InA", "scopes": ["Bollywood / India"]},
            {"name": "InB", "scopes": ["Celebrity Daily — India"]},
            {"name": "InC", "scopes": ["Viral — India"]},
            {"name": "WoA", "scopes": ["International (US / Hollywood)"]},
            {"name": "WoB", "scopes": ["UK"]},
            {"name": "WoC", "scopes": ["South Korea (English)"]},
            {"name": "WoD", "scopes": ["Celebrity Daily — US / Global"]},
            {"name": "WoE", "scopes": ["Music"]},
            {"name": "WoF", "scopes": ["Tech"]},
            {"name": "PkA", "scopes": ["Pakistan (Lollywood / TV dramas)"]},
            {"name": "PkB", "scopes": ["YouTube Dramas"]},
            {"name": "PkC", "scopes": ["Celebrity Daily — Pakistan"]},
        ]
        b = _buckets_for(rows)
        for name in ("InA", "InB", "InC"):
            self.assertEqual(b[name], "indian", name)
        for name in ("WoA", "WoB", "WoC", "WoD", "WoE", "WoF"):
            self.assertEqual(b[name], "world", name)
        for name in ("PkA", "PkB", "PkC"):
            self.assertEqual(b[name], "pakistan", name)

    def test_india_wins_over_world_when_both_present(self):
        b = _buckets_for([{"name": "Mix", "scopes": [
            "International (US / Hollywood)", "Bollywood / India"]}])
        self.assertEqual(b["Mix"], "indian")

    def test_unreadable_registry_returns_empty(self):
        self.assertEqual(batch.load_source_buckets(
            os.path.join(ROOT, "scripts", "no-such-registry.json")), {})

    def test_real_registry_buckets(self):
        # The repo's real registry: every source gets a bucket, and the
        # three taxonomy families are all represented.
        buckets = batch.load_source_buckets()
        self.assertTrue(buckets)
        self.assertEqual(set(buckets.values()),
                         {"indian", "world", "pakistan"})


class SplitOrderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.buckets = batch.load_source_buckets()
        by_bucket = {}
        for name, b in cls.buckets.items():
            by_bucket.setdefault(b, []).append(name)
        cls.names = by_bucket

    def _queue(self, n_indian, n_world, n_pakistan):
        def take(bucket, n, tag):
            pool = self.names[bucket]
            return [_item(pool[i % len(pool)], f"{tag}{i}")
                    for i in range(n)]
        # Incoming order is deliberately NOT split-friendly: all world,
        # then all indian, then pakistan — the split must fix it.
        return (take("world", n_world, "w")
                + take("indian", n_indian, "i")
                + take("pakistan", n_pakistan, "p"))

    def _bucket_of(self, item):
        return self.buckets.get(item["source"], "other")

    def test_first_four_attempts_are_two_plus_two(self):
        queue = self._queue(5, 5, 2)
        order = batch.split_attempt_order(queue, self._bucket_of,
                                          head=8)
        first4 = [self._bucket_of(it) for it in order[:4]]
        self.assertEqual(first4, ["indian", "world", "indian", "world"])
        self.assertEqual(first4.count("indian"), 2)
        self.assertEqual(first4.count("world"), 2)

    def test_order_is_a_permutation_preserving_bucket_order(self):
        queue = self._queue(5, 5, 2)
        order = batch.split_attempt_order(queue, self._bucket_of,
                                          head=8)
        self.assertEqual(sorted(it["title"] for it in order),
                         sorted(it["title"] for it in queue))
        for bucket in ("indian", "world", "pakistan"):
            before = [it["title"] for it in queue
                      if self._bucket_of(it) == bucket]
            after = [it["title"] for it in order
                     if self._bucket_of(it) == bucket]
            self.assertEqual(after, before, bucket)

    def test_rest_comes_after_head_before_interleave_tail(self):
        queue = self._queue(6, 6, 2)
        order = batch.split_attempt_order(queue, self._bucket_of,
                                          head=8)
        buckets = [self._bucket_of(it) for it in order]
        # Head: 8 alternating attempts; then the 2 pakistan items;
        # then the remaining interleaved indian/world tail.
        self.assertEqual(buckets[:8],
                         ["indian", "world"] * 4)
        self.assertEqual(buckets[8:10], ["pakistan", "pakistan"])
        self.assertEqual(buckets[10:], ["indian", "world"] * 2)

    def test_dry_side_falls_back_to_other_side(self):
        queue = self._queue(1, 3, 0)
        order = batch.split_attempt_order(queue, self._bucket_of,
                                          head=8)
        self.assertEqual([self._bucket_of(it) for it in order],
                         ["indian", "world", "world", "world"])

    def test_unknown_source_is_rest_not_blocking(self):
        queue = self._queue(2, 2, 0) + [_item("No Such Source", "u0")]
        order = batch.split_attempt_order(queue, self._bucket_of,
                                          head=8)
        self.assertEqual([self._bucket_of(it) for it in order[:4]],
                         ["indian", "world", "indian", "world"])
        self.assertEqual(order[-1]["title"], "u0")


if __name__ == "__main__":
    unittest.main()
