"""Tests that a data directory or a project directory named with a line break, and a summary with a hiding character, cannot start a line of what the hook tells the agent or the host.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import unittest
from dataclasses import replace

import paths
import messages
from checkpoint_repository import make_dir, make_parent
from codex_hook import CodexHook, write
from hostile_builders import report_with

FORGED_DATA = "overwatch: FORGED-DATA"
BIDIRECTIONAL_OVERRIDE = "\u202e"


def starts_a_line(text: str) -> bool:
    return any(line.startswith(FORGED_DATA) for line in text.splitlines())


class HostileDataDirectoryTests(CodexHook):
    def setUp(self) -> None:
        super().setUp()
        self.data = self.data / f"d\n{FORGED_DATA}"
        make_dir(self.data)

    def test_a_data_directory_named_with_a_line_break_cannot_start_a_line_of_the_inherited_backlog_notice(self) -> None:
        _, started, _ = self.start_legacy_session()
        told = started["hookSpecificOutput"]["additionalContext"]
        self.assertIn("inherited backlog", told, "the session start did not tell the backlog")
        self.assertFalse(starts_a_line(told), f"a data directory name started a line of the notice: {told!r}")


class HostileProjectDirectoryTests(CodexHook):
    def setUp(self) -> None:
        super().setUp()
        hostile = self.cwd.parent / f"p\n{FORGED_DATA}" / "project"
        make_parent(hostile)
        self.cwd.rename(hostile)
        self.cwd = hostile

    def test_a_project_directory_named_with_a_line_break_cannot_start_a_line_of_the_error_the_hook_tells(self) -> None:
        write(self.cwd / ".overwatch.json", "{")
        told = self.call("SessionStart")[0]["systemMessage"]
        self.assertTrue(told.startswith("overwatch: could not read "), f"the hook told another error: {told!r}")
        self.assertFalse(starts_a_line(told), f"a directory name started a line of the error: {told!r}")


class GateReasonTests(unittest.TestCase):
    def test_a_summary_with_a_bidirectional_override_is_written_as_an_escape_in_the_reason_that_guards_an_action(self) -> None:
        reason = messages.gate_reason([replace(report_with("check"), summary=f"1 failed{BIDIRECTIONAL_OVERRIDE}ok")])
        self.assertNotIn(BIDIRECTIONAL_OVERRIDE, reason, "the guard reason carries the override raw")
        self.assertTrue(paths.ROOT.is_dir(), f"{paths.ROOT} is no directory")


if __name__ == "__main__":
    unittest.main()
