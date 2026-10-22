from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hooks"))
import codex  # noqa: E402
import triage  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import table  # noqa: E402


ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "hooks" / "codex.py"
HOOKS_CONFIG = ROOT / "hooks" / "codex-hooks.json"
CODEX_MANIFEST = ROOT / ".codex-plugin" / "plugin.json"
CLAUDE_MANIFEST = ROOT / ".claude-plugin" / "plugin.json"
PACKAGE_MANIFEST = ROOT / "package.json"


def write(path: Path, text: str) -> None:
    path.write_text(text)


def read(path: Path) -> str:
    return path.read_text()


def mkdir(path: Path) -> None:
    path.mkdir(parents=True)


class CodexHookTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.cwd = Path(self.temporary.name) / "project"
        self.data = Path(self.temporary.name) / "data"
        self.cwd.mkdir()
        subprocess.run(["git", "init", "-q", str(self.cwd)], check=True)
        self.bin = Path(self.temporary.name) / "bin"
        self.bin.mkdir()

    def tool(self, name: str, output: str, code: int) -> None:
        """Puts a fake `name` on PATH that prints `output` and exits with `code`."""
        script = self.bin / name
        script.write_text(f"#!/bin/sh\ncat <<'EOF'\n{output}\nEOF\nexit {code}\n")
        script.chmod(0o755)

    def configure(self, *, watch: bool = False) -> tuple[Path, Path]:
        result = self.cwd / "result.txt"
        count = self.cwd / "count.txt"
        runner = self.cwd / "check.py"
        runner.write_text(
            textwrap.dedent(
                f"""
                from pathlib import Path
                import time

                count = Path({str(count)!r})
                count.write_text(str(int(count.read_text()) + 1) if count.exists() else "1")
                print(Path({str(result)!r}).read_text(), flush=True)
                {"time.sleep(30)" if watch else ""}
                """
            )
        )
        command = [sys.executable, str(runner)]
        config = {
            "name": "fixture",
            "summary": "^RESULT:.*$",
            "failed": "FAIL",
            "argv" if watch else "baseline": command,
        }
        (self.cwd / ".overwatch.json").write_text(json.dumps(config))
        return result, count

    def call(self, event: str, **fields: object) -> tuple[dict[str, object], float]:
        payload = {
            "session_id": "session-1",
            "cwd": str(self.cwd),
            "hook_event_name": event,
            **fields,
        }
        environment = {
            **os.environ,
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "PLUGIN_DATA": str(self.data),
        }
        started = time.monotonic()
        process = subprocess.run(
            [sys.executable, str(HOOK)],
            input=json.dumps(payload),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            timeout=5,
            check=True,
        )
        return json.loads(process.stdout), time.monotonic() - started

    def prime_tools(self) -> None:
        scripts = {path: read(path) for path in self.bin.iterdir()}
        for path in scripts:
            summary = {"gotestsum": "DONE 2 tests, 0 failures", "pytest": "=== 3 passed in 0.01s ==="}.get(path.name, "")
            write(path, f"#!/bin/sh\necho '{summary}'\nexit 0\n")
        self.call("SessionStart")
        for path, text in scripts.items():
            write(path, text)
        write(self.cwd / "changed.txt", "changed")

    def test_failure_notifies_once_but_completion_remains_guarded(self) -> None:
        result, count = self.configure()
        write(result, "RESULT: PASS")
        self.assertEqual(self.call("SessionStart")[0], {})
        write(result, "details\nRESULT: FAIL")
        failed, _ = self.call("PostToolUse", tool_name="apply_patch")
        self.assertNotIn("decision", failed)
        self.assertIn("Full output:", failed["hookSpecificOutput"]["additionalContext"])
        stopped, _ = self.call("Stop", stop_hook_active=False)
        self.assertEqual(stopped["decision"], "block")
        self.assertIn("RESULT: FAIL", stopped["reason"])
        for event in ("UserPromptSubmit", "PostToolUse"):
            self.assertEqual(self.call(event, stop_hook_active=False)[0], {})
        self.assertEqual(self.call("Stop")[0]["decision"], "block")
        self.assertEqual(read(count), "2")

    def test_timing_changes_do_not_repeat_a_failure(self) -> None:
        result, _ = self.configure()
        write(result, "RESULT: PASS")
        self.call("SessionStart")
        write(result, "RESULT: FAIL in 0.01s")
        self.assertIn("systemMessage", self.call("Stop")[0])
        write(result, "RESULT: FAIL in 0.02s")
        self.assertEqual(self.call("Stop")[0]["decision"], "block")

    def test_existing_failure_stays_quiet(self) -> None:
        result, _ = self.configure()
        write(result, "RESULT: FAIL")
        started = self.call("SessionStart")[0]
        self.assertNotIn("decision", started)
        self.assertIn("inherited backlog", started["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.call("Stop")[0], {})

    def test_stop_continuation_does_not_consume_a_new_failure_guard(self) -> None:
        result, _ = self.configure()
        write(result, "RESULT: PASS")
        self.call("SessionStart")
        write(result, "RESULT: FAIL")
        self.assertEqual(self.call("Stop", stop_hook_active=True)[0]["decision"], "block")
        self.assertEqual(self.call("Stop")[0]["decision"], "block")
        self.assertEqual(self.call("Stop")[0]["decision"], "block")

    def test_summary_only_backlog_blocks_only_when_error_counts_increase(self) -> None:
        result, _ = self.configure()
        write(result, "RESULT: FAIL 10000 errors")
        self.call("SessionStart")
        write(result, "RESULT: FAIL 9999 errors")
        self.assertEqual(self.call("PostToolUse")[0], {})
        write(result, "RESULT: FAIL 10001 errors")
        self.assertNotIn("decision", self.call("PostToolUse")[0])
        self.assertEqual(self.call("Stop")[0]["decision"], "block")
        self.assertEqual(self.call("Stop")[0]["decision"], "block")

    def test_another_new_issue_gets_its_own_stop_guard(self) -> None:
        first = {"name": "fixture", "failed": True, "failures": ["legacy"], "summary": "1 failed"}
        baseline = codex.report_state([first], {})
        report = {**first, "failures": ["legacy", "new-a"], "summary": "2 failed"}
        current = codex.report_state([report], baseline)
        self.assertTrue(codex.block_stop({"hook_event_name": "Stop"}, current))
        report = {**report, "failures": ["new-b", "new-a", "legacy"], "summary": "3 failed"}
        following = codex.report_state([report], current)
        self.assertTrue(codex.block_stop({"hook_event_name": "Stop"}, following))
        report = {**report, "failures": ["new-a"], "summary": "1 failed"}
        remaining = codex.report_state([report], following)
        self.assertTrue(codex.block_stop({"hook_event_name": "Stop"}, remaining))

    def legacy_project(self) -> tuple[list[str], dict[str, object], Path]:
        write(self.cwd / "go.mod", "module legacy")
        failures = [f"--- FAIL: TestCase{i} (0.00s)" for i in range(10_000)]
        self.tool("go", "\n".join([*failures, "FAIL"]), 1)
        started = self.call("SessionStart")[0]
        return failures, started, next(self.data.glob("*.baseline.json"))

    def test_large_legacy_baseline_is_compact_and_inspectable(self) -> None:
        _, started, inventory = self.legacy_project()
        context = started["hookSpecificOutput"]["additionalContext"]
        self.assertLess(len(context), 1000)
        self.assertIn("10000 named issues", context)
        self.assertNotIn("decision", started)
        self.assertEqual(self.call("Stop")[0], {})
        check = json.loads(read(inventory))["checks"][0]
        self.assertEqual(len(check["failures"]), 10_000)
        self.assertIn("TestCase9999", read(Path(check["log"])))

    def test_triage_filters_and_pages_a_large_baseline(self) -> None:
        _, _, inventory = self.legacy_project()
        selected = triage.triage(json.loads(read(inventory)), "GO", "TestCase99")
        batch = triage.triage_page(selected, 3, 3)
        self.assertEqual(batch["total"], 111)
        self.assertEqual(len(batch["issues"]), 3)
        self.assertEqual(batch["issues"], selected["issues"][3:6])
        self.assertEqual(triage.triage(json.loads(read(inventory)), "missing")["total"], 0)

    def test_legacy_cleanup_preserves_the_new_failure_gate(self) -> None:
        """A new issue keeps completion guarded while cleanup preserves the inherited snapshot."""
        failures, _, inventory = self.legacy_project()
        snapshot = read(inventory)
        self.tool("go", "\n".join([*failures, "--- FAIL: TestNew (0.00s)", "FAIL"]), 1)
        write(self.cwd / "edit.txt", "new change")
        changed = self.call("PostToolUse")[0]
        self.assertNotIn("decision", changed)
        self.assertIn("TestNew", changed["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.call("Stop")[0]["decision"], "block")
        self.assertEqual(self.call("Stop")[0]["decision"], "block")
        self.tool("go", "\n".join([*failures[100:], "--- FAIL: TestNew (0.00s)", "FAIL"]), 1)
        write(self.cwd / "edit.txt", "legacy cleanup")
        self.assertEqual(self.call("PostToolUse")[0], {})
        self.assertEqual(self.call("Stop")[0]["decision"], "block")
        self.assertEqual(read(inventory), snapshot)

    def test_changed_workspace_reruns_and_reports_recovery(self) -> None:
        result, count = self.configure()
        write(result, "RESULT: PASS")
        self.call("SessionStart", source="startup")
        write(result, "RESULT: FAIL")
        self.call("PostToolUse")

        write(result, "RESULT: PASS")
        recovered, _ = self.call("PostToolUse", tool_name="apply_patch")
        self.assertIn("green again", recovered["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(read(count), "3")

        stopped, _ = self.call("Stop", stop_hook_active=False)
        self.assertEqual(stopped, {})
        self.assertEqual(read(count), "3")

    def test_watch_command_stops_after_its_first_report(self) -> None:
        result, _ = self.configure(watch=True)
        write(result, "RESULT: PASS")

        output, elapsed = self.call("SessionStart", source="startup")
        self.assertEqual(output, {})
        self.assertLess(elapsed, 3)

    def test_enabled_false_runs_nothing(self) -> None:
        write(self.cwd / ".overwatch.json", json.dumps({"enabled": False}))
        output, _ = self.call("SessionStart", source="startup")
        self.assertEqual(output, {})

    def test_invalid_override_warns_without_blocking_codex(self) -> None:
        write(self.cwd / ".overwatch.json", "not json")
        output, _ = self.call("Stop", stop_hook_active=False)
        self.assertIn("systemMessage", output)
        self.assertNotIn("decision", output)

    def test_every_language_in_a_polyglot_project_is_checked_by_exit_code(self) -> None:
        write(self.cwd / "go.mod", "module example.com/calc\n")
        write(self.cwd / "Cargo.toml", "[package]\n")
        self.tool("go", "--- FAIL: TestAdd (0.00s)\n    calc_test.go:3: Add(3, 7) = 10\nFAIL", 1)
        self.tool("cargo", "test tests::adds ... ok\ntest result: ok. 1 passed", 0)

        self.prime_tools()
        started, _ = self.call("PostToolUse")
        self.assertEqual(started["systemMessage"], "Overwatch: go ✗ 1 failed: TestAdd")
        self.assertIn("Failing: `TestAdd`.", started["hookSpecificOutput"]["additionalContext"])

    def test_each_language_is_checked_at_once(self) -> None:
        write(self.cwd / "go.mod", "module example.com/calc\n")
        write(self.cwd / "Cargo.toml", "[package]\n")
        for name, output in (("go", "ok  example.com/calc 0.1s"), ("cargo", "test result: ok. 1 passed")):
            script = self.bin / name
            write(script, f"#!/bin/sh\nsleep 2\necho '{output}'\n")
            script.chmod(0o755)

        started, elapsed = self.call("SessionStart", source="startup")
        self.assertEqual(started, {})
        self.assertLess(elapsed, 3.5)

    def test_a_language_the_root_lacks_is_checked_in_each_subproject(self) -> None:
        for directory, marker in (("services/api", "go.mod"), ("tools", "Cargo.toml"), ("node_modules/pad", "go.mod")):
            mkdir(self.cwd / directory)
            write(self.cwd / directory / marker, "")
        go = self.bin / "go"
        write(go, '#!/bin/sh\npwd > "$(dirname "$0")/go.cwd"\necho "--- FAIL: TestAdd (0.00s)"\nexit 1\n')
        go.chmod(0o755)
        self.tool("cargo", "test result: ok. 1 passed", 0)

        self.prime_tools()
        started, _ = self.call("PostToolUse")
        self.assertEqual(started["systemMessage"], "Overwatch: go services/api ✗ 1 failed: TestAdd")
        self.assertIn("`go test ./...` in `services/api` failed", started["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(Path(read(self.bin / "go.cwd").strip()).resolve(), (self.cwd / "services/api").resolve())

    def test_go_uses_gotestsum_when_it_is_on_path(self) -> None:
        write(self.cwd / "go.mod", "module example.com/calc\n")
        self.tool("go", "", 0)
        self.tool("gotestsum", "=== FAIL: . TestAdd (0.00s)\n\nDONE 2 tests, 1 failure in 0.184s", 1)

        self.prime_tools()
        started, _ = self.call("PostToolUse")
        self.assertEqual(started["systemMessage"], "Overwatch: go ✗ 2 tests, 1 failure in 0.184s: . TestAdd")

    def test_the_typescript_table_is_generated_from_watchers_json(self) -> None:
        self.assertEqual(read(table.TARGET), table.render(), "run python3 scripts/table.py")

    def test_python_without_uv_reruns_pytest_from_path(self) -> None:
        write(self.cwd / "pyproject.toml", "[project]\n")
        self.tool("pytest", "FAILED tests/test_add.py::test_add - assert 10 == 11\n=== 1 failed, 2 passed in 0.03s ===", 1)

        self.prime_tools()
        started, _ = self.call("PostToolUse")
        self.assertEqual(started["systemMessage"], "Overwatch: python ✗ 1 failed, 2 passed in 0.03s: tests/test_add.py::test_add")

    def test_full_output_is_saved_without_truncation(self) -> None:
        report = {"name": "fixture", "text": "details\n" * 2000}
        path = codex.write_log(self.data / "state.json", report)
        self.assertEqual(read(path), report["text"])

    def test_colour_codes_are_read_through(self) -> None:
        output = "\x1b[0m\x1b[31mFAILED\x1b[0m | 1 passed | 1 failed\n\x1b[0m\x1b[38;5;12mWatcher\x1b[0m Test failed. Restarting..."
        report = codex.read_report(next(w for w in codex.WATCHERS if w["name"] == "deno"), output)
        assert report is not None
        self.assertTrue(report["failed"])
        self.assertEqual(report["summary"], "FAILED | 1 passed | 1 failed")

    def test_a_run_with_no_summary_that_exits_nonzero_fails(self) -> None:
        python = codex.WATCHERS[1]
        report = codex.read_report(python, "error: Failed to parse uv.lock", 2)
        assert report is not None
        self.assertEqual((report["failed"], report["summary"]), (True, "exited with code 2"))
        self.assertIsNone(codex.read_report(python, "nothing", 0))

    def test_every_codex_hook_has_a_branded_status_message(self) -> None:
        config = json.loads(read(HOOKS_CONFIG))
        handlers = [
            handler
            for groups in config["hooks"].values()
            for group in groups
            for handler in group["hooks"]
        ]

        self.assertTrue(handlers)
        for handler in handlers:
            self.assertRegex(handler.get("statusMessage", ""), r"^Overwatch: ")

    def test_codex_overlay_registers_the_hook_config(self) -> None:
        codex = json.loads(read(CODEX_MANIFEST))
        claude = json.loads(read(CLAUDE_MANIFEST))
        package = json.loads(read(PACKAGE_MANIFEST))

        self.assertFalse((ROOT / "plugin.json").exists(), "a root Agent Plugin manifest suppresses Codex hooks")
        self.assertEqual(codex["version"], claude["version"])
        self.assertEqual(package["version"], claude["version"])
        self.assertEqual(codex["hooks"], "./hooks/codex-hooks.json")
        self.assertEqual(codex["interface"]["displayName"], "Overwatch")
        self.assertEqual(package["exports"], "./integrations/opencode.js")
        self.assertEqual(package["pi"]["extensions"], ["./integrations/pi.js"])


if __name__ == "__main__":
    unittest.main()
