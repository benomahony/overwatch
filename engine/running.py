"""Runs a project's checks: each command to its first complete report or its end, in parallel, killing what it
started when it stops; or, for watchers with a watch command, the daemon's latest report.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor

from records import TIMED_OUT, Report
from unix import output_selector, read_available
from reading import ANSI, command_for, command_line, read_report
from discovery import ConfigurationError, Watcher, language_of, subproject


COMMAND_TIMEOUT = 540


# How long a stopped command has to exit before it is killed, in seconds.
TERMINATE_GRACE = 3


class TimedOut(Exception):
    """A command that outlived its deadline, with what it printed by then."""

    def __init__(self, command: str, timeout: float, output: str) -> None:
        assert command and timeout > 0, f"{command!r} timed out after {timeout}s; name the command and its positive timeout"
        super().__init__(f"{command} did not report within {timeout:g}s")
        self.timeout, self.output = timeout, output
        assert str(self) == f"{command} did not report within {timeout:g}s", f"TimedOut reads {self}, not the command and timeout"


def terminate(process: subprocess.Popen[bytes]) -> bytes:
    """Stops process, killing it when it ignores the request, and returns what it printed meanwhile."""
    process.terminate()
    try:
        tail, _ = process.communicate(timeout=TERMINATE_GRACE)
    except subprocess.TimeoutExpired:
        process.kill()
        tail, _ = process.communicate()
    assert process.returncode is not None, f"process {process.pid} still runs after terminate; kill it"
    assert process.stdout is None or process.stdout.closed, f"process {process.pid}'s output is still open; communicate must read it to the end"
    return tail or b""


def _run_command(
    cwd: Path, watcher: Watcher, argv: list[str], stop_after_report: bool,
) -> tuple[str, int | None]:
    """Runs argv in cwd for at most the watcher's timeout, returning what it printed and its exit code; None when
    stopped after its report, and TimedOut once the timeout passes first. Private:
    only _run_check calls it, with a watcher's command from watchers.json or the project's own .overwatch.json, which
    read_override accepts only from the user who runs the hook. It runs as an argument list, never through a shell,
    with no input."""
    if stop_after_report and "summary" not in watcher:
        raise ConfigurationError(f"{watcher['name']} runs a watch command but has no summary; give it one in .overwatch.json or watchers.json")
    if not argv:
        raise ConfigurationError(f"{watcher['name']} has an empty command; give it argv or baseline in .overwatch.json")
    command = command_line(argv)
    timeout = timeout_of(watcher)
    try:
        process = subprocess.Popen(
            argv,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            env={**os.environ, **watcher["env"]} if "env" in watcher else None,
        )
    except OSError as error:
        raise ConfigurationError(f"could not start {command}: {error}") from error
    assert process.stdout is not None, f"{command} started without an output pipe; open it with stdout=PIPE"
    assert process.args == argv, f"started {process.args}, not {command}; pass argv to Popen as given"

    if not stop_after_report:
        try:
            output, _ = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            raise TimedOut(command, timeout, terminate(process).decode(errors="replace"))
        return output.decode(errors="replace"), process.returncode

    summary = re.compile(watcher["summary"], re.MULTILINE)
    chunks, reported, exited = _read_until_report(process, summary, time.monotonic() + timeout)
    # However the reading ended, the command is stopped here, once, keeping what it printed meanwhile.
    chunks.append(terminate(process))
    output = b"".join(chunks).decode(errors="replace")
    if not reported and not exited:
        raise TimedOut(command, timeout, output)
    return output, None if reported else process.returncode


def _read_until_report(process: subprocess.Popen[bytes], summary: re.Pattern[str], deadline: float) -> tuple[list[bytes], bool, bool]:
    """What process prints until a complete line matches summary, it exits, or deadline passes, and whether it
    reported and whether it exited; it is left running for the caller to stop."""
    assert process.stdout is not None, f"process {process.pid} has no output pipe to read; open it with stdout=PIPE"
    selector = output_selector(process.stdout)
    chunks: list[bytes] = []
    reported = exited = False
    try:
        while time.monotonic() < deadline and not reported and not exited:
            chunk = read_available(selector)
            if chunk:
                chunks.append(chunk)
                text = ANSI.sub("", b"".join(chunks).decode(errors="replace"))
                reported = summary.search(text[:text.rfind('\n') + 1]) is not None
            exited = not reported and process.poll() is not None
    finally:
        selector.close()
    assert not (reported and exited), f"process {process.pid} both reported and exited before reporting"
    return chunks, reported, exited


def _run_check(cwd: Path, watcher: Watcher) -> Report | None:
    """Runs one watcher's command and reads its report, or None when it has no command. Private: run_checks calls it
    for each watcher find_watchers returned, after apply_override checked what it took from .overwatch.json."""
    selected = command_for(watcher)
    if selected is None:
        return None
    argv, stop_after_report = selected
    try:
        output, code = _run_command(subproject(cwd, watcher.get("dir", "")), watcher, argv, stop_after_report)
    except TimedOut as timed_out:
        return timed_out_report(watcher, command_line(argv), timed_out)
    report = read_report(watcher, output, code)
    if report is None:
        tail = output.strip()[-2_000:]
        detail = f"\n\n{tail}" if tail else ""
        raise ConfigurationError(f"{command_line(argv)} gave no matching summary; make the summary pattern for {watcher['name']} in .overwatch.json match its output{detail}")
    assert report.name == watcher["name"], f"{watcher['name']} reported as {report.name}; name the report after its watcher"
    assert report.command == command_line(argv), f"{watcher['name']} reported {report.command} but ran {command_line(argv)}"
    return report


def timeout_of(watcher: Watcher) -> float:
    """How long the watcher's command may run before it times out: its timeout setting, else COMMAND_TIMEOUT."""
    assert "name" in watcher, f"timeout_of was given {watcher!r}; pass a watcher find_watchers returned"
    timeout = watcher.get("timeout", COMMAND_TIMEOUT)
    assert isinstance(timeout, (int, float)) and timeout > 0, f"{watcher['name']} has timeout {timeout!r}; configure checks it is a positive number"
    return float(timeout)


def timed_out_report(watcher: Watcher, command: str, timed_out: TimedOut) -> Report:
    """The report of a check that outlived its deadline: failed with the one failure TIMED_OUT, as the model's
    TimesOut gives, whatever it printed meanwhile kept as its text."""
    assert command and isinstance(timed_out, TimedOut), f"{watcher['name']} timed out running {command!r} with {timed_out!r}; pass both"
    report = Report(name=watcher["name"], language=language_of(watcher), command=command, dir=watcher.get("dir"),
                    summary=f"timed out after {timed_out.timeout:g}s", failed=True, failures=(TIMED_OUT,), environment=None,
                    text=timed_out.output.strip())
    assert report.failures == (TIMED_OUT,), f"{watcher['name']} timed out with failures {report.failures}; give it {TIMED_OUT} alone"
    return report


def run_checks(cwd: Path, watchers: list[Watcher]) -> list[Report]:
    """The reports of the watchers that have a command, in watcher order, after running every one at once, so a
    polyglot project waits for its slowest suite, not the sum of them. A watcher with no command gives no report."""
    if not watchers:
        return []
    with ThreadPoolExecutor(max_workers=len(watchers)) as pool:
        reports = list(pool.map(lambda watcher: _run_check(cwd, watcher), watchers))
    assert len(reports) == len(watchers), f"ran {len(reports)} of {len(watchers)} checks; map every watcher"
    ran = [report for report in reports if report is not None]
    assert [report.name for report in ran] == [watcher["name"] for watcher, report in zip(watchers, reports) if report], f"reports {[report.name for report in ran]} are out of watcher order"
    return ran


def run_persistent_checks(cwd: Path, watchers: list[Watcher], data: Path) -> list[Report]:
    """Reports for the watchers with a watch command from the project's daemon, once they have settled, so each covers
    the files as they are now; the watchers with none are rerun here, as run_checks does."""
    import daemon
    assert cwd.is_absolute() and cwd.is_dir(), f"project {cwd} must be an absolute directory"
    assert data.is_absolute() and data.is_dir(), f"data directory {data} must be absolute and exist"
    assert all(isinstance(watcher.get("name"), str) for watcher in watchers), f"watchers {watchers!r} must each have a string name"
    persistent = [watcher for watcher in watchers if watcher.get("argv")]
    transient = [watcher for watcher in watchers if not watcher.get("argv")]
    reports = daemon.latest(cwd, data, "settled") if persistent else []
    reports = [report for report in reports if any(report.name == watcher["name"] for watcher in persistent)]
    reports.extend(run_checks(cwd, transient))
    assert all(isinstance(report, Report) for report in reports), f"daemon/check reports {reports!r} must all be Report values"
    return reports
