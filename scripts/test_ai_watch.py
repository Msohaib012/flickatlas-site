#!/usr/bin/env python3
"""Guard tests for scripts/ai_watch.py (no network, no keys needed).
Run: python3 test-ai_watch.py
Exit 0 = all pass.
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
NEW = os.path.join(HERE, "..", "new")
sys.path.insert(0, NEW)

spec = importlib.util.spec_from_file_location(
    "ai_watch", os.path.join(NEW, "scripts-ai_watch.py"))
aw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(aw)

PASS = 0
FAIL = 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("PASS:", name)
    else:
        FAIL += 1
        print("FAIL:", name, extra)


# --- 1. Spike verdict2 passes the production schema validator ---
v2 = json.load(open(os.path.join(HERE, "..", "spike", "verdict2-raw.txt"),
                    encoding="utf-8"))
check("spike verdict2 valid", aw.valid_verdict(v2))
check("spike verdict2 has 32 verdicts", len(v2["verdicts"]) == 32,
      f"got {len(v2['verdicts'])}")
check("spike verdict2 all theek (healthy state)",
      all(x["status"] == "theek" for x in v2["verdicts"]))
check("spike verdict2 modes are lists",
      all(isinstance(x.get("modes"), list) for x in v2["verdicts"]))

# --- 2. Invalid verdicts are rejected ---
check("garbage verdict rejected", not aw.valid_verdict({"a": 1}))
check("bad status rejected",
      not aw.valid_verdict({"checked_at": "x", "overall": "theek",
                            "verdicts": [{"id": "fetch", "kind": "step",
                                          "name_ur": "Fetch",
                                          "status": "explode", "modes": [],
                                          "evidence_ur": "e", "fix": "koi-nahi",
                                          "auto_fixable": False}] * 25}))
check("too few verdicts rejected",
      not aw.valid_verdict({"checked_at": "x", "overall": "theek",
                            "verdicts": []}))

# --- 3. Flag OFF -> skip (never runs Gemini, never writes verdicts) ---
tmp = tempfile.mkdtemp(prefix="aiw-flag-")
try:
    os.makedirs(os.path.join(tmp, "out"), exist_ok=True)
    os.makedirs(os.path.join(tmp, "data"), exist_ok=True)
    with open(os.path.join(tmp, "data", "automation-state.json"),
              "w", encoding="utf-8") as f:
        json.dump({"ai_watch": False}, f)
    aw.FLAG_PATH = os.path.join(tmp, "data", "automation-state.json")
    aw.WATCH_PATH = os.path.join(tmp, "out", "ai-watch.json")
    check("flag false -> off", aw.flag_on() is False)
    # main() with flag off writes skipped + exits 0
    rc = aw.main()
    out = json.load(open(aw.WATCH_PATH, encoding="utf-8"))
    check("flag off main exits 0", rc == 0)
    check("flag off writes skipped", out.get("status") == "skipped",
          str(out.get("status")))
    check("flag off reason names the toggle",
          "AI watchdog off" in (out.get("reason") or ""))
    check("flag off writes no verdicts", out.get("verdicts") == [])
    # missing file -> ON
    os.remove(os.path.join(tmp, "data", "automation-state.json"))
    check("flag missing -> on", aw.flag_on() is True)
    # malformed file -> ON (fail open to running, never silent-dead)
    with open(os.path.join(tmp, "data", "automation-state.json"),
              "w", encoding="utf-8") as f:
        f.write("not json {{{")
    check("flag malformed -> on", aw.flag_on() is True)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# --- 4. No Gemini keys -> call returns None, no crash ---
check("no keys -> empty list",
      aw.gemini_keys() == [] if not any(
          os.environ.get(f"GEMINI_API_KEY_{i}") for i in range(1, 7))
      and not os.environ.get("GEMINI_API_KEY") else True)
check("call_gemini with no keys -> None",
      aw.call_gemini([], "hi", aw.VERDICT_SCHEMA) is None)

# --- 5. Fallback verdicts from the LIVE state: 32, sane ---
state = json.load(open(os.path.join(HERE, "..", "spike", "state-summary.json"),
                       encoding="utf-8"))
steps = state["steps"]
fb = aw.fallback_verdicts(state, steps)
check("fallback produces 32 verdicts", len(fb) == 32, f"got {len(fb)}")
check("fallback verdicts valid shape",
      aw.valid_verdict({"checked_at": state["checked_at_pkt"],
                        "overall": "theek", "verdicts": fb}))
check("fallback marks all steps theek (healthy state)",
      all(x["status"] == "theek" for x in fb
          if x["kind"] == "step"),
      str([(x["id"], x["status"]) for x in fb
           if x["status"] != "theek"]))

# --- 6. Prune ledger: 48h rule (fake registry + fake DNS-dead host) ---
tmp = tempfile.mkdtemp(prefix="aiw-prune-")
try:
    reg = [{"name": "DeadSite", "url": "https://dead-site-nonexistent-xyz.invalid",
            "rss": "https://dead-site-nonexistent-xyz.invalid/rss.xml"},
           {"name": "AliveSite", "url": "https://example.com",
            "rss": "https://example.com/rss.xml"}]
    reg_path = os.path.join(tmp, "registry.json")
    with open(reg_path, "w", encoding="utf-8") as f:
        json.dump(reg, f)
    aw.REGISTRY_PATH = reg_path
    fake_state = dict(state)
    fake_state["fetch_report"] = {
        "error_sources": [{"source": "DeadSite",
                           "note": "URLError: <urlopen error [Errno -2] Name or service not known>"}]}
    fake_state["five_modes"] = dict(state["five_modes"])
    fake_state["five_modes"]["a_run_hua"] = {"age_min": 10}
    # first sighting: proposal only, NOT pruned
    af, ro, cand = aw.auto_fixes(fake_state, steps, {}, None, "run-1")
    check("prune first sighting proposes, does not prune",
          "DeadSite" in cand and len(af) == 0,
          f"cand={cand} af={af}")
    check("prune proposal in report_only",
          any("DeadSite" in r for r in ro))
    reg_after = json.load(open(reg_path, encoding="utf-8"))
    check("registry untouched on first sighting", len(reg_after) == 2)
    # 49h-old ledger entry: pruned
    old = (datetime.now(timezone.utc) - timedelta(hours=49)).isoformat().replace("+00:00", "Z")
    af2, ro2, cand2 = aw.auto_fixes(fake_state, steps,
                                    {"prune_candidates": {"DeadSite": old}},
                                    None, "run-2")
    check("prune after 48h removes the entry",
          any("DeadSite" in a.get("what_ur", "") for a in af2),
          str(af2))
    reg_after2 = json.load(open(reg_path, encoding="utf-8"))
    check("registry has 1 entry after prune",
          len(reg_after2) == 1 and reg_after2[0]["name"] == "AliveSite",
          str(reg_after2))
    check("prune reports Flickposts remainder",
          any("Flickposts" in r for r in ro2), str(ro2))
finally:
    shutil.rmtree(tmp, ignore_errors=True)


# --- 7. call_gemini request shape + key rotation (mocked urlopen) ---
import urllib.request as _url
import urllib.error  # binds bare name 'urllib' for the mock


class _FakeResp:
    def __init__(self, payload):
        self._b = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _fake_ok(payload_text):
    def _open(req, timeout=None):
        return _FakeResp({"candidates": [{"content": {"parts": [
            {"text": payload_text}]}}]})
    return _open


_orig_open = _url.urlopen
try:
    # 429 on key 1 -> key 2 succeeds; responseSchema must be in the body
    seen = []

    def _open_429_then_ok(req, timeout=None):
        body = json.loads(req.data.decode("utf-8"))
        seen.append(body)
        if len(seen) == 1:
            raise urllib.error.HTTPError(req.full_url, 429, "quota", {}, None)
        return _FakeResp({"candidates": [{"content": {"parts": [
            {"text": '{"ok": true}'}]}}]})

    _url.urlopen = _open_429_then_ok
    got = aw.call_gemini(["key-one", "key-two"], "hi",
                         {"type": "object",
                          "properties": {"ok": {"type": "boolean"}}})
    check("call_gemini rotates past 429", got == {"ok": True}, str(got))
    check("call_gemini sent responseSchema",
          seen[0]["generationConfig"].get("responseSchema") == {
              "type": "object",
              "properties": {"ok": {"type": "boolean"}}}, str(seen[0]))
    check("call_gemini sent responseMimeType application/json",
          seen[0]["generationConfig"].get("responseMimeType")
          == "application/json")
    check("call_gemini tried both keys", len(seen) == 2, str(len(seen)))

    # all keys fail -> None (never raises)
    def _open_always_429(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 429, "quota", {}, None)
    _url.urlopen = _open_always_429
    check("call_gemini all-429 -> None",
          aw.call_gemini(["k1", "k2"], "hi", {"type": "object"}) is None)
finally:
    _url.urlopen = _orig_open

# --- 8. dns_dead: captive resolver (198.18.x.x) counts as dead ---
check("dns_dead: captive 198.18 -> dead",
      aw.dns_dead("dead-site-nonexistent-xyz.invalid") is True)
check("_is_nonpublic_ip: 198.18.x.x is non-public",
      aw._is_nonpublic_ip("198.18.190.128") is True)
check("_is_nonpublic_ip: 8.8.8.8 is public",
      aw._is_nonpublic_ip("8.8.8.8") is False)
check("_is_nonpublic_ip: 142.250.80.14 is public",
      aw._is_nonpublic_ip("142.250.80.14") is False)
check("_is_nonpublic_ip: 10.0.0.1 is non-public",
      aw._is_nonpublic_ip("10.0.0.1") is True)

print(f"\n== result: {PASS} PASS, {FAIL} FAIL ==")
sys.exit(1 if FAIL else 0)
