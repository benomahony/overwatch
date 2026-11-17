"""Tests of what the checkpoint and the revert say about a repository: whether TCR can start in it, and the submodules and nested repositories in it.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import unittest
from pathlib import Path

from checkpoint_repository import UNFINISHED, RepositoryCase, clear_marker, git, make_dir, present, put
import checkpoint
from codex_hook import read


class RepositoryStateTests(RepositoryCase):
    def test_a_merge_in_progress_is_neither_committed_nor_reverted(self) -> None:
        self.start_a_conflicting_merge()
        with self.assertRaises(checkpoint.CheckpointError) as raised:
            checkpoint.revert(self.repo)
        self.assertIn("merge", str(raised.exception))
        self.assertTrue(present(self.repo / ".git" / "MERGE_HEAD"))
        self.assertIn("<<<<<<<", read(self.repo / "a.txt"))
        with self.assertRaises(checkpoint.CheckpointError):
            checkpoint.checkpoint(self.repo)
        self.assertTrue(present(self.repo / ".git" / "MERGE_HEAD"))

    def test_an_untracked_nested_repository_is_not_committed_and_survives_a_revert(self) -> None:
        make_dir(self.repo / "nested")
        git(self.repo / "nested", ["init", "-q", "-b", "main"])
        put(self.repo / "nested" / "f.txt", "x\n")
        git(self.repo / "nested", ["add", "-A"])
        git(self.repo / "nested", ["commit", "-q", "-m", "inner"])
        put(self.repo / "agent_new.py", "y\n")
        before = git(self.repo, ["rev-parse", "HEAD"])
        with self.assertRaises(checkpoint.CheckpointError) as raised:
            checkpoint.checkpoint(self.repo)
        self.assertIn("empty link", str(raised.exception))
        self.assertEqual(git(self.repo, ["rev-parse", "HEAD"]), before)
        checkpoint.revert(self.repo)
        self.assertFalse(present(self.repo / "agent_new.py"))
        self.assertTrue(present(self.repo / "nested" / "f.txt"))

    def test_tcr_is_available_only_on_a_clean_branch_with_nothing_in_progress(self) -> None:
        self.assertIsNone(checkpoint.unavailable_reason(self.repo))
        put(self.repo / "a.txt", "edited\n")
        self.assertIn("uncommitted", checkpoint.unavailable_reason(self.repo) or "")
        git(self.repo, ["checkout", "-q", "--", "a.txt"])
        git(self.repo, ["checkout", "-q", "--detach"])
        self.assertIn("detached", checkpoint.unavailable_reason(self.repo) or "")
        git(self.repo, ["checkout", "-q", "main"])
        self.start_a_conflicting_merge()
        self.assertIn("merge", checkpoint.unavailable_reason(self.repo) or "")

    def test_every_unfinished_operation_is_refused_by_name(self) -> None:
        """For each marker git leaves while a merge, rebase, cherry-pick, revert or bisect is unfinished, TCR is
        unavailable and names that operation, and a checkpoint and a revert both refuse and keep the work."""
        for marker, name in UNFINISHED.items():
            location = self.repo / ".git" / marker
            if marker.startswith("rebase"):
                make_dir(location)
            else:
                put(location, "x\n")
            with self.subTest(marker=marker):
                self.assertIn(name, checkpoint.unavailable_reason(self.repo) or "")
                put(self.repo / "a.txt", "work in the middle of " + name + "\n")
                with self.assertRaises(checkpoint.CheckpointError):
                    checkpoint.checkpoint(self.repo)
                with self.assertRaises(checkpoint.CheckpointError):
                    checkpoint.revert(self.repo)
                self.assertEqual(read(self.repo / "a.txt"), "work in the middle of " + name + "\n")
            clear_marker(location)
            git(self.repo, ["checkout", "-q", "--", "a.txt"])

    def test_tcr_is_unavailable_in_a_repository_with_no_commit(self) -> None:
        git(Path(self.outside.name), ["init", "-q", "-b", "main"])
        self.assertIn("no commit", checkpoint.unavailable_reason(Path(self.outside.name)) or "")

    def test_tcr_is_unavailable_while_an_untracked_nested_repository_is_present(self) -> None:
        make_dir(self.repo / "nested")
        git(self.repo / "nested", ["init", "-q"])
        put(self.repo / "nested" / "f.txt", "x\n")
        self.assertIn("nested", checkpoint.unavailable_reason(self.repo) or "")

    def test_the_submodules_that_hold_changes_are_listed_by_path(self) -> None:
        source = Path(self.outside.name)
        git(source, ["init", "-q", "-b", "main"])
        put(source / "s.txt", "inner\n")
        git(source, ["add", "-A"])
        git(source, ["commit", "-q", "-m", "inner"])
        git(self.repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", str(source), "libs"])
        git(self.repo, ["commit", "-q", "-m", "add the submodule"])
        self.assertEqual(checkpoint.dirty_submodules(self.repo), [])
        put(self.repo / "libs" / "new.txt", "inside\n")
        put(self.repo / "a.txt", "broken\n")
        self.assertEqual(checkpoint.dirty_submodules(self.repo), ["libs"])
        checkpoint.revert(self.repo)
        self.assertEqual(checkpoint.dirty_submodules(self.repo), ["libs"])

    def test_a_directory_outside_a_git_tree_is_refused(self) -> None:
        with self.assertRaises(checkpoint.CheckpointError):
            checkpoint.is_clean(Path(self.outside.name))


if __name__ == "__main__":
    unittest.main()
