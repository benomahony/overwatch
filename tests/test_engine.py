"""Tests of overwatch's Codex hook, driven through its stdin as Codex drives it, with fake tools on PATH.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

from dataclasses import replace
import json
import os
import re
import shlex
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest

from daemons import data_directory
from paths import ROOT
import engine
import table
import triage


# Codex runs the engine through its adapter, as the plugin installs it.
HOOK = ROOT / "integrations" / "codex.py"
HOOKS_CONFIG = ROOT / "integrations" / "codex-hooks.json"
CODEX_MANIFEST = ROOT / ".codex-plugin" / "plugin.json"
CLAUDE_MANIFEST = ROOT / ".claude-plugin" / "plugin.json"
PACKAGE_MANIFEST = ROOT / "package.json"
# How long one hook call may take, in seconds, before the test fails.
HOOK_TIMEOUT = 5
# How many failures the inherited backlog of a legacy project holds.
LEGACY_FAILURES = 10_000


def write(path: Path, text: str, replacing: str | None = None) -> None:
    """Writes text to a fixture file in the test's own temporary directory: a new file when replacing is None, else
    the file that holds exactly replacing, read and rewritten through one handle, so a test only ever writes over
    the content it says it is replacing."""
    with path.open("x" if replacing is None else "r+") as handle:
        current = None if replacing is None else handle.read()
        if current != replacing:
            raise AssertionError(f"{path} holds {current!r}, not {replacing!r}; pass what the test last wrote there as replacing")
        handle.seek(0)
        handle.truncate()
        handle.write(text)
        handle.flush()
        assert handle.tell() == len(text.encode()), f"{path} took {handle.tell()} bytes of {len(text.encode())}; write all of it"
        assert os.fstat(handle.fileno()).st_size == handle.tell(), f"{path} kept bytes past what was written; truncate it first"


def read(path: Path) -> str:
    """The text of a fixture file the hook or a fake tool wrote, read through one handle."""
    data = path.read_bytes()
    text = data.decode()
    assert text.encode() == data, f"{path} did not decode back to its own bytes; read it as UTF-8 text"
    assert len(text) <= len(data), f"{path} gave {len(text)} characters from {len(data)} bytes; decode it as UTF-8"
    return text


def fixture_report(failed: bool = False, failures: tuple[str, ...] = (), summary: str = "passed", text: str = "") -> engine.Report:
    """A report of the fixture check, as read_report would give it, with the given result."""
    report = engine.Report("fixture", "project", "fixture", None, summary, failed, failures if failed else (), None, text)
    assert report.failed or not report.failures, f"fixture report passed with failures {failures}; give failures only to a failure"
    assert report.summary == summary, f"fixture report summary {report.summary} is not {summary}"
    return report


def tool_script(output: str, code: int) -> str:
    """The script of a fake tool that prints output and exits with code."""
    script = f"#!/bin/sh\ncat <<'EOF'\n{output}\nEOF\nexit {code}\n"
    assert script.startswith("#!/bin/sh\n"), f"fake tool script {script[:40]!r} has no shell line"
    assert script.endswith(f"exit {code}\n"), f"fake tool script does not exit with {code}"
    return script


def passing(summary: str) -> str:
    """The script of a fake tool that prints summary, quoted for the shell, and passes."""
    script = f"#!/bin/sh\necho {shlex.quote(summary)}\nexit 0\n"
    assert shlex.quote(summary) in script, f"passing script {script!r} does not print {summary!r}; echo it quoted"
    assert script.endswith("exit 0\n"), f"passing script {script!r} does not exit 0; end it with exit 0"
    return script


def barrier_script(mine: Path, theirs: Path, output: str) -> str:
    """A fake tool that marks it has started at mine, waits for another to mark theirs, then prints output and
    passes; if the other never starts, it gives up after HOOK_TIMEOUT / 2 seconds and fails."""
    tries = int(HOOK_TIMEOUT / 2 / 0.05)
    script = (f"#!/bin/sh\ntouch {shlex.quote(str(mine))}\ni=0\n"
              f"while [ ! -e {shlex.quote(str(theirs))} ] && [ $i -lt {tries} ]; do sleep 0.05; i=$((i+1)); done\n"
              f"[ -e {shlex.quote(str(theirs))} ] || exit 3\necho {shlex.quote(output)}\n")
    assert shlex.quote(str(theirs)) in script, f"barrier script does not wait for {theirs}; quote it into the loop"
    assert script.endswith(f"echo {shlex.quote(output)}\n"), f"barrier script does not end by printing {output!r}"
    return script


def mkdir(path: Path) -> None:
    """Makes a fixture directory that does not exist yet; one that does raises FileExistsError."""
    path.mkdir(parents=True)
    assert path.is_dir(), f"{path} was not made; check its parent is writable"
    assert not any(path.iterdir()), f"{path} is not empty just after it was made; give each fixture directory its own name"


class CodexHookTests(unittest.TestCase):
    def test_inspection_does_not_wait_for_running_checks(self) -> None:
        """A baseline holding the session lock must not prevent inspection tools."""
        root = engine.data_root(str(self.data))
        event = engine.Event("PreToolUse", "session-1", str(self.cwd), "Bash", {"command": "git status"})
        with engine.locked(engine.state_path(event, self.cwd, root), root):
            output, _ = self.call("PreToolUse", tool_name="Bash", tool_input={"command": "git status"})
        self.assertEqual(output, {})

    def setUp(self) -> None:
        """Gives each test its own temporary directory, removed when it ends, holding a fresh git repository for the
        project, a data directory for the hook's state, and an empty bin directory for fake tools, which call puts
        first on PATH."""
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.cwd = Path(self.temporary.name) / "project"
        self.data = data_directory(self)
        self.cwd.mkdir()
        subprocess.run(["git", "init", "-q", str(self.cwd)], check=True)
        self.bin = Path(self.temporary.name) / "bin"
        self.bin.mkdir()
        assert (self.cwd / ".git").is_dir(), f"git init made no repository in {self.cwd}"
        assert not any(self.bin.iterdir()), f"{self.bin} starts with tools in it; each test adds its own"

    def tool(self, name: str, output: str, code: int, replacing: tuple[str, int] | None = None) -> None:
        """Puts a fake `name` in the test's bin directory, a POSIX shell script that prints `output` and exits with
        `code`, in place of the fake that printed and exited with replacing, when the test swaps one. The hook runs
        on POSIX only, so its tests do too."""
        assert "\nEOF\n" not in f"\n{output}\n", f"output for {name} holds the heredoc's EOF line; pick another fixture output"
        if Path(name).name != name or name in ("", ".", ".."):
            raise ValueError(f"fake tool name {name!r} is not a plain file name; name it as it is run")
        script = self.bin / name
        write(script, tool_script(output, code), None if replacing is None else tool_script(*replacing))
        script.chmod(0o755)
        assert os.access(script, os.X_OK), f"{script} is not executable; chmod it"

    def configure(self, *, watch: bool = False) -> tuple[Path, Path]:
        """Writes the fixture check, check.py, which prints result.txt and counts its runs in count.txt, and the
        project's .overwatch.json, which runs it as its baseline, or as its watch command, which keeps running, when
        watch is set. Returns result.txt and count.txt; both are in the test's temporary directory, removed with it,
        and a second call fails, since each file is written new."""
        result = self.cwd / "result.txt"
        # Runner bookkeeping is not a source edit and must not change the workspace fingerprint.
        count = Path(self.temporary.name) / "count.txt"
        runner = self.cwd / "check.py"
        write(runner,
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
        write(self.cwd / ".overwatch.json", json.dumps(config))
        watchers = engine.find_watchers(self.cwd)
        assert [watcher["name"] for watcher in watchers][:1] == ["fixture"], f"{self.cwd} runs {[watcher['name'] for watcher in watchers]}, not the fixture check first; check .overwatch.json"
        assert not count.exists(), f"{count} exists before the fixture check ran; nothing but check.py should write it"
        return result, count

    def call(self, event: str, **fields: object) -> tuple[dict[str, object], float]:
        """Sends one hook event to the hook script, as Codex does, returning its output and how long it took. Only
        the test's fake tools and the system's default PATH are on PATH, so the hook runs only what the test gave it."""
        payload = {
            "session_id": "session-1",
            "cwd": str(self.cwd),
            "hook_event_name": event,
            **fields,
        }
        environment = {
            **os.environ,
            "PATH": f"{self.bin}{os.pathsep}{os.defpath}",
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
            timeout=HOOK_TIMEOUT,
            check=True,
        )
        output, elapsed = json.loads(process.stdout), time.monotonic() - started
        assert type(output) is dict, f"the hook answered {event} with {process.stdout[:80]}, not a JSON object; print one object from main"
        assert not process.stderr, f"the hook wrote to stderr for {event}: {process.stderr[-400:]}; fix the error it reports"
        return output, elapsed

    def start_passing_session(self) -> None:
        """Starts the session with every fake tool passing, so its baseline is green, then puts back the tools the
        test set up and changes the workspace. The next event reruns the real tools, and what they report is a new
        failure against that baseline, which is what the test checks."""
        scripts = {path: read(path) for path in self.bin.iterdir()}
        assert scripts, f"{self.bin} has no tools to start passing; add them with tool() first"
        for path in scripts:
            summary = {"gotestsum": "DONE 2 tests, 0 failures", "pytest": "=== 3 passed in 0.01s ==="}.get(path.name, "")
            write(path, passing(summary), scripts[path])
        self.call("SessionStart")
        for path, text in scripts.items():
            summary = {"gotestsum": "DONE 2 tests, 0 failures", "pytest": "=== 3 passed in 0.01s ==="}.get(path.name, "")
            write(path, text, passing(summary))
        write(self.cwd / "changed.txt", "changed")
        assert all(read(path) == text for path, text in scripts.items()), f"tools in {self.bin} were not put back after the passing start; write each back"

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
        self.assertEqual(engine.state_from(json.loads(json.dumps(engine.state_json(state)))), state)

    def test_saved_state_of_another_shape_starts_the_session_afresh(self) -> None:
        result, count = self.configure()
        write(result, "RESULT: PASS")
        self.call("SessionStart")
        [state] = [path for path in self.data.glob("*.json") if not path.name.endswith(".baseline.json")]
        saved = read(state)
        write(state, json.dumps({"reports": [{"name": "fixture", "failed": "yes"}]}), saved)
        self.assertEqual(self.call("PostToolUse", tool_name="apply_patch")[0], {})
        self.assertEqual(read(count), "2")

    def start_legacy_session(self) -> tuple[list[str], dict[str, object], Path]:
        """Makes a Go project whose tests have LEGACY_FAILURES inherited failures and starts a session in it,
        returning the failures, the hook's output and the triage inventory it saved."""
        write(self.cwd / "go.mod", "module legacy")
        failures = [f"--- FAIL: TestCase{i} (0.00s)" for i in range(LEGACY_FAILURES)]
        self.tool("go", "\n".join([*failures, "FAIL"]), 1)
        started = self.call("SessionStart")[0]
        inventories = list(self.data.glob("*.baseline.json"))
        assert len(inventories) == 1, f"the session saved inventories {inventories}; baseline_inventory should save one"
        assert "hookSpecificOutput" in started, f"the session start said nothing of the inherited backlog: {started}; check baseline_inventory's notice"
        return failures, started, inventories[0]

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

    def git(self, *args: str) -> None:
        """Runs git in the project as a fixed test identity, so commits need no user configuration."""
        subprocess.run(["git", "-c", "user.email=dev@example.com", "-c", "user.name=dev", *args],
                       cwd=self.cwd, check=True, capture_output=True)

    def test_an_edit_committed_in_the_same_step_is_a_new_failure(self) -> None:
        result, _ = self.configure()
        write(result, "RESULT: PASS")
        self.git("add", "-A")
        self.git("commit", "-qm", "init")
        self.call("SessionStart")
        write(result, "RESULT: FAIL", "RESULT: PASS")
        self.git("commit", "-qam", "break")
        failed, _ = self.call("PostToolUse", tool_name="Bash")
        self.assertIn("Full output:", failed["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.call("Stop")[0]["decision"], "block")

    def test_a_checkout_that_moves_head_takes_a_fresh_baseline(self) -> None:
        result, _ = self.configure()
        write(result, "RESULT: PASS")
        self.git("add", "-A")
        self.git("commit", "-qm", "init")
        self.git("checkout", "-qb", "other")
        write(result, "RESULT: FAIL", "RESULT: PASS")
        self.git("commit", "-qam", "other")
        self.git("checkout", "-q", "-")
        self.call("SessionStart")
        self.git("checkout", "-q", "other")
        moved, _ = self.call("PostToolUse", tool_name="Bash")
        self.assertIn("inherited backlog", moved["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.call("Stop")[0], {})

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
        report = engine.read_report(next(w for w in engine.WATCHERS if w["name"] == "deno"), output)
        assert report is not None, f"deno's summary was not found in {output!r}; check its summary pattern"
        self.assertTrue(report.failed)
        self.assertEqual(report.summary, "FAILED | 1 passed | 1 failed")

    def test_a_run_with_no_summary_that_exits_nonzero_fails(self) -> None:
        python = engine.WATCHERS[1]
        report = engine.read_report(python, "error: Failed to parse uv.lock", 2)
        assert report is not None, "a nonzero exit with no summary gave no report; read it by its exit code"
        self.assertEqual((report.failed, report.summary), (True, "exited with code 2"))
        self.assertIsNone(engine.read_report(python, "nothing", 0))

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
