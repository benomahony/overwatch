"""Tests of what the engine tells the agent about a failing check.
Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""

from __future__ import annotations

from pathlib import Path
import unittest

import paths
from messages import failure_message, report_key
from records import Report

assert paths.ROOT.is_dir(), f"{paths.ROOT} is not the repository; import paths to put engine/ on the import path"

TESTMON = "uv run --with pytest --with pytest-watcher --with pytest-testmon ptw . --testmon"
TIMING_OUTPUT = (
    "FAILED tests/test_web.py::test_responds_within_limit_ms\n"
    "E       AssertionError: / took 87ms (limit: 50ms)\n"
    "1 failed, 4 passed in 0.31s\n"
)
TESTMON_HINT = ("This looks like a timing test, and `--testmon` traces every call in watch mode, so it runs slower than it "
                "would alone. If the code is no slower, mark timing tests and keep them out of the watcher with "
                "`-m \"not performance\"` in `watchers.python.argv` in .overwatch.json.")
LOG = Path("/home/me/.cache/overwatch/logs/python.log")


def python_report(command: str, text: str) -> Report:
    """A failing python report of one new test failure, run as command, whose output is text."""
    return Report(name="python", language="python", command=command, dir=None, summary="1 failed, 4 passed in 0.31s",
                  failed=True, failures=("tests/test_web.py::test_responds_within_limit_ms",), environment=None, text=text)


def message_for(report: Report) -> str:
    """The failure message for report alone, with nothing failing at the session's start."""
    return failure_message([report], {}, {report_key(report): LOG})


class FailureMessageTests(unittest.TestCase):
    def test_a_timing_failure_under_testmon_says_testmon_slows_it_and_how_to_keep_it_out_of_the_watcher(self) -> None:
        message = message_for(python_report(TESTMON, TIMING_OUTPUT))
        self.assertIn("Fix these new failures before finishing.", message)
        self.assertIn(TESTMON_HINT, message)
        self.assertTrue(message.endswith(f"Full output: `{LOG}`"), message)

    def test_a_timing_failure_without_testmon_gets_no_testmon_hint(self) -> None:
        message = message_for(python_report("uv run pytest", TIMING_OUTPUT))
        self.assertNotIn("timing test", message)

    def test_a_failure_under_testmon_that_times_nothing_gets_no_hint(self) -> None:
        message = message_for(python_report(TESTMON, "E       assert 3 == 4\n1 failed, 4 passed in 0.31s\n"))
        self.assertNotIn("timing test", message)


if __name__ == "__main__":
    unittest.main()
