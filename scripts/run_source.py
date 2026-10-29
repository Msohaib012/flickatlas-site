#!/usr/bin/env python3
"""Run an existing direct reader only when due; stage valid results atomically.

Fresh temporary staging distinguishes a successful unchanged check from an
old retained file. Empty/failed readers never erase last-good staged data.
"""
import argparse
from datetime import date
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from pipeline_schedule import SOURCE_STATE, load, record_source, save, source_due


def valid_data(data):
    if not isinstance(data, dict):
        return {}
    clean = {}
    for tid, rows in data.items():
        if not str(tid).isdigit() or not isinstance(rows, list):
            continue
        accepted = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            value, day = row.get('collection_inr_cr'), row.get('day')
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                continue
            if isinstance(day, bool) or not isinstance(day, int) or day < 1:
                continue
            try:
                date.fromisoformat(row.get('date') or '')
            except (ValueError, TypeError):
                continue
            accepted.append(row)
        if accepted:
            clean[str(tid)] = accepted
    return clean


def merge_data(previous, incoming):
    merged = valid_data(previous)
    for tid, rows in valid_data(incoming).items():
        days = {(r['date'], r['day']): r for r in merged.get(tid, [])}
        for row in rows:
            days[(row['date'], row['day'])] = row
        merged[tid] = sorted(days.values(), key=lambda r: (r['date'], r['day']))
    return merged


def execute(name, command, stage_dir='out/boxoffice-staging', reviews_out=None,
            state_path=SOURCE_STATE, now=None, runner=None):
    if not source_due(name, state=load(state_path), now=now):
        print(f'{name}: source gate off; local averaging may still run')
        return 0
    runner = runner or subprocess.run
    try:
        with tempfile.TemporaryDirectory(prefix='flickatlas-source-') as tmp:
            tmp = Path(tmp)
            stage = tmp / 'stage'
            stage.mkdir()
            replacements = {'{stage}': str(stage), '{out}': str(tmp / 'output.json'),
                            '{reviews}': str(tmp / 'reviews.json')}
            argv = [replacements.get(part, part) for part in command]
            result = runner(argv, text=True, capture_output=True, check=False)
            # Reader diagnostics, not their entire duplicate JSON output.
            if result.stderr:
                print('\n'.join(result.stderr.splitlines()[-80:]), file=sys.stderr)
            if result.returncode:
                record_source(name, False, 'reader process failed; last-good staging retained',
                              state_path=state_path, now=now)
                return result.returncode
            incoming = []
            for path in sorted(stage.glob('*.json')):
                if not re.fullmatch(r'[a-z0-9-]+\.json', path.name):
                    continue
                clean = valid_data(load(path))
                if clean:
                    incoming.append((path.name, clean))
            if not incoming:
                record_source(name, False, 'no valid nonempty source staging; last-good retained',
                              state_path=state_path, now=now)
                print(f'{name}: no validated data; successful-check time unchanged')
                return 1
            changed, count = 0, 0
            for filename, data in incoming:
                dest = Path(stage_dir) / filename
                merged = merge_data(load(dest), data)
                changed += bool(save(dest, merged))
                count += sum(len(rows) for rows in data.values())
            if reviews_out:
                reviews = load(tmp / 'reviews.json')
                if reviews:
                    old = load(reviews_out)
                    old.update(reviews)
                    save(reviews_out, old)
            record_source(name, True, f'validated {count} rows; {changed} staging files changed',
                          state_path=state_path, now=now)
            print(f'{name}: successful check; {count} rows, {changed} changed files')
            return 0
    except Exception as exc:
        # Do not persist exception URLs/credentials in tracked public state.
        record_source(name, False, 'reader error; last-good staging retained',
                      state_path=state_path, now=now)
        print(f'{name}: reader error ({type(exc).__name__}); last-good retained', file=sys.stderr)
        return 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stage-dir', default='out/boxoffice-staging')
    ap.add_argument('--reviews-out')
    ap.add_argument('name')
    ap.add_argument('command', nargs=argparse.REMAINDER)
    args = ap.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        ap.error('an existing source-reader command is required')
    return execute(args.name, command, args.stage_dir, args.reviews_out)


if __name__ == '__main__':
    raise SystemExit(main())
