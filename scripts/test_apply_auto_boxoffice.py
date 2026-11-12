#!/usr/bin/env python3
"""Offline checks for the apply-auto box-office merge guards (fix 2026-11-12).

Covers apply_box_row_update: an update equalling the stored overseas
figure is skipped (Ramayana Day 7 was overwritten with its own overseas
$2,641,310); a normal update applies and never moves the stored date.
Run: python3 scripts/test_apply_auto_boxoffice.py
"""
import importlib.util
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "apply_auto", os.path.join(_HERE, "apply-auto.py"))
apply_auto = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(apply_auto)


def test_overseas_equal_update_skipped():
    hit = {"date": "2026-11-11", "day": "Day 7", "collection": 7464342,
           "overseas": 2641310}
    entry = {"date": "2026-11-12", "day": "Day 7", "collection": 2641310}
    assert apply_auto.apply_box_row_update(hit, entry, "Ramayana", 7) is False
    assert hit["collection"] == 7464342
    assert hit["date"] == "2026-11-11"


def test_normal_update_applies_and_keeps_date():
    hit = {"date": "2026-11-11", "day": "Day 7", "collection": 6000000,
           "overseas": 2641310}
    entry = {"date": "2026-11-11", "day": "Day 7", "collection": 7464342}
    assert apply_auto.apply_box_row_update(hit, entry, "Ramayana", 7) is True
    assert hit["collection"] == 7464342
    assert hit["date"] == "2026-11-11"


def test_same_value_no_change():
    hit = {"date": "2026-11-11", "day": "Day 7", "collection": 7464342}
    entry = {"date": "2026-11-11", "day": "Day 7", "collection": 7464342}
    assert apply_auto.apply_box_row_update(hit, entry, "Ramayana", 7) is False


def test_update_without_overseas_field_allowed():
    hit = {"date": "2026-11-12", "day": "Day 8", "collection": 2426836}
    entry = {"date": "2026-11-12", "day": "Day 8", "collection": 3000000}
    assert apply_auto.apply_box_row_update(hit, entry, "Ramayana", 8) is True
    assert hit["collection"] == 3000000


if __name__ == "__main__":
    for _name, _fn in sorted(list(globals().items())):
        if _name.startswith("test_") and callable(_fn):
            _fn()
            print(f"ok: {_name}")
    print("test_apply_auto_boxoffice: all passed")
