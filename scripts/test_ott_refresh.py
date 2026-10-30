#!/usr/bin/env python3
"""Regression tests for the permanent OTT refresh (owner order
2026-10-30): persistent digital dates, bounded prioritised fetch,
date-only Coming entries, popularity tie-breaks, and the categorical
Pakistani exclusion in the data build. Mock-only: no network."""
import importlib.util, json, os, sys, tempfile, types
from datetime import date
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def load(name, file):
    s = importlib.util.spec_from_file_location(name, os.path.join(HERE, file))
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


sys.modules['step_runs'] = types.SimpleNamespace(record=lambda *a, **k: None)
sched = types.ModuleType('pipeline_schedule')
sched.record_source = lambda *a, **k: None
sys.modules['pipeline_schedule'] = sched
ott = load('build_ott_refresh_test', 'build_ott.py')

passn = 0


def check(name, condition):
    global passn
    if not condition:
        raise AssertionError(name)
    passn += 1


NF = [{'name': 'Netflix', 'logo_path': '/n.png'}]
REG = {'Netflix': '/n.png', 'Amazon Prime Video': '/a.png'}
TODAY = '2026-10-30'

# --- 1. Mixed-year Now: strictly newest OTT date first per the data
# build; popularity only breaks same-date ties, never lifts an older
# title above a newer one.
pub = {
    'a': {'id': 101, 'type': 'movie', 'release_date': '2026-09-10',
          'providers': NF, 'popularity': 5},
    'b': {'id': 102, 'type': 'movie', 'release_date': '2025-06-15',
          'providers': NF, 'popularity': 50},
    'c': {'id': 103, 'type': 'movie', 'release_date': '2024-03-01',
          'providers': NF, 'popularity': 99},
    'd': {'id': 104, 'type': 'movie', 'release_date': '2026-09-10',
          'providers': NF, 'popularity': 20},
    'e': {'id': 105, 'type': 'movie', 'release_date': '2026-09-10',
          'providers': NF, 'popularity': 3},
}
now, coming, _ = ott.classify(pub, TODAY, {}, REG)
check('mixed-year Now order is date desc, popularity tie-break',
      [x['id'] for x in now] == [104, 101, 105, 102, 103])
check('mixed-year Now has no Coming leakage', coming == [])

# --- 2. Coming fills both industries, soonest first; a confirmed date
# whose note names no provider survives as a date-only entry.
pub2 = {
    'a': {'id': 201, 'type': 'movie', 'release_date': '2026-12-01',
          'providers': []},
    'b': {'id': 202, 'type': 'movie', 'release_date': '2026-12-05',
          'providers': []},
    'c': {'id': 203, 'type': 'movie', 'release_date': '2026-12-03',
          'providers': []},
}
digital2 = {
    '201': {'date': '2026-11-02', 'country': 'IN', 'note': 'Netflix'},
    '202': {'date': '2026-11-01', 'country': 'US', 'note': ''},
    '203': {'date': '2026-11-03', 'country': 'GB', 'note': 'Prime Video'},
}
now2, coming2, _ = ott.classify(pub2, TODAY, digital2, REG)
check('Coming is soonest-first across industries',
      [x['id'] for x in coming2] == [202, 201, 203])
check('named platform is attached from the note',
      coming2[1]['providers'] == [{'name': 'Netflix', 'logo_path': '/n.png'}])
check('unnamed platform stays a date-only entry (no guessed logo)',
      coming2[0]['providers'] == [] and coming2[0]['date_kind'] == 'digital')
check('note alias resolves to the registry provider',
      coming2[2]['providers'] == [{'name': 'Amazon Prime Video',
                                   'logo_path': '/a.png'}])
check('future titles without providers are not in Now', now2 == [])

# --- 3. Pakistani dramas never enter either pool, even with a
# PK-region provider list; an Indian Urdu title is NOT excluded.
pub3 = {
    'drama': {'id': 301, 'type': 'tv', 'first_air_date': '2026-09-01',
              'providers': NF, 'industry': 'pakistani',
              'origin_country': ['PK'], 'original_language': 'ur'},
    'pkmovie': {'id': 302, 'type': 'movie', 'release_date': '2026-10-01',
                'providers': [{'name': 'Paramount Plus',
                               'logo_path': '/p.png'}],
                'industry': 'pakistani', 'origin_country': ['PK', 'GB'],
                'original_language': 'en'},
    'urdu_in': {'id': 303, 'type': 'movie', 'release_date': '2026-10-05',
                'providers': NF, 'industry': 'bollywood',
                'origin_country': ['IN'], 'original_language': 'ur'},
    'series': {'id': 304, 'type': 'tv', 'first_air_date': '2026-10-01',
               'providers': NF, 'industry': 'bollywood',
               'origin_country': ['IN'], 'original_language': 'hi'},
}
now3, coming3, _ = ott.classify(pub3, TODAY, {}, REG)
ids3 = {x['id'] for x in now3} | {x['id'] for x in coming3}
check('Pakistani drama is in neither OTT pool', 301 not in ids3)
check('Pakistani movie is excluded like the render rule', 302 not in ids3)
check('Indian Urdu movie stays in Now', 303 in {x['id'] for x in now3})
check('Indian TV series stays in Now', 304 in {x['id'] for x in now3})

# --- 4. A title already streaming does not double-list in Coming for
# another region's future premiere; a not-yet-streaming title with the
# same evidence does.
pub4 = {
    'a': {'id': 701, 'type': 'movie', 'release_date': '2026-10-29',
          'providers': [{'name': 'Amazon Prime Video',
                         'logo_path': '/a.png'}]},
    'b': {'id': 702, 'type': 'movie', 'release_date': '2026-12-01',
          'providers': []},
}
digital4 = {'701': {'date': '2026-11-10', 'country': 'US', 'note': ''},
            '702': {'date': '2026-11-10', 'country': 'US', 'note': ''}}
now4, coming4, _ = ott.classify(pub4, TODAY, digital4, REG)
check('already-streaming title stays Now-only',
      [x['id'] for x in now4] == [701] and coming4 == [
          {'id': 702, 'type': 'movie', 'providers': [],
           'date': '2026-11-10', 'date_kind': 'digital', 'country': 'US'}])

# --- 5/6/7. fetch_digital: past dates persist, the fetch is bounded,
# unfetched records survive the merge, pending premieres go first.
def rd(results_by_country):
    return {'results': [{'iso_3166_1': c, 'release_dates': rds}
                        for c, rds in results_by_country]}


RESPONSES = {
    '/watch/providers/movie': {'results': [
        {'provider_name': 'Netflix', 'logo_path': '/n.png'},
        {'provider_name': 'Amazon Prime Video', 'logo_path': '/a.png'}]},
    '/movie/201/release_dates': rd([('IN', [{'type': 4,
        'release_date': '2026-11-02T00:00:00.000Z', 'note': 'Netflix'}])]),
    '/movie/202/release_dates': rd([('US', [{'type': 4,
        'release_date': '2026-11-01T00:00:00.000Z', 'note': ''}])]),
    '/movie/401/release_dates': rd([('US', [{'type': 4,
        'release_date': '2026-10-20T00:00:00.000Z', 'note': 'Netflix'}])]),
    '/movie/599/release_dates': rd([('US', [{'type': 4,
        'release_date': '2026-11-06T00:00:00.000Z', 'note': 'Netflix'}])]),
}

pubf = {'201': {'id': 201, 'type': 'movie', 'release_date': '2026-12-01'},
        '202': {'id': 202, 'type': 'movie', 'release_date': '2026-12-05'},
        '401': {'id': 401, 'type': 'movie', 'release_date': '2026-09-01'},
        '599': {'id': 599, 'type': 'movie', 'release_date': '2020-05-01'},
        '598': {'id': 598, 'type': 'movie', 'release_date': '2019-04-01'}}
# 80 stalest-group fillers so the budget really binds.
for i in range(600, 680):
    pubf[str(i)] = {'id': i, 'type': 'movie', 'release_date': '2019-06-01'}

prior_cache = {
    'fetched_at': '2026-10-29T00:00:00Z', 'days': 30,
    'digital': {'599': {'date': '2026-11-06', 'country': 'US',
                        'note': 'Netflix'},
                '598': {'date': '2026-10-01', 'country': 'US',
                        'note': 'Netflix'}},
    'registry': {'Netflix': '/n.png'},
    'checked': {'598': '2026-10-29T12:00:00Z'},
}

oldget = ott.tmdb_get
calls = []


def mock_get(path, key):
    calls.append(path)
    return RESPONSES.get(path, {'results': []})


try:
    ott.tmdb_get = mock_get
    with tempfile.TemporaryDirectory() as d:
        cache = os.path.join(d, 'ott-digital.json')
        json.dump(prior_cache, open(cache, 'w'))
        # Pending premieres are re-verified first: budget 1 buys 599.
        calls.clear()
        dig1, _ = ott.fetch_digital(pubf, 'k', date(2026, 10, 30), 30,
                                    cache, refresh=True, budget=1)
        rd_calls = [c for c in calls if 'release_dates' in c]
        check('budget 1 fetches only the pending premiere',
              rd_calls == ['/movie/599/release_dates'])
        check('pending premiere record kept after re-verification',
              dig1.get('599', {}).get('date') == '2026-11-06')
        # Full-budget run: bounded, merges, and keeps past dates.
        json.dump(prior_cache, open(cache, 'w'))
        calls.clear()
        dig2, reg2 = ott.fetch_digital(pubf, 'k', date(2026, 10, 30), 30,
                                       cache, refresh=True, budget=64)
        rd_calls = [c for c in calls if 'release_dates' in c]
        check('release_dates calls stay within budget', len(rd_calls) <= 64)
        check('future IN date stored', dig2.get('201', {}).get('date')
              == '2026-11-02')
        check('future empty-note date stored', dig2.get('202', {}).get(
            'date') == '2026-11-01')
        check('PAST digital date is kept, not dropped',
              dig2.get('401', {}).get('date') == '2026-10-20')
        check('unfetched stale record survives the merge',
              dig2.get('598', {}).get('date') == '2026-10-01')
        saved = json.load(open(cache))
        check('cache file persists past dates too',
              saved['digital'].get('401', {}).get('date') == '2026-10-20')
        check('cache records per-title check stamps',
              '401' in (saved.get('checked') or {}))
        # The stored past date now drives the Now entry.
        pub401 = {'401': {'id': 401, 'type': 'movie',
                          'release_date': '2026-09-01', 'providers': NF}}
        now5, _, _ = ott.classify(pub401, TODAY, dig2, reg2)
        check('Now uses the real digital date, not the theatrical date',
              len(now5) == 1 and now5[0]['date'] == '2026-10-20'
              and now5[0]['date_kind'] == 'digital')
finally:
    ott.tmdb_get = oldget

print(f'PASS: {passn} OTT refresh tests')
