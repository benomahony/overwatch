#!/usr/bin/env python3
"""One-shot check runner for Overwatch's coding-agent adapters.

Command hooks and in-process plugins call this runner with a Claude-style hook
event. It checks the git repository holding the event's directory, and nothing
outside one. It runs one build whenever the workspace changes and caches its
result for later hooks. A configured watch command is stopped after its first
complete report. The first result of each check is its baseline: only failures
it did not have are reported, each once, with the full output in a log file.

It runs on POSIX systems; the calls that need one are in unix.py.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys
from collections.abc import Iterator, Mapping
from dataclasses import asdict, replace
from typing import Any

from gating import PolicyError, brings_in_files, protected_checks, read_gate, tool_command
from triage import InventoryError, parse_check, parse_inventory
from records import TIMED_OUT, Event, Read, First, Report, Session, State, Step, digest_of
from sessions import data_root, in_data, load_state, locked, save_state, state_path, touched_path, write_log
from running import run_persistent_checks
from messages import SUMMARY_DECORATION, context_output, environment_message, failing_suffix, failure_message, failure_status, gate_reason, is_regression, known_failures, recovery_message, report_key
from workspace import commit_of, fingerprint, is_committed, repository_of
from discovery import ConfigurationError, find_watchers, key_of, read_override


# Tools that can change the workspace, by the names each host gives them. A change first seen at any other
# event came from another process, since each of these is followed by its own PostToolUse.
EDITING_TOOLS = frozenset({"apply_patch", "Bash", "bash", "Edit", "edit", "MultiEdit", "powershell", "shell", "Write", "write"})


# How often a follower looks whether the process that started it still runs, so it stops soon after it.
PARENT_SECONDS = 5.0
EVENT_FIELDS = ("hook_event_name", "session_id", "cwd", "tool_name", "integration")


def read_event() -> Event:
    """The hook event on stdin, or ConfigurationError naming the fields that are not strings."""
    try:
        value = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError) as error:
        raise ConfigurationError(f"could not read the hook event: {error}; send one JSON object on stdin") from error
    if not isinstance(value, dict):
        raise ConfigurationError(f"the hook event was a JSON {type(value).__name__}; send one JSON object on stdin")
    fields = {name: value.get(name) or "" for name in EVENT_FIELDS}
    wrong = sorted(name for name, given in fields.items() if not isinstance(given, str))
    if wrong:
        raise ConfigurationError(f"the hook event's fields {wrong} must be strings; send each as a JSON string")
    event = Event(**fields, tool_input=value.get("tool_input"))
    read = (event.hook_event_name, event.session_id, event.cwd, event.tool_name, event.integration)
    assert read == tuple(fields[name] for name in EVENT_FIELDS), f"event {event} lost one of the fields {fields}"
    assert event.tool_input is value.get("tool_input"), f"event for {event.hook_event_name} replaced its tool input; pass it through"
    return event


def report_state(reports: list[Report] | tuple[Report, ...], old: State) -> State:
    """Keep each check's first result as its baseline, unless the session has edited since the commit: then it has
    none and every failure is new. A timeout is never a baseline, as in the model's Deliver."""
    baseline = dict(old.baseline)
    for report in reports:
        if not report.environment and TIMED_OUT not in report.failures:
            baseline.setdefault(report_key(report), First(False, (), 'passed') if old.touched else First(report.failed, report.failures, report.summary))
    regressions = [report for report in reports if is_regression(report, baseline)]
    signatures = regression_signatures(regressions, baseline)
    assert set(old.baseline) <= set(baseline), f"baseline lost {set(old.baseline) - set(baseline)}; keep each check's first result"
    assert bool(signatures) == bool(regressions), f"{len(regressions)} regressions gave signatures {signatures}; sign each one"
    return replace(old, reports=tuple(reports), baseline=baseline, failed=bool(regressions),
                   told=json.dumps(signatures) if regressions else None, signatures=tuple(signatures))


def regression_signatures(reports: list[Report], baseline: Mapping[str, First]) -> list[str]:
    """What identifies each regression, the new failures or else the summary without timings, sorted."""
    signatures: list[str] = []
    for report in reports:
        known = set(known_failures(report, baseline))
        fresh = [name for name in report.failures if name not in known]
        identities = fresh or [re.sub(r"\d+(?:\.\d+)?m?s\b", "", report.summary)]
        signatures.extend(json.dumps([report_key(report), identity]) for identity in identities)
    assert len(signatures) >= len(reports), f"{len(reports)} regressions gave {len(signatures)} signatures; sign each at least once"
    assert all(json.loads(signature)[0] in {report_key(report) for report in reports} for signature in signatures), f"signatures {signatures} name a check that did not regress"
    return sorted(signatures)


def block_stop(event: Event, current: State) -> bool:
    """Whether a Stop event is refused because guarded checks fail."""
    if event.hook_event_name != "Stop":
        return False
    guarded = gate_reports(current)
    assert all(report in current.reports for report in guarded), f"guarded {[report.name for report in guarded]} are not this run's reports; select them from current.reports"
    assert all(report.failed for report in guarded), f"{[report.name for report in guarded if not report.failed]} pass but block Stop; gate_reports must keep only failures"
    return bool(guarded)


def gate_reports(current: State, checks: tuple[str, ...] | list[str] | None = None) -> list[Report]:
    """The failing reports that guard an action: those among checks, inherited ones only when the policy blocks them."""
    inherited = current.inherited == "block"
    guarded = [report for report in current.reports
               if report.failed and not report.environment
               and (not checks or report.name in checks or report.language in checks)
               and (inherited or is_regression(report, current.baseline))]
    assert len(guarded) <= len(current.reports), f"guarded {len(guarded)} of {len(current.reports)} reports; select from them"
    assert not any(report.environment for report in guarded), f"{[report.name for report in guarded if report.environment]} cannot run but guard; leave them out"
    return guarded


def protected_output(event: Event, cwd: Path, session: Session) -> dict[str, Any]:
    """The PreToolUse output: a denial when the tool call is protected and its checks fail, else nothing. Saves the
    rechecked state in session, keeping what the agent was told, since a tool call tells it nothing."""
    checks = protected_checks(event.tool_name, tool_command(event.tool_input), read_gate(read_override(cwd)))
    if checks is None:
        return {}
    read = checked_state(session, cwd)
    old, current = read.old, read.current
    save_state(session, replace(current, told=old.told))
    reports = gate_reports(current, checks)
    if not reports:
        return {}
    reason = gate_reason(reports)
    assert all(report.failed for report in reports), f"{[report.name for report in reports if not report.failed]} pass but deny the call"
    assert all(not checks or report.name in checks or report.language in checks for report in reports), f"{[report.name for report in reports]} guard a call protected only by {checks}"
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                   "permissionDecisionReason": reason}}


def inventory_checks(session: Session) -> dict[str, dict[str, object]] | None:
    """The entries the session's triage inventory already lists, by their check's key, as triage.py parses them:
    none when there is no inventory yet, and None when its digest does not match or triage.py cannot read it, so the
    caller can say it was replaced. Any other failure to read it is raised to the caller, which reports it."""
    try:
        value = json.loads(session.inventory.read_text())
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError:
        return None
    if not isinstance(value, dict) or value.get("digest") != digest_of(value.get("checks")):
        return None
    try:
        parse_inventory(value)
    except InventoryError:
        return None
    entries = {key_of(check.name, check.dir): entry for entry in value["checks"] for check in [parse_check(entry)]}
    assert len(entries) <= len(value["checks"]), f"inventory {session.inventory} gave {len(entries)} keys for {len(value['checks'])} entries"
    assert all("\0" in key for key in entries), f"inventory {session.inventory} keys {list(entries)} were not built with key_of"
    return entries


def inherited_failures(old: State, current: State) -> list[Report]:
    """The reports of checks that failed on their first run in this session, for reasons in the code."""
    added = [report for report in current.reports if report_key(report) not in old.baseline]
    failing = [report for report in added if report.failed and not report.environment
               and (first := current.baseline.get(report_key(report))) is not None and first.failed]
    assert all(report in current.reports for report in failing), f"inherited failures {[report.name for report in failing]} are not this run's; select them from current.reports"
    assert not any(report_key(report) in old.baseline for report in failing), f"{[report.name for report in failing]} already had a baseline; leave out checks old.baseline holds"
    return failing


def inventory_entry(report: Report, log: Path) -> dict[str, object]:
    """A report as the triage inventory lists it: every field but its output, which log holds instead."""
    entry: dict[str, object] = {name: value for name, value in asdict(report).items() if name != "text"}
    entry["log"] = str(log)
    assert entry["name"] == report.name and "text" not in entry, f"inventory entry {entry} does not list {report.name} without its output; drop only the text field"
    assert entry["log"] == str(log), f"inventory entry for {report.name} links {entry['log']}, not {log}; set log last"
    return entry


def baseline_inventory(old: State, current: State, session: Session) -> str:
    """Keeps the inherited backlog inspectable without putting it in model context: writes session.inventory, the
    entries it already lists for other checks followed by one for each check that first failed in this run, each
    linking its full log. Each check is added once: added holds only checks old.baseline lacks, and the state saved
    after this event holds them all, so the same event delivered again adds nothing, and an entry for the same
    check is replaced, not repeated."""
    added = inherited_failures(old, current)
    if not added:
        return ""
    inventory = session.inventory
    keys = {report_key(report): report for report in added}
    listed = inventory_checks(session)
    checks = [entry for key, entry in (listed or {}).items() if key not in keys]
    checks.extend(inventory_entry(report, write_log(session, report, "baseline-")) for report in keys.values())
    inventory.write_text(json.dumps({"digest": digest_of(checks), "checks": checks}, indent=2))
    assert len(checks) >= len(added), f"inventory {inventory} holds {len(checks)} checks after adding {len(added)}; append every one"
    assert all("text" not in check for check in checks[-len(added):]), f"inventory {inventory} kept a report's output; link its log instead"
    count = sum(len(report.failures) for report in added)
    detail = f"{count} named issues" if count else "individual issue names unavailable; see full logs"
    policy = ("Inherited findings guard completion and protected actions. "
              if current.inherited == "block"
              else "It is not a Stop blocker; only new failures are guarded. ")
    return (f"overwatch: inherited backlog in {len(added)} checks ({detail}). "
            f"{policy}"
            f"Triage inventory: `{inventory}`. Filter or page it with engine/triage.py; full logs are linked there."
            f"{' The earlier inventory could not be read, so it now lists only these checks.' if listed is None else ''}")


def new_environment(reports: tuple[Report, ...] | list[Report], told: tuple[str, ...]) -> list[Report]:
    """The reports that cannot run for a reason the agent has not been told yet."""
    fresh = [report for report in reports if report.environment and report.environment not in told]
    assert all(report in reports for report in fresh), f"new environment reports {[report.name for report in fresh]} are not among the reports; select them from reports"
    assert not any(report.environment in told for report in fresh), f"{[report.environment for report in fresh]} repeat what the agent was told; leave out lines in told"
    return fresh


def process_event(event: Event, root: Path) -> dict[str, Any]:
    """The hook output for one event, saving the state it leaves in root. Hooks of one session can run at once, so
    each holds the session's lock from reading the state to saving it: the next one waits, then sees the saved
    fingerprint and reuses the results instead of running the checks again."""
    cwd = repository_of(Path(event.cwd or os.getcwd()).resolve())
    if cwd is None:
        return {}
    # Inspection and repair calls need no check state. Do not queue them behind
    # a baseline build holding the session lock.
    if event.hook_event_name == "PreToolUse":
        # An editing tool says so before it runs, without waiting for the lock, so a check running meanwhile knows
        # when it reads its result that the session may have changed what it read.
        if event.tool_name in EDITING_TOOLS:
            touched_path(in_data(state_path(event, cwd, root), root)).touch(mode=0o600)
        checks = protected_checks(event.tool_name, tool_command(event.tool_input), read_gate(read_override(cwd)))
        if checks is None:
            return {}
    with locked(state_path(event, cwd, root), root) as session:
        if event.hook_event_name == "PreToolUse":
            return protected_output(event, cwd, session)
        edit = event.hook_event_name == "PostToolUse" and event.tool_name in EDITING_TOOLS
        command = tool_command(event.tool_input) if event.hook_event_name == "PostToolUse" else ""
        read = checked_state(session, cwd, Step(edit, command))
        current = read.current
        output = report_output(event, read, session)
        save_state(session, current)
    assert current.fingerprint is not None, f"state for {cwd} has no fingerprint; checked_state must record one"
    assert session.state.exists(), f"no state was saved for {cwd} at {session.state}; save_state must write it"
    return output


def is_moved(cwd: Path, old: str | None, new: str | None, command: str) -> bool:
    """Whether HEAD went from old to new in a way that can bring in failures the agent did not make: by anything but
    commits alone, as the reflog shows, or in a step whose command ran a git operation that can bring in files, as a
    squash merge committed in the same step does. False when HEAD did not move or either end is unknown."""
    assert cwd.is_absolute(), f"is_moved was given {cwd}; pass the repository's absolute path"
    if old is None or new is None or old == new:
        return False
    moved = brings_in_files(command) or not is_committed(cwd, old, new)
    assert moved or not brings_in_files(command), f"{command!r} brings in files but {old}..{new} kept the baseline"
    return moved


def checked_state(session: Session, cwd: Path, step: Step = Step(), followed: list[Report] | None = None) -> Read:
    """The state before and after this read, and whether the read follows the session's own edit: the model's
    edited, which only such a read may wake the agent for. Recheck changed workspaces and rebaseline moved commits;
    followed, the settled reports a follower got from the daemon, replaces those checks, keeping the last report of
    each watcher the daemon does not run. Keep the starting fingerprint so edits during a
    run demand another check instead of marking their newer workspace as already verified. step.edit says this hook
    follows the session's own edit, which keeps its later first results from the baseline, as does the touched
    marker an editing tool's PreToolUse leaves, found when the result is read; a commit move starts the baseline afresh and wins over
    an edit in the same hook, since a pull is not the agent's change. A move made by commits alone keeps the
    baseline, unless step.command, the step's shell command, ran a git operation that can bring in files, as a squash
    merge committed in the same step does."""
    old = load_state(session)
    head = commit_of(cwd)
    moved = is_moved(cwd, old.head, head, step.command)
    if moved:
        old = replace(old, baseline={}, fingerprint=None, told=None, failed=False, signatures=())
    gate = read_gate(read_override(cwd))
    before = fingerprint(cwd)
    should_run = followed is None and old.fingerprint != before
    reports = (merged_reports(followed, old.reports) if followed is not None else
               run_persistent_checks(cwd, find_watchers(cwd), session.state.parent) if should_run else old.reports)
    # Read once the checks have run, as the session may have started editing while they did. Every read clears
    # edited, as in the model's ReadResults, so the marker goes once read.
    marker = touched_path(session.state)
    edited = step.edit or marker.exists()
    touched = not moved and (old.touched or edited)
    marker.unlink(missing_ok=True)
    told = old.environment
    environment = new_environment(reports, told)
    current = replace(
        report_state(reports, replace(old, touched=touched)),
        inherited=gate.inherited,
        fingerprint=before,
        head=head,
        environment=(*told, *(report.environment for report in environment if report.environment)),
    )
    assert current.environment[:len(told)] == told, f"environment {current.environment} forgot what the agent was told; keep {told} first"
    assert should_run or followed is not None or current.reports == old.reports, f"unchanged workspace {cwd} got new reports; reuse the saved ones"
    return Read(old, current, edited)


def merged_reports(followed: list[Report], saved: tuple[Report, ...]) -> list[Report]:
    """The reports a follower read takes: followed, from the daemon, and the saved report of each watcher the daemon
    does not run, which only a hook reruns."""
    assert len({report_key(report) for report in followed}) == len(followed), f"the daemon gave {[report.name for report in followed]}, one watcher twice"
    keys = {report_key(report) for report in followed}
    merged = [*followed, *(report for report in saved if report_key(report) not in keys)]
    assert merged[:len(followed)] == followed, f"merged reports {[report.name for report in merged]} dropped the daemon's {[report.name for report in followed]}"
    return merged


def report_output(event: Event, read: Read, session: Session) -> dict[str, Any]:
    """The hook output for the state read left: what newly fails, recovers or cannot run, and a Stop refusal when
    guarded. A read that follows the session's own edit: a failure it finds is the agent's, and may wake it, as one
    after a timeout may; another process's is told without waking, as the model's waking is edited or a timeout."""
    old, current, edited = read.old, read.current, read.edited
    reports = current.reports
    environment = new_environment(reports, old.environment)
    baseline_notice = baseline_inventory(old, current, session)
    parts: list[str] = [baseline_notice] if baseline_notice else []
    output: dict[str, Any] = {}
    blocking = block_stop(event, current)
    waking = False
    if current.failed and current.told != old.told:
        regressions = [report for report in reports if is_regression(report, current.baseline)]
        logs = {report_key(report): write_log(session, report) for report in regressions}
        waking = edited or any(TIMED_OUT in report.failures for report in regressions)
        message = failure_message(regressions, current.baseline, logs, not edited)
        parts.append(message)
        output["systemMessage"] = failure_status(regressions)
    elif not current.failed and old.failed:
        parts.append(recovery_message(reports))
    if environment:
        parts.append(environment_message(environment))
        output.setdefault("systemMessage", "Overwatch: some checks cannot run in this environment")
    if blocking:
        output.update({"decision": "block", "reason": gate_reason(gate_reports(current))})
    if parts:
        output.update(context_output(event.hook_event_name, "\n\n".join(parts)))
    if event.integration:
        output['overwatch'] = {**integration_report(current), 'waking': waking}
    assert blocking == (output.get("decision") == "block"), f"output {output} disagrees with blocking={blocking}; block only a guarded Stop"
    assert bool(parts) == ("hookSpecificOutput" in output), f"output {output} drops or invents context for {len(parts)} parts"
    return output


def integration_report(current: State) -> dict[str, Any]:
    """Internal plugin transport metadata; native hook responses retain their existing schema and deduplication."""
    reports = current.reports
    status = ' · '.join(f"{report.name} {'✗' if report.failed else '✓'} {SUMMARY_DECORATION.sub('', report.summary)}{failing_suffix(report.failures)}"
                        for report in reports)
    result = {'status': f'Overwatch: {status}' if status else None,
              'guarded': bool(gate_reports(current)), 'signature': current.told}
    assert result['guarded'] == bool(gate_reports(current)), f'Plugin report {result} lost its guarded state'
    assert not reports or result['status'], f'{len(reports)} reports produced no plugin status'
    return result


def follow(event: Event, root: Path, parent: int) -> Iterator[dict[str, Any]]:
    """The output for each settled result the project's daemon gives after a watcher publishes, read as a hook
    reads one and saved in the same state, while the process parent still runs. Hooks keep telling the engine of
    the session's edits, so a result after one may wake the agent, and another process's never does."""
    import daemon
    cwd = repository_of(Path(event.cwd or os.getcwd()).resolve())
    assert root.is_absolute(), f"follow was given data directory {root}; pass what data_root returned"
    # A follower whose parent exited before it started has been handed to init, and has no session to follow.
    if cwd is None or parent <= 1:
        return
    generation = 0
    while os.getppid() == parent:
        generation, reports = daemon.next_reports(cwd, root, generation, PARENT_SECONDS)
        if reports is None:
            continue
        with locked(state_path(event, cwd, root), root) as session:
            read = checked_state(session, cwd, followed=reports)
            output = report_output(event, read, session)
            save_state(session, read.current)
        assert session.state.exists(), f"no state was saved for {cwd} at {session.state}; save_state must write it"
        if output:
            assert json.loads(json.dumps(output)) == output, f"follow would print {output!r}, which is not plain JSON"
            yield output


def main() -> None:
    """Answers one hook event on stdin with JSON on stdout; with `follow`, reads one event naming the session and
    prints a line of JSON for each settled result after that, as a hook would answer it, until its parent exits. The event comes from the agent host that started this
    process, through the pipe it holds, so no one else can write it. Every problem is told to the host in that
    output, as a system message it shows the user: a mistake in .overwatch.json, its gate or the event as the error
    says. An unexpected error is also written to stderr, where the host logs it."""
    if sys.argv[1:] == ["follow"]:
        parent = os.getppid()
        for output in follow(read_event(), data_root(os.environ.get("PLUGIN_DATA")), parent):
            print(json.dumps(output), flush=True)
        return
    try:
        output = json.dumps(process_event(read_event(), data_root(os.environ.get("PLUGIN_DATA"))))
    except (ConfigurationError, PolicyError) as error:
        output = json.dumps({"systemMessage": f"overwatch: {error}"})
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
        print(f"overwatch: unexpected {type(error).__name__}: {error}", file=sys.stderr)
        output = json.dumps({"systemMessage": f"overwatch: unexpected error: {error}; report it at "
                                              "https://github.com/benomahony/overwatch/issues with the hook event"})
    assert output.startswith("{"), f"hook output {output[:40]} is not a JSON object; return a dict from process_event"
    assert "\n" not in output, "hook output spans lines; print it as one JSON line"
    print(output)


if __name__ == "__main__":
    main()
