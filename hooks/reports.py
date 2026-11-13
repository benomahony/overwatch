"""What a check's report says about the session: its key, its failures against the baseline, the text told to the agent and the log of its output.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from pathlib import Path

from records import ConfigurationError, First, Report, Session

FAILURE_LIMIT = 10
# The decoration each tool puts around its summary, which the status line leaves out.
SUMMARY_DECORATION = re.compile(
    r"^Build Summary:\s*|^zanity:\s*|^=+\s*|\s*=+$|^Test Files\s+|^Test Suites:\s*|^DONE\s+|^(?:ok|FAILED) \| "
)


def key_of(name: str, directory: str | None) -> str:
    """What identifies a check across runs: its name and the sub-project it ran in, joined by a NUL neither can hold."""
    if "\0" in name or "\0" in (directory or ""):
        raise ConfigurationError(f"check {name!r} in {directory!r} holds a NUL character; remove it from its name in .overwatch.json")
    key = f"{name}\0{directory or ''}"
    assert key.split("\0") == [name, directory or ""], f"key {key!r} does not split back into {name!r} and {directory!r}"
    assert key.count("\0") == 1, f"key {key!r} holds {key.count(chr(0))} separators; join exactly two fields"
    return key


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


def log_path(session: Session, report: Report, prefix: str = "") -> Path:
    """Where report's full output is kept in session.logs: named by prefix and a digest of the report's key, so each
    check has one log for each prefix."""
    log = session.logs / f"{prefix}{hashlib.sha256(report_key(report).encode()).hexdigest()[:16]}.log"
    assert log.parent == session.logs, f"log {log} is outside {session.logs}; name it by digest alone"
    assert log.name.startswith(prefix) and log.suffix == ".log", f"log {log} is not named {prefix}<digest>.log"
    return log


def write_log(session: Session, report: Report, prefix: str = "") -> Path:
    """Writes report's full output to its log_path in session.logs, keeping the output out of the conversation. Logs
    are overwatch's own cache of output a rerun reproduces, so replacing that check's earlier log loses nothing the
    user made. session comes from locked(), so this process holds its lock and no other is writing there."""
    log = log_path(session, report, prefix)
    log.write_text(report.text)
    assert log.read_text() == report.text, f"{log} does not hold {report.name}'s output as given; write it whole"
    assert log.parent == session.logs, f"wrote {report.name}'s output to {log}, outside {session.logs}"
    return log

