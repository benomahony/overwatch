"""Tests that a revert that a bug stopped is told as a bug, and not as a failure of git: for a bug before the reset ran, and for a bug in the listing of the files after it.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import contextlib
import io
import subprocess
import unittest
import unittest.mock
from collections.abc import Iterator
from pathlib import Path

import paths
import checkpoint
import test_tcr_revert_faults as faults
from bugs import BUG_ADVICE
from tcr_hardening_case import HardeningCase
from test_tcr import EDITING

GIT_FAILED = "and git failed"
STOPPED_ON_A_BUG = "stopped on a bug"
LISTING_FAILED = "Git could not list the files now"


class BugNoticeTests(HardeningCase):
    with_a_staged_copy = False

    start_a_revert = faults.RevertFaultTests.start_a_revert

    @contextlib.contextmanager
    def bug_in_the_listing_after(self, injected: faults.Fault) -> Iterator[None]:
        listed = checkpoint.uncommitted

        def raises_once_the_reset_was_tried(root: Path) -> list[str]:
            if injected.reset_ran:
                raise AssertionError("injected into the listing")
            return listed(root)

        with (unittest.mock.patch.object(subprocess, "run", injected.runner()), unittest.mock.patch.object(checkpoint, "uncommitted", raises_once_the_reset_was_tried),
              contextlib.redirect_stderr(io.StringIO())):
            yield

    def test_a_bug_that_stops_the_reset_before_it_ran_is_told_as_a_bug_and_not_as_a_git_failure(self) -> None:
        self.start_a_revert()
        real = subprocess.run

        def raises_at_the_reset(argv: list[str], *arguments: object, **options: object) -> subprocess.CompletedProcess[bytes]:
            if argv[:4] == faults.RESET_COMMAND:
                raise AssertionError("injected into the reset")
            return real(argv, *arguments, **options)

        with unittest.mock.patch.object(subprocess, "run", raises_at_the_reset), contextlib.redirect_stderr(io.StringIO()):
            told = self.context(self.call_here("PostToolUse", **EDITING))
        self.assertIn(STOPPED_ON_A_BUG, told, "a bug was not told as one")
        self.assertIn(BUG_ADVICE, told, "the notice does not say to report the bug")
        self.assertNotIn(GIT_FAILED, told, "a bug was told as a failure of git")
        self.assertNotIn("TCR reverted", told, "a reset that never ran was told as a revert")

    def test_a_bug_in_the_listing_after_a_reset_git_refused_is_told_as_a_bug_and_not_as_a_listing_git_could_not_make(self) -> None:
        self.start_a_revert()
        injected = faults.Fault(self.cwd, faults.REFUSED)
        with self.bug_in_the_listing_after(injected):
            told = self.context(self.call_here("PostToolUse", **EDITING))
        self.assertIn(BUG_ADVICE, told, "a bug in the listing was not told as one")
        self.assertNotIn(LISTING_FAILED, told, "a bug in the listing was told as a failure of git")

    def test_a_bug_in_the_listing_after_a_reset_that_succeeded_is_told_as_a_revert_and_as_a_bug_in_the_listing(self) -> None:
        self.start_a_revert()
        with self.bug_in_the_listing_after(faults.Fault(self.cwd, faults.NORMAL)):
            told = self.context(self.call_here("PostToolUse", **EDITING))
        self.assertIn("TCR reverted", told, "a reset that succeeded was not told as a revert")
        self.assertIn(BUG_ADVICE, told, "a bug in the listing was not told as one")
        self.assertTrue(paths.ROOT.is_dir(), f"{paths.ROOT} is no directory")


if __name__ == "__main__":
    unittest.main()
