"""What a report means against the session's baseline, and the text that tells the agent: a new failure, a
recovery, an environment error, or why a protected action is refused.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import json
from pathlib import Path
import re
from collections.abc import Mapping
from typing import Any

from records import First, Report
from discovery import key_of


FAILURE_LIMIT = 10
# A timing assertion in a test's output, as "took 87ms (limit: 50ms)" or a test reading elapsed time.
TIMING = re.compile(r"\btook \d+(?:\.\d+)? ?m?s\b|\belapsed\b|\bperf_counter\b")


# The decoration each tool puts around its summary, which the status line leaves out.
SUMMARY_DECORATION = re.compile(
    r"^Build Summary:\s*|^zanity:\s*|^=+\s*|\s*=+$|^Test Files\s+|^Test Suites:\s*|^DONE\s+|^(?:ok|FAILED) \| "
)


def failing_line(failures: list[str]) -> str:
    """Names the failing tests, the first FAILURE_LIMIT of them, for the agent; nothing when there are none."""
    shown = failures[:FAILURE_LIMIT]
    hidden = len(failures) - len(shown)
    more = f", and {hidden} more" if hidden else ""
    line = f"Failing: {', '.join(f'`{name}`' for name in shown)}{more}.\n" if shown else ""
    assert not shown or line.startswith(f"Failing: `{shown[0]}`"), f"line {line} does not name {shown} first; quote the first {FAILURE_LIMIT} in order"
    assert (hidden > 0) == line.endswith(" more.\n"), f"line {line} for {len(failures)} failures miscounts the {hidden} not shown"
    return line


def where(report: Report) -> str:
    """The sub-project a report's command ran in, for the agent."""
    text = f" in `{report.dir}`" if report.dir else ""
    assert bool(text) == bool(report.dir), f"where gave {text} for dir {report.dir}; name the dir only when there is one"
    assert not text or text.endswith(f"`{report.dir}`"), f"where gave {text}; quote the dir {report.dir}"
    return text


def report_key(report: Report) -> str:
    """The key of the check report came from."""
    key = key_of(report.name, report.dir)
    assert key.startswith(report.name), f"key {key!r} does not start with {report.name}; build it with key_of(name, dir)"
    assert key.endswith(report.dir or ""), f"key {key!r} does not end with {report.dir}; build it with key_of(name, dir)"
    return key


def known_failures(report: Report, baseline: Mapping[str, First]) -> list[str]:
    """The failures this check already had when the session started: none when its first result passed."""
    first = baseline.get(report_key(report))
    known = list(first.failures) if first is not None and first.failed else []
    assert first is None or first.failed or not known, f"{report.name} knows failures {known} from a passing baseline"
    assert first is None or not first.failed or len(known) == len(first.failures), f"{report.name} kept {len(known)} known failures; keep all of them"
    return known


def is_regression(report: Report, baseline: Mapping[str, First]) -> bool:
    """Whether a report fails in a way its baseline, the session's first result, did not."""
    if not report.failed or report.environment:
        return False
    first = baseline.get(report_key(report))
    known = set(known_failures(report, baseline))
    if first is None or not first.failed or any(name not in known for name in report.failures):
        return True
    previous, counts = failure_counts(first.summary), failure_counts(report.summary)
    grew = [kind for kind, count in counts.items() if count > previous.get(kind, 0)]
    assert first.failed and report.failed, f"{report.name} compared counts without two failing results; compare only failing ones"
    assert set(grew) <= set(counts), f"{report.name} grew in {grew}, which its summary does not count"
    return bool(grew)


def failure_counts(summary: str) -> dict[str, int]:
    """Each count a summary gives, keyed by its kind (error, warning or failure) and its place among the counts of
    that kind, so a summary with two failure counts, such as zig's failed steps and failed tests, compares each with
    its own."""
    counts: dict[str, int] = {}
    seen = {"error": 0, "warning": 0, "failure": 0}
    for number, label in re.findall(r"(\d+)\s+(errors?|warnings?|failures?|failed|fail)\b", summary):
        kind = "error" if label.startswith("error") else "warning" if label.startswith("warning") else "failure"
        counts[f"{kind} {seen[kind]}"] = int(number)
        seen[kind] += 1
    assert len(counts) == sum(seen.values()), f"summary {summary} gave {len(counts)} counts from {seen}; key each by its kind and place"
    assert all(str(count) in summary for count in counts.values()), f"counts {counts} are not in summary {summary}; take each from it"
    return counts


def timing_hint(report: Report) -> str:
    """A line for a failure that looks like a timing test run under pytest-testmon, whose tracing slows every call so
    timings in watch mode measure the instrumentation; empty for any other failure. The failure still holds completion."""
    hint = ""
    if "--testmon" in report.command.split() and TIMING.search(report.text):
        hint = (f"This looks like a timing test, and `--testmon` traces every call in watch mode, so it runs slower than it "
                f"would alone. If the code is no slower, mark timing tests and keep them out of the watcher with "
                f"`-m \"not performance\"` in `watchers.{report.name}.argv` in .overwatch.json.\n")
    assert hint == "" or hint.endswith("\n"), f"timing hint {hint!r} must end its line"
    assert hint == "" or "--testmon" in report.command, f"timing hint given for {report.command!r}, which runs no testmon"
    return hint


def failure_message(reports: list[Report], baseline: Mapping[str, First], logs: dict[str, Path], outside: bool = False) -> str:
    """Tells the agent which checks newly fail, what fails in each and where the full output is; outside when the
    failure was first seen after another process's change rather than the session's own edit."""
    assert all(report_key(report) in logs for report in reports), f"no log for {[report.name for report in reports if report_key(report) not in logs]}; write one for each report"
    messages: list[str] = []
    for report in reports:
        known = set(known_failures(report, baseline))
        fresh = [name for name in report.failures if name not in known]
        old = len(report.failures) - len(fresh)
        messages.append(
            f"overwatch: `{report.command}`{where(report)} failed after "
            f"{'a change made outside this session' if outside else 'the latest change'}: {report.summary}\n"
            f"{failing_line(fresh)}"
            f"{f'{old} more were already failing when the session started.' + chr(10) if old else ''}"
            + ("This session made no edit since the previous result, so another process may be changing these files; "
               "check before overwriting its work.\n" if outside else
               "Fix these new failures before finishing. Tools remain available while you investigate.\n") +
            timing_hint(report) +
            f"Full output: `{logs[report_key(report)]}`"
        )
    text = "\n\n".join(messages)
    assert text.count("Full output: ") == len(reports), f"message links {text.count('Full output: ')} logs for {len(reports)} reports; link each once"
    return text


def environment_message(reports: list[Report]) -> str:
    """Tells the agent which checks cannot run where they are, and that no code change fixes that."""
    assert all(report.environment for report in reports), f"{[report.name for report in reports if not report.environment]} have no environment line; pass only checks that cannot run"
    lines = "\n".join(f"- `{report.command}`{where(report)}: {report.environment}" for report in reports)
    assert lines.count("\n- ") == max(len(reports) - 1, 0), f"environment message lists {lines.count(chr(10) + '- ') + 1} lines for {len(reports)} checks"
    return (
        "overwatch: these checks cannot run in this environment, so they are not reporting. "
        f"This is not caused by your changes and needs no code change:\n{lines}"
    )


def failing_suffix(failures: tuple[str, ...]) -> str:
    """The first failure and how many more, for the status line."""
    if not failures:
        return ""
    more = f" +{len(failures) - 1} more" if len(failures) > 1 else ""
    suffix = f": {failures[0]}{more}"
    assert suffix.startswith(f": {failures[0]}"), f"suffix {suffix} does not name {failures[0]} first"
    assert (len(failures) > 1) == suffix.endswith(" more"), f"suffix {suffix} for {len(failures)} failures miscounts the rest"
    return suffix


def failure_status(reports: list[Report]) -> str:
    """The status line for failing checks, one part each."""
    assert reports, "failure_status was given no reports; pass the checks that newly fail"
    summaries = " · ".join(
        f"{report.name} ✗ {SUMMARY_DECORATION.sub('', report.summary)}{failing_suffix(report.failures)}"
        for report in reports
    )
    assert summaries.count(" ✗ ") >= len(reports), f"status {summaries} marks fewer than {len(reports)} checks; give each one part"
    return f"Overwatch: {summaries}"


def recovery_message(reports: tuple[Report, ...]) -> str:
    """Tells the agent the checks pass again, with each one's summary."""
    summaries = " · ".join(f"overwatch {report.name} ✓ {SUMMARY_DECORATION.sub('', report.summary)}" for report in reports)
    assert summaries.count(" ✓ ") >= len(reports), f"recovery {summaries} marks fewer than {len(reports)} checks; give each one part"
    text = f"overwatch: green again. {summaries}"
    assert text.endswith(summaries), f"recovery {text} drops the summaries; end with them"
    return text


def context_output(event_name: str, text: str) -> dict[str, Any]:
    """The hook output that adds text to the agent's context for event_name."""
    assert text, f"context for {event_name} is empty; add context only when there is something to say"
    output = {
        "hookSpecificOutput": {
            "hookEventName": event_name,
            "additionalContext": text,
        }
    }
    assert json.loads(json.dumps(output)) == output, f"context for {event_name} is not plain JSON; pass text as a string"
    return output


def gate_reason(reports: list[Report]) -> str:
    """Why an action is refused: the failing checks that guard it, and that repairs remain possible."""
    assert reports, "gate_reason was given no reports; give it the checks that guard the action"
    lines = [f"- {report.name}: {' '.join(SUMMARY_DECORATION.sub('', report.summary).split())}" for report in reports]
    assert len(lines) == len(reports) and all("\n" not in line for line in lines), f"reason lines {lines} do not give each guarding check one line"
    return ("overwatch: this action is guarded while relevant checks fail:\n" + "\n".join(lines) + "\n"
            "Inspection, edits, and check commands remain available. Rerun the checks after repairing the failure.")
