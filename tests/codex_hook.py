"""The Codex hook test harness: a fresh git project, fake tools on PATH and the hook driven through its stdin as
Codex drives it.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest

from daemons import data_directory
from paths import ROOT
import engine


# Codex runs the engine through its adapter, as the plugin installs it.
HOOK = ROOT / "integrations" / "codex.py"
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


class CodexHook(unittest.TestCase):
    """A test of the Codex hook in a project of its own, with the fixtures each test builds its case from."""

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

    def git(self, *args: str) -> None:
        """Runs git in the project as a fixed test identity, so commits need no user configuration."""
        subprocess.run(["git", "-c", "user.email=dev@example.com", "-c", "user.name=dev", *args],
                       cwd=self.cwd, check=True, capture_output=True)
