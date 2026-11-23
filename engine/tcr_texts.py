"""What TCR tells the agent, as text: what a revert restored and where the discarded work is saved, why an edit is held
or left alone. A text holds what the engine does not control, a path, a file or check name, git's output, so no assert
here inspects one: each asserts on the values the text is built from.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from pathlib import Path

from bugs import BUG_ADVICE
from checkpoint import RESET_DONE, RESET_FAILED, RESET_UNKNOWN
from discovery import OVERRIDE_PATH
from messages import failing_line, known_failures, report_key, where
from records import TIMED_OUT, First, Report
from repository_state import MESSAGE_FILES, named
from safe_text import safe_line, safe_path
from tcr_settings import SAVE_REVERTED_FIELD, SETTINGS_FIELD

SUBMODULES_LEFT = " The files inside the submodules {names} were not restored and still hold changes."
STILL_CHANGED = " Still changed: {names}."
CHANGED_SINCE_LISTING = " Changed after TCR listed the files: {names}."
AS_HEAD = " Now as HEAD has them: {names}."
PRESENT_STATE = "`git status` shows the present state."
GIT_FAILED = "and git failed."
BUG_STOPPED = f"and it stopped on a bug: {BUG_ADVICE}."
LISTING_FAILED = "Git could not list the files now."
LISTING_BUG = f"The files could not be listed: {BUG_ADVICE}."
GONE = "The discarded work is gone: `{field}` is false in {path}."
NOT_SAVED = "No copy was saved: `{field}` is false in {path}."


def restoration(restored: list[str], saved: str | None, skipped: list[str], staged: bool = False) -> str:
    """What the revert message says of the files: which came back, which submodules still hold changes that a revert does
    not reach, and where the work the revert discarded is saved and how to get it back, or that it is gone because the
    setting turned the saving off. When the index held a version that the tree did not, it names the command for that too.
    No file came back when the reset failed on every file the revert was to restore, and then no work was discarded, so none is gone.
    """
    assert saved or not staged, "a staged copy is saved with the work, so there is none when nothing was saved"
    assert saved != "", f"the saved ref is {saved!r}, which names no saved work; pass None when nothing was saved"
    came_back = f"Restored: {named(restored)}." if restored else "No file was restored."
    came_back += named_in(skipped, SUBMODULES_LEFT, "submodules skipped")
    if saved is None:
        unsaved = GONE if restored else NOT_SAVED
        return f"{came_back} {unsaved.format(field=f'{SETTINGS_FIELD}.{SAVE_REVERTED_FIELD}', path=OVERRIDE_PATH)}"
    return f"{came_back} The discarded work is saved in `{saved}`; recover it with `git checkout {saved} -- .`.{staged_copy_recovery(saved, staged)}"


@dataclass(frozen=True)
class Recovery:
    """What a revert leaves for the agent to recover from: the ref that saved the work, or None when nothing was saved; whether the index held a version the tree did not; the submodules whose files the revert does not reach; the files that changed after TCR listed them, which no revert covered."""
    saved: str | None
    staged: bool
    skipped: list[str]
    changed_later: list[str] = field(default_factory=list)
    as_head: list[str] = field(default_factory=list)
    still_changed: list[str] = field(default_factory=list)


RESET_OUTCOMES = (RESET_DONE, RESET_FAILED, RESET_UNKNOWN)


@dataclass(frozen=True)
class Facts:
    """What the code knows of a revert that did not finish: how the reset command ended (a RESET_ outcome of checkpoint), the changed files listed before the reset, the files listed after it, or None when they could not be listed, and whether a bug, not a git failure, stopped the revert or the second listing."""
    reset: str
    before: list[str]
    after: list[str] | None
    bug: bool = False

    def listing_changes(self) -> tuple[list[str], list[str], list[str]]:
        """The files of the first listing that the second does not list, those that both give, and those that only the second gives, which changed after the first; none of them when there is no second listing."""
        assert isinstance(self.reset, str), f"the reset result is {self.reset!r}, not a text"
        assert self.reset in RESET_OUTCOMES, f"the reset result is {self.reset!r}, which is no outcome of a reset"
        if self.after is None:
            return [], [], []
        return ([name for name in self.before if name not in self.after], [name for name in self.before if name in self.after], [name for name in self.after if name not in self.before])


def interrupted_restoration(facts: Facts, recovery: Recovery) -> str:
    """What the revert message says of the files when the reset succeeded and a later step failed: the files as the two listings show them, or, when git could not list them after the reset, that `git status` shows the present state, with the saved copy and the submodules told as always."""
    assert facts.reset == RESET_DONE, f"the reset result is {facts.reset!r}; only a reset that succeeded is told as a revert"
    assert recovery.saved != "", f"the saved ref is {recovery.saved!r}, which names no saved work; pass None when nothing was saved"
    if facts.after is None:
        return unlisted_restoration(recovery, facts.bug)
    return partial_restoration(facts.before, facts.after, recovery)


def unlisted_restoration(recovery: Recovery, bug: bool = False) -> str:
    """What the revert message says of the files when they could not be listed after the reset, by git or because of a bug: nothing about which came back, and where the saved copy is."""
    assert isinstance(recovery.saved, str | None), f"the saved ref is {recovery.saved!r}, not a text or None"
    copy = f"The discarded work is saved in `{recovery.saved}`; recover it with `git checkout {recovery.saved} -- .`.{staged_copy_recovery(recovery.saved, recovery.staged)}" if recovery.saved else NOT_SAVED.format(field=f"{SETTINGS_FIELD}.{SAVE_REVERTED_FIELD}", path=OVERRIDE_PATH)
    told = f"{LISTING_BUG if bug else LISTING_FAILED} {PRESENT_STATE}{named_in(recovery.skipped, SUBMODULES_LEFT, 'submodules skipped')} {copy}"
    assert MESSAGE_FILES > 0, f"{MESSAGE_FILES} names are listed, so a notice lists none"
    return told


def interrupted_attempt(facts: Facts, recovery: Recovery) -> str:
    """The text of a revert whose reset did not succeed or is not known to have: an attempt that git or a bug stopped, with the files told only as the two listings show them."""
    assert facts.reset != RESET_DONE, f"the reset result is {facts.reset!r}; a reset that succeeded is told as a revert"
    assert recovery.saved != "", f"the saved ref is {recovery.saved!r}, which names no saved work; pass None when nothing was saved"
    came_back, still_changed, changed_later = facts.listing_changes()
    told = replace(recovery, changed_later=changed_later, as_head=came_back, still_changed=still_changed)
    return unreverted_message(told, facts.bug)


def partial_restoration(restored: list[str], left: list[str], recovery: Recovery) -> str:
    """What the revert message says when files are still changed after the revert: the files of the first listing that came back, those of it that git could not restore, and those that changed after the listing, which the revert did not cover."""
    assert recovery.saved != "", f"the saved ref is {recovery.saved!r}, which names no saved work; pass None when nothing was saved"
    assert isinstance(recovery.saved, str | None), f"the saved ref is {recovery.saved!r}, not a text or None"
    came_back = restoration([name for name in restored if name not in left], recovery.saved, recovery.skipped, recovery.staged)
    refused = named_in([name for name in left if name in restored], STILL_CHANGED, "files still changed")
    late = named_in([name for name in left if name not in restored], CHANGED_SINCE_LISTING, "files changed after the listing")
    return came_back + refused + late


def named_in(names: list[str], sentence: str, kind: str) -> str:
    """The sentence with the names, each quoted, put where it says {names}, or nothing when there is no name."""
    assert "{names}" in sentence, f"the sentence {sentence!r} has no place for the {kind}"
    assert kind, f"the sentence {sentence!r} lists names with no word for what they are"
    told = sentence.format(names=named(names)) if names else ""
    return told


def staged_copy_recovery(saved: str, staged: bool) -> str:
    """The sentence that names the second parent of the saved ref and the command that recovers it, when the index held a version the tree did not, or nothing."""
    assert saved, f"the saved ref is {saved!r}, which names no saved work to recover"
    told = f" The version that was staged is in `{saved}^2`; recover it with `git checkout {saved}^2 -- .`." if staged else ""
    assert bool(told) == staged, f"the staged copy note {told!r} disagrees with staged being {staged}"
    return told


def revert_message(regressions: list[Report], baseline: Mapping[str, First], logs: dict[str, Path], restoration_text: str) -> str:
    """Tells the agent which new failures caused the revert, where the full output is, and what was restored."""
    assert regressions, "a revert for no failure cannot be told"
    parts: list[str] = []
    for report in regressions:
        known = set(known_failures(report, baseline))
        fresh = [name for name in report.failures if name not in known]
        parts.append(f"overwatch: TCR reverted the latest change because `{safe_path(report.command)}`{where(report)} failed: {safe_line(report.summary)}\n"
                     f"{failing_line(fresh)}Full output: `{safe_path(str(logs[report_key(report)]))}`")
    assert len(parts) == len(regressions), f"{len(parts)} reverts were told for {len(regressions)} failures"
    return "\n\n".join(parts) + f"\n{restoration_text} Try a smaller step."


def held_message(reports: list[Report], logs: dict[str, Path]) -> str:
    """Tells the agent that TCR held the edit, committing and reverting nothing, because a failing check has no
    earlier result to compare its failure with."""
    assert reports, "held_message was given no check; give the checks that hold the edit"
    assert {report_key(report) for report in reports} <= set(logs), f"the logs {sorted(logs)} leave out a held check"
    names = ", ".join(safe_path(report.name) for report in reports)
    lines = "".join(f"\n`{safe_path(report.command)}`{where(report)}: {safe_line(report.summary)}. Full output: `{safe_path(str(logs[report_key(report)]))}`" for report in reports)
    timed_out = [safe_path(report.name) for report in reports if TIMED_OUT in report.failures]
    reason = f"{', '.join(timed_out)} outlived its deadline and says nothing of the edit" if len(timed_out) == len(reports) else f"{names} failed and has no earlier result to compare with"
    return (f"overwatch: TCR held the edit: {reason}. Nothing was committed or reverted."
            f"{lines}\nThe edit is committed once the check passes.")


def left_unreverted(reason: str) -> str:
    """Tells the agent that TCR left the latest change uncommitted and unreverted, and why. A reason that ends in a full
    stop does not get a second one."""
    assert reason, f"TCR left a change alone for the reason {reason!r}; give one"
    ending = "" if reason.endswith(".") else "."
    notice = f"overwatch: TCR left the latest change uncommitted and unreverted: {safe_line(reason)}{ending}"
    assert len(notice) > len(reason), f"the notice of {len(notice)} characters does not hold its reason of {len(reason)}"
    return notice


def failing_check(regressions: list[Report], logs: dict[str, Path]) -> str:
    """The sentence that names each check whose new failure TCR tried to revert, quoted, and where its full output is."""
    assert regressions, "no failure was given to name"
    assert {report_key(report) for report in regressions} <= set(logs), f"the logs {sorted(logs)} leave out a failing check"
    names = named([report.name for report in regressions])
    outputs = ", ".join(f"`{safe_path(str(logs[report_key(report)]))}`" for report in regressions[:MESSAGE_FILES])
    plural = len(regressions) > 1
    return f" The failing {'checks are' if plural else 'check is'} {names}; {'their' if plural else 'its'} full output is in {outputs}."


def unreverted_message(recovery: Recovery, bug: bool = False) -> str:
    """Tells the agent that TCR tried to revert the latest change and that git failed, or a bug stopped it, and what is known of the files: that
    `git status` shows the present state; the files that the two listings show as now as HEAD has them and those that changed after TCR listed them; where a copy of the work is saved, if one
    was, and the staged copy and the submodules the revert does not reach, as a completed revert tells them."""
    saved, staged = recovery.saved, recovery.staged
    assert saved != "", f"the saved ref is {saved!r}, which names no saved work; pass None when nothing was saved"
    assert saved or not staged, "a staged copy is saved with the work, so there is none when nothing was saved"
    copy = (f"A copy of the work is saved in `{saved}`; `git checkout {saved} -- .` restores it.{staged_copy_recovery(saved, staged)}" if saved else f"No copy was saved: `{SETTINGS_FIELD}.{SAVE_REVERTED_FIELD}` is false in {OVERRIDE_PATH}.")
    skipped = named_in(recovery.skipped, SUBMODULES_LEFT, "submodules skipped")
    as_head = named_in(recovery.as_head, AS_HEAD, "files now as HEAD has them")
    still_changed = named_in(recovery.still_changed, STILL_CHANGED, "files still changed")
    changed_later = named_in(recovery.changed_later, CHANGED_SINCE_LISTING, "files changed after the listing")
    return f"overwatch: TCR tried to revert the latest change after a new failure, {BUG_STOPPED if bug else GIT_FAILED} {PRESENT_STATE} {copy}{skipped}{as_head}{still_changed}{changed_later}"
