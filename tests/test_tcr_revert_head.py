"""Tests that the event after a TCR revert reads no HEAD move that did not happen, whatever committed while the checks ran.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import unittest

import test_tcr
from checkpoint_repository import git, isolate_git, restore_git
from codex_hook import CodexHook, read, write
from test_tcr import EDITING, FAILING, PASSING

COMMIT_DURING_THE_CHECKS = """
import subprocess
flag = Path({flag!r})
if "FAIL" in Path({result!r}).read_text() and not flag.exists():
    flag.write_text("done")
    subprocess.run(["git", "-C", {repo!r}, "-c", "user.name=person", "-c", "user.email=person@example.com", "-c", "commit.gpgsign=false",
                    "-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "-m", "a person's commit"], check=True)
"""
PERSON_COMMIT = "a person's commit"
GIT_STEP_THAT_BRINGS_IN_NOTHING = {"command": "git merge --no-edit HEAD"}


class RevertThenNextEventTests(CodexHook):
    set_setting = test_tcr.TcrHookTests.set_setting
    start = test_tcr.TcrHookTests.start
    subjects = test_tcr.TcrHookTests.subjects
    context = test_tcr.TcrHookTests.context

    def setUp(self) -> None:
        self.addCleanup(restore_git, isolate_git())
        CodexHook.setUp(self)
        assert (self.cwd / ".git").is_dir(), f"{self.cwd} is no repository for the hook to work in"
        assert self.data.is_dir(), f"{self.data} is no data directory for the hook's state"

    def commit_during_the_checks(self) -> None:
        runner = self.cwd / "check.py"
        text = read(runner)
        flag = self.cwd.parent / "committed.flag"
        write(runner, text + COMMIT_DURING_THE_CHECKS.format(flag=str(flag), result=str(self.cwd / "result.txt"), repo=str(self.cwd)), text)
        assert PERSON_COMMIT in read(runner), f"{runner} does not commit while it runs"
        assert not flag.exists(), f"{flag} exists before the check ran"

    def revert_a_failure(self) -> None:
        result = self.start()
        write(result, FAILING, PASSING)
        reverted = self.context(self.call("PostToolUse", **EDITING)[0])
        assert "reverted" in reverted, f"the failure was not reverted: {reverted!r}"
        assert read(result) == PASSING, f"{result} holds {read(result)!r} after the revert"

    def fail_again_in_a_git_step(self) -> str:
        write(self.cwd / "result.txt", FAILING, PASSING)
        told = self.context(self.call("PostToolUse", **EDITING, tool_input=GIT_STEP_THAT_BRINGS_IN_NOTHING)[0])
        assert told, "the hook told nothing about a step that failed again"
        assert self.cwd.joinpath("result.txt").exists(), "result.txt is gone"
        return told

    def test_a_step_after_a_revert_judges_its_failure_as_the_agents_own(self) -> None:
        self.revert_a_failure()
        told = self.fail_again_in_a_git_step()
        self.assertIn("reverted", told)
        self.assertEqual(read(self.cwd / "result.txt"), PASSING)
        self.assertEqual(self.subjects(), ["start"])

    def test_a_commit_made_while_the_checks_ran_leaves_the_next_step_judging_its_failure(self) -> None:
        self.start()
        self.commit_during_the_checks()
        write(self.cwd / "result.txt", FAILING, PASSING)
        reverted = self.context(self.call("PostToolUse", **EDITING)[0])
        self.assertIn("reverted", reverted)
        self.assertEqual(self.subjects()[0], PERSON_COMMIT)
        told = self.fail_again_in_a_git_step()
        self.assertIn("reverted", told)
        self.assertEqual(read(self.cwd / "result.txt"), PASSING)
        self.assertEqual(git(self.cwd, ["status", "--porcelain"]), "")


if __name__ == "__main__":
    unittest.main()
