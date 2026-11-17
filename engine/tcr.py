"""TCR mode: commit the agent's green edits and revert the ones that add a failure.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import time
from collections.abc import Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import checkpoint
from discovery import OVERRIDE_PATH, ConfigurationError
from messages import failing_line, failure_status, is_regression, known_failures, report_key, where
from records import TIMED_OUT, Event, First, Report, Session, State
from sessions import write_log
from tcr_settings import ALLOW_FIELD, HOST_LIMIT_SECONDS, SAVE_REVERTED_FIELD, SETTINGS_FIELD, Settings, read_settings
from workspace import commit_of, content_fingerprint, fingerprint

TCR_MODE = "tcr"
TCR_ACTIVE = "active"
TURN_START_EVENTS = frozenset({"SessionStart", "UserPromptSubmit"})
SHORT_COMMIT = 7
UPSTREAM_LANGUAGE = "git"
UNSETTLED = "unsettled"
OUTSIDE_CHANGE = "files changed outside the agent's edits, and a revert would discard them"
NO_CHECKS = "no checks are configured"
DIRTY_TREE = "the working tree has uncommitted changes"
TCR_OFF = "overwatch: TCR is off: `mode` is no longer set in .overwatch.json, so edits are neither committed nor reverted."
PROTECTED_BRANCHES = frozenset({"main", "master"})
# What a checkpoint needs once the checks are done: one git command's time, for the longest of them.
MIN_SECONDS_LEFT = 30
# What a revert needs: a save for each attempt, then the reset and the clean, each git command taking its longest.
REVERT_SECONDS_LEFT = (checkpoint.MAX_SAVE_ATTEMPTS + 2) * checkpoint.GIT_TIMEOUT
PROCESS_STARTED = time.monotonic()
PROCESS_STARTED_WALL = time.time()
NANOSECONDS = 1_000_000_000


@dataclass(frozen=True)
class Turn:
    """What one hook event gives TCR to decide on: the event, the repository, the session, the project's settings, whether
    the read followed the agent's own edit, and whether it took a fresh baseline because HEAD moved."""
    event: Event
    cwd: Path
    session: Session
    override: dict[str, Any]
    edited: bool
    moved: bool = False


@dataclass(frozen=True)
class TcrStep:
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


def has_time_for_git(started: float, now: float, limit: float, needed: float) -> bool:
    """Whether, now, the host's limit for a hook that started at started leaves needed seconds for git. Both times are
    readings of the monotonic clock, in seconds."""
    left = limit - (now - started)
    assert now >= started, f"the clock read {now} after it read {started}; use one monotonic clock"
    assert limit > 0 and needed > 0, f"a hook limit of {limit} seconds, or a need of {needed}, leaves no time to reason about"
    return left >= needed


def held_fingerprint_of(cwd: Path) -> str:
    """What a held edit's files are: the fingerprint of the workspace, which a person's change of size or time shows, and
    a digest of the contents of the files that differ from HEAD, which a change that keeps both shows."""
    root = checkpoint.repository_root(cwd)
    assert cwd.resolve().is_relative_to(root), f"{cwd} is not inside the repository {root} it is fingerprinted in"
    names = checkpoint.uncommitted(root)
    value = f"{fingerprint(cwd)}:{content_fingerprint(root, names)}"
    assert value.count(":") == 1, f"held fingerprint {value!r} is not a fingerprint and a content digest"
    return value


def why_unavailable(turn: Turn, old: State, current: State) -> str | None:
    """Why TCR cannot run at the start of a turn, or None when it can. Uncommitted changes are no reason when they are
    the held edit and nobody touched the files since it was held. When the files changed while the checks ran, the
    reason says that the agent edited, if an editing tool announced it, and otherwise that a check wrote them."""
    try:
        held_tree_unchanged = bool(old.held) and old.held_fingerprint is not None and old.held_fingerprint == held_fingerprint_of(turn.cwd)
        reason = checkpoint.unavailable_reason(turn.cwd, dirty_ok=held_tree_unchanged)
    except checkpoint.CheckpointError as error:
        return str(error)
    if reason is None and not edit_reports(current):
        return NO_CHECKS
    if reason is not None and reason.startswith(DIRTY_TREE) and turn.edited:
        reason = f"{reason}; the agent edited while the first checks ran, so TCR starts at the next turn start"
    elif reason is not None and reason.startswith(DIRTY_TREE) and fingerprint(turn.cwd) != current.fingerprint:
        reason = f"{reason}; the checks changed the files while they ran, so add what a check writes to .gitignore"
    assert not held_tree_unchanged or reason is None or DIRTY_TREE not in reason, f"the held edit's own changes were given as a reason: {reason!r}"
    assert reason is None or reason, "TCR is unavailable without a reason"
    return reason


def tcr_state(turn: Turn, old: State, current: State) -> str:
    """TCR_ACTIVE, or the reason TCR cannot run. It is decided when the session first meets TCR and again at the start
    of each turn, when the agent is not mid-edit. At other events the previous answer stands, except that files which
    changed while no edit of the agent was running are someone else's, so TCR waits for the next turn start."""
    previous = old.tcr
    if previous is not None and turn.event.hook_event_name not in TURN_START_EVENTS:
        outside = (previous == TCR_ACTIVE and not turn.edited
                   and old.judged not in (None, UNSETTLED) and old.judged != current.fingerprint)
        return OUTSIDE_CHANGE if outside else previous
    reason = why_unavailable(turn, old, current)
    state = TCR_ACTIVE if reason is None else reason
    assert state == TCR_ACTIVE or state, f"TCR is unavailable without a reason for {turn.cwd}; give one"
    assert (state == TCR_ACTIVE) == (reason is None), f"state {state!r} disagrees with reason {reason!r}"
    return state


def branch_notice(turn: Turn) -> str:
    """The sentence that tells the agent checkpoints land on a branch people share, or nothing on any other branch."""
    branch = checkpoint.current_branch(checkpoint.repository_root(turn.cwd))
    sentence = f" The branch is `{branch}`, so TCR's checkpoints land on it." if branch in PROTECTED_BRANCHES else ""
    assert (branch in PROTECTED_BRANCHES) == bool(sentence), f"the sentence {sentence!r} disagrees with the branch {branch!r}"
    assert sentence == "" or sentence.startswith(" "), f"the sentence {sentence!r} does not join the notice before it"
    return sentence


def tcr_notice(previous: str | None, state: str, branch: str = "") -> tuple[str, ...]:
    """What the agent is told when the TCR state changed from previous to state: nothing when it did not. branch is
    a sentence about the branch the checkpoints land on, told when TCR turns on."""
    if state == previous:
        return ()
    if state == TCR_ACTIVE:
        notice = f"overwatch: TCR is on: an edit that keeps the checks green is committed, and an edit that adds a failure is reverted.{branch}"
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


def settles_edit(current: State, files_unchanged: bool) -> bool:
    """Whether the checks just run belong to the agent's own latest edit, so TCR may commit or revert: nothing changed
    the files again while the checks ran, and every check could run."""
    reports = edit_reports(current)
    settles = files_unchanged and bool(reports) and not any(report.environment for report in reports)
    assert not settles or reports, f"TCR settles the edit of {current.fingerprint!r} with no check to read; leave it unsettled"
    assert not settles or current.fingerprint not in (None, UNSETTLED), f"TCR settles an edit whose checked files have the fingerprint {current.fingerprint!r}, which names no files"
    return settles


def written_since_start(root: Path) -> list[str]:
    """The files that differ from HEAD and were modified after this hook started, so that they were written while it ran
    the checks."""
    started = int(PROCESS_STARTED_WALL * NANOSECONDS)
    assert root.is_dir(), f"{root} is no directory to look for written files in"
    assert started > 0, f"the hook started at {started} nanoseconds, before any file could be written"
    written = []
    for name in checkpoint.uncommitted(root):
        try:
            if (root / name).stat().st_mtime_ns >= started:
                written.append(name)
        except OSError:
            continue
    assert len(set(written)) == len(written), f"{written} lists a file twice"
    return written


def changed_while_checking(turn: Turn, current: State) -> str:
    """Why the files differ after the checks ran: the files they wrote, when git can name them; otherwise that something
    changed them."""
    try:
        written = written_since_start(checkpoint.repository_root(turn.cwd))
    except checkpoint.CheckpointError:
        written = []
    checks = sorted({report.name for report in edit_reports(current)})
    assert all(checks), f"the checks {checks} include one with no name to tell the agent"
    writer = f"the check {checks[0]}" if len(checks) == 1 else f"one of the checks {', '.join(checks)}"
    reason = f"{writer} wrote files ({checkpoint.named(written)}), so TCR cannot tell them from the agent's; add them to .gitignore" if written and checks else OUTSIDE_CHANGE
    assert reason == OUTSIDE_CHANGE or all(name in reason for name in written[:checkpoint.MESSAGE_FILES]), f"reason {reason!r} leaves out a written file"
    return reason


def unsettled(turn: Turn, current: State, files_unchanged: bool) -> TcrStep:
    """What TCR does when the checks just run do not belong to the agent's latest edit: it neither commits nor reverts and
    judges again at the next edit. When the files changed while the checks ran it tells the agent why; when the files
    are the held edit's, it records them so that a turn start can tell nobody changed them since."""
    assert current.fingerprint != UNSETTLED or not files_unchanged, f"TCR judged the fingerprint {current.fingerprint!r} unsettled with files_unchanged {files_unchanged}"
    state = replace(current, fingerprint=UNSETTLED)
    if not files_unchanged:
        return TcrStep(state, (left_unreverted(changed_while_checking(turn, current)),))
    if current.held:
        state = replace(state, held_fingerprint=held_fingerprint_of(turn.cwd))
    assert state.fingerprint == UNSETTLED, "an unsettled edit keeps the fingerprint that would let the checks be reused"
    return TcrStep(state)


def restoration(restored: list[str], saved: str | None, skipped: list[str], staged: bool = False) -> str:
    """What the revert message says of the files: which came back, which submodules still hold changes that a revert does
    not reach, and where the work the revert discarded is saved and how to get it back, or that it is gone because the
    setting turned the saving off. When the index held a version that the tree did not, it names the command for that too."""
    came_back = f"Restored: {', '.join(f'`{name}`' for name in restored)}."
    if skipped:
        came_back += f" The files inside the submodules {', '.join(f'`{name}`' for name in skipped)} were not restored and still hold changes."
    if saved is None:
        text = f"{came_back} The discarded work is gone: `{SETTINGS_FIELD}.{SAVE_REVERTED_FIELD}` is false in {OVERRIDE_PATH}."
    else:
        text = f"{came_back} The discarded work is saved in `{saved}`; recover it with `git checkout {saved} -- .`."
        if staged:
            text += f" The version that was staged is in `{saved}^2`; recover it with `git checkout {saved}^2 -- .`."
    assert all(f"`{name}`" in text for name in [*restored, *skipped]), f"message leaves out one of the restored files {restored} or skipped submodules {skipped}"
    assert (saved is None) == ("is gone" in text), f"message {text!r} disagrees with the saved ref {saved!r}"
    return text


def revert_message(regressions: list[Report], baseline: Mapping[str, First], logs: dict[str, Path], restoration_text: str) -> str:
    """Tells the agent which new failures caused the revert, where the full output is, and what was restored."""
    assert regressions and restoration_text, f"a revert for {len(regressions)} failures cannot be told without what it restored"
    parts: list[str] = []
    for report in regressions:
        known = set(known_failures(report, baseline))
        fresh = [name for name in report.failures if name not in known]
        parts.append(f"overwatch: TCR reverted the latest change because `{report.command}`{where(report)} failed: {report.summary}\n"
                     f"{failing_line(fresh)}Full output: `{logs[report_key(report)]}`")
    text = "\n\n".join(parts) + f"\n{restoration_text} Try a smaller step."
    assert text.count("TCR reverted") == len(regressions), f"message names {text.count('TCR reverted')} reverts for {len(regressions)} failures"
    return text


def held_message(reports: list[Report], logs: dict[str, Path]) -> str:
    """Tells the agent that TCR held the edit, committing and reverting nothing, because a failing check has no
    earlier result to compare its failure with."""
    assert reports, "held_message was given no check; give the checks that hold the edit"
    names = ", ".join(report.name for report in reports)
    lines = "".join(f"\n`{report.command}`{where(report)}: {report.summary}. Full output: `{logs[report_key(report)]}`" for report in reports)
    timed_out = [report.name for report in reports if TIMED_OUT in report.failures]
    reason = f"{', '.join(timed_out)} outlived its deadline and says nothing of the edit" if len(timed_out) == len(reports) else f"{names} failed and has no earlier result to compare with"
    text = (f"overwatch: TCR held the edit: {reason}. Nothing was committed or reverted."
            f"{lines}\nThe edit is committed once the check passes.")
    assert all(report.name in text and str(logs[report_key(report)]) in text for report in reports), f"message {text!r} leaves out one of the held checks"
    assert "held the edit" in text, f"message {text!r} does not say that the edit was held"
    return text


def left_unreverted(reason: str) -> str:
    """Tells the agent that TCR left the latest change uncommitted and unreverted, and why."""
    text = f"overwatch: TCR left the latest change uncommitted and unreverted: {reason}."
    assert reason == reason.rstrip("."), f"the reason {reason!r} ends in a full stop, so the notice would end in two"
    assert reason and text.endswith(f"{reason}."), f"the notice {text!r} does not give its reason"
    return text


def nothing_to_revert(current: State, regressions: list[Report]) -> TcrStep:
    """Leaves the edit alone when a check fails and no file differs from the latest checkpoint: the failure is not the
    edit's to undo, so the agent is told. No file differs, so no held edit's files need to be recognised later."""
    causes = "; ".join(f"{report.name} reported {report.summary}" for report in regressions)
    step = TcrStep(current, (left_unreverted(f"{causes}, but no file differs from the latest checkpoint, so there is nothing to revert"),))
    assert "nothing to revert" in step.notices[0], f"notice {step.notices[0]!r} does not say there is nothing to revert"
    assert step.state is current, "leaving an edit alone changed the state"
    return step


def reverted(turn: Turn, current: State, regressions: list[Report], save_reverted: bool) -> TcrStep:
    """Restores the latest checkpoint and tells the agent why. A failure with nothing to restore is not the edit's, so
    it is only reported. When the revert cannot finish, TCR is unavailable and says why."""
    root = checkpoint.repository_root(turn.cwd)
    restored = checkpoint.uncommitted(root)
    if not restored:
        return nothing_to_revert(current, regressions)
    logs = {report_key(report): write_log(turn.session, report) for report in regressions}
    try:
        saved = checkpoint.revert(turn.cwd, save_ref=save_reverted)
    except checkpoint.CheckpointError as error:
        return TcrStep(replace(current, tcr=str(error)), tcr_notice(TCR_ACTIVE, str(error)))
    state = replace(current, reports=(), failed=False, told=None, signatures=(), fingerprint=UNSETTLED, head=commit_of(turn.cwd))
    skipped = checkpoint.dirty_submodules(root)
    staged = saved is not None and checkpoint.has_staged_copy(root, saved)
    step = TcrStep(state, (revert_message(regressions, current.baseline, logs, restoration(restored, saved, skipped, staged)),), failure_status(regressions))
    assert not step.state.failed, "a reverted workspace still counts as failed"
    assert step.state.head == commit_of(turn.cwd), f"state head {step.state.head} is not the restored commit"
    return step


def refusal_reason(refused: checkpoint.Refused) -> str:
    """Why TCR is unavailable after a checkpoint refused to commit: the files and the rules, and how to go on."""
    listed = ", ".join(refusal.text() for refusal in refused.refusals)
    reason = (f"the checkpoint would commit {listed}, so nothing was committed or reverted; add what is safe to commit to `{SETTINGS_FIELD}.{ALLOW_FIELD}` "
              f"in {OVERRIDE_PATH}, or to .gitignore, and commit the pending edit yourself")
    assert all(refusal.path in reason for refusal in refused.refusals), f"reason {reason!r} leaves out one of the refused files"
    assert reason, "TCR is unavailable without a reason"
    return reason


def checkpointed(turn: Turn, current: State, allow: tuple[str, ...]) -> TcrStep:
    """Commits the green edit as a checkpoint. When a file must not be committed, or the commit cannot be made, TCR is
    unavailable and says why, and the work is left as it is."""
    try:
        head = checkpoint.checkpoint(turn.cwd, allow)
    except checkpoint.Refused as refused:
        reason = refusal_reason(refused)
        return TcrStep(replace(current, tcr=reason), tcr_notice(TCR_ACTIVE, reason))
    except checkpoint.CheckpointError as error:
        return TcrStep(replace(current, tcr=str(error)), tcr_notice(TCR_ACTIVE, str(error)))
    if head is None:
        return TcrStep(current)
    step = TcrStep(replace(current, head=head), status=f"Overwatch: TCR checkpoint {head[:SHORT_COMMIT]}")
    assert step.state.head == commit_of(turn.cwd), f"state head {step.state.head} is not the new checkpoint"
    assert step.state.tcr == TCR_ACTIVE, f"a checkpoint left TCR {step.state.tcr!r}, not active"
    return step


def has_no_earlier_result(old: State, key: str, report: Report) -> bool:
    """Whether a check fails and no earlier result of it can judge the failure: it has no baseline before this edit, it
    was held before and has not passed since, or it outlived its deadline, which says nothing of what the edit broke."""
    fails = report.failed and not report.environment
    assert not fails or report.failures or report.summary, f"the check {key!r} failed with nothing to name the failure"
    assert key == report_key(report), f"the key {key!r} is not the key of the check {report.name}; look the baseline up by the key of the report itself"
    return fails and (key not in old.baseline or key in old.held or TIMED_OUT in report.failures)


def without_earlier_result(old: State, current: State) -> tuple[State, list[Report]]:
    """The state with the checks that passed, after being held for want of an earlier result, now judged by that pass,
    and the failing checks that have no earlier result to be judged by: they first appear in this edit, or were held
    before. A held check is told apart from an inherited failure by its key in state.held."""
    keyed = [(report_key(report), report) for report in edit_reports(current)]
    passed = {key: report for key, report in keyed if not report.failed and key in old.held}
    unjudged = [(key, report) for key, report in keyed if has_no_earlier_result(old, key, report)]
    baseline = {**current.baseline, **{key: First(False, (), report.summary) for key, report in passed.items()}}
    held_keys = tuple(sorted({*(key for key in old.held if key not in passed), *(key for key, _ in unjudged)}))
    assert not set(passed) & {key for key, _ in unjudged}, f"checks {set(passed)} both passed and failed in one result"
    assert all(key in held_keys for key, _ in unjudged), f"held {held_keys} leaves out a check that has no earlier result"
    return replace(current, baseline=baseline, held=held_keys, held_fingerprint=None), [report for _, report in unjudged]


def held(turn: Turn, current: State, unjudged: list[Report]) -> TcrStep:
    """Leaves the edit uncommitted and unreverted, and tells the agent which checks could not judge it. The state
    records the fingerprint of the files it left, so a turn start can tell that nobody changed them since."""
    logs = {report_key(report): write_log(turn.session, report) for report in unjudged}
    step = TcrStep(replace(current, held_fingerprint=held_fingerprint_of(turn.cwd)), (held_message(unjudged, logs),))
    assert step.state.head == commit_of(turn.cwd), f"holding an edit moved HEAD from {step.state.head}"
    assert set(step.state.held) >= {report_key(report) for report in unjudged}, f"the held checks {step.state.held} leave out a check that holds the edit"
    return step


def after_edit(turn: Turn, old: State, current: State, settings: Settings) -> TcrStep:
    """Judges the agent's own latest edit once its checks are in: it reverts a new failure, commits a green result,
    and leaves alone a result that a check without an earlier result, inherited findings that block, or too little time
    left in the host's limit would make unsafe to act on."""
    current, unjudged = without_earlier_result(old, current)
    regressions = [report for report in edit_reports(current) if report_key(report) not in current.held and is_regression(report, current.baseline)]
    needed = REVERT_SECONDS_LEFT if regressions else MIN_SECONDS_LEFT
    if not has_time_for_git(PROCESS_STARTED, time.monotonic(), settings.host_limit_seconds, needed):
        elapsed = round(time.monotonic() - PROCESS_STARTED)
        action = "reverting" if regressions else "committing"
        notice = (f"overwatch: TCR held the edit: the checks took {elapsed} of the {settings.host_limit_seconds:g} "
                  f"seconds the host gives a hook, and {action} needs {needed} more. Nothing was committed or reverted.")
        return TcrStep(replace(current, fingerprint=UNSETTLED), (notice,))
    if regressions:
        return reverted(turn, current, regressions, settings.save_reverted)
    if unjudged:
        return held(turn, current, unjudged)
    if current.inherited == "block" and any(report.failed for report in edit_reports(current)):
        return TcrStep(current)
    settled = checkpointed(turn, current, settings.allow)
    assert settled.state.tcr is not None, "TCR settled an edit without a state"
    assert not regressions, f"TCR committed past {len(regressions)} new failures"
    return settled


def settle(turn: Turn, old: State, current: State) -> TcrStep:
    """What TCR does at this event: nothing without the mode, except to tell the agent when the mode went away;
    otherwise it keeps its state, and on the agent's own latest edit it judges the result. The step's state records
    the files TCR looked at, so that a later follower read of other files does not hide an edit from it."""
    step = decide(turn, old, current)
    assert isinstance(step, TcrStep), f"TCR decided {step!r} at {turn.event.hook_event_name}, which is no step"
    recorded = replace(step, state=replace(step.state, judged=step.state.fingerprint))
    assert recorded.state.judged == recorded.state.fingerprint, f"TCR recorded {recorded.state.judged!r} for the files {recorded.state.fingerprint!r}"
    return recorded


def decide(turn: Turn, old: State, current: State) -> TcrStep:
    """The step of settle before it records what TCR looked at."""
    if read_mode(turn.override) != TCR_MODE:
        return TcrStep(current) if old.tcr is None else TcrStep(replace(current, tcr=None, held=()), (TCR_OFF,))
    try:
        return judge(turn, old, current, read_settings(turn.override))
    except ConfigurationError:
        raise
    except checkpoint.SCREENING_FAILURES as error:
        reason = str(error) if isinstance(error, checkpoint.CheckpointError) else f"TCR stopped on an unexpected {type(error).__name__}: {error}"
        step = TcrStep(replace(current, tcr=reason), tcr_notice(old.tcr, reason))
        assert step.state.tcr != TCR_ACTIVE, f"a git failure left TCR active: {reason!r}"
        assert old.tcr == reason or step.notices, f"the agent was not told that TCR stopped: {reason!r}"
        return step


def judge(turn: Turn, old: State, current: State, settings: Settings) -> TcrStep:
    """What TCR does at this event in TCR mode: it keeps its state, and on the agent's own latest edit it judges the
    result. A git command that fails along the way raises CheckpointError, which settle turns into an unavailable TCR."""
    state = tcr_state(turn, old, current)
    current = replace(current, tcr=state)
    on_branch = branch_notice(turn) if state == TCR_ACTIVE and old.tcr != state else ""
    notices = tcr_notice(old.tcr, state, on_branch)
    if state != TCR_ACTIVE or not turn.edited or turn.moved or old.judged == current.fingerprint:
        return TcrStep(current, notices)
    files_unchanged = fingerprint(turn.cwd) == current.fingerprint
    if not settles_edit(current, files_unchanged):
        step = unsettled(turn, current, files_unchanged)
        return replace(step, notices=(*notices, *step.notices))
    taken = after_edit(turn, old, current, settings)
    assert taken.state.tcr is not None, f"TCR judged an edit and left no state; the state before was {state!r}"
    assert taken.state.held is not None, "TCR judged an edit and lost which checks it holds"
    return replace(taken, notices=(*notices, *taken.notices))


def told(output: dict[str, Any], event_name: str, taken: TcrStep) -> dict[str, Any]:
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
