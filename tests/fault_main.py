"""Runs the hook's main with one step after the reset made to raise: `python fault_main.py STEP ERROR`, with the event on stdin as the host sends it. STEP is a key of STEPS, a function of the checkpoint module that runs after the reset, and ERROR a key of ERRORS.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import unittest.mock

import checkpoint
import engine

RESET_COMMAND = ["git", "reset", "--hard", "HEAD"]
DECODE_FAILURE = ("utf-8", b"\xff", 0, 1, "invalid start byte")


ERRORS = {
    "TypeError": TypeError("injected"),
    "ValueError": ValueError("injected"),
    "UnicodeDecodeError": UnicodeDecodeError(*DECODE_FAILURE),
    "KeyError": KeyError("injected"),
    "AssertionError": AssertionError("injected"),
    "OSError": OSError("injected"),
}
OTHER_UNEXPECTED = {
    "RuntimeError": RuntimeError("injected"),
    "AttributeError": AttributeError("injected"),
    "ZeroDivisionError": ZeroDivisionError("injected"),
    "IndexError": IndexError("injected"),
    "NameError": NameError("injected"),
    "SubprocessError": subprocess.SubprocessError("injected"),
}
NOT_CONVERTED = {"KeyboardInterrupt": KeyboardInterrupt(), "MemoryError": MemoryError(), "SystemExit(1)": SystemExit(1), "SystemExit(0)": SystemExit(0)}
SIGNALS = {"SIGTERM": signal.SIGTERM}
STEPS = {"remove_untracked": checkpoint.remove_untracked, "uncommitted": checkpoint.uncommitted, "has_commit": checkpoint.has_commit}


def main(step: str, error: str) -> None:
    ran = {"reset": False}
    real_run, real_step = subprocess.run, STEPS[step]

    def tracked_run(argv: list[str], *arguments: object, **options: object) -> subprocess.CompletedProcess[bytes]:
        result = real_run(argv, *arguments, **options)
        ran["reset"] = ran["reset"] or argv[:4] == RESET_COMMAND
        return result

    def failing_step(*arguments: object, **options: object) -> object:
        if ran["reset"] and error in SIGNALS:
            os.kill(os.getpid(), SIGNALS[error])
        if ran["reset"]:
            raise {**ERRORS, **OTHER_UNEXPECTED, **NOT_CONVERTED}[error]
        return real_step(*arguments, **options)

    sys.argv = [sys.argv[0]]
    with unittest.mock.patch.object(subprocess, "run", tracked_run), unittest.mock.patch.object(checkpoint, step, failing_step):
        engine.main()


if __name__ == "__main__":
    main(*sys.argv[1:])
