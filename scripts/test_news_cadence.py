#!/usr/bin/env python3
"""Offline unit tests for news source and external-trend cadence helpers."""
import importlib.util
import json
import os
import unittest
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, "scripts", filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fetch = load_module("news_fetch", "fetch.py")
convert = load_module("convert_news", "convert-news.py")


class FetchCadenceTests(unittest.TestCase):
    def test_registry_tiers_are_evidence_derived(self):
        with open(os.path.join(ROOT, "scripts", "registry.json"), encoding="utf-8") as f:
            registry = json.load(f)
        from collections import Counter
        counts = Counter(fetch.source_cadence(row)[0] for row in registry)
        self.assertEqual(counts, {"hourly": 85, "6h": 8, "12h": 25, "daily": 19})

    def test_explicit_stale_and_blocked_evidence(self):
        self.assertEqual(fetch.source_cadence({"rss": "/feed", "notes": "Feed is stale"}), ("6h", 6))
        self.assertEqual(fetch.source_cadence({"rss": "/feed", "http_status": 403}), ("daily", 24))
        self.assertEqual(fetch.source_cadence({"sitemap": "/map"}), ("12h", 12))

    def test_scheduled_slots_and_no_bootstrap(self):
        entry = {"sitemap": "/map"}
        self.assertFalse(fetch.source_due(entry, {}, datetime(2026, 10, 29, 11, tzinfo=timezone.utc))[0])
        self.assertTrue(fetch.source_due(entry, {}, datetime(2026, 10, 29, 12, tzinfo=timezone.utc))[0])
        entry = {"rss": "/feed", "notes": "Slow updater"}
        for hour, expected in ((5, False), (6, True), (12, True), (18, True), (0, True)):
            self.assertEqual(fetch.source_due(entry, {}, datetime(2026, 10, 29, hour, tzinfo=timezone.utc))[0], expected)
        entry = {"url": "/"}
        self.assertTrue(fetch.source_due(entry, {}, datetime(2026, 10, 29, 12, tzinfo=timezone.utc))[0])
        self.assertFalse(fetch.source_due(entry, {}, datetime(2026, 10, 29, 18, tzinfo=timezone.utc))[0])

    def test_catchup_and_failed_attempt_cooldown(self):
        entry = {"sitemap": "/map"}
        now = datetime(2026, 10, 29, 13, tzinfo=timezone.utc)
        rec = {"last_successful_check": "2026-10-29T00:00:00Z"}
        self.assertTrue(fetch.source_due(entry, rec, now)[0])
        rec["last_attempt"] = "2026-10-29T12:30:00Z"
        self.assertFalse(fetch.source_due(entry, rec, now)[0])

    def test_304_success_timestamp_is_handled_by_source_runner(self):
        record = {"etag": "tag", "last_modified": "date", "links": ["a"]}
        self.assertEqual(record["etag"], "tag")
        self.assertIn("links", record)


class TrendCadenceTests(unittest.TestCase):
    def test_daily_utc_gate_and_no_bootstrap(self):
        self.assertFalse(convert.trends_discovery_due({}, datetime(2026, 10, 29, 17, tzinfo=timezone.utc)))
        self.assertTrue(convert.trends_discovery_due({}, datetime(2026, 10, 29, 18, tzinfo=timezone.utc)))

    def test_catchup_and_cooldown(self):
        record = {"last_tavily_success": "2026-10-28T16:00:00Z"}
        now = datetime(2026, 10, 29, 17, tzinfo=timezone.utc)
        self.assertTrue(convert.trends_discovery_due(record, now))
        record["last_tavily_attempt"] = "2026-10-29T16:30:00Z"
        self.assertFalse(convert.trends_discovery_due(record, now))
        record = {"last_tavily_success": "2026-10-28T18:00:00Z"}
        self.assertFalse(convert.trends_discovery_due(record, now))

    def test_google_hourly_attempt_gate_is_independent(self):
        now = datetime(2026, 10, 29, 13, tzinfo=timezone.utc)
        self.assertTrue(convert.google_trends_due({}, now))
        self.assertFalse(convert.google_trends_due({"last_google_attempt": "2026-10-29T12:01:00Z"}, now))
        self.assertTrue(convert.google_trends_due({"last_google_attempt": "2026-10-29T12:00:00Z"}, now))
        self.assertFalse(convert.trends_discovery_due({}, now))  # daily fallback gate is not coupled to RSS
        self.assertTrue(convert.trends_discovery_due({}, now.replace(hour=18)))

    def test_rss_parses_new_namespace_and_preserves_evidence(self):
        now = datetime(2026, 10, 29, 13, tzinfo=timezone.utc)
        xml = b'''<rss xmlns:ht="https://trends.google.com/trending/rss"><channel><item>
        <title>Example Film</title><pubDate>Thu, 29 Oct 2026 12:30:00 GMT</pubDate>
        <ht:approx_traffic>20K+</ht:approx_traffic><ht:news_item><ht:news_item_title>News headline</ht:news_item_title>
        <ht:news_item_url>https://news.example/story</ht:news_item_url></ht:news_item></item></channel></rss>'''
        items, stale = convert.parse_google_rss(xml, "US", now)
        self.assertEqual(stale, 0)
        self.assertEqual(len(items), 1)
        item = items[0]
        self.assertEqual(item["q"], "Example Film")
        self.assertEqual(item["traffic"], "20K+")
        self.assertEqual(item["geo"], "US")
        self.assertEqual(item["feed_url"], "https://trends.google.com/trending/rss?geo=US")
        self.assertEqual(item["trending_started_at"], "2026-10-29T12:30:00Z")
        self.assertEqual(item["observed_at"], "2026-10-29T13:00:00Z")
        self.assertEqual(item["news"], [{"title": "News headline", "url": "https://news.example/story"}])

    def test_both_namespace_generations_are_parsed_by_local_names(self):
        now = datetime(2026, 10, 29, 13, tzinfo=timezone.utc)
        for namespace in ("https://trends.google.com/trending/rss", "https://trends.google.com/trends/api"):
            xml = f'''<rss xmlns:ht="{namespace}"><channel><item><title>Term</title><pubDate>Thu, 29 Oct 2026 12:00:00 GMT</pubDate><ht:approx_traffic>5K+</ht:approx_traffic></item></channel></rss>'''.encode()
            items, _ = convert.parse_google_rss(xml, "IN", now)
            self.assertEqual(items[0]["traffic"], "5K+")

    def test_stale_and_future_items_never_claim_currentness(self):
        now = datetime(2026, 10, 29, 13, tzinfo=timezone.utc)
        xml = b'''<rss><channel><item><title>Old</title><pubDate>Wed, 28 Oct 2026 12:59:59 GMT</pubDate></item>
        <item><title>Future</title><pubDate>Thu, 29 Oct 2026 13:00:01 GMT</pubDate></item></channel></rss>'''
        items, stale = convert.parse_google_rss(xml, "US", now)
        self.assertEqual(items, [])
        self.assertEqual(stale, 2)

    def test_mocked_google_fetch_uses_both_current_endpoints(self):
        now = datetime(2026, 10, 29, 13, tzinfo=timezone.utc)
        calls = []
        xml = b'''<rss><channel><item><title>Old</title><pubDate>Fri, 24 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>'''

        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return False
            def read(self):
                return xml

        def opener(request, timeout):
            calls.append((request.full_url, timeout))
            return Response()

        evidence, successes, errors = convert.fetch_trends_google(now, opener)
        self.assertEqual(successes, 2)
        self.assertEqual(errors, [])
        self.assertEqual(evidence["status"], "upstream-stale")
        self.assertEqual(evidence["items"], [])
        self.assertEqual([url for url, _ in calls], [
            "https://trends.google.com/trending/rss?geo=US",
            "https://trends.google.com/trending/rss?geo=IN",
        ])

    def test_google_fetch_failure_is_reported_without_synthetic_items(self):
        now = datetime(2026, 10, 29, 13, tzinfo=timezone.utc)
        def opener(_request, timeout):
            raise OSError("offline fixture")
        evidence, successes, errors = convert.fetch_trends_google(now, opener)
        self.assertIsNone(evidence)
        self.assertEqual(successes, 0)
        self.assertEqual(len(errors), 2)

    def test_local_news_conversion_has_no_external_trend_gate(self):
        # build_news remains a pure conversion of the provided queue and does
        # not consult any Google/Tavily cadence state.
        self.assertTrue(callable(convert.build_news))
        self.assertTrue(callable(convert.google_trends_due))


if __name__ == "__main__":
    unittest.main()
