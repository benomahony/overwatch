"""Tests that what git says of HEAD is read once per decision, and that a failed read is told as one, never as a detached HEAD or one off a branch; and that no function of the engine makes two reads of one fact without a reason on this list.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import ast
import collections
import unittest
from collections.abc import Callable
from pathlib import Path

import paths
import checkpoint
import repository_state
from checkpoint_repository import RepositoryCase, git, put
from git_faults import FAULTS, TIMES_OUT, NthGitCall

COULD_NOT_TELL = "git could not tell what HEAD names"
OFF_BRANCH_WORDS = ("not on a branch", "detached")
GIT_READERS = frozenset({"has_commit", "head_ref", "off_branch", "current_branch", "is_clean", "uncommitted", "staged_changes", "dirty_submodules",
                         "nested_repositories", "operation_in_progress", "submodules", "unwatched_edits"})
TWO_READS_OF_ONE_FACT = {
    ("checkpoint.py", "checkpoint", "has_commit"): "the first read decides whether the branch check applies, the second whether there is a HEAD to remember; a failure of either raises and commits nothing",
    ("checkpoint.py", "revert", "has_commit"): "the first read refuses a repository with no commit, the second asserts after the reset that the commit is still there; they ask at different times on purpose",
    ("checkpoint_command.py", "revert_answer", "uncommitted"): "the first asks whether the tree differs from HEAD before the revert, the second asserts after it that nothing differs; they ask at different times on purpose",
    ("checkpoint.py", "revert", "uncommitted"): "the first lists what the revert saves and discards, the second lists what is left after the reset; they ask at different times on purpose",
}


class HeadReadTests(RepositoryCase):
    def setUp(self) -> None:
        super().setUp()
        self.head = git(self.repo, ["rev-parse", "HEAD"]).strip()

    def make_the_checkpoint_dirty(self) -> None:
        git(self.repo, ["reset", "-q", "--hard", self.head])
        git(self.repo, ["clean", "-fdq"])
        put(self.repo / "new.txt", "new\n")

    def reasons_with_the_kth_git_command_failing(self, ask: Callable[[], object], fault: str, prepare: Callable[[], None] = lambda: None) -> list[tuple[str, str]]:
        """For each git command the question runs, what it answers when that command fails, or the error it raises. prepare runs before each question."""
        prepare()
        with NthGitCall(None, TIMES_OUT) as counting:
            ask()
        answers = []
        for k in range(1, len(counting.commands) + 1):
            prepare()
            with NthGitCall(k, fault) as failing:
                try:
                    answer = str(ask())
                except checkpoint.CheckpointError as error:
                    answer = str(error)
                answers.append((" ".join(failing.failed_command()), answer))
        return answers

    def test_a_failed_read_of_the_state_never_says_head_is_off_a_branch_while_it_is_on_one(self) -> None:
        for fault in FAULTS:
            for command, answer in self.reasons_with_the_kth_git_command_failing(lambda: checkpoint.unavailable_reason(self.repo), fault):
                with self.subTest(fault=fault, failing=command):
                    self.assertFalse(any(word in answer for word in OFF_BRANCH_WORDS), f"HEAD is on main, and with `{command}` failing the answer was {answer!r}")
                    self.assertEqual(COULD_NOT_TELL in answer, "symbolic-ref" in command, f"with `{command}` failing the answer was {answer!r}")

    def test_a_failed_read_before_a_checkpoint_never_says_head_is_off_a_branch_while_it_is_on_one(self) -> None:
        for fault in FAULTS:
            for command, answer in self.reasons_with_the_kth_git_command_failing(lambda: checkpoint.checkpoint(self.repo), fault, self.make_the_checkpoint_dirty):
                with self.subTest(fault=fault, failing=command):
                    self.assertFalse(any(word in answer for word in OFF_BRANCH_WORDS), f"HEAD is on main, and with `{command}` failing the answer was {answer!r}")

    def test_a_head_that_git_says_is_detached_is_told_detached(self) -> None:
        git(self.repo, ["checkout", "-q", "--detach"])
        self.assertEqual(repository_state.off_branch(self.repo), "HEAD is detached", "a detached HEAD was not told")
        self.assertIn("HEAD is detached", checkpoint.unavailable_reason(self.repo) or "", "the reason does not say HEAD is detached")

    def test_a_head_on_a_branch_has_no_off_branch_sentence_and_a_failed_read_raises_instead_of_answering_detached(self) -> None:
        self.assertIsNone(repository_state.off_branch(self.repo), "a HEAD on main was told off a branch")
        for fault in FAULTS:
            with NthGitCall(1, fault):
                with self.assertRaises(checkpoint.CheckpointError, msg=f"a read of HEAD that {fault} was answered") as raised:
                    repository_state.head_ref(self.repo)
            self.assertIn(COULD_NOT_TELL, str(raised.exception), f"the failure of the read does not say git could not tell: {raised.exception}")


def calls_per_function(source: Path) -> dict[str, collections.Counter[str]]:
    counts: dict[str, collections.Counter[str]] = {}
    for function in (node for node in ast.walk(ast.parse(source.read_text())) if isinstance(node, ast.FunctionDef)):
        calls = (node.func for node in ast.walk(function) if isinstance(node, ast.Call))
        names = [call.id if isinstance(call, ast.Name) else call.attr for call in calls if isinstance(call, (ast.Name, ast.Attribute))]
        counts[function.name] = collections.Counter(name for name in names if name in GIT_READERS)
    return counts


class ClassCheckTests(unittest.TestCase):
    def test_a_function_that_reads_one_fact_of_git_twice_is_on_the_list_with_its_reason(self) -> None:
        found = set()
        for source in sorted((paths.ROOT / "engine").glob("*.py")):
            for function, counts in calls_per_function(source).items():
                found |= {(source.name, function, reader) for reader, count in counts.items() if count > 1}
        self.assertEqual(found, set(TWO_READS_OF_ONE_FACT), "a function reads a fact of git twice without a reason on the list, or the list names a function that no longer does")

    def test_no_function_asks_for_the_branch_twice(self) -> None:
        for source in sorted((paths.ROOT / "engine").glob("*.py")):
            for function, counts in calls_per_function(source).items():
                asked = counts["off_branch"] + counts["current_branch"] + counts["head_ref"]
                self.assertLessEqual(asked, 1, f"{source.name}:{function} reads HEAD's branch {asked} times")


if __name__ == "__main__":
    unittest.main()
