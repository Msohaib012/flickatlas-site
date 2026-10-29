#!/usr/bin/env python3
"""Regression tests for the publisher's Bollywood / World Cinema boundary."""
import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
PUBLISHER_PATH = ROOT / "scripts" / "publish-titles.py"
SPEC = importlib.util.spec_from_file_location("publish_titles", PUBLISHER_PATH)
PUBLISHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PUBLISHER)


class IndustryScopeTests(unittest.TestCase):
    def test_india_origin_in_any_language_is_bollywood(self):
        for language in ("hi", "ta", "te", "ml", "kn", "en", "es"):
            with self.subTest(language=language):
                self.assertEqual(PUBLISHER.derive_industry({
                    "original_language": language,
                    "origin_country": ["IN"],
                }), "bollywood")

    def test_production_country_is_used_when_origin_is_missing(self):
        self.assertEqual(PUBLISHER.derive_industry({
            "original_language": "en",
            "production_countries": [{"iso_3166_1": "IN"}],
        }), "bollywood")

    def test_expanded_indian_language_fallback(self):
        for language in ("sa", "ks", "sd", "kok", "mni", "mai", "sat", "doi",
                         "brx", "bho", "awa", "mag", "mwr", "hne", "tcy"):
            with self.subTest(language=language):
                self.assertEqual(PUBLISHER.derive_industry({
                    "original_language": language,
                }), "bollywood")

    def test_pakistan_is_never_world_cinema(self):
        for language in ("en", "ur", "pa"):
            with self.subTest(language=language):
                self.assertEqual(PUBLISHER.derive_industry({
                    "original_language": language,
                    "origin_country": ["PK"],
                }), "pakistani")
        self.assertEqual(PUBLISHER.derive_industry({"original_language": "ur"}), "pakistani")

    def test_indian_urdu_and_spoken_language_fallback(self):
        self.assertEqual(PUBLISHER.derive_industry({
            "original_language": "ur", "origin_country": ["IN"],
        }), "bollywood")
        self.assertEqual(PUBLISHER.derive_industry({
            "spoken_languages": [{"iso_639_1": "kok"}],
        }), "bollywood")

    def test_other_countries_are_world_cinema(self):
        for country, language in (("US", "en"), ("ES", "es"), ("JP", "ja")):
            with self.subTest(country=country):
                self.assertEqual(PUBLISHER.derive_industry({
                    "original_language": language,
                    "origin_country": [country],
                }), "world")

    def test_mixed_india_pakistan_keeps_pakistani_precedence(self):
        self.assertEqual(PUBLISHER.derive_industry({
            "original_language": "hi", "origin_country": ["IN", "PK"],
        }), "pakistani")


if __name__ == "__main__":
    unittest.main()
