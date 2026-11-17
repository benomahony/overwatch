"""What the tests of TCR's hardening share: a committed project with one check, the files the hook edits and checks write, and the texts of the checks' results.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import json
import os
import sys
import time
import unittest
import unittest.mock

import paths
import engine
import sessions
import tcr
from checkpoint_repository import git, put, set_mode
from codex_hook import CodexHook, read, write
import test_tcr
from test_tcr import EDITING

assert str(paths.ROOT / "engine") in sys.path, f"{paths.ROOT / 'engine'} is not on sys.path {sys.path}; paths puts engine/ there so engine imports by name"
FAILING_PYTEST = "=== 1 failed in 0.01s ==="
PASSING_PYTEST = "=== 1 passed in 0.01s ==="
FAILING_GO = "=== FAIL: . TestAdd (0.00s)\n\nDONE 2 tests, 1 failure in 0.184s"
PASSING_GO = "DONE 2 tests in 0.184s"
WORSE_GO = "=== FAIL: . TestAdd (0.00s)\n=== FAIL: . TestSub (0.00s)\n\nDONE 3 tests, 2 failures in 0.184s"
AWS_KEY = "AKIA" + "A" * 16
PROJECT_FILE = "[project]\n"
GO_MODULE = "module example\n"
SLOW_CHECK_SECONDS = 2
EXECUTABLE = 0o755


class HardeningCase(CodexHook):
    setUp = test_tcr.TcrHookTests.setUp

    set_setting = test_tcr.TcrHookTests.set_setting

    start = test_tcr.TcrHookTests.start

    subjects = test_tcr.TcrHookTests.subjects

    context = test_tcr.TcrHookTests.context

    def revert_refs(self) -> list[str]:
        refs = git(self.cwd, ["for-each-ref", "--format=%(refname)", "refs/overwatch/reverted"]).split()
        assert all(ref.startswith("refs/overwatch/reverted/") for ref in refs), f"a ref outside the saved ones was listed: {refs}"
        assert len(set(refs)) == len(refs), f"a saved ref was listed twice: {refs}"
        return refs

    def start_a_python_project(self, settings: dict[str, object] | None = None) -> None:
        """Starts a session on a committed project with one check, pytest, which passes, and the given settings."""
        write(self.cwd / ".overwatch.json", json.dumps({"mode": "tcr", **(settings or {})}))
        write(self.cwd / "pyproject.toml", PROJECT_FILE)
        self.tool("pytest", PASSING_PYTEST, 0)
        self.commit("start")
        started = self.call("SessionStart")[0]
        assert "TCR is on" in self.context(started), f"the session did not start TCR: {started}"
        assert self.subjects() == ["start"], f"the session started on {self.subjects()}, not one start commit"

    def edit(self, name: str) -> dict[str, object]:
        """The agent writes a new file and the hook reads the checks."""
        assert not (self.cwd / name).exists(), f"{name} is already in {self.cwd}; each edit writes a file of its own"
        write(self.cwd / name, "edit\n")
        output = self.call("PostToolUse", **EDITING)[0]
        assert isinstance(output, dict), f"the hook answered the edit of {name} with {output!r}, not an object"
        return output

    def add_go_check(self, output: str, code: int) -> dict[str, object]:
        """The agent's edit creates go.mod, so a check that was not there before runs, with the given result."""
        self.tool("gotestsum", output, code)
        assert not (self.cwd / "go.mod").exists(), f"go.mod is already in {self.cwd}; the check is not new"
        write(self.cwd / "go.mod", GO_MODULE)
        answer = self.call("PostToolUse", **EDITING)[0]
        assert isinstance(answer, dict), f"the hook answered the go.mod edit with {answer!r}, not an object"
        return answer

    def make_pytest_slow(self) -> None:
        """Replaces the passing pytest with one that takes SLOW_CHECK_SECONDS to pass."""
        script = self.bin / "pytest"
        put(script, f"#!/bin/sh\nsleep {SLOW_CHECK_SECONDS}\necho '{PASSING_PYTEST}'\n")
        set_mode(script, EXECUTABLE)
        assert read(script).count(PASSING_PYTEST) == 1, f"{script} does not pass after its sleep"
        assert os.access(script, os.X_OK), f"{script} cannot be run, so no check would pass"

    def call_here(self, event: str, **fields: str) -> dict[str, object]:
        """The hook's answer to one event, computed in this process so that a test can replace what the hook calls. The
        hook's process clock starts now, as it does for each real event."""
        tools = {"PATH": f"{self.bin}{os.pathsep}{os.defpath}", "PLUGIN_DATA": str(self.data)}
        sent = engine.Event(event, "session-1", str(self.cwd), fields.get("tool_name", ""), {}, "")
        with unittest.mock.patch.dict(os.environ, tools), unittest.mock.patch.object(tcr, "PROCESS_STARTED", time.monotonic()):
            output = engine.process_event(sent, engine.data_root(str(self.data)))
        assert isinstance(output, dict), f"the hook answered {event} with {output!r}, not an object"
        assert os.environ.get("PLUGIN_DATA") != str(self.data), f"the data directory {self.data} was left in the environment"
        return output

    def fail_pytest(self) -> None:
        """Swaps the passing pytest for one that fails."""
        self.tool("pytest", FAILING_PYTEST, 1, replacing=(PASSING_PYTEST, 0))
        assert FAILING_PYTEST in read(self.bin / "pytest"), f"{self.bin / 'pytest'} does not print the failure"
        assert PASSING_PYTEST not in read(self.bin / "pytest"), f"{self.bin / 'pytest'} still prints the pass"

    def make_pytest_hang(self) -> None:
        """Replaces the passing pytest with one that outlives its one-second deadline."""
        script = self.bin / "pytest"
        put(script, "#!/bin/sh\nexec sleep 30\n")
        set_mode(script, EXECUTABLE)
        assert "sleep 30" in read(script), f"{script} does not hang"
        assert os.access(script, os.X_OK), f"{script} cannot be run, so no check would hang"

    def saved_state(self) -> dict:
        root = sessions.data_root(str(self.data))
        sent = engine.Event("PostToolUse", "session-1", str(self.cwd), "Bash", {}, "")
        state = json.loads(sessions.state_path(sent, self.cwd.resolve(), root).read_text())["state"]
        assert "held" in state and "tcr" in state, f"the saved state {sorted(state)} has no held or tcr field"
        assert isinstance(state["held"], list), f"the held checks {state['held']!r} are no list"
        return state
