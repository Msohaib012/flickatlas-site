#!/usr/bin/env python3
"""Offline integrity tests for title-specific worldwide box-office data."""
import importlib.util
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(HERE, filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TAVILY = load_module("tavily_boxoffice", "tavily_boxoffice.py")
WORLDWIDE = load_module("worldwide_boxoffice", "worldwide_boxoffice.py")


class WorldwideTitleIntegrityTests(unittest.TestCase):
    def test_parenthetical_title_alias_is_allowed(self):
        self.assertTrue(TAVILY.result_mentions_film(
            "Dhood (Sandstorm)", "Dhood worldwide box office", "Dhood gross"))

    def test_unrelated_chart_does_not_match_target_title(self):
        self.assertFalse(TAVILY.result_mentions_film(
            "Dhood (Sandstorm)", "List of highest-grossing films",
            "Worldwide box office gross: $913 million"))

    def test_specific_worldwide_total_is_accepted(self):
        result = {
            "url": "https://trade.example/dhood-sandstorm-box-office",
            "title": "Dhood (Sandstorm) worldwide box office",
            "content": "Dhood (Sandstorm) worldwide gross: $1.25 million",
        }
        self.assertEqual(TAVILY.pick_worldwide([result], "Dhood (Sandstorm)")[:2],
                         (1_250_000, result["url"]))

    def test_generic_highest_grossing_list_is_rejected(self):
        result = {
            "url": "https://en.wikipedia.org/wiki/List_of_highest-grossing_films",
            "title": "List of highest-grossing films",
            "content": "Worldwide box office gross: $913 million",
        }
        usd, source, _ = TAVILY.pick_worldwide([result], "Dhood (Sandstorm)")
        self.assertIsNone(usd)
        self.assertIsNone(source)

    def test_search_result_without_target_title_is_rejected(self):
        result = {
            "url": "https://trade.example/top-grosses",
            "title": "Worldwide box office report",
            "content": "Worldwide theatrical gross: $913 million",
        }
        self.assertIsNone(TAVILY.pick_worldwide([result], "Dhood (Sandstorm)")[0])

    def test_target_in_headline_but_not_near_gross_is_rejected(self):
        result = {
            "url": "https://trade.example/dhood-article",
            "title": "Dhood (Sandstorm) worldwide box office update",
            "content": "Another film's worldwide box office gross was $913 million.",
        }
        self.assertIsNone(TAVILY.pick_worldwide(
            [result], "Dhood (Sandstorm)")[0])

    def test_target_far_from_candidate_figure_is_rejected(self):
        result = {
            "url": "https://trade.example/box-office-roundup",
            "title": "Worldwide box office roundup",
            "content": "Dhood (Sandstorm) is mentioned in this roundup. "
                       + ("unrelated text " * 30)
                       + "Another film worldwide gross: $913 million",
        }
        self.assertIsNone(TAVILY.pick_worldwide(
            [result], "Dhood (Sandstorm)")[0])

    def test_target_in_previous_sentence_is_rejected(self):
        result = {
            "url": "https://trade.example/box-office-roundup",
            "title": "Worldwide box office roundup",
            "content": "Dhood (Sandstorm) is mentioned here. Another film's "
                       "worldwide box office gross was $913 million.",
        }
        self.assertIsNone(TAVILY.pick_worldwide(
            [result], "Dhood (Sandstorm)")[0])

    def test_non_wikipedia_generic_chart_is_rejected(self):
        result = {
            "url": "https://charts.example/charts/top-grossing-movies",
            "title": "Dhood (Sandstorm) appears on the list",
            "content": "Dhood (Sandstorm) appears in this list; another film "
                       "has worldwide box office gross of $913 million.",
        }
        self.assertIsNone(TAVILY.pick_worldwide(
            [result], "Dhood (Sandstorm)")[0])

    def test_unrelated_theknot_site_is_blocked(self):
        result = {
            "url": "https://www.theknot.com/us/surviving-hurricane-otis-fullmovie",
            "title": "Surviving Hurricane Otis",
            "content": "Worldwide box office gross: $152 million",
        }
        self.assertIsNone(TAVILY.pick_worldwide(
            [result], "Surviving Hurricane Otis")[0])

    def test_merger_drops_generic_chart_staging_even_if_it_is_still_present(self):
        staged = {"1799668": {
            "as_of": "2026-10-28", "scope": "worldwide",
            "source": "https://en.wikipedia.org/wiki/List_of_highest-grossing_films",
            "total_usd": 913_000_000,
        }}
        merged, notes = WORLDWIDE.merge({}, [("tavily-worldwide.json", staged)])
        self.assertEqual(merged, {})
        self.assertTrue(any("generic leaderboard source ignored" in n for n in notes))

    def test_merger_drops_non_wikipedia_chart_staging(self):
        staged = {"1799668": {
            "as_of": "2026-10-28", "scope": "worldwide",
            "source": "https://charts.example/charts/top-grossing-movies",
            "total_usd": 913_000_000,
        }}
        merged, _ = WORLDWIDE.merge({}, [("tavily-worldwide.json", staged)])
        self.assertEqual(merged, {})

    def test_current_data_has_no_dhood_false_total_or_generic_chart_sources(self):
        root = os.path.dirname(HERE)
        with open(os.path.join(root, "out", "boxoffice-staging",
                               "tavily-worldwide.json"), encoding="utf-8") as f:
            staged = json.load(f)
        with open(os.path.join(root, "js", "worldwide-data.js"),
                  encoding="utf-8") as f:
            text = f.read()
        marker = "window.FA_WORLDWIDE = "
        start = text.index(marker) + len(marker)
        published = json.loads(text[start:text.rfind(";")])
        for records in (staged, published):
            dhood = records.get("1799668")
            self.assertFalse(dhood and dhood.get("total_usd") == 913_000_000)
            self.assertFalse(any(WORLDWIDE.generic_chart_source(entry)
                                 for entry in records.values()))

    def test_merger_keeps_title_specific_staging(self):
        staged = {"1799668": {
            "as_of": "2026-10-28", "scope": "worldwide",
            "source": "https://trade.example/dhood-sandstorm-box-office",
            "title": "Dhood (Sandstorm)", "total_usd": 1_250_000,
        }}
        merged, _ = WORLDWIDE.merge({}, [("tavily-worldwide.json", staged)])
        self.assertEqual(merged["1799668"]["total_usd"], 1_250_000)


if __name__ == "__main__":
    unittest.main(verbosity=2)
