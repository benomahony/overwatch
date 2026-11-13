"""Tests of overwatch's Codex hook, driven through its stdin as Codex drives it, with fake tools on PATH.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

from dataclasses import replace
import json
import re
from pathlib import Path
import os
import unittest
from unittest.mock import patch

from codex_hook import CodexHook, barrier_script, fixture_report, mkdir, read, tool_script, write
from paths import ROOT
import discovery
import engine
import reading
import records
import running
import table
import triage


HOOKS_CONFIG = ROOT / "integrations" / "codex-hooks.json"
CODEX_MANIFEST = ROOT / ".codex-plugin" / "plugin.json"
CLAUDE_MANIFEST = ROOT / ".claude-plugin" / "plugin.json"
PACKAGE_MANIFEST = ROOT / "package.json"
# What `zanity check . --plain` prints for two findings: one record per finding, then the summary.
ZANITY_FAILING = "".join(
    f'path="calc.py"\tline={line}\tcolumn=5\tseverity="warning"\trule="{rule}"\tmessage="{message}"\tfix="Handle it."\t'
    f'matching_total=null\tnext_offset=null\tedit_start=null\tedit_end=null\tedit_text=null\tid="{id}"\tclassification="unclassified"\n'
    for line, rule, message, id in (
        (1, "dead-symbol", "'f' is a function that nothing refers to.", "ba4ccb9f687bffd53f6f5176d8eb3ee6263cd74a332002b2b20408e3325566d4"),
        (4, "swallowed-error", "This error handler does nothing.", "cdde7f46bc45c60ec4c5cab46a974f59403f54448133a3abefc633b26ce88853"),
    )
) + "zanity: 0 errors and 2 warnings in 1 of 1 file\n"


class CodexHookTests(CodexHook):
    def test_inspection_does_not_wait_for_running_checks(self) -> None:
        """A baseline holding the session lock must not prevent inspection tools."""
        root = engine.data_root(str(self.data))
        event = engine.Event("PreToolUse", "session-1", str(self.cwd), "Bash", {"command": "git status"})
        with engine.locked(engine.state_path(event, self.cwd, root), root):
            output, _ = self.call("PreToolUse", tool_name="Bash", tool_input={"command": "git status"})
        self.assertEqual(output, {})

    def test_failure_notifies_once_but_completion_remains_guarded(self) -> None:
        result, count = self.configure()
        write(result, "RESULT: PASS")
        self.assertEqual(self.call("SessionStart")[0], {})
        write(result, "details\nRESULT: FAIL", "RESULT: PASS")
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
        write(result, "RESULT: FAIL in 0.01s", "RESULT: PASS")
        self.assertIn("systemMessage", self.call("Stop")[0])
        write(result, "RESULT: FAIL in 0.02s", "RESULT: FAIL in 0.01s")
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
        write(result, "RESULT: FAIL", "RESULT: PASS")
        self.assertEqual(self.call("Stop", stop_hook_active=True)[0]["decision"], "block")
        self.assertEqual(self.call("Stop")[0]["decision"], "block")
        self.assertEqual(self.call("Stop")[0]["decision"], "block")

    def test_summary_only_backlog_blocks_only_when_error_counts_increase(self) -> None:
        result, _ = self.configure()
        write(result, "RESULT: FAIL 10000 errors")
        self.call("SessionStart")
        write(result, "RESULT: FAIL 9999 errors", "RESULT: FAIL 10000 errors")
        self.assertEqual(self.call("PostToolUse")[0], {})
        write(result, "RESULT: FAIL 10001 errors", "RESULT: FAIL 9999 errors")
        self.assertNotIn("decision", self.call("PostToolUse")[0])
        self.assertEqual(self.call("Stop")[0]["decision"], "block")
        self.assertEqual(self.call("Stop")[0]["decision"], "block")

    def test_another_new_issue_gets_its_own_stop_guard(self) -> None:
        first = fixture_report(failed=True, failures=("legacy",), summary="1 failed")
        baseline = engine.report_state([first], engine.State())
        stop = engine.Event("Stop", "session-1", str(self.cwd), "", None)
        report = replace(first, failures=("legacy", "new-a"), summary="2 failed")
        current = engine.report_state([report], baseline)
        self.assertTrue(engine.block_stop(stop, current))
        report = replace(report, failures=("new-b", "new-a", "legacy"), summary="3 failed")
        following = engine.report_state([report], current)
        self.assertTrue(engine.block_stop(stop, following))
        report = replace(report, failures=("new-a",), summary="1 failed")
        remaining = engine.report_state([report], following)
        self.assertTrue(engine.block_stop(stop, remaining))

    def test_a_summary_with_two_failure_counts_compares_each_with_its_own(self) -> None:
        first = fixture_report(failed=True, summary="Build Summary: 3/5 steps succeeded (1 failed); 1/3 tests passed (2 failed)")
        baseline = engine.report_state([first], engine.State()).baseline
        more_steps = replace(first, summary="Build Summary: 3/5 steps succeeded (2 failed); 1/3 tests passed (2 failed)")
        fewer_tests = replace(first, summary="Build Summary: 4/5 steps succeeded (1 failed); 2/3 tests passed (1 failed)")
        self.assertTrue(engine.is_regression(more_steps, baseline))
        self.assertFalse(engine.is_regression(fewer_tests, baseline))

    def test_saved_state_reads_back_as_it_was_written(self) -> None:
        state = engine.report_state([fixture_report(failed=True, failures=("legacy",), summary="1 failed")], engine.State())
        self.assertEqual(records.state_from(json.loads(json.dumps(records.state_json(state)))), state)

    def test_saved_state_of_another_shape_starts_the_session_afresh(self) -> None:
        result, count = self.configure()
        write(result, "RESULT: PASS")
        self.call("SessionStart")
        [state] = [path for path in self.data.glob("*.json") if not path.name.endswith(".baseline.json")]
        saved = read(state)
        write(state, json.dumps({"reports": [{"name": "fixture", "failed": "yes"}]}), saved)
        self.assertEqual(self.call("PostToolUse", tool_name="apply_patch")[0], {})
        self.assertEqual(read(count), "2")

    def test_large_legacy_baseline_is_compact_and_inspectable(self) -> None:
        _, started, inventory = self.start_legacy_session()
        context = started["hookSpecificOutput"]["additionalContext"]
        self.assertLess(len(context), 1000)
        self.assertIn("10000 named issues", context)
        self.assertNotIn("decision", started)
        self.assertEqual(self.call("Stop")[0], {})
        check = json.loads(read(inventory))["checks"][0]
        self.assertEqual(len(check["failures"]), 10_000)
        self.assertIn("TestCase9999", read(Path(check["log"])))

    def test_triage_filters_and_pages_a_large_baseline(self) -> None:
        _, _, inventory = self.start_legacy_session()
        checks = triage.parse_inventory(json.loads(read(inventory)))
        selected = triage.triage(checks, "GO", "TestCase99")
        batch = triage.triage_page(selected, 3, 3)
        self.assertEqual(batch.total, 111)
        self.assertEqual(len(batch.issues), 3)
        self.assertEqual(batch.issues, selected.issues[3:6])
        self.assertEqual(len(triage.triage(checks, "missing").issues), 0)

    def test_legacy_cleanup_preserves_the_new_failure_gate(self) -> None:
        """A new issue keeps completion guarded while cleanup preserves the inherited snapshot."""
        failures, _, inventory = self.start_legacy_session()
        snapshot = read(inventory)
        self.tool("go", "\n".join([*failures, "--- FAIL: TestNew (0.00s)", "FAIL"]), 1, ("\n".join([*failures, "FAIL"]), 1))
        write(self.cwd / "edit.txt", "new change")
        changed = self.call("PostToolUse")[0]
        self.assertNotIn("decision", changed)
        self.assertIn("TestNew", changed["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.call("Stop")[0]["decision"], "block")
        self.assertEqual(self.call("Stop")[0]["decision"], "block")
        self.tool("go", "\n".join([*failures[100:], "--- FAIL: TestNew (0.00s)", "FAIL"]), 1,
                  ("\n".join([*failures, "--- FAIL: TestNew (0.00s)", "FAIL"]), 1))
        write(self.cwd / "edit.txt", "legacy cleanup", "new change")
        self.assertEqual(self.call("PostToolUse")[0], {})
        self.assertEqual(self.call("Stop")[0]["decision"], "block")
        self.assertEqual(read(inventory), snapshot)

    def test_changed_workspace_reruns_and_reports_recovery(self) -> None:
        result, count = self.configure()
        write(result, "RESULT: PASS")
        self.call("SessionStart", source="startup")
        write(result, "RESULT: FAIL", "RESULT: PASS")
        self.call("PostToolUse")

        write(result, "RESULT: PASS", "RESULT: FAIL")
        recovered, _ = self.call("PostToolUse", tool_name="apply_patch")
        self.assertIn("green again", recovered["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(read(count), "3")

        stopped, _ = self.call("Stop", stop_hook_active=False)
        self.assertEqual(stopped, {})
        self.assertEqual(read(count), "3")

    def test_watch_command_stops_after_its_first_report(self) -> None:
        result, count = self.configure(watch=True)
        write(result, "RESULT: PASS")

        output, _ = self.call("SessionStart", source="startup")
        self.assertEqual(output, {})
        self.assertEqual(read(count), "1")

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

        self.start_passing_session()
        started, _ = self.call("PostToolUse")
        self.assertEqual(started["systemMessage"], "Overwatch: go ✗ 1 failed: TestAdd")
        self.assertIn("Failing: `TestAdd`.", started["hookSpecificOutput"]["additionalContext"])

    def test_each_language_is_checked_at_once(self) -> None:
        write(self.cwd / "go.mod", "module example.com/calc\n")
        write(self.cwd / "Cargo.toml", "[package]\n")
        # Each fake waits for the other to start, so only checks run at once both pass; run one after the other,
        # the first gives up waiting and fails.
        for name, other, output in (("go", "cargo", "ok  example.com/calc 0.1s"), ("cargo", "go", "test result: ok. 1 passed")):
            script = self.bin / name
            write(script, barrier_script(self.bin / f"{name}.started", self.bin / f"{other}.started", output))
            script.chmod(0o755)

        started, _ = self.call("SessionStart", source="startup")
        self.assertEqual(started, {})

    def test_a_language_the_root_lacks_is_checked_in_each_subproject(self) -> None:
        for directory, marker in (("services/api", "go.mod"), ("tools", "Cargo.toml"), ("node_modules/pad", "go.mod")):
            mkdir(self.cwd / directory)
            write(self.cwd / directory / marker, "")
        go = self.bin / "go"
        write(go, '#!/bin/sh\npwd > "$(dirname "$0")/go.cwd"\necho "--- FAIL: TestAdd (0.00s)"\nexit 1\n')
        go.chmod(0o755)
        self.tool("cargo", "test result: ok. 1 passed", 0)

        self.start_passing_session()
        started, _ = self.call("PostToolUse")
        self.assertEqual(started["systemMessage"], "Overwatch: go services/api ✗ 1 failed: TestAdd")
        self.assertIn("`go test ./...` in `services/api` failed", started["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(Path(read(self.bin / "go.cwd").strip()).resolve(), (self.cwd / "services/api").resolve())

    def test_go_uses_gotestsum_when_it_is_on_path(self) -> None:
        write(self.cwd / "go.mod", "module example.com/calc\n")
        self.tool("go", "", 0)
        self.tool("gotestsum", "=== FAIL: . TestAdd (0.00s)\n\nDONE 2 tests, 1 failure in 0.184s", 1)

        self.start_passing_session()
        started, _ = self.call("PostToolUse")
        self.assertEqual(started["systemMessage"], "Overwatch: go ✗ 2 tests, 1 failure in 0.184s: . TestAdd")

    def test_watchers_settings_configure_each_entry_by_name(self) -> None:
        write(self.cwd / "Cargo.toml", "[package]\n")
        settings = {"rust": {"baseline": ["cargo", "test", "--lib"], "env": {"RUST_BACKTRACE": "1"}},
                    "zanity": {"enabled": False}, "git": {"env": {"OVERWATCH_GIT_INTERVAL": "300"}}}
        write(self.cwd / ".overwatch.json", json.dumps({"watchers": settings}))
        watchers = {watcher["name"]: watcher for watcher in engine.find_watchers(self.cwd)}
        self.assertEqual(watchers["rust"]["baseline"], ["cargo", "test", "--lib"])
        self.assertEqual(watchers["rust"]["env"], {"RUST_BACKTRACE": "1"})
        self.assertNotIn("zanity", watchers)
        if "git" in watchers:
            self.assertEqual(watchers["git"]["env"], {"OVERWATCH_GIT_INTERVAL": "300"})

    def test_a_watchers_env_reaches_its_command(self) -> None:
        write(self.cwd / "Cargo.toml", "[package]\n")
        write(self.cwd / ".overwatch.json", json.dumps({"watchers": {"rust": {"env": {"OVERWATCH_FIXTURE": "set"}}}}))
        self.tool("cargo", "test tests::adds ... FAILED", 101)
        original = tool_script("test tests::adds ... FAILED", 101)
        guarded = original.replace("#!/bin/sh\n", '#!/bin/sh\n[ "$OVERWATCH_FIXTURE" = set ] || exit 0\n', 1)
        self.assertNotEqual(guarded, original, "the fake cargo does not read the variable; check tool_script's shebang")
        write(self.bin / "cargo", guarded, original)

        self.start_passing_session()
        started, _ = self.call("PostToolUse")
        self.assertEqual(started["systemMessage"], "Overwatch: rust ✗ 1 failed: tests::adds")

    def test_invalid_watchers_settings_name_the_field(self) -> None:
        write(self.cwd / "Cargo.toml", "[package]\n")
        previous = None
        for settings, field in (({"rust": {"enabled": "no"}}, "watchers.rust.enabled"),
                                ({"rust": {"interval": 5}}, "unknown fields ['interval']"),
                                ({"rust": {"env": {"A": 1}}}, "watchers.rust.env"),
                                ({"rust": {"timeout": True}}, "field 'timeout'"),
                                ({"rust": {"timeout": 0}}, "field 'timeout'"),
                                ({"rust": {"settle": "1s"}}, "field 'settle'"),
                                ([], "'watchers'")):
            text = json.dumps({"watchers": settings})
            write(self.cwd / ".overwatch.json", text, previous)
            previous = text
            with self.subTest(settings=settings), self.assertRaisesRegex(engine.ConfigurationError, re.escape(field)):
                engine.find_watchers(self.cwd)

    def test_a_guard_names_each_check_once(self) -> None:
        summary = "zanity: 0 errors, 1 warning in 1/1 file."
        report = engine.Report("zanity", "zanity", "zanity check .", None, summary, True, (), None, summary)
        self.assertIn("\n- zanity: 0 errors, 1 warning in 1/1 file.\n", engine.gate_reason([report]))
        self.assertNotIn("zanity: zanity:", engine.gate_reason([report]))

    def test_the_typescript_table_is_generated_from_watchers_json(self) -> None:
        self.assertEqual(read(table.TARGET), table.render(), "run python3 scripts/table.py")

    def test_python_without_uv_reruns_pytest_from_path(self) -> None:
        write(self.cwd / "pyproject.toml", "[project]\n")
        self.tool("pytest", "FAILED tests/test_add.py::test_add - assert 10 == 11\n=== 1 failed, 2 passed in 0.03s ===", 1)

        self.start_passing_session()
        started, _ = self.call("PostToolUse")
        self.assertEqual(started["systemMessage"], "Overwatch: python ✗ 1 failed, 2 passed in 0.03s: tests/test_add.py::test_add")
        self.assertIn("`pytest", started["hookSpecificOutput"]["additionalContext"])
        self.assertNotIn("`uv run", started["hookSpecificOutput"]["additionalContext"])

    def test_full_output_is_saved_without_truncation(self) -> None:
        result, _ = self.configure()
        write(result, "RESULT: PASS")
        self.call("SessionStart")
        output = "details\n" * 2000 + "RESULT: FAIL"
        write(result, output, "RESULT: PASS")
        context = self.call("PostToolUse", tool_name="apply_patch")[0]["hookSpecificOutput"]["additionalContext"]
        log = context.split("Full output: `")[1].split("`")[0]
        self.assertEqual(read(Path(log)), output)

    def test_colour_codes_are_read_through(self) -> None:
        output = "\x1b[0m\x1b[31mFAILED\x1b[0m | 1 passed | 1 failed\n\x1b[0m\x1b[38;5;12mWatcher\x1b[0m Test failed. Restarting..."
        report = reading.read_report(next(w for w in discovery.WATCHERS if w["name"] == "deno"), output)
        assert report is not None, f"deno's summary was not found in {output!r}; check its summary pattern"
        self.assertTrue(report.failed)
        self.assertEqual(report.summary, "FAILED | 1 passed | 1 failed")

    def test_zanity_names_each_finding_by_path_rule_and_id(self) -> None:
        zanity = next(checker for checker in discovery.CHECKERS if checker["name"] == "zanity")
        self.assertIn("--plain", zanity["argv"])
        report = reading.read_report(zanity, ZANITY_FAILING)
        assert report is not None, f"zanity's summary was not found in {ZANITY_FAILING!r}; check its summary pattern"
        self.assertEqual(report.failures, ("calc.py dead-symbol ba4ccb9f687b", "calc.py swallowed-error cdde7f46bc45"))

    def test_a_check_past_its_timeout_reports_a_timeout_and_no_error(self) -> None:
        self.tool("cargo", "", 0)
        write(self.bin / "cargo", "#!/bin/sh\ntouch fake-cargo-ran\nsleep 30\n", tool_script("", 0))
        write(self.cwd / "Cargo.toml", "[package]\n")
        write(self.cwd / ".overwatch.json", json.dumps({"watchers": {"rust": {"timeout": 0.5}}}))
        # Only the test's fakes are on PATH, so the check is the fake cargo that sleeps, not one on this machine.
        with patch.dict("os.environ", {"PATH": f"{self.bin}{os.pathsep}{os.defpath}"}):
            rust = next(watcher for watcher in engine.find_watchers(self.cwd) if watcher["name"] == "rust")
            [report] = running.run_checks(self.cwd, [rust])
        self.assertTrue((self.cwd / "fake-cargo-ran").exists(), "the check ran a cargo other than the test's fake")
        self.assertEqual((report.failed, report.failures, report.summary), (True, ("timeout",), "timed out after 0.5s"))

    def test_a_run_with_no_summary_that_exits_nonzero_fails(self) -> None:
        python = discovery.WATCHERS[1]
        report = reading.read_report(python, "error: Failed to parse uv.lock", 2)
        assert report is not None, "a nonzero exit with no summary gave no report; read it by its exit code"
        self.assertEqual((report.failed, report.summary), (True, "exited with code 2"))
        self.assertIsNone(reading.read_report(python, "nothing", 0))

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
        self.assertEqual(codex["hooks"], "./integrations/codex-hooks.json")
        self.assertEqual(codex["interface"]["displayName"], "Overwatch")
        self.assertEqual(package["exports"], "./integrations/opencode.js")
        self.assertEqual(package["pi"]["extensions"], ["./integrations/pi.js"])


if __name__ == "__main__":
    unittest.main()
