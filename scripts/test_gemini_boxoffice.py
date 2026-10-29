#!/usr/bin/env python3
"""Offline tests for Gemini review of Tavily India-Net candidates."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GB = load_module("gemini_boxoffice_test", "gemini_boxoffice.py")
TV = GB.tv


class GeminiBoxofficeTests(unittest.TestCase):
    def setUp(self):
        self.today = __import__("datetime").datetime.now(TV.IST).date().isoformat()
        self.quote = f"Alpha Day 1 India Net: Rs 5 crore on {self.today}"
        self.candidate = {
            "candidate_id": f"123:1:{self.today}",
            "tmdb_id": "123",
            "title": "Alpha",
            "result_title": "Alpha Day 1 India Net collection",
            "content": self.quote,
            "quote": self.quote,
            "source_url": "https://trade.example/alpha-day-1",
            "day": 1,
            "date": self.today,
            "collection_inr_cr": 5.0,
        }
        self.daywise = {"123": [{"day": 1, "date": self.today,
                                "collection": 1_000_000}]}

    def test_valid_verbatim_review_is_accepted(self):
        ok, result = GB.verify_quote(
            self.candidate,
            {"accepted": True, "quote": self.quote},
            self.daywise,
        )
        self.assertTrue(ok)
        self.assertEqual(result, self.quote)

    def test_gemini_cannot_invent_a_quote_or_change_amount(self):
        ok, reason = GB.verify_quote(
            self.candidate,
            {"accepted": True,
             "quote": f"Alpha Day 1 India Net: Rs 50 crore on {self.today}"},
            self.daywise,
        )
        self.assertFalse(ok)
        self.assertIn("substring", reason)

    def test_reader_domain_candidate_is_not_an_extra_vote(self):
        candidate = dict(self.candidate,
                         source_url="https://www.sacnilk.com/movie/alpha/day-1")
        records = [{"source": "sacnilk", "collection_inr_cr": 5.0}]
        self.assertEqual(GB.same_reader_domain(candidate, records), "sacnilk")
        self.assertEqual(GB.same_reader_domain(candidate, []), "")

    def test_reader_context_uses_exact_movie_day_and_date(self):
        with tempfile.TemporaryDirectory() as temp:
            stage = Path(temp)
            (stage / "filmynewsnetwork.json").write_text(json.dumps({
                "123": [
                    {"day": 1, "date": self.today,
                     "collection_inr_cr": 4.8},
                    {"day": 2, "date": self.today,
                     "collection_inr_cr": 6.0},
                ]
            }), encoding="utf-8")
            (stage / "overseas-ai.json").write_text(json.dumps({
                "123": [{"day": 1, "date": self.today,
                         "collection_inr_cr": 99.0}]
            }), encoding="utf-8")
            rows = GB.reader_records(stage, self.candidate)
        self.assertEqual(rows, [{"source": "filmynewsnetwork",
                                 "collection_inr_cr": 4.8}])

    def test_pipeline_writes_only_python_parsed_amount_after_gemini_approval(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            evidence = base / "evidence.json"
            stage = base / "staging"
            stage.mkdir()
            out = stage / "tavily.json"
            (stage / "filmynewsnetwork.json").write_text(json.dumps({
                "123": [{"day": 1, "date": self.today,
                         "collection_inr_cr": 4.8}]
            }), encoding="utf-8")
            published = base / "published-titles.js"
            published.write_text("window.FA_PUBLISHED = " + json.dumps({
                "123": {"title": "Alpha"}
            }) + ";\n", encoding="utf-8")
            daywise = base / "daywise-data.js"
            daywise.write_text("window.FA_DAYWISE = " + json.dumps(
                self.daywise) + ";\n", encoding="utf-8")
            evidence.write_text(json.dumps({
                "status": "ok", "candidates": [self.candidate]
            }), encoding="utf-8")
            argv = ["gemini_boxoffice.py", "--evidence", str(evidence),
                    "--staging", str(stage), "--published", str(published),
                    "--daywise", str(daywise), "--out", str(out)]
            answer = {"reviews": [{
                "candidate_id": self.candidate["candidate_id"],
                "accepted": True,
                "quote": self.quote,
            }]}
            with patch.object(GB, "GEMINI_KEYS", return_value=["test-key"]), \
                    patch.object(GB, "CALL_GEMINI", return_value=answer), \
                    patch("sys.argv", argv):
                self.assertEqual(GB.main(), 0)
            result = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(result["123"][0]["collection_inr_cr"], 5.0)
            self.assertEqual(result["123"][0]["source_url"],
                             self.candidate["source_url"])
            self.assertEqual(result["123"][0]["gemini_quote"], self.quote)

    def test_no_gemini_key_preserves_last_good_staging(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            evidence = base / "evidence.json"
            stage = base / "staging"
            stage.mkdir()
            old = {"999": [{"day": 1, "date": self.today,
                            "collection_inr_cr": 7.0, "source": "tavily"}]}
            out = stage / "tavily.json"
            out.write_text(json.dumps(old), encoding="utf-8")
            evidence.write_text(json.dumps({"status": "ok",
                                            "candidates": [self.candidate]}),
                                encoding="utf-8")
            published = base / "published-titles.js"
            published.write_text("window.FA_PUBLISHED = " + json.dumps({
                "123": {"title": "Alpha"}
            }) + ";\n", encoding="utf-8")
            daywise = base / "daywise-data.js"
            daywise.write_text("window.FA_DAYWISE = " + json.dumps(
                self.daywise) + ";\n", encoding="utf-8")
            before = out.read_text(encoding="utf-8")
            argv = ["gemini_boxoffice.py", "--evidence", str(evidence),
                    "--staging", str(stage), "--published", str(published),
                    "--daywise", str(daywise), "--out", str(out)]
            with patch.object(GB, "GEMINI_KEYS", return_value=[]), \
                    patch("sys.argv", argv):
                self.assertEqual(GB.main(), 0)
            self.assertEqual(out.read_text(encoding="utf-8"), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
