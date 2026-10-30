#!/usr/bin/env python3
"""Offline tests for the isolated worldwide-only homepage Box Office flow."""
from __future__ import annotations

import datetime as dt
import importlib.util
import os
import re
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("home_boxoffice_worldwide", ROOT / "scripts/home_boxoffice_worldwide.py")
bo = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(bo)


class WorldwideEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.item = {"id": "123", "title": "Fixture Film", "original_title": "Fixture Film",
                     "release_date": "2026-10-20", "industry": "bollywood"}
        self.result = {
            "title": "Fixture Film worldwide box office",
            "content": "Fixture Film's worldwide box-office gross for today, October 31, 2026, was $12 million.",
            "published_date": "2026-10-31", "url": "https://official.example/box-office",
        }

    def test_money_parser_preserves_currency_and_units(self):
        self.assertEqual(bo.parse_amounts("Worldwide gross $12.5 million")[0]["amount"], 12_500_000)
        self.assertEqual(bo.parse_amounts("Worldwide gross ₹25 crore")[0]["amount"], 250_000_000)
        self.assertEqual(bo.parse_amounts("Worldwide total 8.2 million EUR")[0]["currency"], "EUR")
        self.assertEqual(bo.parse_amounts("Worldwide amount 8.2 mysterycoins"), [])

    def test_each_window_gets_its_own_targeted_query(self):
        today = "2026-10-31"
        total = bo.make_query(self.item, "cumulative_total", today)
        self.assertIn("cumulative worldwide total", total)
        self.assertIn("as of 2026-10-31", total)
        self.assertNotIn("last 2 days", total)
        self.assertNotIn("opening week", total)
        week = bo.make_query(self.item, "last_7_days", today)
        self.assertIn("first 7 days / opening week (2026-10-25 through 2026-10-31)", week)
        self.assertNotIn("cumulative", week)
        two = bo.make_query(self.item, "last_2_days", today)
        self.assertIn("last 2 days (2026-10-30 through 2026-10-31)", two)
        self.assertNotIn("cumulative", two)
        for query in (total, week, two):
            self.assertIn('"Fixture Film" 2026', query)
            self.assertNotIn("gross for today", query)
            self.assertNotIn("india net", query.lower())
            self.assertNotIn("overseas-only", query.lower())
        with self.assertRaises(ValueError):
            bo.make_query(self.item, "today", today)

    def test_candidate_requires_title_worldwide_scope_and_exact_window(self):
        candidate = bo.make_candidate(self.item, "today", self.result, "2026-10-31")
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate["amount"], 12_000_000)
        self.assertEqual(candidate["currency"], "USD")
        bad = {**self.result, "content": "Fixture Film India Net box-office gross for today, October 31, 2026, was $12 million."}
        self.assertIsNone(bo.make_candidate(self.item, "today", bad, "2026-10-31"))
        unrelated = {**self.result, "title": "Different Film worldwide box office", "content": "Different Film's worldwide gross for today, October 31, 2026, was $12 million."}
        self.assertIsNone(bo.make_candidate(self.item, "today", unrelated, "2026-10-31"))
        wrong_period = {**self.result, "content": "Fixture Film's worldwide box-office gross on October 30, 2026, was $12 million."}
        self.assertIsNone(bo.make_candidate(self.item, "today", wrong_period, "2026-10-31"))

    def test_last_7_day_evidence_must_match_the_requested_period(self):
        today = "2026-10-31"
        exact = {"title": "Fixture Film worldwide box office",
            "content": "For the 7 days from 2026-10-25 through 2026-10-31, Fixture Film's worldwide theatrical gross was $12 million.",
            "published_date": today, "url": self.result["url"]}
        candidate = bo.make_candidate(self.item, "last_7_days", exact, today)
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate["period_start"], "2026-10-25")
        self.assertEqual(candidate["period_end"], today)
        prompt = bo.build_review_prompt(today, [candidate])
        self.assertIn("2026-10-25", prompt)
        self.assertIn("2026-10-31", prompt)
        quote = exact["content"]
        accepted = bo.accepted_metric(candidate, {"accepted": True, "quote": quote},
                                       today, "2026-10-31T00:00:00Z")
        self.assertIsNotNone(accepted)
        self.assertEqual(accepted["period_start"], "2026-10-25")

        vague = {**exact, "content": "Fixture Film's worldwide 7-day gross was $12 million; the page was updated October 31, 2026."}
        self.assertIsNone(bo.make_candidate(self.item, "last_7_days", vague, today),
            "a current article date alone cannot prove that its 7-day figure covers this exact window")
        anchored = {**exact, "content": "Fixture Film's worldwide gross for the last 7 days ending October 31, 2026 was $12 million."}
        self.assertIsNotNone(bo.make_candidate(self.item, "last_7_days", anchored, today),
            "a relative 7-day claim is valid only when its endpoint is explicit")

    def test_last_2_day_evidence_must_match_the_requested_period(self):
        today = "2026-10-31"
        self.assertEqual(bo.period_for("last_2_days", today), ("2026-10-30", "2026-10-31"))
        exact = {"title": "Fixture Film worldwide box office",
            "content": "For the last 2 days from 2026-10-30 through 2026-10-31, Fixture Film's worldwide theatrical gross was $22 million.",
            "published_date": today, "url": self.result["url"]}
        candidate = bo.make_candidate(self.item, "last_2_days", exact, today)
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate["period_start"], "2026-10-30")
        self.assertEqual(candidate["period_end"], today)
        prompt = bo.build_review_prompt(today, [candidate])
        self.assertIn("last_2_days", prompt)
        self.assertIn("two-day period", prompt)
        self.assertIn("2026-10-30", prompt)
        accepted = bo.accepted_metric(candidate, {"accepted": True, "quote": exact["content"]},
                                      today, "2026-10-31T00:00:00Z")
        self.assertIsNotNone(accepted)
        self.assertEqual(accepted["window"], "last_2_days")
        self.assertEqual(accepted["period_start"], "2026-10-30")
        self.assertEqual(accepted["as_of"], today)

        vague = {**exact, "content": "Fixture Film's worldwide gross for the last 2 days was $22 million; the page was updated October 31, 2026."}
        self.assertIsNone(bo.make_candidate(self.item, "last_2_days", vague, today),
            "a current article date alone cannot prove that its 2-day figure covers this exact window")
        anchored = {**exact, "content": "Fixture Film's worldwide gross for the last 2 days ending October 31, 2026 was $22 million."}
        self.assertIsNotNone(bo.make_candidate(self.item, "last_2_days", anchored, today),
            "a relative 2-day claim is valid only when its endpoint is explicit")
        wrong_period = {**exact, "content": "For the last 2 days from 2026-10-29 through 2026-10-30, Fixture Film's worldwide theatrical gross was $22 million."}
        self.assertIsNone(bo.make_candidate(self.item, "last_2_days", wrong_period, today),
            "a 2-day figure for a different pair of dates is not evidence for this window")

    def test_cumulative_total_requires_total_wording_and_asof_evidence(self):
        today = "2026-10-31"
        dated = {"title": "Fixture Film worldwide box office",
            "content": "As of October 31, 2026, Fixture Film's cumulative worldwide total was $12 million.",
            "published_date": today, "url": self.result["url"]}
        candidate = bo.make_candidate(self.item, "cumulative_total", dated, today)
        self.assertIsNotNone(candidate)
        accepted = bo.accepted_metric(candidate, {"accepted": True, "quote": dated["content"]},
                                       today, "2026-10-31T00:00:00Z")
        self.assertIsNotNone(accepted)
        self.assertEqual(accepted["as_of"], today)
        vague = {**dated, "content": "Fixture Film's worldwide gross was $12 million."}
        self.assertIsNone(bo.make_candidate(self.item, "cumulative_total", vague, today))
        undated = {**dated, "content": "Fixture Film's worldwide total was $12 million."}
        self.assertIsNone(bo.make_candidate(self.item, "cumulative_total", undated, today),
            "the article publication date alone cannot establish when a cumulative total was measured")

    def test_range_parser_accepts_only_explicit_same_currency_ranges(self):
        stated = bo.parse_ranges("₹0.65 crore to ₹0.70 crore")
        self.assertEqual([(r["amount"], r["amount_high"], r["currency"]) for r in stated],
                         [(6_500_000, 7_000_000, "INR")])
        bare = bo.parse_ranges("₹0.65–0.70 crore")
        self.assertEqual([(r["amount"], r["amount_high"]) for r in bare], [(6_500_000, 7_000_000)],
                         "a shared trailing unit applies to both bounds")
        between = bo.parse_ranges("between $12 and $15 million")
        self.assertEqual([(r["amount"], r["amount_high"]) for r in between], [(12_000_000, 15_000_000)])
        self.assertEqual(bo.parse_ranges("grossed $12 million in India and $15 million overseas"), [],
                         "two separate scope figures are not a range")
        self.assertEqual(bo.parse_ranges("₹0.65 crore in India and ₹0.70 crore overseas"), [])
        self.assertEqual(bo.parse_ranges("₹0.70 crore to ₹0.65 crore"), [], "an inverted range is not evidence")
        events = bo.amount_events("worldwide total ₹0.65–0.70 crore")
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0]["is_range"], "a stated range consumes its bounds; the low bound alone is not an event")

    def bh_item_result(self):
        item = {"id": "1806232", "title": "Tum Mere Ho", "original_title": "Tum Mere Ho",
                "release_date": "2026-10-23", "industry": "bollywood"}
        result = {"title": "Tum Mere Ho box office collection",
            "content": ("Tum Mere Ho (2026), starring Gurmeet Choudhary and Ishita Chauhan, collected "
                        "approximately ₹0.54 crore nett in India in its first week. As of October 30, 2026, "
                        "the worldwide total of Tum Mere Ho stands at ₹0.65 crore to ₹0.70 crore so far, "
                        "according to trade estimates."),
            "published_date": "2026-10-30",
            "url": "https://www.bollywoodhungama.com/news/box-office-specials/tum-mere-ho-box-office-collection/"}
        return item, result

    def test_bh_style_worldwide_range_becomes_a_range_candidate(self):
        item, result = self.bh_item_result()
        candidate = bo.make_candidate(item, "cumulative_total", result, "2026-10-30")
        self.assertIsNotNone(candidate, "the BH worldwide range must survive candidate extraction")
        self.assertEqual(candidate["amount"], 6_500_000)
        self.assertEqual(candidate["amount_high"], 7_000_000)
        self.assertEqual(candidate["currency"], "INR")
        prompt = bo.build_review_prompt("2026-10-30", [candidate])
        self.assertIn('"amount_high": 7000000.0', prompt)
        quote = ("As of October 30, 2026, the worldwide total of Tum Mere Ho stands at "
                 "₹0.65 crore to ₹0.70 crore so far")
        accepted = bo.accepted_metric(candidate, {"accepted": True, "quote": quote},
                                      "2026-10-30", "2026-10-30T09:00:00Z")
        self.assertIsNotNone(accepted)
        self.assertEqual(accepted["amount"], 6_500_000)
        self.assertEqual(accepted["amount_high"], 7_000_000,
                         "the accepted metric keeps the range; it is never collapsed or averaged")
        self.assertEqual(accepted["source_name"], "bollywoodhungama.com")
        low_only = bo.accepted_metric(candidate, {"accepted": True, "quote": "Tum Mere Ho worldwide total ₹0.65 crore"},
                                      "2026-10-30", "2026-10-30T09:00:00Z")
        self.assertIsNone(low_only, "quoting only the lower bound cannot verify a range candidate")
        bare = {**result, "content": ("As of October 30, 2026, Tum Mere Ho has reached a worldwide "
                                      "total of ₹0.65–0.70 crore so far at the global box office.")}
        bare_candidate = bo.make_candidate(item, "cumulative_total", bare, "2026-10-30")
        self.assertIsNotNone(bare_candidate)
        self.assertEqual((bare_candidate["amount"], bare_candidate["amount_high"]), (6_500_000, 7_000_000))

    def test_range_without_worldwide_scope_is_rejected(self):
        item, result = self.bh_item_result()
        india_only = {**result, "content": ("As of October 30, 2026, the India nett total of Tum Mere Ho "
                                            "stands at ₹0.65 crore to ₹0.70 crore so far.")}
        self.assertIsNone(bo.make_candidate(item, "cumulative_total", india_only, "2026-10-30"))

    def test_same_title_older_year_film_never_produces_a_candidate(self):
        item, _ = self.bh_item_result()
        classic = {"title": "Tum Mere Ho (1990) box office",
            "content": ("Tum Mere Ho (1990), the Aamir Khan and Juhi Chawla film, earned a worldwide "
                        "total of ₹3.80 crore in its full run."),
            "published_date": "2026-10-30", "url": "https://en.wikipedia.org/wiki/Tum_Mere_Ho"}
        for window in bo.WINDOWS:
            self.assertIsNone(bo.make_candidate(item, window, classic, "2026-10-30"),
                              "the 1990 film's figures must never attach to the 2026 title")
        embedded = {"title": "Tum Mere Ho box office history",
            "content": ("As of October 30, 2026, Tum Mere Ho (1990) holds a worldwide total of "
                        "₹3.80 crore, a figure the 2026 remake could not approach."),
            "published_date": "2026-10-30", "url": "https://example.com/history"}
        self.assertIsNone(bo.make_candidate(item, "cumulative_total", embedded, "2026-10-30"),
                          "a sentence pinning the title to 1990 is rejected even inside a mixed article")
        self.assertTrue(bo.title_year_conflict("Tum Mere Ho", "2026", "Tum Mere Ho (1990)"))
        self.assertFalse(bo.title_year_conflict("Tum Mere Ho", "2026", "Tum Mere Ho (2026)"))
        self.assertFalse(bo.title_year_conflict("Tum Mere Ho", "2026", "Tum Mere Ho box office"))

    def test_search_budget_caps_and_prioritises_cumulative(self):
        now = dt.datetime(2026, 10, 30, 9, 0, tzinfo=dt.timezone.utc)
        candidates = [{"id": str(1000 + n), "title": f"Film {n}", "industry": "bollywood",
                       "windows_to_refresh": ["last_2_days", "last_7_days", "cumulative_total"]}
                      for n in range(16)]
        manifest = {"selections": {"bollywood": [c["id"] for c in candidates], "world": []},
                    "candidates": candidates}
        queries, writes = [], []
        def fake_tavily(query):
            queries.append(query)
            return []
        previous = {"schema_version": 1, "reports": {}, "selections": {"bollywood": [], "world": []}}
        with patch.dict(os.environ, {"TAVILY_API_KEY": "test-key", "CLOUDFLARE_API_TOKEN": "test-token"}), \
             patch.object(bo, "run_selector", return_value=manifest):
            summary = bo.run_refresh(tavily_fn=fake_tavily, gemini_fn=lambda prompt: {"reviews": []},
                kv_read=lambda: previous, kv_write=writes.append, now=now)
        self.assertEqual(len(queries), bo.SEARCH_BUDGET)
        self.assertEqual(summary["query_count"], bo.SEARCH_BUDGET)
        self.assertEqual(summary["skipped_searches"], 48 - bo.SEARCH_BUDGET,
                         "every job over the per-run budget is deferred, none is dropped silently")
        self.assertTrue(all("cumulative worldwide total" in q for q in queries),
                        "the budget is spent on the highest-priority window first")
        self.assertEqual(len(writes), 1, "the snapshot is still written when the budget is exhausted")
        self.assertEqual(len(writes[0]["search_log"]), bo.SEARCH_BUDGET,
                         "every executed search is recorded for the cooldown")

    def test_search_cooldown_skips_windows_searched_within_24h(self):
        now = dt.datetime(2026, 10, 30, 9, 0, tzinfo=dt.timezone.utc)
        candidates = [{"id": "2001", "title": "Film A", "industry": "bollywood",
                       "windows_to_refresh": ["cumulative_total", "last_7_days"]},
                      {"id": "2002", "title": "Film B", "industry": "bollywood",
                       "windows_to_refresh": ["cumulative_total"]}]
        manifest = {"selections": {"bollywood": ["2001", "2002"], "world": []},
                    "candidates": candidates}
        queries, writes = [], []
        def fake_tavily(query):
            queries.append(query)
            return []
        previous = {"schema_version": 1, "reports": {},
                    "selections": {"bollywood": [], "world": []},
                    "search_log": {"2001:cumulative_total": "2026-10-30T05:00:00Z",
                                   "2002:cumulative_total": "2026-10-29T08:00:00Z"}}
        with patch.dict(os.environ, {"TAVILY_API_KEY": "test-key", "CLOUDFLARE_API_TOKEN": "test-token"}), \
             patch.object(bo, "run_selector", return_value=manifest):
            summary = bo.run_refresh(tavily_fn=fake_tavily, gemini_fn=lambda prompt: {"reviews": []},
                kv_read=lambda: previous, kv_write=writes.append, now=now)
        self.assertEqual(summary["cooldown_skips"], 1,
                         "the window searched 4h ago is skipped; the one searched 25h ago runs")
        self.assertEqual(len(queries), 2)
        log = writes[0]["search_log"]
        self.assertEqual(log["2001:cumulative_total"], "2026-10-30T05:00:00Z",
                         "a skipped window keeps its original search stamp")
        self.assertEqual(log["2001:last_7_days"], "2026-10-30T09:00:00Z")
        self.assertEqual(log["2002:cumulative_total"], "2026-10-30T09:00:00Z")

    def test_gemini_quote_must_prove_amount_worldwide_and_window(self):
        candidate = bo.make_candidate(self.item, "today", self.result, "2026-10-31")
        quote = "Fixture Film's worldwide box-office gross for today, October 31, 2026, was $12 million."
        accepted = bo.accepted_metric(candidate, {"accepted": True, "quote": quote},
                                      "2026-10-31", "2026-10-31T00:00:00Z")
        self.assertEqual(accepted["scope"], "worldwide")
        self.assertEqual(accepted["window"], "today")
        self.assertEqual(accepted["currency"], "USD")
        self.assertEqual(accepted["source_url"], self.result["url"])
        self.assertEqual(accepted["observed_date"], "2026-10-31")
        self.assertEqual(accepted["reviewed_by"], "Gemini")
        self.assertIsNone(bo.accepted_metric(candidate, {"accepted": True, "quote": "India Net $12 million today"},
                                             "2026-10-31", "2026-10-31T00:00:00Z"))
        self.assertIsNone(bo.accepted_metric(candidate, {"accepted": True, "quote": "Fixture Film worldwide gross $15 million today, October 31, 2026."},
                                             "2026-10-31", "2026-10-31T00:00:00Z"))
        self.assertIsNone(bo.accepted_metric(candidate, {"accepted": False, "quote": ""},
                                             "2026-10-31", "2026-10-31T00:00:00Z"))

    def test_per_window_searches_yield_three_independently_reviewed_metrics(self):
        now = dt.datetime(2026, 10, 30, 20, 0, tzinfo=dt.timezone.utc)  # 01:00 PKT next day
        manifest = {"selections": {"bollywood": ["123"], "world": []}, "candidates": [
            {"id": "123", "title": "Fixture Film", "industry": "bollywood",
             "windows_to_refresh": ["last_2_days", "last_7_days", "cumulative_total"]}
        ]}
        quotes = {
            "last_2_days": "For the last 2 days from 2026-10-30 through 2026-10-31, Fixture Film's worldwide theatrical gross was $22 million.",
            "last_7_days": "For the 7 days from 2026-10-25 through 2026-10-31, Fixture Film's worldwide theatrical gross was $52 million.",
            "cumulative_total": "As of October 31, 2026, Fixture Film's cumulative worldwide total was $120 million.",
        }
        multi_metric_result = {"title": "Fixture Film official worldwide box-office report",
            "content": " ".join(quotes.values()), "published_date": "2026-10-31",
            "url": "https://official.example/box-office"}
        queries = []
        writes = []
        prompt_calls = []
        def fake_tavily(query):
            queries.append(query)
            return [multi_metric_result]
        def fake_gemini(prompt):
            prompt_calls.append(prompt)
            candidates = __import__("json").loads(prompt.split("Candidates:\n", 1)[1])
            return {"reviews": [{"candidate_id": c["candidate_id"], "accepted": True,
                                  "quote": quotes[c["window"]]} for c in candidates]}
        previous = {"schema_version": 1, "reports": {}, "selections": {"bollywood": [], "world": []}}
        def fake_write(value):
            writes.append(value)
        with patch.dict(os.environ, {"TAVILY_API_KEY": "test-key", "CLOUDFLARE_API_TOKEN": "test-token"}), \
             patch.object(bo, "run_selector", return_value=manifest):
            summary = bo.run_refresh(tavily_fn=fake_tavily, gemini_fn=fake_gemini,
                kv_read=lambda: previous, kv_write=fake_write, now=now)
        self.assertEqual(len(queries), 3, "one targeted Tavily search per uncovered window")
        self.assertIn("cumulative worldwide total", queries[0],
                      "the cumulative search runs first (highest-value window)")
        self.assertIn("2026-10-25 through 2026-10-31", queries[1])
        self.assertIn("2026-10-30 through 2026-10-31", queries[2])
        self.assertEqual(summary["query_count"], 3)
        self.assertEqual(summary["skipped_searches"], 0)
        self.assertEqual(summary["candidate_count"], 3)
        self.assertEqual(summary["accepted"]["last_2_days"], 1)
        self.assertEqual(summary["accepted"]["last_7_days"], 1)
        self.assertEqual(summary["accepted"]["cumulative_total"], 1)
        self.assertEqual(len(prompt_calls), 1)
        reviewed = __import__("json").loads(prompt_calls[0].split("Candidates:\n", 1)[1])
        self.assertEqual({c["window"] for c in reviewed}, set(bo.WINDOWS))
        self.assertEqual(len(writes), 1)
        report = writes[0]["reports"]["123"]
        self.assertEqual(report["last_2_days"]["amount"], 22_000_000)
        self.assertEqual(report["last_7_days"]["amount"], 52_000_000)
        self.assertEqual(report["cumulative_total"]["amount"], 120_000_000)
        self.assertEqual(report["last_2_days"]["scope"], "worldwide")
        self.assertNotIsInstance(report["last_2_days"], list, "the per-window upsert cannot append duplicates")
        self.assertEqual(writes[0]["selection_date_pkt"], "2026-10-31")
        self.assertEqual(writes[0]["selection_date_ist"], "2026-10-31")
        queries.clear()
        second_writes = []
        with patch.dict(os.environ, {"TAVILY_API_KEY": "test-key", "CLOUDFLARE_API_TOKEN": "test-token"}), \
             patch.object(bo, "run_selector", return_value=manifest):
            second_summary = bo.run_refresh(tavily_fn=fake_tavily, gemini_fn=fake_gemini,
                kv_read=lambda: writes[0], kv_write=second_writes.append, now=now)
        self.assertEqual(len(queries), 0,
                         "an immediate same-slot rerun searches nothing: all three windows are on cooldown")
        self.assertEqual(second_summary["cooldown_skips"], 3)
        self.assertEqual(len(second_writes), 1)
        second_report = second_writes[0]["reports"]["123"]
        self.assertEqual(set(second_report).intersection(bo.WINDOWS), set(bo.WINDOWS),
                         "the rerun carries each window's metric forward instead of appending duplicates")
        self.assertEqual(second_report["last_2_days"]["amount"], 22_000_000)
        self.assertEqual(second_report["last_7_days"]["amount"], 52_000_000)
        self.assertEqual(second_report["cumulative_total"]["amount"], 120_000_000)

    def test_pair_metrics_are_primary_and_only_uncovered_window_uses_direct_fallback(self):
        now = dt.datetime(2026, 10, 30, 20, 0, tzinfo=dt.timezone.utc)
        today = "2026-10-31"
        pair_2day = {"scope": "worldwide", "method": "paired_components", "window": "last_2_days",
                      "amount": 16, "currency": "USD", "period_start": "2026-10-30",
                      "period_end": today, "as_of": today, "observed_date": today,
                      "observed_at": "2026-10-30T20:00:00Z"}
        pair_week = {**pair_2day, "window": "last_7_days", "amount": 112,
                     "period_start": "2026-10-25"}
        manifest = {"selections": {"bollywood": ["123"], "world": []}, "candidates": [
            {"id": "123", "title": "Fixture Film", "industry": "bollywood",
             "windows_to_refresh": ["cumulative_total"],
             "paired": {"last_2_days": pair_2day, "last_7_days": pair_week}}
        ]}
        total_result = {"title": "Fixture Film worldwide box office",
            "content": "As of October 31, 2026, Fixture Film's cumulative worldwide total was $120 million.",
            "published_date": today, "url": self.result["url"]}
        quote = total_result["content"]
        queries, writes = [], []

        def fake_tavily(query):
            queries.append(query)
            return [total_result]

        def fake_gemini(prompt):
            candidates = __import__("json").loads(prompt.split("Candidates:\n", 1)[1])
            self.assertEqual({candidate["window"] for candidate in candidates}, {"cumulative_total"})
            return {"reviews": [{"candidate_id": candidate["candidate_id"],
                                  "accepted": True, "quote": quote} for candidate in candidates]}

        previous = {"schema_version": 1, "reports": {}, "selections": {"bollywood": [], "world": []}}
        with patch.dict(os.environ, {"TAVILY_API_KEY": "test-key", "CLOUDFLARE_API_TOKEN": "test-token"}), \
             patch.object(bo, "run_selector", return_value=manifest):
            summary = bo.run_refresh(tavily_fn=fake_tavily, gemini_fn=fake_gemini,
                kv_read=lambda: previous, kv_write=writes.append, now=now)

        self.assertEqual(len(queries), 1)
        self.assertEqual(summary["query_count"], 1)
        self.assertEqual(summary["paired"]["last_2_days"], 1)
        self.assertEqual(summary["paired"]["last_7_days"], 1)
        self.assertEqual(summary["paired"]["cumulative_total"], 0)
        report = writes[0]["reports"]["123"]
        self.assertEqual(report["last_2_days"]["method"], "paired_components")
        self.assertEqual(report["last_2_days"]["amount"], 16)
        self.assertEqual(report["last_7_days"]["amount"], 112)
        self.assertEqual(report["cumulative_total"]["method"], "tavily_gemini")
        self.assertEqual(report["cumulative_total"]["amount"], 120_000_000)

    def test_missing_credentials_fail_before_kv_or_tavily(self):
        writes = []
        with patch.dict(os.environ, {"TAVILY_API_KEY": "", "CLOUDFLARE_API_TOKEN": ""}):
            with self.assertRaises(RuntimeError):
                bo.run_refresh(kv_read=lambda: self.fail("must not read KV"), kv_write=writes.append,
                               tavily_fn=lambda query: self.fail("must not search"), gemini_fn=lambda prompt: {})
        self.assertEqual(writes, [])

    def test_dedicated_schedule_maps_to_requested_pkt_hours_and_is_isolated(self):
        workflow = (ROOT / ".github/workflows/home-boxoffice-worldwide.yml").read_text()
        workflow_code = "\n".join(line for line in workflow.splitlines() if not line.lstrip().startswith("#"))
        match = re.search(r"cron:\s*['\"]([^'\"]+)['\"]", workflow)
        self.assertIsNotNone(match, "dedicated schedule must exist")
        cron = match.group(1)
        self.assertEqual(cron, "0 9,13,17,20 * * *")
        utc_hours = [9, 13, 17, 20]
        pkt_hours = [(h + 5) % 24 for h in utc_hours]
        self.assertEqual(pkt_hours, [14, 18, 22, 1])
        self.assertIn("UTC+05:00", workflow)
        self.assertIn("workflow_dispatch:", workflow_code,
                      "the refresh must be manually dispatchable so it can be fired on demand")
        self.assertNotIn("permissions:\n  contents: write", workflow)
        self.assertIn("group: flickatlas-home-boxoffice-worldwide", workflow)
        self.assertIn("python3 scripts/home_boxoffice_worldwide.py --run", workflow)
        self.assertIn(f"HOME_BOXOFFICE_KV_NAMESPACE_ID: {bo.DEFAULT_NAMESPACE_ID}", workflow)
        for forbidden in ("scripts/hourly-pipeline", "scripts/gemini_batch.py --", "publish", "git push", "cloudflare_deploy.py"):
            self.assertNotIn(forbidden, workflow_code)
        hourly = (ROOT / ".github/workflows/hourly-pipeline.yml").read_text()
        self.assertIn("cron: '35 * * * *'", hourly, "existing hourly automation schedule must remain unchanged")
        self.assertIn("group: flickatlas-site-writes", hourly)

    def test_namespace_id_matches_cloudflare_worker_deploy_binding(self):
        deploy = (ROOT / "scripts/cloudflare_deploy.py").read_text()
        self.assertIn(f'HOME_BOXOFFICE_NAMESPACE_ID = "{bo.DEFAULT_NAMESPACE_ID}"', deploy)
        self.assertEqual(bo.KV_KEY, "current")
        runner = (ROOT / "scripts/home_boxoffice_worldwide.py").read_text()
        self.assertIn("HOME_BOXOFFICE_KV_NAMESPACE_ID", runner)


if __name__ == "__main__":
    unittest.main(verbosity=2)
