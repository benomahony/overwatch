"""What counts as a bug in the engine, as opposed to a failure it expects, and how one is reported.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import subprocess

ENGINE_BUGS = (AssertionError, AttributeError, ArithmeticError, LookupError, NameError, RuntimeError)
TOLD_UNEXPECTED = (ValueError, TypeError, KeyError, subprocess.SubprocessError)
UNEXPECTED_ERRORS = (*ENGINE_BUGS, *TOLD_UNEXPECTED)
BUG_ADVICE = "this is a bug, report it"

