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

    def test_one_query_requests_all_three_worldwide_windows_for_a_title(self):
        today = "2026-10-31"
        query = bo.make_query(self.item, today)
        self.assertIn("today (2026-10-31 through 2026-10-31)", query)
        self.assertIn("exact 7-day window (2026-10-25 through 2026-10-31)", query)
        self.assertIn("cumulative worldwide total as of 2026-10-31", query)
        self.assertNotIn("india net", query.lower())
        self.assertNotIn("overseas-only", query.lower())

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

    def test_one_search_per_title_yields_three_independently_reviewed_metrics(self):
        now = dt.datetime(2026, 10, 30, 20, 0, tzinfo=dt.timezone.utc)  # 01:00 PKT next day
        manifest = {"selections": {"bollywood": ["123"], "world": []}, "candidates": [
            {"id": "123", "title": "Fixture Film", "industry": "bollywood",
             "windows_to_refresh": ["today", "last_7_days", "cumulative_total"]}
        ]}
        quotes = {
            "today": "Fixture Film's worldwide box-office gross for today, October 31, 2026, was $12 million.",
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
        self.assertEqual(len(queries), 1, "one Tavily search is made for this title, not once per window")
        self.assertIn("2026-10-25 through 2026-10-31", queries[0])
        self.assertEqual(summary["query_count"], 1)
        self.assertEqual(summary["candidate_count"], 3)
        self.assertEqual(summary["accepted"]["today"], 1)
        self.assertEqual(summary["accepted"]["last_7_days"], 1)
        self.assertEqual(summary["accepted"]["cumulative_total"], 1)
        self.assertEqual(len(prompt_calls), 1)
        reviewed = __import__("json").loads(prompt_calls[0].split("Candidates:\n", 1)[1])
        self.assertEqual({c["window"] for c in reviewed}, set(bo.WINDOWS))
        self.assertEqual(len(writes), 1)
        report = writes[0]["reports"]["123"]
        self.assertEqual(report["today"]["amount"], 12_000_000)
        self.assertEqual(report["last_7_days"]["amount"], 52_000_000)
        self.assertEqual(report["cumulative_total"]["amount"], 120_000_000)
        self.assertEqual(report["today"]["scope"], "worldwide")
        self.assertNotIsInstance(report["today"], list, "the per-window upsert cannot append duplicates")
        self.assertEqual(writes[0]["selection_date_pkt"], "2026-10-31")
        self.assertEqual(writes[0]["selection_date_ist"], "2026-10-31")
        queries.clear()
        second_writes = []
        with patch.dict(os.environ, {"TAVILY_API_KEY": "test-key", "CLOUDFLARE_API_TOKEN": "test-token"}), \
             patch.object(bo, "run_selector", return_value=manifest):
            bo.run_refresh(tavily_fn=fake_tavily, gemini_fn=fake_gemini,
                kv_read=lambda: writes[0], kv_write=second_writes.append, now=now)
        self.assertEqual(len(queries), 1)
        self.assertEqual(len(second_writes), 1)
        second_report = second_writes[0]["reports"]["123"]
        self.assertEqual(set(second_report).intersection(bo.WINDOWS), set(bo.WINDOWS),
                         "rerunning the same slot overwrites each window instead of appending duplicates")
        self.assertEqual(second_report["today"]["amount"], 12_000_000)
        self.assertEqual(second_report["last_7_days"]["amount"], 52_000_000)
        self.assertEqual(second_report["cumulative_total"]["amount"], 120_000_000)

    def test_pair_metrics_are_primary_and_only_uncovered_window_uses_direct_fallback(self):
        now = dt.datetime(2026, 10, 30, 20, 0, tzinfo=dt.timezone.utc)
        today = "2026-10-31"
        pair_today = {"scope": "worldwide", "method": "paired_components", "window": "Today",
                      "amount": 16, "currency": "USD", "period_start": today,
                      "period_end": today, "as_of": today, "observed_date": today,
                      "observed_at": "2026-10-30T20:00:00Z"}
        pair_week = {**pair_today, "window": "Last 7 days", "amount": 112,
                     "period_start": "2026-10-25"}
        manifest = {"selections": {"bollywood": ["123"], "world": []}, "candidates": [
            {"id": "123", "title": "Fixture Film", "industry": "bollywood",
             "windows_to_refresh": ["cumulative_total"],
             "paired": {"today": pair_today, "last_7_days": pair_week}}
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
        self.assertEqual(summary["paired"]["today"], 1)
        self.assertEqual(summary["paired"]["last_7_days"], 1)
        self.assertEqual(summary["paired"]["cumulative_total"], 0)
        report = writes[0]["reports"]["123"]
        self.assertEqual(report["today"]["method"], "paired_components")
        self.assertEqual(report["today"]["amount"], 16)
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
        self.assertNotIn("workflow_dispatch:", workflow)
        self.assertNotIn("permissions:\n  contents: write", workflow)
        self.assertIn("group: flickatlas-home-boxoffice-worldwide", workflow)
        self.assertIn("python3 scripts/home_boxoffice_worldwide.py --run", workflow)
        self.assertIn(f"HOME_BOXOFFICE_KV_NAMESPACE_ID: {bo.DEFAULT_NAMESPACE_ID}", workflow)
        for forbidden in ("scripts/hourly-pipeline", "scripts/gemini_batch.py --", "publish", "git push", "cloudflare_deploy.py", "workflow_dispatch"):
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
