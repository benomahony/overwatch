"""What counts as a bug in the engine, as opposed to a failure it expects, and how one is reported.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import subprocess
import sys
import traceback

ENGINE_BUGS = (AssertionError, AttributeError, ArithmeticError, LookupError, NameError, RuntimeError)
TOLD_UNEXPECTED = (ValueError, TypeError, KeyError, subprocess.SubprocessError)
UNEXPECTED_ERRORS = (*ENGINE_BUGS, *TOLD_UNEXPECTED)
BUG_ADVICE = "this is a bug, report it"


def report_bug(error: BaseException) -> None:
    """Writes the traceback of an unexpected error of the engine to stderr, where the host logs it."""
    assert isinstance(error, UNEXPECTED_ERRORS), f"{type(error).__name__} is no bug the engine reports; a failure it expects is told another way"
    assert error.__traceback__ is not None, f"{error!r} was never raised, so it has no traceback to report"
    traceback.print_exception(error, file=sys.stderr)
