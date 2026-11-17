"""Tests of the edits TCR holds for want of an earlier result, when a hold ends, and what a check that timed out does.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import json
import os
import unittest
import unittest.mock

from checkpoint_repository import git, put
import records
from codex_hook import read, write
from tcr_hardening_case import FAILING_GO, FAILING_PYTEST, GO_MODULE, HardeningCase, PASSING_GO, PASSING_PYTEST, WORSE_GO


class HoldTests(HardeningCase):
    def test_a_failing_check_with_no_earlier_result_holds_the_edit_and_tells_the_agent(self) -> None:
        self.start_a_python_project()
        output = self.add_go_check(FAILING_GO, 1)
        self.assertEqual(self.subjects(), ["start"])
        self.assertEqual(read(self.cwd / "go.mod"), GO_MODULE)
        self.assertIn("TCR held the edit", self.context(output))
        self.assertIn("has no earlier result to compare with", self.context(output))
        self.assertIn("go failed", self.context(output))

    def test_a_held_edit_stays_held_while_the_new_check_fails_and_is_committed_when_it_passes(self) -> None:
        self.start_a_python_project()
        self.add_go_check(FAILING_GO, 1)
        again = self.edit("second.txt")
        self.assertEqual(self.subjects(), ["start"])
        self.assertIn("TCR held the edit", self.context(again))
        self.tool("gotestsum", PASSING_GO, 0, replacing=(FAILING_GO, 1))
        self.edit("third.txt")
        self.assertEqual(sorted(git(self.cwd, ["show", "--name-only", "--format=", "HEAD"]).split()), ["go.mod", "second.txt", "third.txt"])
        self.assertEqual(git(self.cwd, ["status", "--porcelain"]), "")

    def test_a_held_edit_survives_the_start_of_a_turn_and_the_next_passing_edit_commits_it(self) -> None:
        self.start_a_python_project()
        self.add_go_check(FAILING_GO, 1)
        next_turn, _ = self.call("UserPromptSubmit")
        self.assertNotIn("TCR is unavailable", self.context(next_turn))
        self.tool("gotestsum", PASSING_GO, 0, replacing=(FAILING_GO, 1))
        self.edit("second.txt")
        self.assertEqual(sorted(git(self.cwd, ["show", "--name-only", "--format=", "HEAD"]).split()), ["go.mod", "second.txt"])
        self.assertEqual(git(self.cwd, ["status", "--porcelain"]), "")

    def test_a_held_edit_does_not_survive_the_start_of_a_turn_when_a_person_changed_the_files(self) -> None:
        self.start_a_python_project()
        self.add_go_check(FAILING_GO, 1)
        write(self.cwd / "mine.txt", "mine\n")
        next_turn, _ = self.call("UserPromptSubmit")
        self.assertIn("TCR is unavailable", self.context(next_turn))
        self.tool("gotestsum", PASSING_GO, 0, replacing=(FAILING_GO, 1))
        self.edit("second.txt")
        self.assertEqual(self.subjects(), ["start"])

    def test_a_held_check_that_gets_worse_holds_the_edit_again_and_does_not_revert_it(self) -> None:
        self.start_a_python_project()
        self.add_go_check(FAILING_GO, 1)
        self.tool("gotestsum", WORSE_GO, 1, replacing=(FAILING_GO, 1))
        again = self.edit("second.txt")
        self.assertIn("TCR held the edit", self.context(again))
        self.assertNotIn("TCR reverted", self.context(again))
        self.assertEqual(read(self.cwd / "go.mod"), GO_MODULE)
        self.assertEqual(read(self.cwd / "second.txt"), "edit\n")
        self.assertEqual(self.subjects(), ["start"])

    def test_a_check_that_passed_after_being_held_reverts_a_later_failure(self) -> None:
        self.start_a_python_project()
        self.add_go_check(FAILING_GO, 1)
        self.tool("gotestsum", PASSING_GO, 0, replacing=(FAILING_GO, 1))
        self.edit("second.txt")
        self.tool("gotestsum", FAILING_GO, 1, replacing=(PASSING_GO, 0))
        reverted = self.edit("third.txt")
        self.assertFalse((self.cwd / "third.txt").exists())
        self.assertIn("TCR reverted", self.context(reverted))

    def test_a_known_regression_reverts_even_when_a_new_check_cannot_be_judged(self) -> None:
        self.start_a_python_project()
        self.tool("pytest", FAILING_PYTEST, 1, replacing=(PASSING_PYTEST, 0))
        reverted = self.add_go_check(FAILING_GO, 1)
        self.assertFalse((self.cwd / "go.mod").exists())
        self.assertEqual(self.subjects(), ["start"])
        self.assertIn("TCR reverted", self.context(reverted))

    def test_a_check_held_and_then_reverted_away_is_still_held_when_it_comes_back(self) -> None:
        self.start_a_python_project()
        self.tool("pytest", FAILING_PYTEST, 1, replacing=(PASSING_PYTEST, 0))
        self.add_go_check(FAILING_GO, 1)
        self.tool("pytest", PASSING_PYTEST, 0, replacing=(FAILING_PYTEST, 1))
        again = self.edit("go.mod")
        self.assertEqual(self.subjects(), ["start"])
        self.assertIn("TCR held the edit", self.context(again))

    def test_a_new_check_that_passes_does_not_hold_the_edit(self) -> None:
        self.start_a_python_project()
        self.add_go_check(PASSING_GO, 0)
        self.assertEqual(self.subjects()[0], "tcr: go.mod")

    def test_an_edit_held_while_another_check_is_held_resumes_at_the_next_turn_start(self) -> None:
        self.start_a_python_project()
        self.add_go_check(FAILING_GO, 1)
        self.tool("pytest", "error sending request for url", 1, replacing=(PASSING_PYTEST, 0))
        self.edit("second.txt")
        next_turn, _ = self.call("UserPromptSubmit")
        self.assertNotIn("TCR is unavailable", self.context(next_turn))
        self.tool("pytest", PASSING_PYTEST, 0, replacing=("error sending request for url", 1))
        self.tool("gotestsum", PASSING_GO, 0, replacing=(FAILING_GO, 1))
        self.edit("third.txt")
        self.assertEqual(sorted(git(self.cwd, ["show", "--name-only", "--format=", "HEAD"]).split()), ["go.mod", "second.txt", "third.txt"])

    def test_a_held_edit_whose_content_changed_with_the_same_size_and_time_does_not_resume(self) -> None:
        self.start_a_python_project()
        self.add_go_check(FAILING_GO, 1)
        held = self.cwd / "go.mod"
        stamp = held.stat()
        write(held, "module exampl3\n", GO_MODULE)
        os.utime(held, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        self.assertEqual((held.stat().st_size, held.stat().st_mtime_ns), (stamp.st_size, stamp.st_mtime_ns))
        next_turn, _ = self.call("UserPromptSubmit")
        self.assertIn("TCR is unavailable", self.context(next_turn))

    def test_a_check_that_outlives_its_deadline_holds_the_edit_and_reverts_nothing(self) -> None:
        self.start_a_python_project({"watchers": {"python": {"timeout": 1}}})
        self.make_pytest_hang()
        output = self.edit("slow.txt")
        self.assertEqual(self.subjects(), ["start"])
        self.assertEqual(read(self.cwd / "slow.txt"), "edit\n")
        self.assertIn("TCR held the edit", self.context(output))
        self.assertIn("outlived its deadline", self.context(output))
        self.assertNotIn("TCR reverted", self.context(output))

    def test_a_held_timeout_is_committed_with_the_edits_that_follow_once_the_check_passes(self) -> None:
        self.start_a_python_project({"watchers": {"python": {"timeout": 1}}})
        self.make_pytest_hang()
        self.edit("slow.txt")
        put(self.bin / "pytest", f"#!/bin/sh\necho '{PASSING_PYTEST}'\n")
        self.edit("second.txt")
        self.assertEqual(sorted(git(self.cwd, ["show", "--name-only", "--format=", "HEAD"]).split()), ["second.txt", "slow.txt"])
        self.assertEqual(git(self.cwd, ["status", "--porcelain"]), "")

    def test_a_new_failing_check_holds_the_edit_of_a_session_that_has_already_edited(self) -> None:
        self.start_a_python_project()
        self.edit("first.txt")
        self.assertEqual(self.subjects()[0], "tcr: first.txt")
        held = self.add_go_check(FAILING_GO, 1)
        self.assertIn("TCR held the edit", self.context(held))
        self.assertNotIn("TCR reverted", self.context(held))
        self.assertEqual(read(self.cwd / "go.mod"), GO_MODULE)
        again = self.edit("second.txt")
        self.assertIn("TCR held the edit", self.context(again))
        self.assertEqual(self.subjects()[0], "tcr: first.txt")

    def test_a_head_that_a_checkout_moved_clears_the_held_edit_so_the_next_turn_waits_for_a_clean_tree(self) -> None:
        self.start_a_python_project()
        self.add_go_check(FAILING_GO, 1)
        moved = git(self.cwd, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "elsewhere"])
        git(self.cwd, ["checkout", "-q", "-b", "side", moved])
        next_turn, _ = self.call("UserPromptSubmit")
        self.assertIn("TCR is unavailable", self.context(next_turn))
        self.assertIn("uncommitted changes", self.context(next_turn))

    def test_a_pull_through_the_agents_shell_ends_the_hold_of_an_edit_the_person_committed(self) -> None:
        self.start_a_python_project()
        self.add_go_check(FAILING_GO, 1)
        self.assertTrue(self.saved_state()["held"])
        self.commit("the person commits")
        self.call("UserPromptSubmit")
        self.assertTrue(self.saved_state()["held"])
        moved = git(self.cwd, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "a teammate's commit"])
        git(self.cwd, ["update-ref", "refs/heads/teammate", moved])
        git(self.cwd, ["merge", "-q", "--ff-only", "teammate"])
        output, _ = self.call("PostToolUse", tool_name="Bash", tool_input={"command": "git merge --ff-only teammate"})
        self.assertEqual(self.saved_state()["held"], [], f"the pull left the hold in place: {self.context(output)}")
        self.assertEqual(self.saved_state()["tcr"], "active")
        self.assertNotIn("TCR reverted", self.context(output))


class HeldChecksStateTests(unittest.TestCase):
    def test_the_checks_held_for_want_of_an_earlier_result_are_saved_and_read_back(self) -> None:
        state = records.State(held=("python\0", "go\0sub"), tcr="active", held_fingerprint="0123abcd")
        self.assertEqual(records.state_from(json.loads(json.dumps(records.state_json(state)))), state)

    def test_a_state_saved_before_held_existed_holds_no_checks(self) -> None:
        saved = records.state_json(records.State())
        del saved["held"]
        self.assertEqual(records.state_from(saved).held, ())

    def test_held_checks_that_are_not_text_make_the_state_unreadable(self) -> None:
        saved = records.state_json(records.State())
        saved["held"] = [1]
        with self.assertRaises(records.StateError):
            records.state_from(saved)


if __name__ == "__main__":
    unittest.main()
