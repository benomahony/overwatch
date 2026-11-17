"""Tests of four decisions of TCR that the replay of the model's schedules leaves unchecked: each has a mutant that the
replay and the other TCR tests let survive.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

import paths
import engine
import tcr
import workspace
from codex_hook import CodexHook, read, write
from checkpoint_repository import git, isolate_git, make_dir, put, restore_git
import test_tcr
import tcr_hardening_case as hardening
from test_tcr import EDITING, PASSING
from tcr_hardening_case import FAILING_GO

HELD_NOTICE = "TCR held the edit"
STALE_COMMIT = "0" * 40


class DecisionTests(CodexHook):
    setUp = hardening.HardeningCase.setUp
    set_setting = hardening.HardeningCase.set_setting
    start_a_python_project = hardening.HardeningCase.start_a_python_project
    add_go_check = hardening.HardeningCase.add_go_check
    edit = hardening.HardeningCase.edit
    subjects = hardening.HardeningCase.subjects
    context = hardening.HardeningCase.context

    def remove_mode(self) -> None:
        settings = self.cwd / ".overwatch.json"
        text = read(settings)
        without = {name: value for name, value in json.loads(text).items() if name != "mode"}
        write(settings, json.dumps(without), text)
        assert "mode" not in json.loads(read(settings)), f"{settings} still sets the mode"
        assert settings.exists(), f"{settings} is gone after the write"

    def test_an_editing_step_that_changed_no_file_does_not_tell_a_held_edit_again(self) -> None:
        self.start_a_python_project()
        held = self.add_go_check(FAILING_GO, 1)
        self.assertIn(HELD_NOTICE, self.context(held))
        unchanged, _ = self.call("PostToolUse", **EDITING)
        self.assertNotIn(HELD_NOTICE, self.context(unchanged))
        self.assertEqual(self.subjects(), ["start"])

    def test_a_held_check_is_forgotten_when_the_mode_goes_off_and_comes_back(self) -> None:
        self.start_a_python_project()
        self.add_go_check(FAILING_GO, 1)
        self.remove_mode()
        gone, _ = self.call("PostToolUse", **EDITING)
        self.assertIn("TCR is off", self.context(gone))
        git(self.cwd, ["add", "-A"])
        git(self.cwd, ["commit", "-q", "-m", "the person commits what was held"])
        self.set_setting("mode", "tcr")
        git(self.cwd, ["add", "-A"])
        git(self.cwd, ["commit", "-q", "-m", "the person turns TCR on"])
        resumed, _ = self.call("UserPromptSubmit")
        self.assertIn("TCR is on", self.context(resumed))
        again = self.edit("second.txt")
        self.assertNotIn(HELD_NOTICE, self.context(again))
        self.assertIn("TCR reverted", self.context(again))
        self.assertFalse((self.cwd / "second.txt").exists())

    def test_an_edit_that_changes_no_content_makes_no_commit_and_leaves_the_state_as_it_was(self) -> None:
        result = self.start()
        put(result, PASSING)
        os.utime(result, ns=(result.stat().st_atime_ns, result.stat().st_mtime_ns + 1))
        output, _ = self.call("PostToolUse", **EDITING)
        self.assertEqual(self.subjects(), ["start"])
        self.assertNotIn("checkpoint", str(output))
        self.assertEqual(git(self.cwd, ["status", "--porcelain"]), "")

    start = test_tcr.TcrHookTests.start


class RevertRefreshesTheHeadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.addCleanup(restore_git, isolate_git())
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.repo = self.root / "repo"
        make_dir(self.repo)
        git(self.repo, ["init", "-q"])
        put(self.repo / "a.txt", "base\n")
        git(self.repo, ["add", "-A"])
        git(self.repo, ["commit", "-q", "-m", "base"])
        put(self.repo / "a.txt", "edited\n")
        self.data = self.root / "data"
        make_dir(self.data)
        assert git(self.repo, ["status", "--porcelain"]) == "M a.txt", f"{self.repo} holds {git(self.repo, ['status', '--porcelain'])!r}, not one edited file"
        assert self.data.is_dir() and self.data.parent == self.repo.parent, f"{self.data} is not the data directory next to {self.repo}"

    def test_the_state_after_a_revert_holds_the_commit_the_repository_is_at(self) -> None:
        failing = engine.Report("fixture", "project", "fixture", None, "failed", True, ("a",), None, "FAIL")
        event = engine.Event("PostToolUse", "revert-head", str(self.repo), "Edit", {})
        stale = engine.State(head=STALE_COMMIT, tcr="active")
        with engine.locked(engine.state_path(event, self.repo, self.data), self.data) as session:
            turn = tcr.Turn(event, self.repo, session, {"mode": "tcr"}, edited=True)
            step = tcr.reverted(turn, stale, [failing], save_reverted=False)
        self.assertEqual(step.state.head, workspace.commit_of(self.repo))
        self.assertNotEqual(step.state.head, STALE_COMMIT)
        self.assertEqual(git(self.repo, ["status", "--porcelain"]), "")


if __name__ == "__main__":
    unittest.main()
