"""A fault for every git command in turn: the k-th git command a test runs times out or exits with an error.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import subprocess
import unittest.mock
from types import TracebackType
from typing import Any

import paths
from checkpoint_git import GIT_TIMEOUT

REAL_RUN = subprocess.run
TIMES_OUT, EXITS_WITH_AN_ERROR = "times out", "exits with an error"
FAULTS = (TIMES_OUT, EXITS_WITH_AN_ERROR)
TIMES_OUT_AFTER_RUNNING = "times out after running"
ALL_FAULTS = (*FAULTS, TIMES_OUT_AFTER_RUNNING)
FATAL_EXIT = 128
FATAL_MESSAGE = "fatal: injected"
assert paths.ROOT.is_dir(), f"{paths.ROOT} is no directory"


class NthGitCall:
    """While active, counts the git commands run through subprocess.run, records their arguments, and makes the k-th fail as fault says: time out, exit with an error, or run to its end and then time out, as a command does that finishes just as its time is up. With k None it only counts."""

    def __init__(self, k: int | None, fault: str) -> None:
        assert fault in ALL_FAULTS, f"{fault!r} is no fault; use one of {ALL_FAULTS}"
        self.k = k
        self.fault = fault
        self.commands: list[list[str]] = []

        def run(argv: list[str], *arguments: object, **options: object) -> subprocess.CompletedProcess[Any]:
            if argv[:1] != ["git"]:
                return REAL_RUN(argv, *arguments, **options)
            self.commands.append(argv)
            if len(self.commands) != self.k:
                return REAL_RUN(argv, *arguments, **options)
            if self.fault == TIMES_OUT_AFTER_RUNNING:
                REAL_RUN(argv, *arguments, **options)
                raise subprocess.TimeoutExpired(argv, GIT_TIMEOUT)
            if self.fault == TIMES_OUT:
                raise subprocess.TimeoutExpired(argv, GIT_TIMEOUT)
            reads_text = bool(options.get("text") or options.get("universal_newlines") or options.get("encoding") or options.get("errors"))
            output, message = ("", FATAL_MESSAGE) if reads_text else (b"", FATAL_MESSAGE.encode())
            if options.get("check"):
                raise subprocess.CalledProcessError(FATAL_EXIT, argv, output, message)
            return subprocess.CompletedProcess(argv, FATAL_EXIT, output, message)

        self.patch = unittest.mock.patch.object(subprocess, "run", run)

    def failed_command(self) -> list[str]:
        assert self.k is not None and len(self.commands) >= self.k, f"only {len(self.commands)} git commands ran, so the {self.k}th did not"
        return self.commands[self.k - 1]

    def __enter__(self) -> NthGitCall:
        self.patch.__enter__()
        return self

    def __exit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        self.patch.__exit__(kind, error, trace)
