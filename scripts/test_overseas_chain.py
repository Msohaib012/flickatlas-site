#!/usr/bin/env python3
"""Offline tests for the permanent overseas collection chain
(2026-10-30 audit fix). No network, no live writes: Sacnilk fetches
and Tavily/Gemini calls are faked; everything lands in temp dirs.

Covers:
  * backfill_overseas.py as the pipeline gap sweep — fills a missing
    completed day from that day's quicknews page, MERGES staging
    instead of overwriting, attempt-marks figure-less days (no daily
    re-fetch), never sweeps today's live rows, prioritises freshest
    titles / newest days under a page budget, and one title's missing
    page never blocks another title.
  * overseas_ai.py quota discipline — priority order (newest release
    first), attempt cooldown keyed on the missing-day signature, and
    the per-run search cap.
  * multisource_boxoffice.py — a sweep staging figure
    (overseas_inr_cr) lands in the FA_DAYWISE row's "overseas" USD
    field, the exact field the renderers read, India untouched.
"""
import contextlib
import datetime as dt
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
import unittest.mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


sweep = load_module("backfill_overseas", "backfill_overseas.py")
oai = load_module("overseas_ai", "overseas_ai.py")
ms = load_module("multisource_boxoffice", "multisource_boxoffice.py")
sb = sys.modules["sacnilk_boxoffice"]

TODAY = dt.datetime.now(dt.timezone.utc).date()


def iso(days_ago):
    return (TODAY - dt.timedelta(days=days_ago)).isoformat()


def write_js(path, var, value):
    with open(path, "w", encoding="utf-8") as f:
        f.write("window.%s = %s;\n" % (var, json.dumps(value)))


def quicknews_html(day, cr):
    return ("<html><body><p>Overseas, the film collected ₹%s Cr on "
            "Day %d, taking its total overseas gross to ₹99.00 Cr</p>"
            "</body></html>" % (cr, day))


class SweepTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.mkdtemp()
        self.pub = os.path.join(self.td, "published.js")
        self.dw = os.path.join(self.td, "daywise.js")
        self.out = os.path.join(self.td, "overseas-backfill.json")
        self.state = os.path.join(self.td, "sweep-state.json")
        # Alpha: fresher (latest row today). Missing overseas on
        # Day 2 (T-10) and Day 4 (T-8); Day 11 is dated TODAY (live —
        # must never be swept). Beta: older (latest row T-2); its
        # Day 1 (T-6) page 404s.
        write_js(self.pub, "FA_PUBLISHED", {
            "100": {"id": 100, "type": "movie", "title": "Alpha",
                    "release_date": iso(11)},
            "200": {"id": 200, "type": "movie", "title": "Beta",
                    "release_date": iso(6)},
        })
        write_js(self.dw, "FA_DAYWISE", {
            "100": [
                {"day": "Day 1", "date": iso(11), "collection": 100,
                 "overseas": 50},
                {"day": "Day 2", "date": iso(10), "collection": 100},
                {"day": "Day 4", "date": iso(8), "collection": 100},
                {"day": "Day 9", "date": iso(3), "collection": 100,
                 "overseas": 60},
                {"day": "Day 11", "date": iso(0), "collection": 100},
            ],
            "200": [
                {"day": "Day 1", "date": iso(6), "collection": 100},
                {"day": "Day 5", "date": iso(2), "collection": 100,
                 "overseas": 40},
            ],
        })
        # Pre-existing staging: an unrelated title's entry and an old
        # Alpha Day 3 entry — both must survive the sweep untouched.
        with open(self.out, "w", encoding="utf-8") as f:
            json.dump({
                "999": [{"day": 1, "date": iso(30),
                         "overseas_inr_cr": 9.9,
                         "source": "overseas-backfill"}],
                "100": [{"day": 3, "date": iso(8),
                         "overseas_inr_cr": 3.3,
                         "source": "overseas-backfill"}],
            }, f)
        self.fetches = []
        pages = {}
        slug_a = sb.slugify("Alpha", "2026")
        slug_b = sb.slugify("Beta", "2026")
        pages[(slug_a, 2)] = quicknews_html(2, "5.50")
        pages[(slug_a, 4)] = quicknews_html(4, "7.25")
        pages[(slug_b, 1)] = None  # 404

        def fake_fetch(slug, day):
            self.fetches.append((slug, day))
            return pages.get((slug, day))

        self._orig_fetch = sb.fetch_quicknews
        sb.fetch_quicknews = fake_fetch
        sweep.step_runs = None
        self.addCleanup(self._restore)

    def _restore(self):
        sb.fetch_quicknews = self._orig_fetch

    def run_sweep(self, *extra):
        argv = ["backfill_overseas.py", "--published", self.pub,
                "--daywise", self.dw, "--out", self.out,
                "--state", self.state, "--sleep", "0"] + list(extra)
        with contextlib.redirect_stdout(io.StringIO()):
            with unittest.mock.patch.object(sys, "argv", argv):
                rc = sweep.main()
        self.assertEqual(rc, 0)

    def staging(self):
        with open(self.out, encoding="utf-8") as f:
            return json.load(f)

    def test_fills_merges_and_marks_attempts(self):
        self.run_sweep()
        st = self.staging()
        # Pre-existing entries preserved (merge, not overwrite).
        self.assertEqual(st["999"][0]["overseas_inr_cr"], 9.9)
        alpha = {e["day"]: e for e in st["100"]}
        self.assertEqual(alpha[3]["overseas_inr_cr"], 3.3)
        # Missing completed days filled from their own pages.
        self.assertEqual(alpha[2]["overseas_inr_cr"], 5.5)
        self.assertEqual(alpha[2]["date"], iso(10))
        self.assertEqual(alpha[4]["overseas_inr_cr"], 7.25)
        # Beta's 404 day produced nothing; today's row never fetched.
        self.assertNotIn("200", st)
        fetched_days = {(s, d) for s, d in self.fetches}
        slug_a = sb.slugify("Alpha", "2026")
        self.assertNotIn((slug_a, 11), fetched_days)
        # Attempt state: filled + no-page outcomes recorded.
        with open(self.state, encoding="utf-8") as f:
            state = json.load(f)
        self.assertEqual(state["100:2"]["outcome"], "filled")
        self.assertEqual(state["200:1"]["outcome"], "no-page")

    def test_attempt_cooldown_blocks_refetch(self):
        self.run_sweep()
        # Simulate the engine having merged the fills into the
        # baseline (production: step 6 of the same hourly run).
        write_js(self.dw, "FA_DAYWISE", {
            "100": [
                {"day": "Day 1", "date": iso(11), "collection": 100,
                 "overseas": 50},
                {"day": "Day 2", "date": iso(10), "collection": 100,
                 "overseas": 10},
                {"day": "Day 4", "date": iso(8), "collection": 100,
                 "overseas": 10},
            ],
            "200": [
                {"day": "Day 1", "date": iso(6), "collection": 100},
                {"day": "Day 5", "date": iso(2), "collection": 100,
                 "overseas": 40},
            ],
        })
        self.fetches = []
        self.run_sweep()
        # Beta Day 1 is still missing but was attempted yesterday:
        # the cooldown defers it — zero fetches this run.
        self.assertEqual(self.fetches, [])

    def test_priority_and_page_budget(self):
        self.run_sweep("--max-pages", "1")
        # Exactly one fetch: the freshest title (Alpha, latest row
        # today vs Beta's T-2), its NEWEST missing day (Day 4).
        slug_a = sb.slugify("Alpha", "2026")
        self.assertEqual(self.fetches, [(slug_a, 4)])


class AiFillerTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.mkdtemp()
        self.pub = os.path.join(self.td, "published.js")
        self.dw = os.path.join(self.td, "daywise.js")
        self.out = os.path.join(self.td, "overseas-ai.json")
        self.attempts = os.path.join(self.td, "attempts.json")
        write_js(self.pub, "FA_PUBLISHED", {
            "300": {"id": 300, "type": "movie", "title": "Old Film",
                    "release_date": iso(20)},
            "400": {"id": 400, "type": "movie", "title": "New Film",
                    "release_date": iso(3)},
            "500": {"id": 500, "type": "movie", "title": "Fresh Hit",
                    "release_date": iso(2)},
        })
        self.daywise = {
            "300": [{"day": "Day 1", "date": iso(20), "collection": 1},
                    {"day": "Day 2", "date": iso(19), "collection": 1},
                    {"day": "Day 3", "date": iso(18), "collection": 1}],
            "400": [{"day": "Day 1", "date": iso(3), "collection": 1}],
            "500": [{"day": "Day 1", "date": iso(2), "collection": 1}],
        }
        write_js(self.dw, "FA_DAYWISE", self.daywise)
        self.searched = []

        def fake_search(title, local):
            self.searched.append(title)
            return ([{"title": title, "url": "https://x.example/" + title,
                      "content": "overseas day wise report"}], 2)

        self._saved = (oai.PIPELINE_CALL, oai.PIPELINE_KEYS,
                       oai.tavily_keys, oai.search_overseas, oai.step_runs)
        oai.PIPELINE_CALL = lambda keys, prompt, schema: {"days": []}
        oai.PIPELINE_KEYS = lambda: ["k"]
        oai.tavily_keys = lambda: ["k"]
        oai.search_overseas = fake_search
        oai.step_runs = None
        self.addCleanup(self._restore)

    def _restore(self):
        (oai.PIPELINE_CALL, oai.PIPELINE_KEYS, oai.tavily_keys,
         oai.search_overseas, oai.step_runs) = self._saved

    def run_ai(self, *extra):
        argv = ["overseas_ai.py", "--published", self.pub,
                "--daywise", self.dw, "--out", self.out,
                "--attempts", self.attempts] + list(extra)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            with unittest.mock.patch.object(sys, "argv", argv):
                rc = oai.main()
        self.assertEqual(rc, 0)
        return buf.getvalue()

    def ledger(self):
        with open(self.attempts, encoding="utf-8") as f:
            return json.load(f)

    def test_every_cycle_attempts_every_title(self):
        # Owner order 2026-10-30 19:27 PKT: every cycle, every
        # in-scope title missing a figure is attempted — no cooldown,
        # no silent skip. Order: homepage window (last 14 days,
        # newest first), then the rest.
        self.run_ai()
        self.assertEqual(self.searched,
                         ["Fresh Hit", "New Film", "Old Film"])
        att = self.ledger()
        self.assertEqual(att["500"]["missing"], "1")
        self.assertEqual(att["300"]["missing"], "1,2,3")
        self.assertFalse(any(r["deferred"] for r in att.values()))
        # The very next cycle attempts them ALL again.
        self.searched = []
        self.run_ai()
        self.assertEqual(self.searched,
                         ["Fresh Hit", "New Film", "Old Film"])

    def test_budget_deferral_rotates_and_never_starves(self):
        # Budget for exactly one movie per cycle: the cut movies are
        # stamped deferred and LEAD the next cycle, so over three
        # cycles every title is attempted exactly once.
        self.run_ai("--max-searches", "2")
        self.assertEqual(self.searched, ["Fresh Hit"])
        att = self.ledger()
        self.assertTrue(att["400"]["deferred"])
        self.assertTrue(att["300"]["deferred"])
        self.assertFalse(att["500"]["deferred"])
        self.searched = []
        log = self.run_ai("--max-searches", "2")
        self.assertEqual(self.searched, ["New Film"])
        self.assertIn("deferred — search budget", log)
        att = self.ledger()
        self.assertTrue(att["500"]["deferred"],
                        "the movie cut this cycle is deferred, not dropped")
        self.assertTrue(att["300"]["deferred"])
        # Longest-deferred first: Old Film (cut in cycles 1 and 2)
        # now outranks Fresh Hit (cut in cycle 2 only).
        self.searched = []
        self.run_ai("--max-searches", "2")
        self.assertEqual(self.searched, ["Old Film"])
        # And the rotation continues — nobody is starved.
        self.searched = []
        self.run_ai("--max-searches", "2")
        self.assertEqual(self.searched, ["Fresh Hit"])


class EngineTests(unittest.TestCase):
    def test_sweep_figure_lands_in_daywise_overseas_field(self):
        td = tempfile.mkdtemp()
        staging = os.path.join(td, "staging")
        os.makedirs(staging)
        date2 = iso(2)
        with open(os.path.join(staging, "overseas-backfill.json"),
                  "w", encoding="utf-8") as f:
            json.dump({"100": [{"day": 2, "date": date2,
                                "overseas_inr_cr": 4.2,
                                "source": "overseas-backfill"}]}, f)
        published = {"100": {"id": 100, "type": "movie",
                             "title": "Alpha", "release_date": iso(3)}}
        collected, extras, _skipped, _rejected = ms.load_staging(
            staging, TODAY, published, "sacnilk")
        finalized = ms.finalize(collected, extras, "sacnilk")
        daywise = {"100": [{"day": "Day 2", "date": date2,
                            "collection": 12345}]}
        ms.merge_into_baseline(daywise, finalized)
        row = daywise["100"][0]
        self.assertEqual(row["collection"], 12345)  # India untouched
        self.assertEqual(row["overseas"],
                         round(4.2 * 1e7 / ms.INR_PER_USD))


if __name__ == "__main__":
    unittest.main()
