#!/usr/bin/env python3
"""Cadence-aware lightweight refresh of the worldwide TMDB snapshot."""
import argparse
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key")
    args = ap.parse_args()
    try:
        import pipeline_schedule
    except Exception as exc:
        print(f"refresh-trending: schedule helper unavailable: {exc}", file=sys.stderr)
        return 1
    if not pipeline_schedule.source_due("trending_worldwide"):
        print("refresh-trending: not due")
        return 0
    spec = importlib.util.spec_from_file_location("title_seed", os.path.join(HERE, "title-seed.py"))
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    key = mod.read_key(args)
    if not key:
        pipeline_schedule.record_source("trending_worldwide", False, "TMDB key unavailable")
        return 1
    ok = mod.refresh_trending(key, os.path.join(HERE, "..", "js"), False)
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
