#!/usr/bin/env python3
"""Tests for the Sacnilk overseas parsing + backfill (2026-11-07).

Covers the Ramayana regression: the reader never fetched the title
(slug 404) and, even with a working slug, only ever read quicknews
for the current day — so Days 1-2 overseas were never learned.
Synthetic quicknews HTML only; no network, no fixtures.
Run: python3 scripts/test_sacnilk_overseas.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sacnilk_boxoffice as sb


def _qn_page(overseas_sentence):
    return (
        "<html><body><table><tr><th>Day</th><th>India net</th></tr>"
        "<tr><td>Day 1 Thu 5 Nov</td><td>\u20b964.85 Cr</td></tr>"
        "</table><p>" + overseas_sentence + "</p></body></html>")


class TestOverseasParsing(unittest.TestCase):
    def test_day1_phrasing_keys_to_none(self):
        # Day-1 phrasing carries the cumulative total, which IS the
        # Day 1 figure; the caller assigns it to the page's day.
        _pd, _adv, ex = sb.parse_quicknews(_qn_page(
            "Overseas, the film has grossed a total of \u20b951.25 Cr "
            "in gross collections"))
        self.assertEqual(ex[None]["overseas_inr_cr"], 51.25)

    def test_dayN_phrasing_keys_to_day(self):
        _pd, _adv, ex = sb.parse_quicknews(_qn_page(
            "Overseas, the film collected \u20b935 Cr on Day 2, taking "
            "its total overseas gross to \u20b986.25 Cr"))
        self.assertEqual(ex[2]["overseas_inr_cr"], 35.0)

    def test_no_overseas_sentence(self):
        _pd, _adv, ex = sb.parse_quicknews(_qn_page("No overseas yet."))
        self.assertNotIn("overseas_inr_cr", ex.get(1, {}))


class TestMissingOverseasDays(unittest.TestCase):
    def test_past_days_missing_only(self):
        per_day = {1: ("5 Nov", 64.85), 2: ("6 Nov", 48.05),
                   3: ("7 Nov", 10.68)}
        # cur_day 3 already has overseas; Day 1-2 do not.
        extras = {3: {"overseas_inr_cr": 5.0}}
        self.assertEqual(sb.missing_overseas_days(per_day, extras, 3),
                         [1, 2])

    def test_current_day_never_backfilled(self):
        per_day = {1: ("5 Nov", 64.85), 2: ("6 Nov", 48.05)}
        self.assertEqual(sb.missing_overseas_days(per_day, {}, 2), [1])

    def test_cap_bounds_run(self):
        per_day = {d: (f"{d} Nov", 1.0) for d in range(1, 20)}
        self.assertEqual(len(sb.missing_overseas_days(per_day, {}, 20)),
                         7)


class TestSlugOverride(unittest.TestCase):
    def test_ramayana_slug(self):
        # TMDB titles it "Ramayana: Rise of a Legend"; Sacnilk files
        # it as "Ramayana Part 1" — slugify() 404s without this.
        self.assertEqual(sb.SLUG_OVERRIDES.get("656908"),
                         "ramayana_part_1_2026")


if __name__ == "__main__":
    unittest.main(verbosity=2)
