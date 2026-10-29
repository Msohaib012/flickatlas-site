"""Mock-only regression tests for metadata/provider outcome safety."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def load_script(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


refresh = load_script("refresh_metadata_under_test", "refresh-metadata.py")
backfill = load_script("backfill_providers_under_test", "backfill_providers.py")


class Recorder:
    def __init__(self):
        self.calls = []

    def record(self, *args, **kwargs):
        self.calls.append((args, kwargs))


class FakePublish:
    HEADER = "// test\n"

    def __init__(self, entries):
        self.entries = entries
        self.writes = 0

    def read_js_map(self, _path, _name):
        return {key: dict(value) for key, value in self.entries.items()}

    def write_js_map(self, _path, _name, entries, _header):
        self.writes += 1
        self.entries = {key: dict(value) for key, value in entries.items()}
        return True

    def build_entry(self, details, _media, categories, published_at):
        return {**details, "categories": categories,
                "published_at": published_at}


class FakeSeed:
    def __init__(self, publish, fetch):
        self.publish = publish
        self.fetch = fetch

    def read_key(self, _args):
        return "stub-key"

    def load_publish_titles(self):
        return self.publish

    def fetch_providers(self, tid, media, key):
        return self.fetch(tid, media, key)


def entry(**kwargs):
    return {"id": "1", "type": "movie", "title": "Example",
            "categories": ["editorial"], "published_at": "2020-01-01",
            "release_date": "", "providers": [{"name": "Keep"}],
            **kwargs}


class MetadataOutcomeTests(unittest.TestCase):
    def run_refresh(self, entries, detail_fetch, *, dry_run=False):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "published.js")
            Path(out).write_text("untouched", encoding="utf-8")
            original = Path(out).read_text(encoding="utf-8")
            pt = FakePublish(entries)
            ts = type("TMDB", (), {
                "fetch_typed": staticmethod(detail_fetch),
                "tmdb_get": staticmethod(lambda *_: {"results": {}}),
            })()
            recorder = Recorder()
            args = ["refresh-metadata.py", "--key", "mock", "--out", out]
            if dry_run:
                args.append("--dry-run")
            with patch.object(refresh, "read_key", return_value="mock"), \
                 patch.object(refresh, "load_module", side_effect=[pt, ts]), \
                 patch.object(refresh, "step_runs", recorder), \
                 patch.object(sys, "argv", args), \
                 patch.object(refresh.time, "sleep"), \
                 contextlib.redirect_stdout(io.StringIO()):
                code = refresh.main()
            return code, recorder, pt, Path(out).read_text(encoding="utf-8"), original

    def test_all_detail_requests_fail_records_failed_and_preserves_data(self):
        def fail(*_):
            raise RuntimeError("mock source outage")
        code, recorder, pt, contents, original = self.run_refresh(
            {"1": entry(), "2": entry(id="2", title="Second")}, fail)
        self.assertEqual(code, 1)
        self.assertEqual(pt.writes, 0)
        self.assertEqual(contents, original)
        kwargs = recorder.calls[0][1]
        self.assertEqual(kwargs["status"], "failed")
        self.assertEqual(kwargs["reason"], "source-fail")
        self.assertEqual(kwargs["checked"]["valid"], 0)
        self.assertEqual(kwargs["checked"]["failed"], 2)

    def test_empty_candidate_run_records_success(self):
        code, recorder, pt, contents, original = self.run_refresh({}, lambda *_: None)
        self.assertEqual(code, 0)
        self.assertEqual(pt.writes, 0)
        self.assertEqual(contents, original)
        self.assertEqual(recorder.calls[0][1]["status"], "success")
        self.assertEqual(recorder.calls[0][1]["reason"], "no-new-data")

    def test_dry_run_does_not_write_or_record(self):
        code, recorder, pt, contents, original = self.run_refresh(
            {"1": entry()}, lambda *_: {"overview": "fresh"}, dry_run=True)
        self.assertEqual(code, 0)
        self.assertEqual(pt.writes, 0)
        self.assertEqual(recorder.calls, [])
        self.assertEqual(contents, original)


class ProviderOutcomeTests(unittest.TestCase):
    def run_backfill(self, entries, fetch, *, apply=True):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "published.js")
            Path(out).write_text("untouched", encoding="utf-8")
            original = Path(out).read_text(encoding="utf-8")
            pt = FakePublish(entries)
            ts = FakeSeed(pt, fetch)
            recorder = Recorder()
            args = ["backfill_providers.py", "--key", "mock", "--out", out]
            args += ["--apply"] if apply else ["--dry-run"]
            with patch.object(backfill, "load_title_seed", return_value=ts), \
                 patch.object(backfill, "step_runs", recorder), \
                 patch.object(sys, "argv", args), \
                 patch.object(backfill.time, "sleep"), \
                 contextlib.redirect_stdout(io.StringIO()):
                code = backfill.main()
            return code, recorder, pt, Path(out).read_text(encoding="utf-8"), original

    def test_all_provider_requests_fail_records_failed_and_preserves_data(self):
        def fail(*_):
            raise RuntimeError("mock provider outage")
        code, recorder, pt, contents, original = self.run_backfill(
            {"1": entry(providers=[])}, fail)
        self.assertEqual(code, 1)
        self.assertEqual(pt.writes, 1)  # unchanged snapshot remains last-good
        self.assertEqual(contents, original)
        kwargs = recorder.calls[0][1]
        self.assertEqual(kwargs["status"], "failed")
        self.assertEqual(kwargs["reason"], "source-fail")
        self.assertEqual(kwargs["checked"]["failed"], 1)

    def test_valid_empty_provider_response_is_successful(self):
        code, recorder, pt, _contents, _original = self.run_backfill(
            {"1": entry(providers=[])}, lambda *_: [])
        self.assertEqual(code, 0)
        self.assertEqual(pt.entries["1"]["providers"], [])
        self.assertEqual(recorder.calls[0][1]["status"], "success")

    def test_no_missing_providers_is_explicit_unchanged_check(self):
        code, recorder, _pt, _contents, _original = self.run_backfill(
            {"1": entry()}, lambda *_: self.fail("must not fetch"))
        self.assertEqual(code, 0)
        checked = recorder.calls[0][1]["checked"]
        self.assertEqual(checked["processed"], 0)
        self.assertIn("not a new upstream fetch", checked["detail"])
        self.assertEqual(recorder.calls[0][1]["reason"], "no-new-data")

    def test_dry_run_does_not_write_or_record(self):
        code, recorder, pt, contents, original = self.run_backfill(
            {"1": entry(providers=[])}, lambda *_: [], apply=False)
        self.assertEqual(code, 0)
        self.assertEqual(pt.writes, 0)
        self.assertEqual(recorder.calls, [])
        self.assertEqual(contents, original)


if __name__ == "__main__":
    unittest.main()
