#!/usr/bin/env python3
"""Source checks for the existing hourly workflow, not a second scheduler.

Clock slots are UTC. Missing state is clock-only; failed/empty checks never
advance last_success. A missed slot permits one bounded catch-up, not replay.
"""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SOURCE_STATE = ROOT / 'out/source-refresh-state.json'
ORCHESTRATOR_STATE = ROOT / 'out/orchestrator-state.json'

def policy(hours, interval, retry=1, **extra):
    return dict(hours=list(hours), interval_hours=interval,
                retry_hours=retry, **extra)

POLICIES = {
    'episode_guides': policy((13, 15, 17, 19), 6, active_hours=list(range(13, 20))),
    'title_seed': policy((6, 18), 12),
    'trending_worldwide': policy((0, 6, 12, 18), 6),
    'sacnilk_boxoffice': policy((2, 5, 8, 11, 14, 17, 20, 23), 3, retry=3),
    'fnn_boxoffice': policy((0, 4, 8, 12, 16, 20), 4, retry=4),
    'wp_boxoffice': policy((0, 6, 12, 18), 6, retry=6),
    'bollybourse_boxoffice': policy((0, 6, 12, 18), 6, retry=6),
    'filmibeat_boxoffice': policy((0, 6, 12, 18), 6, retry=6),
    'moviemint_boxoffice': policy((8,), 24, retry=24),
    'tavily_boxoffice': policy((8, 18), 12),
    'gemini_reviews': policy((19,), 24),
    'trending_weekly': policy(range(24), 1),
    'overseas_ai': policy((8,), 24),
    'stats_pipeline': policy((0, 6, 12, 18), 6),
    'stats_health': policy((6,), 24),
    'metadata_refresh': policy((6,), 24),
    'providers_backfill': policy((2,), 24),
    'ott_digital': policy((0, 12), 12),
    'keywords_refresh': policy((3,), 24),
}
FLAGS = {
    'run_episode': 'episode_guides', 'run_title': 'title_seed',
    'run_worldwide': 'trending_worldwide', 'run_sacnilk': 'sacnilk_boxoffice',
    'run_tavily': 'tavily_boxoffice', 'run_reviews': 'gemini_reviews',
    'run_trending': 'trending_weekly', 'run_overseas': 'overseas_ai',
    'run_stats_pipeline': 'stats_pipeline', 'run_stats_health': 'stats_health',
    'run_metadata': 'metadata_refresh', 'run_providers': 'providers_backfill',
    'run_digital': 'ott_digital', 'run_keywords': 'keywords_refresh',
}
SOURCE_NAMES = {'trending_worldwide', 'sacnilk_boxoffice', 'fnn_boxoffice',
                'wp_boxoffice', 'bollybourse_boxoffice', 'filmibeat_boxoffice',
                'moviemint_boxoffice', 'ott_digital'}


def parse_time(value):
    try:
        dt = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return (dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else
                dt.astimezone(timezone.utc))
    except (TypeError, ValueError):
        return None


def utc_now(now=None):
    if now is None:
        return datetime.now(timezone.utc)
    return now.replace(tzinfo=timezone.utc) if now.tzinfo is None else now.astimezone(timezone.utc)


def iso(now):
    return utc_now(now).strftime('%Y-%m-%dT%H:%M:%SZ')


def load(path):
    try:
        value = json.loads(Path(path).read_text(encoding='utf-8'))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(value, ensure_ascii=False, indent=1) + '\n'
    if path.exists() and path.read_text(encoding='utf-8') == content:
        return False
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(content, encoding='utf-8')
    os.replace(tmp, path)
    return True


def successful_time(rec):
    value = rec.get('last_success') or rec.get('last_success_at')
    if not value and rec.get('last_status') == 'success':
        value = rec.get('last_run')
    return parse_time(value)


def due(name, rec=None, now=None):
    """Pure gate. Failed attempts have bounded backoff; unknown state never bootstraps."""
    now, rec, p = utc_now(now), rec or {}, POLICIES[name]
    if p.get('active_hours') and now.hour not in p['active_hours']:
        return False
    attempt = parse_time(rec.get('last_attempt_at') or rec.get('last_run'))
    success = successful_time(rec)
    if attempt and attempt > now:
        attempt = None
    if success and success > now:
        success = None
    failures = max(1, int(rec.get('consecutive_failures') or 1))
    retry_hours = min(p['interval_hours'], p['retry_hours'] * 2 ** min(failures - 1, 6))
    if attempt:
        elapsed = (now - attempt).total_seconds()
        if elapsed < 3600:
            return False
        if rec.get('last_status') in ('failed', 'no-data') and elapsed < retry_hours * 3600:
            return False
    if now.hour in p['hours']:
        return True
    if success:
        return (now - success).total_seconds() > (p['interval_hours'] + 1) * 3600
    return bool(attempt and rec.get('last_status') in ('failed', 'no-data')
                and (now - attempt).total_seconds() >= retry_hours * 3600)


def source_due(name, state=None, now=None):
    state = load(SOURCE_STATE) if state is None else state
    return due(name, (state.get('steps', {}).get(name) or {}), now)


def record_source(name, success, detail='', state_path=None, now=None):
    """Only callers that validated upstream data may claim a successful check."""
    path = state_path or SOURCE_STATE
    state, stamp = load(path), iso(utc_now(now))
    rec = state.setdefault('steps', {}).setdefault(name, {})
    rec.update(last_attempt_at=stamp, last_run=stamp,
               last_status='success' if success else 'failed')
    if success:
        rec['last_success'] = stamp
    rec['consecutive_failures'] = 0 if success else int(rec.get('consecutive_failures') or 0) + 1
    # No keys/query credentials may enter public tracked state.
    detail = re.sub(r'(?i)(api[_-]?key|access_token|token|authorization)([=:\s]+)[^&\s]+',
                    r'\1\2[redacted]', str(detail))
    rec['detail'] = detail[:180]
    state['updated_at'] = stamp
    save(path, state)
    return rec


def decide(state=None, source_state=None, now=None):
    state = load(ORCHESTRATOR_STATE) if state is None else state
    source_state = load(SOURCE_STATE) if source_state is None else source_state
    flags = {}
    for flag, name in FLAGS.items():
        pool = source_state if name in SOURCE_NAMES else state
        # This is a cheap local intersection, not an upstream API call.
        flags[flag] = True if name == 'trending_weekly' else due(
            name, pool.get('steps', {}).get(name) or {}, now)
    return flags


GATED_ENV = {
    'episode_guides': ('RUN_EPISODE', 'EPISODE_OUTCOME'),
    'title_seed': ('RUN_TITLE', 'TITLE_OUTCOME'),
    'sacnilk_boxoffice': ('RUN_SACNILK', 'SACNILK_OUTCOME'),
    'tavily_boxoffice': ('RUN_TAVILY', 'TAVILY_OUTCOME'),
    'overseas_ai': ('RUN_OVERSEAS', 'OVERSEAS_OUTCOME'),
    'gemini_reviews': ('RUN_REVIEWS', 'REVIEWS_OUTCOME'),
    'trending_weekly': ('RUN_TRENDING', 'TRENDING_OUTCOME'),
    'stats_pipeline': ('RUN_STATS_PIPE', 'STATS_PIPE_OUTCOME'),
    'stats_health': ('RUN_HEALTH', 'HEALTH_OUTCOME'),
    'metadata_refresh': ('RUN_METADATA', 'METADATA_OUTCOME'),
    'providers_backfill': ('RUN_PROVIDERS', 'PROVIDERS_OUTCOME'),
    'keywords_refresh': ('RUN_KEYWORDS', 'KEYWORDS_OUTCOME'),
}
HOURLY_ENV = {'fetch': 'FETCH_OUTCOME', 'gemini_batch': 'GEMINI_OUTCOME',
              'apply_auto': 'APPLY_OUTCOME', 'publish': 'PUBLISH_OUTCOME',
              'convert_news': 'FEED_OUTCOME', 'stats_traffic': 'TRAFFIC_OUTCOME',
              'multisource_boxoffice': 'MULTISOURCE_OUTCOME', 'version_bump': 'BUMP_OUTCOME'}


def record_environment(root=ROOT, env=None, now=None):
    env, root, now = os.environ if env is None else env, Path(root), utc_now(now)
    path = root / 'out/orchestrator-state.json'
    state = load(path)
    steps = state.setdefault('steps', {})
    runs = load(root / 'out/step-runs.json').get('steps', {})
    plan = dict(HOURLY_ENV)
    plan.update({k: outcome for k, (flag, outcome) in GATED_ENV.items()
                 if env.get(flag) == 'true'})
    for name, outcome_var in plan.items():
        if name in SOURCE_NAMES:
            continue  # Only the validated source-owned record below is authoritative.
        outcome = env.get(outcome_var) or 'unknown'
        if outcome == 'skipped':
            continue
        rec = steps.setdefault(name, {})
        actual = [r for r in runs.get(name, [])
                  if env.get('GITHUB_RUN_ID') and r.get('run_id') == env['GITHUB_RUN_ID']]
        status = actual[-1].get('status') if actual else outcome
        reason = actual[-1].get('reason') if actual else None
        if reason in ('source-fail', 'error'):
            status = 'failed'
        rec.update(last_run=iso(now), last_attempt_at=iso(now), last_status=status)
        if status in ('failed', 'no-data'):
            rec['consecutive_failures'] = int(rec.get('consecutive_failures') or 0) + 1
        if status == 'success' and reason not in ('source-fail', 'error'):
            rec['last_success'] = iso(now)
            rec['consecutive_failures'] = 0
    # Individual readers, not their aggregate shell outcome, own source freshness.
    for name, rec in load(root / 'out/source-refresh-state.json').get('steps', {}).items():
        steps.setdefault(name, {}).update(rec)
    # Proof freshness is a successful evidence check, not the article's age.
    try:
        text = (root / 'js/trending-topics.js').read_text(encoding='utf-8')
        match = re.search(r'window\.FA_TRENDING_TOPICS\s*=\s*(\{.*\});?\s*$', text, re.S)
        payload = json.loads(match.group(1)) if match else {}
        checked = parse_time(payload.get('checked_at'))
        age = (now - checked).total_seconds() if checked else None
        stale = payload.get('status') != 'ok' or age is None or age < 0 or age > 3 * 3600
        topic_rec = steps.setdefault('trending_weekly', {})
        topic_rec.update(
            stale=stale,
            evidence_checked_at=iso(checked) if checked else None)
        if not stale:
            topic_rec['last_success'] = iso(checked)
    except (OSError, ValueError):
        steps.setdefault('trending_weekly', {})['stale'] = True
    state['updated_at'] = iso(now)
    save(path, state)
    return state


PUBLIC_CYCLES = [
    ('hero', 'Hero Banner', 'Title discovery every 12h; active/recent-title metadata daily (existing 50-title cap); selection rebuilt from published data.', ['title_seed', 'metadata_refresh'], 'Newest release first'),
    ('spotlight', 'Spotlight / Lollywood / Dramas', 'Title discovery every 12h; active/recent-title metadata daily (existing 50-title cap).', ['title_seed', 'metadata_refresh'], 'Newest release or first-air date first'),
    ('coming', 'Coming Soon / Most Awaited / Release Calendar', 'Title discovery every 12h; confirmed release dates checked daily.', ['title_seed', 'metadata_refresh'], 'Nearest upcoming date first'),
    ('ott', 'Now on OTT / OTT Coming Soon', 'Digital dates every 12h; active-title metadata and missing-provider enrichment daily; cached local display rebuilt hourly.', ['ott_digital', 'metadata_refresh', 'providers_backfill'], 'Now: newest first. Coming: nearest date first'),
    ('worldwide', 'Trending Worldwide', 'Global TMDB weekly top-20 checked every 6h; published movies only.', ['trending_worldwide'], 'Newest release first within the eligible global set'),
    ('topics', 'Trending Topics', 'Google Trends RSS (US/India) checked hourly; only fresh trend proof matching published articles. Old or unavailable proof hides the section.', ['trending_weekly'], 'Newest published article first, not search-volume rank'),
    ('boxoffice', 'Box Office', 'Tavily search + Gemini evidence review at 13:35 and 23:35 PKT via the existing :35 UTC hourly workflow; other readers keep their current cadence. Local averaging remains hourly.', ['sacnilk_boxoffice', 'fnn_boxoffice', 'wp_boxoffice', 'bollybourse_boxoffice', 'filmibeat_boxoffice', 'moviemint_boxoffice', 'tavily_boxoffice'], 'Newest movie release first'),
    ('news', 'News / Trailers / Awards news', 'Working RSS hourly; explicitly slow RSS every 6h; sitemap/homepage every 12h; unverified/blocked sources daily. External trend fallback daily.', [], 'Newest published article first'),
    ('episodes', 'Drama Episodes', 'Checks at 18:35, 20:35, 22:35 and 00:35 PKT; missed-slot recovery only in the evening window.', ['episode_guides'], 'Newest episode publication first'),
    ('reviews', 'Reviews / Keywords', 'Reviews and article-keyword refresh daily.', ['gemini_reviews', 'keywords_refresh'], 'Newest published item first; explicit rankings keep their own meaning'),
]


def export_public(root=ROOT):
    root = Path(root)
    state = load(root / 'out/orchestrator-state.json')
    sources = load(root / 'out/source-refresh-state.json')
    merged = dict(state.get('steps', {}))
    merged.update(sources.get('steps', {}))
    checks = {}
    for name, p in POLICIES.items():
        rec = merged.get(name, {})
        success = successful_time(rec)
        if name == 'trending_weekly':
            # Old runs used search coverage, not a real Google trend signal.
            # Only the new source-owned cache can establish this timestamp.
            proof = load(root / 'out/google-trends-evidence.json')
            real = proof.get('source') == 'google-rss'
            checked = parse_time(proof.get('checked_at')) if real else None
            status = proof.get('status') if real else 'not-yet-recorded'
            success = checked if status == 'ok' else None
            rec = {'last_run': iso(checked) if checked else None,
                   'last_status': 'success' if status == 'ok' else status}
        checks[name] = {'hours_utc': p['hours'],
                        'hours_pkt': [(h + 5) % 24 for h in p['hours']],
                        'interval_hours': p['interval_hours'],
                        'last_success': iso(success) if success else None,
                        'last_attempt': rec.get('last_attempt_at') or rec.get('last_run'),
                        'status': rec.get('last_status') or 'not-yet-recorded'}
    value = {'scheduler': 'Existing hourly workflow at :35 UTC; scheduled slots are targets, not guaranteed upstream update times.',
             'note': 'Checks do not guarantee a provider changed its data. Failures keep last-good data without advancing successful-check time. Editorial approval and publication caps are unchanged.',
             'cycles': [dict(id=i, label=label, cadence=cadence, sources=keys, order=order)
                        for i, label, cadence, keys, order in PUBLIC_CYCLES],
             'checks': checks}
    save(root / 'data/refresh-policy.json', value)
    return value


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('action', choices=('decide', 'record', 'export'))
    args = ap.parse_args()
    if args.action == 'decide':
        flags = decide()
        target = os.environ.get('GITHUB_OUTPUT')
        if target:
            with open(target, 'a', encoding='utf-8') as f:
                for name, value in flags.items():
                    f.write(f'{name}={str(value).lower()}\n')
        print(json.dumps(flags, sort_keys=True))
    elif args.action == 'record':
        record_environment()
        export_public()
    else:
        export_public()


if __name__ == '__main__':
    main()
