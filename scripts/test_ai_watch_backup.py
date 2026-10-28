#!/usr/bin/env python3
"""Unit tests for the watchdog self-waking logic (scripts/ai_watch.py).

Covers: backup idempotency (verdict present -> skip, no Gemini call),
in-flight guards (pipeline / watchdog running -> skip, no dispatch),
recovery dispatch (exactly once per hour), the 2-consecutive-failures
stop, redispatch-already-recorded, primary always writes fresh, and the
ai_watch kill switch. No network, no real Gemini, no real dispatch —
gh_request / call_gemini / dispatch_workflow are monkeypatched.

Run: python3 tests/test-ai-watch-backup.py   (from ~/workspace/ai-watch)
Exit 0 = all pass.
"""
import importlib.util
import json
import os
import sys
import tempfile
from datetime import datetime, timezone, timedelta

PASS = 0
FAIL = 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS: {name}")
    else:
        FAIL += 1
        print(f"FAIL: {name} {extra}")


def load_module():
    spec = importlib.util.spec_from_file_location(
        "ai_watch", os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "..", "new", "scripts-ai_watch.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def valid_verdict():
    vs = []
    for i in range(20):
        vs.append({"id": f"s{i}", "kind": "step", "name_ur": f"Step {i}",
                   "status": "theek", "modes": [], "evidence_ur": "ok",
                   "fix": "koi-nahi", "auto_fixable": False})
    return {"checked_at": "2026-10-28 14:25 PKT", "overall": "theek",
            "verdicts": vs, "autofixes": [], "report_only": []}


def make_root(tmp):
    """Minimal repo tree so build_state() succeeds."""
    os.makedirs(os.path.join(tmp, "out"), exist_ok=True)
    os.makedirs(os.path.join(tmp, "js"), exist_ok=True)
    os.makedirs(os.path.join(tmp, "docs"), exist_ok=True)
    for name, data in (("step-runs.json", {}), ("daily-history.json", {"days": []}),
                       ("report.json", {}), ("gemini-batch.json", {})):
        with open(os.path.join(tmp, "out", name), "w") as f:
            json.dump(data, f)
    open(os.path.join(tmp, "js", "published-titles.js"), "w").write(
        "FA_PUBLISHED = {};")
    open(os.path.join(tmp, "js", "daywise-data.js"), "w").write(
        "FA_DAYWISE = {};")
    open(os.path.join(tmp, "docs", "WATCHDOG-SYSTEM.md"), "w").write(
        "# spec (test stub)\n")
    return tmp


class Harness:
    """One isolated run of main() with scripted GitHub + Gemini."""

    def __init__(self, mode, prev_watch=None, flag=None, runs=None,
                 pipeline_run_created=None):
        self.tmp = tempfile.mkdtemp(prefix="aiw-test-")
        make_root(self.tmp)
        # Env MUST be set BEFORE importing: the module reads
        # WATCHDOG_MODE / WATCHDOG_PIPELINE_RUN_ID at import time
        # (same as the real workflow, where env exists before python starts).
        self.env = {
            "WATCHDOG_MODE": mode,
            "GITHUB_TOKEN": "test-token",
            "GITHUB_RUN_ID": "999",
            "GEMINI_API_KEY_1": "test-key",
        }
        if mode == "primary":
            self.env["WATCHDOG_PIPELINE_RUN_ID"] = "123"
        self._old_env = dict(os.environ)
        os.environ.update(self.env)
        self.mod = load_module()
        m = self.mod
        m.REPO_ROOT = self.tmp
        m.OUT_DIR = os.path.join(self.tmp, "out")
        m.WATCH_PATH = os.path.join(self.tmp, "out", "ai-watch.json")
        m.FLAG_PATH = os.path.join(self.tmp, "data", "automation-state.json")
        m.SPEC_PATH = os.path.join(self.tmp, "docs", "WATCHDOG-SYSTEM.md")
        m.REGISTRY_PATH = os.path.join(self.tmp, "scripts", "registry.json")
        if prev_watch is not None:
            with open(m.WATCH_PATH, "w") as f:
                json.dump(prev_watch, f)
        if flag is not None:
            os.makedirs(os.path.join(self.tmp, "data"), exist_ok=True)
            with open(m.FLAG_PATH, "w") as f:
                json.dump(flag, f)
        self.gemini_calls = 0
        self.dispatch_calls = []
        self.runs = runs or []
        self.pipeline_run_created = pipeline_run_created

        def fake_gh(method, path, token, data=None):
            if method == "POST" and path.endswith("/dispatches"):
                self.dispatch_calls.append(path)
                return None
            if "/actions/runs/" in path:
                return {"id": 1, "created_at": self.pipeline_run_created or
                        "2026-10-28T08:40:00Z"}
            if "/actions/workflows/" in path and path.endswith("/runs?per_page=10"):
                return {"workflow_runs": self.runs}
            return {}

        def fake_gemini(keys, prompt, schema, max_tokens=8192):
            self.gemini_calls += 1
            return valid_verdict()

        m.gh_request = fake_gh
        m.call_gemini = fake_gemini
        # dispatch_workflow uses gh_request, so the fake above records it.
    def run(self):
        old = dict(os.environ)
        os.environ.update(self.env)
        try:
            return self.mod.main()
        finally:
            os.environ.clear()
            os.environ.update(old)

    def watch(self):
        try:
            with open(self.mod.WATCH_PATH) as f:
                return json.load(f)
        except Exception:
            return None

    def state(self):
        try:
            with open(self.mod.state_path()) as f:
                return json.load(f)
        except Exception:
            return None


def utc_hour(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:00:00Z")


def run_row(status, conclusion, created):
    return {"id": 1, "status": status, "conclusion": conclusion,
            "created_at": created}


NOW = datetime.now(timezone.utc)
PREV_HOUR = utc_hour(NOW - timedelta(hours=1))
CUR_HOUR = utc_hour(NOW)

# --- 1. backup + verdict present -> skip, no Gemini, file unchanged ---
h = Harness("backup", prev_watch={
    "checked_at": "2026-10-28 14:05 PKT", "overall": "theek",
    "status": "ok", "pipeline_hour": PREV_HOUR, "mode": "primary",
    "verdicts": [], "autofixes": [], "report_only": []})
before = open(h.mod.WATCH_PATH).read()
check("backup verdict-present returns 0", h.run() == 0)
check("backup verdict-present: no Gemini call", h.gemini_calls == 0)
check("backup verdict-present: file unchanged",
      open(h.mod.WATCH_PATH).read() == before)
check("backup verdict-present: no dispatch", h.dispatch_calls == [])

# --- 2. backup + verdict present but check-failed -> proceeds ---
h = Harness("backup", prev_watch={
    "checked_at": "x", "overall": "dhyaan-do", "status": "check-failed",
    "pipeline_hour": PREV_HOUR, "mode": "primary",
    "verdicts": [], "autofixes": [], "report_only": []})
h.run()
check("backup check-failed verdict: Gemini called (retry)", h.gemini_calls == 1)
w = h.watch()
check("backup check-failed verdict: new verdict written",
      w is not None and w.get("pipeline_hour") == PREV_HOUR
      and w.get("status") == "ok")

# --- 3. backup + verdict missing + pipeline in flight -> skip ---
h = Harness("backup", runs=[run_row("in_progress", None,
      (NOW - timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ"))])
h.run()
check("backup pipeline-in-flight: no Gemini call", h.gemini_calls == 0)
check("backup pipeline-in-flight: no dispatch", h.dispatch_calls == [])
check("backup pipeline-in-flight: no verdict written", h.watch() is None)

# --- 4. backup + verdict missing + watchdog in flight -> skip ---
h = Harness("backup", runs=[run_row("queued", None,
      (NOW - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ"))])
# The fake returns the same runs list for BOTH workflow queries, so the
# pipeline check fires first; that still proves an in-flight run skips.
h.run()
check("backup watchdog-in-flight: no Gemini call", h.gemini_calls == 0)
check("backup watchdog-in-flight: no dispatch", h.dispatch_calls == [])

# --- 5. backup + verdict missing + nothing in flight -> 1 dispatch ---
h = Harness("backup", runs=[run_row("completed", "success",
      (NOW - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ"))])
h.run()
check("backup missing verdict: Gemini called", h.gemini_calls == 1)
check("backup missing verdict: exactly 1 dispatch", len(h.dispatch_calls) == 1)
w = h.watch()
check("backup missing verdict: redispatch recorded",
      w is not None and (w.get("redispatch") or {}).get("dispatched") is True
      and (w.get("redispatch") or {}).get("hour") == PREV_HOUR)
check("backup missing verdict: mode=backup",
      w is not None and w.get("mode") == "backup")
check("backup missing verdict: history has entry",
      w is not None and any(
          x.get("pipeline_hour") == PREV_HOUR for x in w.get("history", [])))
s = h.state()
check("backup missing verdict: full state summary saved",
      s is not None and s.get("watchdog", {}).get("pipeline_hour") == PREV_HOUR)
check("backup missing verdict: state has five-modes evidence",
      s is not None and isinstance(s.get("five_modes"), dict)
      and len(s.get("five_modes", {})) == 5)

# --- 6. backup + 2 consecutive failures -> NO dispatch ---
fails = [run_row("completed", "failure",
                 (NOW - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")),
         run_row("completed", "failure",
                 (NOW - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ"))]
h = Harness("backup", runs=fails)
h.run()
check("backup 2 consecutive failures: no dispatch", h.dispatch_calls == [])
w = h.watch()
check("backup 2 consecutive failures: '2 ghante' in report",
      w is not None and any("2 ghante" in r for r in w.get("report_only", [])))

# --- 7. backup + redispatch already recorded this hour -> NO dispatch ---
h = Harness("backup", prev_watch={
    "checked_at": "x", "overall": "dhyaan-do", "status": "ok",
    "pipeline_hour": "2026-10-28T07:00:00Z", "mode": "backup",
    "verdicts": [], "autofixes": [], "report_only": [],
    "redispatch": {"dispatched": True, "hour": PREV_HOUR,
                   "at_pkt": "2026-10-28 14:25 PKT", "reason": "pehle"}})
h.run()
check("backup redispatch-recorded: no second dispatch", h.dispatch_calls == [])
w = h.watch()
check("backup redispatch-recorded: record preserved",
      w is not None and (w.get("redispatch") or {}).get("hour") == PREV_HOUR)

# --- 8. primary + verdict present -> still writes fresh (no skip) ---
h = Harness("primary", prev_watch={
    "checked_at": "x", "overall": "theek", "status": "ok",
    "pipeline_hour": "2026-10-28T08:00:00Z", "mode": "backup",
    "verdicts": [], "autofixes": [], "report_only": []},
    pipeline_run_created="2026-10-28T08:40:00Z")
h.run()
check("primary verdict-present: Gemini called (fresh verdict)",
      h.gemini_calls == 1)
w = h.watch()
check("primary verdict-present: target hour from run created_at",
      w is not None and w.get("pipeline_hour") == "2026-10-28T08:00:00Z")
check("primary: mode=primary", w is not None and w.get("mode") == "primary")
check("primary: no recovery dispatch", h.dispatch_calls == [])
s = h.state()
check("primary: full state summary saved",
      s is not None and s.get("watchdog", {}).get("mode") == "primary"
      and s.get("watchdog", {}).get("pipeline_hour") == "2026-10-28T08:00:00Z")

# --- 9. ai_watch off -> skipped, no Gemini, no dispatch ---
h = Harness("backup", flag={"automation": True, "ai_watch": False,
                            "fetching": True})
h.run()
check("ai_watch off: no Gemini call", h.gemini_calls == 0)
check("ai_watch off: no dispatch", h.dispatch_calls == [])
w = h.watch()
check("ai_watch off: skipped verdict",
      w is not None and w.get("status") == "skipped")

# --- 10. backup target hour = previous UTC hour ---
h = Harness("backup", runs=[run_row("completed", "success",
      (NOW - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ"))])
h.run()
w = h.watch()
check("backup target hour is previous UTC hour",
      w is not None and w.get("pipeline_hour") == PREV_HOUR,
      f"got {w.get('pipeline_hour') if w else None}, want {PREV_HOUR}")

print(f"\n== result: {PASS} PASS, {FAIL} FAIL ==")
sys.exit(0 if FAIL == 0 else 1)
