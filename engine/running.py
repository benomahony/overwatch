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

from records import Report
from unix import output_selector, read_available
from reading import ANSI, command_for, command_line, read_report
from discovery import ConfigurationError, Watcher, subproject


COMMAND_TIMEOUT = 540


# How long a stopped command has to exit before it is killed, in seconds.
TERMINATE_GRACE = 3


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
    """Runs argv in cwd, returning what it printed and its exit code; None when stopped after its report. Private:
    only _run_check calls it, with a watcher's command from watchers.json or the project's own .overwatch.json, which
    read_override accepts only from the user who runs the hook. It runs as an argument list, never through a shell,
    with no input."""
    if stop_after_report and "summary" not in watcher:
        raise ConfigurationError(f"{watcher['name']} runs a watch command but has no summary; give it one in .overwatch.json or watchers.json")
    if not argv:
        raise ConfigurationError(f"{watcher['name']} has an empty command; give it argv or baseline in .overwatch.json")
    command = command_line(argv)
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
            output, _ = process.communicate(timeout=COMMAND_TIMEOUT)
        except subprocess.TimeoutExpired:
            terminate(process)
            raise ConfigurationError(f"{command} did not finish within {COMMAND_TIMEOUT}s")
        return output.decode(errors="replace"), process.returncode

    summary = re.compile(watcher["summary"], re.MULTILINE)
    selector = output_selector(process.stdout)
    chunks: list[bytes] = []
    deadline = time.monotonic() + COMMAND_TIMEOUT
    try:
        while time.monotonic() < deadline:
            chunk = read_available(selector)
            if chunk:
                chunks.append(chunk)
                text = ANSI.sub("", b"".join(chunks).decode(errors="replace"))
                if summary.search(text[:text.rfind('\n') + 1]):
                    chunks.append(terminate(process))
                    return b"".join(chunks).decode(errors="replace"), None
            if process.poll() is not None:
                chunks.append(process.stdout.read() or b"")
                return b"".join(chunks).decode(errors="replace"), process.returncode
    finally:
        selector.close()
    terminate(process)
    raise ConfigurationError(f"{command} gave no report within {COMMAND_TIMEOUT}s")


def _run_check(cwd: Path, watcher: Watcher) -> Report | None:
    """Runs one watcher's command and reads its report, or None when it has no command. Private: run_checks calls it
    for each watcher find_watchers returned, after apply_override checked what it took from .overwatch.json."""
    selected = command_for(watcher)
    if selected is None:
        return None
    argv, stop_after_report = selected
    output, code = _run_command(subproject(cwd, watcher.get("dir", "")), watcher, argv, stop_after_report)
    report = read_report(watcher, output, code)
    if report is None:
        tail = output.strip()[-2_000:]
        detail = f"\n\n{tail}" if tail else ""
        raise ConfigurationError(f"{command_line(argv)} gave no matching summary; make the summary pattern for {watcher['name']} in .overwatch.json match its output{detail}")
    assert report.name == watcher["name"], f"{watcher['name']} reported as {report.name}; name the report after its watcher"
    assert report.command == command_line(argv), f"{watcher['name']} reported {report.command} but ran {command_line(argv)}"
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

