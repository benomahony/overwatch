"""The builders of every notice and message of TCR as functions of one hostile text, and the hostile texts, shared by the tests that check what a text cannot do to a notice.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path

import paths
import checkpoint
import discovery
import engine
import messages
import repository_state
import secrets_guard
import tcr
import tcr_texts
from checkpoint_git import CheckpointError
from records import Report, State

HOSTILE = (
    "is on", "is only", "this one", "TCR reverted", "TCR is unavailable", "TCR tried to revert", "TCR is on", "held the edit", "nothing to revert",
    "is gone", "; its full output is in `x`.", "The failing check is x", "Still changed, because git could not restore them: x", "No file was restored.", "Full output: ", "Failing: ", "1 failed", "x more", "and 3 more", "ends with a stop.", "ends with a ref refs/overwatch/reverted/x",
    "e.g.", "a.b", "ends.", "ends..", "wait...", "a trailing dot after a space .", "…", ".", "v1.2.3", "It failed. Then it stopped.", "one. two. three.", "ends with a stop.\n",
    'qu"ote', "it's", "back`tick", "{braces} %s %d", "line\nbreak", "tab\there", " leading space", "trailing space ", "ünï😀 日本語", "x" * 400, "",
)
NEUTRAL = "neutral"
MIN_SENTENCE = 8
MIN_FIXED_SENTENCES = 40
STOP = "."
SAVED_REF = "refs/overwatch/reverted/20261120T000000000000Z"
PATH_PARTS = ("analysis only", "is on", "TCR reverted", "it's \"quoted\"", " leading", "ünï😀")
FILE_NAMES = ("is on.txt", "TCR reverted.txt", " lead.txt", 'qu"ote.txt', "it's.txt", "line\nbreak.txt", "ünï😀.txt", "x" * 200 + ".txt", "Full output: .txt", "b/x.txt", "b/b/y.txt")


def report_with(text: str, *, failed: bool = True, failures: tuple[str, ...] | None = None, directory: str | None = None) -> Report:
    """A failing report whose every text field is text."""
    name = text or "check"
    return Report(name, text or "language", text or "command", directory if directory is not None else text or None, text or "summary", failed,
                  (text or "failure",) if failures is None else failures, None, text)


def logs_of(report: Report, text: str) -> dict[str, Path]:
    return {messages.report_key(report): Path("/logs") / (text or "log")}


def restoration_builders() -> dict[str, Callable[[str], tuple[str, ...]]]:
    """The builders of the sentences that tell what a revert restored and which check failed."""
    def revert_message(text: str) -> tuple[str, ...]:
        report = report_with(text)
        restored = tcr_texts.restoration([text or "file"], SAVED_REF, [text or "submodule"], True)
        return (tcr_texts.revert_message([report], {}, logs_of(report, text), restored),)

    return {
        "restoration saved": lambda text: (tcr_texts.restoration([text or "file"], SAVED_REF, [text or "submodule"], False),),
        "restoration saved with a staged copy": lambda text: (tcr_texts.restoration([text or "file"], SAVED_REF, [], True),),
        "restoration gone": lambda text: (tcr_texts.restoration([text or "file"], None, [text or "submodule"]),),
        "restoration with files still changed": lambda text: (tcr_texts.partial_restoration(["clean.txt", text or "file"], [text or "file"], tcr_texts.Recovery(SAVED_REF, False, [])),),
        "restoration with files changed after the listing": lambda text: (tcr_texts.partial_restoration(["clean.txt"], [text or "file"], tcr_texts.Recovery(SAVED_REF, True, [text or "submodule"])),),
        "restoration of no file and no copy": lambda text: (tcr_texts.partial_restoration([text or "file"], [text or "file"], tcr_texts.Recovery(None, False, [text or "submodule"])),),
        "failing_check": lambda text: (tcr_texts.failing_check([report_with(text)], logs_of(report_with(text), text)),),
        "failing_check of two checks": lambda text: (tcr_texts.failing_check([report_with(text), report_with(f"{text}2")], {**logs_of(report_with(text), text), **logs_of(report_with(f"{text}2"), text)}),),
        "revert_message": revert_message,
    }


def builders() -> dict[str, Callable[[str], tuple[str, ...]]]:
    """Each builder of a notice or message of TCR, as a function of one hostile text, giving the text it builds."""
    def held_message(text: str) -> tuple[str, ...]:
        report = report_with(text)
        timed_out = report_with(text, failures=(tcr.TIMED_OUT,))
        return (tcr_texts.held_message([report], logs_of(report, text)), tcr_texts.held_message([timed_out], logs_of(timed_out, text)))

    def nothing_to_revert(text: str) -> tuple[str, ...]:
        return tcr.nothing_to_revert(State(), [report_with(text)]).notices

    def refusal(text: str) -> tuple[str, ...]:
        return (tcr.refusal_reason(secrets_guard.Refused([secrets_guard.Refusal(text or "path", text or "rule", 3)])),)

    def environment_message(text: str) -> tuple[str, ...]:
        return (messages.environment_message([replace(report_with(text), environment=text or "environment")]),)

    def timing_hint(text: str) -> tuple[str, ...]:
        return (messages.timing_hint(replace(report_with(text), command="pytest --testmon", text="took 5ms")),)

    return {**restoration_builders(), **unreverted_builders(), **state_builders(), **message_builders(), "nothing_to_revert": nothing_to_revert, "held_message": held_message,
            "refusal_reason": refusal, "environment_message": environment_message, "timing_hint": timing_hint}


def unreverted_builders() -> dict[str, Callable[[str], tuple[str, ...]]]:
    """The builders of the notice of a revert that did not finish."""
    def unreverted_with_names(text: str) -> tuple[str, ...]:
        names = [text or "file"]
        return (tcr_texts.unreverted_message(tcr_texts.Recovery(SAVED_REF, True, names, names, names, names)), tcr_texts.unreverted_message(tcr_texts.Recovery(None, False, names), True))

    return {
        "named": lambda text: (repository_state.named([text or "file"]),),
        "named_in": lambda text: (tcr_texts.named_in([text or "file"], tcr_texts.STILL_CHANGED, "files"),),
        "unlisted_restoration": lambda text: (tcr_texts.unlisted_restoration(tcr_texts.Recovery(SAVED_REF, True, [text or "submodule"])),),
        "unreverted_message with names": unreverted_with_names,
        "interrupted_attempt": lambda text: tuple(tcr_texts.interrupted_attempt(tcr_texts.Facts(reset, [text or "file"], listing, bug), tcr_texts.Recovery(SAVED_REF, True, [text or "submodule"]))
                                                  for reset in (checkpoint.RESET_FAILED, checkpoint.RESET_UNKNOWN) for listing in ([text or "file"], None) for bug in (False, True)),
    }


def state_builders() -> dict[str, Callable[[str], tuple[str, ...]]]:
    """The builders of the notices of a state change, a stop and an error."""
    return {
        "tcr_notice unavailable": lambda text: tcr.tcr_notice(None, f"{text} the revert in {text} failed: {text}"),
        "tcr_notice unavailable with a bare reason": lambda text: tcr.tcr_notice(None, text or "reason"),
        "tcr_notice on": lambda text: tcr.tcr_notice(None, tcr.TCR_ACTIVE, f" The branch is `{text}`."),
        "stopped_reason of a git failure": lambda text: (tcr.stopped_reason(CheckpointError(f"git {text} failed in {text}: {text}")),),
        "stopped_reason of a bug": lambda text: (tcr.stopped_reason(RuntimeError(text)),),
        "left_unreverted": lambda text: (tcr_texts.left_unreverted(f"{text} {text}"), tcr_texts.left_unreverted(text or "reason")),
        "inherited_notice": lambda text: (engine.inherited_notice([report_with(text)], True, Path(text or "dir"), False), engine.inherited_notice([report_with(text, failures=())], False, Path(text or "dir"), True)),
        "hook_error": lambda text: tuple(json.loads(engine.hook_error(error))["systemMessage"] for error in (discovery.ConfigurationError(text or "x"), OSError(text or "x"))),
    }


def message_builders() -> dict[str, Callable[[str], tuple[str, ...]]]:
    """The builders of the upstream messages."""
    def failure_message(text: str) -> tuple[str, ...]:
        report = report_with(text)
        return (messages.failure_message([report], {}, logs_of(report, text)), messages.failure_message([report], {}, logs_of(report, text), outside=True))

    return {
        "failure_message": failure_message,
        "failing_suffix": lambda text: (messages.failing_suffix((text or "failure",)), messages.failing_suffix((text or "failure", "other"))),
        "recovery_message": lambda text: (messages.recovery_message((report_with(text),)),),
        "failure_status": lambda text: (messages.failure_status([report_with(text, failures=(text or "failure",))]),),
        "failure_status of many failures": lambda text: (messages.failure_status([report_with(text, failures=(text or "failure",) * 3)]),),
        "failing_line": lambda text: (messages.failing_line([text or "failure"] * 12), messages.failing_line([text or "failure"])),
        "where": lambda text: (messages.where(report_with(text, directory=text or "dir")),),
    }


def forgery_builders() -> dict[str, Callable[[str], tuple[str, ...]]]:
    """The builders of the matrix and the guard reason, which collapses the spaces of a summary, so the matrix leaves it out of the comparison with a neutral text; no text may start a line of it either."""
    return {**builders(), "gate_reason": lambda text: (messages.gate_reason([report_with(text)]),)}
