#!/usr/bin/env python3
"""Offline tests for atomic standalone generated-data commits.

All Git remotes are temporary local bare repositories. The conflict test
uses a tiny fixture regenerator, never title-seed.py or any source API.
"""
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts" / "commit_with_retry_standalone.sh"
OUTPUTS = (
    "js/published-titles.js",
    "js/ott-data.js",
    "js/trending-data.js",
    "out/step-runs.json",
    "out/source-refresh-state.json",
)
ALL_OUTPUTS = (*OUTPUTS, "index.html")
BASE_CONTENT = {
    "js/published-titles.js": "published-base\n",
    "js/ott-data.js": "ott-base\n",
    "js/trending-data.js": "trending-base\n",
    "out/step-runs.json": "receipt-base\n",
    "out/source-refresh-state.json": "source-state-base\n",
    "index.html": '<script src="/js/published-titles.js?v=fa-base"></script>\n',
}


class CommitWithRetryStandaloneTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fa-commit-test-")
        self.root = Path(self.temp.name)
        self.remote = self.root / "remote.git"
        self._run(["git", "init", "--bare", str(self.remote)])
        self._run(["git", f"--git-dir={self.remote}", "symbolic-ref",
                   "HEAD", "refs/heads/main"])

        seed = self.root / "seed"
        seed.mkdir()
        self._run(["git", "init", "-b", "main", str(seed)])
        self._configure(seed)
        self._write_base(seed)
        self._run(["git", "add", "-A"], cwd=seed)
        self._run(["git", "commit", "-m", "initial"], cwd=seed)
        self._run(["git", "remote", "add", "origin", str(self.remote)], cwd=seed)
        self._run(["git", "push", "-u", "origin", "main"], cwd=seed)

        self.work = self.root / "work"
        self._run(["git", "clone", str(self.remote), str(self.work)])
        self._configure(self.work)
        self.base_sha = self._git(self.work, "rev-parse", "HEAD")

    def tearDown(self):
        self.temp.cleanup()

    def _env(self, extra=None):
        env = os.environ.copy()
        env.update({
            "GIT_TERMINAL_PROMPT": "0",
            # Permit only the local file transport used by these test remotes.
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "protocol.file.allow",
            "GIT_CONFIG_VALUE_0": "always",
        })
        if extra:
            env.update(extra)
        return env

    def _run(self, args, cwd=None, env=None, check=True):
        return subprocess.run(
            args, cwd=cwd, env=env or self._env(), check=check,
            text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            timeout=45)

    def _configure(self, repo):
        self._run(["git", "config", "user.name", "Offline Test"], cwd=repo)
        self._run(["git", "config", "user.email", "offline@example.invalid"], cwd=repo)

    def _git(self, repo, *args):
        return self._run(["git", *args], cwd=repo).stdout.strip()

    def _write_base(self, repo):
        for name, content in BASE_CONTENT.items():
            path = repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")

    def _write_run_outputs(self, marker="run-output"):
        for name in OUTPUTS:
            path = self.work / name
            path.parent.mkdir(parents=True, exist_ok=True)
            base = BASE_CONTENT[name]
            path.write_text(base + marker + "\n", encoding="utf-8")
        (self.work / "index.html").write_text(
            '<script src="/js/published-titles.js?v=fa-run"></script>\n',
            encoding="utf-8")

    def _invoke_helper(self, *, regen="", html_bump="1", retry_add=None):
        env = self._env({
            "RETRY_ADD": retry_add or " ".join(OUTPUTS),
            "RETRY_REGEN": regen,
            "RETRY_MESSAGE": "test: atomic title seed",
            "RETRY_HTML_BUMP": html_bump,
            "RETRY_STRICT_OUTPUTS": "1",
        })
        return subprocess.run(
            ["bash", str(HELPER)], cwd=self.work, env=env, check=False,
            text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            timeout=90)

    def _remote_text(self, path):
        return self._run([
            "git", f"--git-dir={self.remote}", "show", f"main:{path}"
        ]).stdout

    def _remote_changed_paths(self):
        output = self._run([
            "git", f"--git-dir={self.remote}", "diff-tree",
            "--no-commit-id", "--name-only", "-r", "main"
        ]).stdout
        return set(output.splitlines())

    def test_all_generated_sidecars_and_html_push_in_one_commit(self):
        self._write_run_outputs()
        result = self._invoke_helper()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("pushed on attempt 1", result.stdout)
        self.assertEqual(self._remote_changed_paths(), set(ALL_OUTPUTS))
        for name in OUTPUTS:
            self.assertIn("run-output", self._remote_text(name))
        self.assertIn("fa-run", self._remote_text("index.html"))
        self.assertEqual(self._git(self.work, "status", "--porcelain"), "")
        self.assertNotEqual(self._git(self.work, "rev-parse", "HEAD"), self.base_sha)

    def test_undeclared_generated_sidecar_fails_closed_without_partial_push(self):
        self._write_run_outputs()
        forgotten = self.work / "js" / "forgotten-sidecar.js"
        forgotten.write_text("must-not-be-committed\n", encoding="utf-8")
        result = self._invoke_helper(html_bump="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("refusing a partial commit", result.stdout)
        self.assertEqual(self._git(self.work, "rev-parse", "HEAD"), self.base_sha)
        self.assertEqual(
            self._run(["git", f"--git-dir={self.remote}", "rev-parse", "main"]).stdout.strip(),
            self.base_sha)
        self.assertIn("forgotten-sidecar.js", self._git(self.work, "status", "--short"))

    def test_conflict_regenerator_restages_all_sidecars_before_push(self):
        # Move origin/main after the working clone so the local title file
        # conflicts during rebase, as it can during a real concurrent run.
        other = self.root / "other"
        self._run(["git", "clone", str(self.remote), str(other)])
        self._configure(other)
        published = other / "js" / "published-titles.js"
        published.write_text(
            published.read_text(encoding="utf-8") + "upstream-title\n",
            encoding="utf-8")
        self._run(["git", "add", "js/published-titles.js"], cwd=other)
        self._run(["git", "commit", "-m", "concurrent upstream title"], cwd=other)
        self._run(["git", "push", "origin", "main"], cwd=other)

        self._write_run_outputs("local-run")
        regen = self.root / "fixture_regen.py"
        regen.write_text(
            "from pathlib import Path\n"
            f"paths = {OUTPUTS!r}\n"
            "for name in paths:\n"
            "    path = Path(name)\n"
            "    path.write_text(path.read_text(encoding='utf-8') + "
            "'\\nregenerated-fixture\\n', encoding='utf-8')\n",
            encoding="utf-8")
        command = f"{shlex.quote(sys.executable)} {shlex.quote(str(regen))}"
        result = self._invoke_helper(regen=command)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("resolving rebase conflicts", result.stdout)
        self.assertIn("regenerating via", result.stdout)
        self.assertIn("pushed after conflict resolution", result.stdout)

        self.assertEqual(self._remote_changed_paths(), set(ALL_OUTPUTS))
        self.assertIn("upstream-title", self._remote_text("js/published-titles.js"))
        for name in OUTPUTS:
            self.assertIn("regenerated-fixture", self._remote_text(name))
        self.assertIn("fa-run", self._remote_text("index.html"))
        self.assertEqual(self._git(self.work, "status", "--porcelain"), "")

    def test_failed_conflict_regen_does_not_push_partial_sidecars(self):
        other = self.root / "other-failed-regen"
        self._run(["git", "clone", str(self.remote), str(other)])
        self._configure(other)
        published = other / "js" / "published-titles.js"
        published.write_text(
            published.read_text(encoding="utf-8") + "upstream-title\n",
            encoding="utf-8")
        self._run(["git", "add", "js/published-titles.js"], cwd=other)
        self._run(["git", "commit", "-m", "concurrent upstream title"], cwd=other)
        self._run(["git", "push", "origin", "main"], cwd=other)

        self._write_run_outputs("local-run")
        result = self._invoke_helper(regen="false")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("regen failed", result.stdout)
        self.assertIn("aborting to avoid a partial", result.stdout)
        self.assertEqual(self._remote_changed_paths(), {"js/published-titles.js"})
        self.assertIn("upstream-title", self._remote_text("js/published-titles.js"))
        self.assertNotIn("local-run", self._remote_text("js/ott-data.js"))
        self.assertNotEqual(self._git(self.work, "rev-parse", "HEAD"), self.base_sha)
        self.assertEqual(self._git(self.work, "status", "--porcelain"), "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
