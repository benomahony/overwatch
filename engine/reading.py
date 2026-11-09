"""How a check's output is read: the last complete build it printed, its summary, the failures it names, and the
line saying its environment, not its code, stopped it.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import re

from records import Report
from discovery import TABLE, Watcher, language_of


# Colour codes, which some tools (deno) print even into a pipe.
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


# Lines that mean a command could not run where it is, which no change to the code fixes.
ENVIRONMENT: tuple[re.Pattern[str], ...] = tuple(re.compile(pattern) for pattern in TABLE["environment"])


def command_for(watcher: Watcher) -> tuple[list[str], bool] | None:
    """The command to run for a watcher's first result, and whether to stop it after its report."""
    baseline, argv = watcher.get("baseline"), watcher.get("argv")
    selected = (list(baseline), False) if baseline else (list(argv), True) if argv else None
    assert selected is None or selected[0], f"{watcher['name']} selected an empty command; return None when it has none"
    assert selected is None or selected[1] == (not baseline), f"{watcher['name']} would stop its baseline after a report; only stop argv"
    return selected


def command_line(argv: list[str]) -> str:
    """argv as one line, for messages and logs."""
    assert argv, "command_line was given an empty command; pass the argv a watcher runs"
    line = " ".join(argv)
    assert line.startswith(argv[0]), f"command line {line} does not start with {argv[0]}; join argv in order"
    return line


def failures_in(watcher: Watcher, output: str) -> list[str]:
    """Each failing test or error the output names, once each, in order."""
    if "failure" not in watcher:
        return []
    names: list[str] = []
    seen: set[str] = set()
    for match in re.finditer(watcher["failure"], output, re.MULTILINE):
        name = next((group for group in match.groups() if group is not None), "").strip()
        if name and name not in seen:
            seen.add(name)
            names.append(name)
    assert len(names) == len(seen), f"failures {names} repeat a name; add each once"
    assert all(name == name.strip() and name for name in names), f"failures {names} keep blank or padded names; strip them and skip empty ones"
    return names


def environment_in(output: str) -> str | None:
    """The first line saying the command failed for want of something in its environment, not because of the code."""
    line = next((line.strip() for line in output.splitlines() if any(pattern.search(line) for pattern in ENVIRONMENT)), None)
    assert line is None or "\n" not in line, f"environment line {line} spans lines; take one line of the output"
    assert line is None or line in output, f"environment line {line} is not in the output; return the line as printed"
    return line


def last_build(watcher: Watcher, output: str) -> tuple[str, str, str]:
    """The latest complete result, unread suffix, and log text including trailing checker diagnostics."""
    clean = ANSI.sub("", output)
    matches = list(re.finditer(watcher["summary"], clean, re.MULTILINE)) if "summary" in watcher else []
    start = matches[-2].end() if len(matches) > 1 else 0
    end = matches[-1].end() if matches else len(clean)
    assert 0 <= start <= end <= len(clean), f"{watcher['name']} result spans {start}..{end} outside {len(clean)} characters"
    complete = clean[start:end]
    assert not matches or re.search(watcher["summary"], complete, re.MULTILINE), f"{watcher['name']} lost its completed summary in {complete!r}"
    return complete, clean[end:], clean[start:]


def read_report(watcher: Watcher, output: str, code: int | None = None) -> Report | None:
    """Reads one build's output; a run with no summary line is read by its exit code. The watcher's patterns are
    strings that apply_override or scripts/table.py checked compile, and its name a non-empty string."""
    clean, _, text = last_build(watcher, output)
    failures = failures_in(watcher, clean)
    match = re.search(watcher["summary"], clean, re.MULTILINE) if "summary" in watcher else None
    if match is not None:
        line = match.group(0).strip()
        shown = re.search(watcher["result"], clean, re.MULTILINE) if "result" in watcher else None
        summary = shown.group(0).strip() if shown else line
        failed = "failed" in watcher and re.search(watcher["failed"], line) is not None
    elif code is None or (code == 0 and "summary" in watcher):
        return None
    else:
        failed = code != 0
        summary = (f"{len(failures)} failed" if failures else f"exited with code {code}") if failed else "passed"
    selected = command_for(watcher)
    assert selected is not None, f"{watcher['name']} reported without a command; give it argv or baseline in watchers.json"
    report = Report(
        name=watcher["name"],
        language=language_of(watcher),
        command=command_line(selected[0]),
        dir=watcher.get("dir"),
        summary=summary,
        failed=failed,
        failures=tuple(failures) if failed else (),
        environment=environment_in(clean) if failed else None,
        text=text.strip(),
    )
    assert report.failed or not report.failures, f"{watcher['name']} passed with failures {failures}; list failures only when it failed"
    return report
