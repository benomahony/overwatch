"""TCR mode: commit the agent's green edits and revert the ones that add a failure.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import checkpoint
from records import EDITING_TOOLS, OVERRIDE_PATH, ConfigurationError, Event, First, Report, Session, State
from reports import failing_line, failure_status, is_regression, known_failures, report_key, where, write_log
from workspace import commit_of, fingerprint

TCR_MODE = "tcr"
TCR_ACTIVE = "active"
TURN_START_EVENTS = frozenset({"SessionStart", "UserPromptSubmit"})
SHORT_COMMIT = 7
UPSTREAM_LANGUAGE = "git"
UNSETTLED = "unsettled"
OUTSIDE_CHANGE = "files changed outside the agent's edits, and a revert would discard them"


@dataclass(frozen=True)
class Turn:
    """What one hook event gives TCR to decide on: the event, the repository, the session and the project's settings."""
    event: Event
    cwd: Path
    session: Session
    override: dict[str, Any]


@dataclass(frozen=True)
class Step:
    """What TCR did at one event: the state to save, what the agent is told and what the user's status line shows."""
    state: State
    notices: tuple[str, ...] = ()
    status: str | None = None


def read_mode(override: dict[str, Any]) -> str | None:
    """The project's mode from .overwatch.json: TCR_MODE, or None when it names none. Any other mode is a
    ConfigurationError."""
    mode = override.get("mode")
    if mode is not None and mode != TCR_MODE:
        raise ConfigurationError(f"{OVERRIDE_PATH} field 'mode' is {mode!r}; the only mode is {TCR_MODE!r}")
    assert mode in (None, TCR_MODE), f"read_mode accepted {mode!r}; accept only {TCR_MODE!r}"
    assert mode is None or isinstance(mode, str), f"mode {mode!r} is not a string"
    return mode


def edited_by_agent(turn: Turn) -> bool:
    """Whether the event follows a tool of the agent that can edit files."""
    edited = turn.event.hook_event_name == "PostToolUse" and turn.event.tool_name in EDITING_TOOLS
    assert not edited or turn.event.tool_name, "an edit of the agent names no tool"
    assert not edited or turn.event.hook_event_name == "PostToolUse", f"{turn.event.hook_event_name} is no edit of the agent"
    return edited


def tcr_state(turn: Turn, old: State, current: State) -> str:
    """TCR_ACTIVE, or the reason TCR cannot run. It is decided when the session first meets TCR and again at the start
    of each turn, when the agent is not mid-edit. At other events the previous answer stands, except that files which
    changed while no edit of the agent was running are someone else's, so TCR waits for the next turn start."""
    previous = old.tcr
    if previous is not None and turn.event.hook_event_name not in TURN_START_EVENTS:
        outside = (previous == TCR_ACTIVE and not edited_by_agent(turn)
                   and old.fingerprint not in (None, UNSETTLED) and old.fingerprint != current.fingerprint)
        return OUTSIDE_CHANGE if outside else previous
    try:
        reason = checkpoint.unavailable_reason(turn.cwd)
    except checkpoint.CheckpointError as error:
        reason = str(error)
    state = TCR_ACTIVE if reason is None else reason
    assert state == TCR_ACTIVE or state, f"TCR is unavailable without a reason for {turn.cwd}; give one"
    assert (state == TCR_ACTIVE) == (reason is None), f"state {state!r} disagrees with reason {reason!r}"
    return state


def tcr_notice(previous: str | None, state: str) -> tuple[str, ...]:
    """What the agent is told when the TCR state changed from previous to state: nothing when it did not."""
    if state == previous:
        return ()
    if state == TCR_ACTIVE:
        notice = "overwatch: TCR is on: an edit that keeps the checks green is committed, and an edit that adds a failure is reverted."
    else:
        notice = f"overwatch: TCR is unavailable: {state}. Nothing is committed or reverted until it can start again at the start of a turn."
    assert notice.startswith("overwatch: TCR is "), f"notice {notice!r} does not say it is about TCR"
    assert (state == TCR_ACTIVE) == ("is on" in notice), f"notice {notice!r} disagrees with state {state!r}"
    return (notice,)


def edit_reports(current: State) -> list[Report]:
    """The reports an edit of the agent can cause: all but the upstream check, whose failure is another person's push."""
    reports = [report for report in current.reports if report.language != UPSTREAM_LANGUAGE]
    assert all(report in current.reports for report in reports), f"reports {reports} are not all from this run"
    assert not any(report.language == UPSTREAM_LANGUAGE for report in reports), f"reports {reports} still hold a {UPSTREAM_LANGUAGE} check; leave it out"
    return reports


def settles_edit(turn: Turn, current: State) -> bool:
    """Whether the checks just run belong to the agent's own latest edit, so TCR may commit or revert: nothing changed
    the files again while the checks ran, and every check could run."""
    reports = edit_reports(current)
    settles = fingerprint(turn.cwd) == current.fingerprint and bool(reports) and not any(report.environment for report in reports)
    assert not settles or reports, f"TCR settles {turn.event.tool_name} with no check to read; leave it unsettled"
    assert not settles or current.fingerprint not in (None, UNSETTLED), f"TCR settles {turn.cwd} with no fingerprint of the checked files"
    return settles


def revert_message(regressions: list[Report], baseline: Mapping[str, First], logs: dict[str, Path], restored: list[str]) -> str:
    """Tells the agent which new failures caused the revert, where the full output is, and which files came back."""
    assert regressions and restored, f"a revert of {restored} for {len(regressions)} failures cannot be told; give both"
    parts: list[str] = []
    for report in regressions:
        known = set(known_failures(report, baseline))
        fresh = [name for name in report.failures if name not in known]
        parts.append(f"overwatch: TCR reverted the latest change because `{report.command}`{where(report)} failed: {report.summary}\n"
                     f"{failing_line(fresh)}Full output: `{logs[report_key(report)]}`")
    text = "\n\n".join(parts) + f"\nRestored: {', '.join(f'`{name}`' for name in restored)}. Try a smaller step."
    assert text.count("TCR reverted") == len(regressions), f"message names {text.count('TCR reverted')} reverts for {len(regressions)} failures"
    assert all(f"`{name}`" in text for name in restored), f"message leaves out one of the restored files {restored}"
    return text


def reverted(turn: Turn, current: State, regressions: list[Report]) -> Step:
    """Restores the latest checkpoint and tells the agent why. A failure with nothing to restore is not the edit's, so
    it is only reported. When the revert cannot finish, TCR is unavailable and says why."""
    restored = checkpoint.uncommitted(checkpoint.repository_root(turn.cwd))
    if not restored:
        return Step(current)
    logs = {report_key(report): write_log(turn.session, report) for report in regressions}
    try:
        checkpoint.revert(turn.cwd)
    except checkpoint.CheckpointError as error:
        return Step(replace(current, tcr=str(error)), tcr_notice(TCR_ACTIVE, str(error)))
    state = replace(current, reports=(), failed=False, told=None, signatures=(), fingerprint=fingerprint(turn.cwd), head=commit_of(turn.cwd))
    step = Step(state, (revert_message(regressions, current.baseline, logs, restored),), failure_status(regressions))
    assert not step.state.failed, "a reverted workspace still counts as failed"
    assert step.state.head == commit_of(turn.cwd), f"state head {step.state.head} is not the restored commit"
    return step


def checkpointed(turn: Turn, current: State) -> Step:
    """Commits the green edit as a checkpoint. When the commit cannot be made, TCR is unavailable and says why, and
    the changes stay staged."""
    try:
        head = checkpoint.checkpoint(turn.cwd)
    except checkpoint.CheckpointError as error:
        return Step(replace(current, tcr=str(error)), tcr_notice(TCR_ACTIVE, str(error)))
    if head is None:
        return Step(current)
    step = Step(replace(current, head=head), status=f"Overwatch: TCR checkpoint {head[:SHORT_COMMIT]}")
    assert step.state.head == commit_of(turn.cwd), f"state head {step.state.head} is not the new checkpoint"
    assert step.state.tcr == TCR_ACTIVE, f"a checkpoint left TCR {step.state.tcr!r}, not active"
    return step


def settle(turn: Turn, old: State, current: State) -> Step:
    """What TCR does at this event: nothing without the mode; otherwise it keeps its state, and on the agent's own
    latest edit it reverts a new failure, commits a green result, and leaves alone a result that inherited failures
    would block."""
    if read_mode(turn.override) != TCR_MODE:
        return Step(current)
    state = tcr_state(turn, old, current)
    current = replace(current, tcr=state)
    notices = tcr_notice(old.tcr, state)
    if state != TCR_ACTIVE or not edited_by_agent(turn) or old.fingerprint == current.fingerprint:
        return Step(current, notices)
    if not settles_edit(turn, current):
        return Step(replace(current, fingerprint=UNSETTLED), notices)
    regressions = [report for report in edit_reports(current) if is_regression(report, current.baseline)]
    if regressions:
        return reverted(turn, current, regressions)
    if current.inherited == "block" and any(report.failed for report in edit_reports(current)):
        return Step(current)
    settled = checkpointed(turn, current)
    assert settled.state.tcr is not None, "TCR settled an edit without a state"
    assert not regressions, f"TCR committed past {len(regressions)} new failures"
    return settled


def told(output: dict[str, Any], event_name: str, taken: Step) -> dict[str, Any]:
    """output with what TCR tells the agent put before the rest of its context, and its status line when the output
    has none."""
    if taken.notices:
        context = output.setdefault("hookSpecificOutput", {"hookEventName": event_name, "additionalContext": ""})
        earlier = context["additionalContext"]
        context["additionalContext"] = "\n\n".join([*taken.notices, *([earlier] if earlier else [])])
    if taken.status:
        output.setdefault("systemMessage", taken.status)
    if taken.notices and "overwatch" in output:
        output["overwatch"] = {**output["overwatch"], "notices": list(taken.notices)}
    assert not taken.notices or taken.notices[0] in output["hookSpecificOutput"]["additionalContext"], f"output {output} lost the notice {taken.notices[0]}"
    assert not taken.status or "systemMessage" in output, f"output {output} has no status line"
    return output
