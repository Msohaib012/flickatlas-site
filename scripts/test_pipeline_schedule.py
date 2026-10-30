#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline_schedule as p
import run_source as r


def at(hour, minute=35, day=29):
    return datetime(2026, 10, day, hour, minute, tzinfo=timezone.utc)


class Gates(unittest.TestCase):
    def test_clock_only_without_state(self):
        self.assertTrue(p.due('trending_worldwide', {}, at(6)))
        self.assertFalse(p.due('trending_worldwide', {}, at(7)))
        self.assertFalse(p.due('metadata_refresh', {}, at(18)))
        self.assertTrue(p.due('metadata_refresh', {}, at(6)))
        self.assertTrue(p.due('trending_weekly', {}, at(12)))
        self.assertTrue(p.due('trending_weekly', {}, at(18)))

    def test_tavily_gemini_preserves_existing_two_hourly_slots(self):
        policy = p.POLICIES['tavily_boxoffice']
        self.assertEqual(policy['hours'], [8, 18])
        self.assertEqual(policy['interval_hours'], 12)
        self.assertEqual([(hour + 5) % 24 for hour in policy['hours']],
                         [13, 23])
        for hour in (8, 18):
            self.assertTrue(p.due('tavily_boxoffice', {}, at(hour)))
        for hour in (9, 13, 17, 20):
            self.assertFalse(p.due('tavily_boxoffice', {}, at(hour)))

    def test_success_only_catchup_and_duplicate_suppression(self):
        rec = {'last_success': p.iso(at(0)), 'last_run': p.iso(at(0)), 'last_status': 'success'}
        self.assertFalse(p.due('trending_worldwide', rec, at(7)))
        self.assertTrue(p.due('trending_worldwide', rec, at(8)))
        self.assertFalse(p.due('trending_worldwide', {'last_success': p.iso(at(6)),
                          'last_attempt_at': p.iso(at(6)), 'last_status': 'success'}, at(6, 50)))
        self.assertFalse(p.due('title_seed', {'last_run': p.iso(at(0)),
                          'last_status': 'skipped'}, at(14)))

    def test_invalid_and_future_times_do_not_bootstrap(self):
        for value in ('bad', '2099-01-01T00:00:00Z', None):
            self.assertFalse(p.due('trending_worldwide', {'last_success': value}, at(7)))

    def test_source_backoff_and_episode_window(self):
        rec = {'last_status': 'failed', 'last_attempt_at': p.iso(at(8))}
        self.assertFalse(p.due('moviemint_boxoffice', rec, at(9)))
        self.assertTrue(p.due('moviemint_boxoffice', rec, at(8, day=30)))
        rec = {'last_status': 'success', 'last_success': p.iso(at(19, day=28))}
        self.assertFalse(p.due('episode_guides', rec, at(4)))
        self.assertTrue(p.due('episode_guides', rec, at(13)))

    def test_failure_does_not_advance_success(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / 'state.json'
            p.record_source('trending_worldwide', True, state_path=path, now=at(0))
            p.record_source('trending_worldwide', False, 'api_key=redacted-test', state_path=path, now=at(6))
            rec = p.load(path)['steps']['trending_worldwide']
            self.assertEqual(rec['last_success'], p.iso(at(0)))
            self.assertEqual(rec['last_attempt_at'], p.iso(at(6)))
            self.assertNotIn('redacted-test', path.read_text())

    def test_environment_keeps_skipped_and_failed_source_honest(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            p.save(root / 'out/orchestrator-state.json', {'steps': {'title_seed': {
                'last_run': p.iso(at(6)), 'last_success': p.iso(at(6)), 'last_status': 'success'}}})
            p.save(root / 'out/step-runs.json', {'steps': {'trending_weekly': [
                {'run_id': 'test', 'status': 'failed', 'reason': 'source-fail'}]}})
            env = {'RUN_TITLE': 'false', 'RUN_TRENDING': 'true',
                   'TRENDING_OUTCOME': 'success', 'GITHUB_RUN_ID': 'test'}
            state = p.record_environment(root, env, at(12))
            self.assertEqual(state['steps']['title_seed']['last_run'], p.iso(at(6)))
            self.assertEqual(state['steps']['trending_weekly']['last_status'], 'failed')
            self.assertNotIn('last_success', state['steps']['trending_weekly'])

    def test_aggregate_shell_cannot_freshen_failed_source(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            p.save(root / 'out/source-refresh-state.json', {'steps': {'sacnilk_boxoffice': {
                'last_attempt_at': p.iso(at(12)), 'last_status': 'failed'}}})
            env = {'RUN_SACNILK': 'true', 'SACNILK_OUTCOME': 'success'}
            rec = p.record_environment(root, env, at(12))['steps']['sacnilk_boxoffice']
            self.assertEqual(rec['last_status'], 'failed')
            self.assertNotIn('last_success', rec)

    def test_repeated_failures_back_off_without_losing_last_good(self):
        rec = {'last_status': 'failed', 'consecutive_failures': 3,
               'last_attempt_at': p.iso(at(0)), 'last_success': p.iso(at(0, day=28))}
        self.assertFalse(p.due('trending_worldwide', rec, at(2)))
        self.assertTrue(p.due('trending_worldwide', rec, at(8)))


class SourceStaging(unittest.TestCase):
    def row(self, day=1, value=3):
        return {'day': day, 'date': f'2026-10-{day:02d}', 'collection_inr_cr': value, 'source': 'fnn'}

    def test_failed_empty_and_unchanged_checks(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            state, stage = root / 'state.json', root / 'stage'
            stage.mkdir()
            p.save(stage / 'fnn.json', {'1': [self.row()]})
            original = (stage / 'fnn.json').read_bytes()
            def empty(argv, **kwargs):
                return SimpleNamespace(returncode=0, stderr='')
            self.assertEqual(r.execute('fnn_boxoffice', ['test', '{stage}'], stage,
                                      state_path=state, now=at(8), runner=empty), 1)
            self.assertEqual((stage / 'fnn.json').read_bytes(), original)
            self.assertNotIn('last_success', p.load(state)['steps']['fnn_boxoffice'])
            def success(argv, **kwargs):
                p.save(Path(argv[1]) / 'fnn.json', {'1': [self.row()]})
                return SimpleNamespace(returncode=0, stderr='')
            self.assertEqual(r.execute('fnn_boxoffice', ['test', '{stage}'], stage,
                                      state_path=state, now=at(12), runner=success), 0)
            self.assertEqual((stage / 'fnn.json').read_bytes(), original)
            self.assertEqual(p.load(state)['steps']['fnn_boxoffice']['last_success'], p.iso(at(12)))
            with patch.object(r.subprocess, 'run', side_effect=AssertionError('not due')):
                self.assertEqual(r.execute('fnn_boxoffice', ['no-network'], stage,
                                          state_path=state, now=at(12, 50)), 0)

    def test_merge_retains_historical_days_and_rejects_invalid(self):
        merged = r.merge_data({'1': [self.row()]}, {'1': [self.row(2, 4)], '2': [{'day': 0}]})
        self.assertEqual([x['day'] for x in merged['1']], [1, 2])
        self.assertNotIn('2', merged)
        self.assertEqual(r.valid_data({'1': [self.row(value=float('nan'))]}), {})


class PublicPolicy(unittest.TestCase):
    def test_export_reports_tavily_slots_and_hourly_offset(self):
        with tempfile.TemporaryDirectory() as td:
            value = p.export_public(td)
            check = value['checks']['tavily_boxoffice']
            self.assertEqual(check['hours_utc'], [8, 18])
            self.assertEqual(check['hours_pkt'], [13, 23])
            self.assertIn(':35 UTC', value['scheduler'])
            boxoffice = next(c for c in value['cycles'] if c['id'] == 'boxoffice')
            self.assertIn('tavily_boxoffice', boxoffice['sources'])
            for slot in ('13:35', '23:35'):
                self.assertIn(slot, boxoffice['cadence'])


if __name__ == '__main__':
    unittest.main()
