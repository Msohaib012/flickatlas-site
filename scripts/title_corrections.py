#!/usr/bin/env python3
"""Committed title corrections (out/title-corrections.json).

Some TMDB facts are wrong or stale and the pipeline would keep
re-deriving them: refresh-metadata.py re-fetches TMDB details and
overwrites release_date/status from the fresh record, and
publish-titles.py rebuilds entries from TMDB on a manual republish.
A data-only edit to js/published-titles.js therefore does not
survive — the next refresh restores the TMDB value.

A correction in out/title-corrections.json wins over TMDB, the same
way out/boxoffice-corrections.json wins over staging means for box
office (2026-11-11). The file, not the code, is the authority:
remove an entry once TMDB (or an official source) carries the real
value, and the next refresh restores it naturally.

Format: {tmdb_id: {field: value, ..., "note": ..., "source": ...}}.
Only CORRECTABLE_FIELDS are applied; "note"/"source" are
documentation and never touch a record. An explicit "" clears a
field (a postponed film has no release date); that is deliberate
and differs from the refresh's _meaningful() guard, which never
blanks a field.

Writers that apply corrections (call apply_to_published / the
per-entry helper after building/merging, before writing):
  - scripts/refresh-metadata.py (the reverting path — critical)
  - scripts/publish-titles.py (manual republish)
title-seed.py needs none: it skips titles already in FA_PUBLISHED.
home_titles.py needs none: it projects from js/published-titles.js.

Stdlib only.
"""

import json
import os

CORRECTABLE_FIELDS = ("release_date", "first_air_date", "status",
                      "date_kind")
CORRECTIONS_FILENAME = "title-corrections.json"


def corrections_path(root):
    return os.path.join(root, "out", CORRECTIONS_FILENAME)


def load_corrections(root):
    """Read out/title-corrections.json. Missing/invalid -> {} (no-op)."""
    path = corrections_path(root)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"title-corrections: unreadable {path} ({e}) — ignoring")
        return {}
    if not isinstance(data, dict):
        print(f"title-corrections: {path} is not an object — ignoring")
        return {}
    out = {}
    for tid, corr in data.items():
        if not isinstance(corr, dict):
            continue
        fields = {k: v for k, v in corr.items()
                  if k in CORRECTABLE_FIELDS}
        if fields:
            out[str(tid)] = fields
    return out


def apply_one(entry, tid, corrections):
    """Apply the correction for one title to an entry dict in place.
    Returns the list of field names changed (including fields cleared
    to ""). Never invents a field: only whitelisted fields, only for
    ids present in the corrections file."""
    corr = (corrections or {}).get(str(tid))
    if not corr:
        return []
    changed = []
    for field, value in corr.items():
        if entry.get(field) != value:
            entry[field] = value
            changed.append(field)
    if changed:
        print(f"title-corrections: {tid} ({entry.get('title') or ''}) "
              f"-> {', '.join(sorted(changed))}")
    return changed


def apply_to_published(published, root):
    """Apply all corrections to a {tid: entry} map in place.
    Returns [(tid, [fields])] for every title corrected."""
    corrections = load_corrections(root)
    if not corrections:
        return []
    applied = []
    for tid, entry in (published or {}).items():
        if not isinstance(entry, dict):
            continue
        changed = apply_one(entry, tid, corrections)
        if changed:
            applied.append((str(tid), changed))
    return applied
