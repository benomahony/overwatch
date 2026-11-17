"""Tests of the files that git is told not to watch, with `assume-unchanged` or `skip-worktree`: an edit to one is not in `git status`, so TCR must see it itself, whether it changes the content, the mode or the kind of file.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

from pathlib import Path

from checkpoint_repository import RepositoryCase, git, link, make_dir, mode_of, present, put, remove, set_mode
import checkpoint
from codex_hook import read

FLAGS = ("assume-unchanged", "skip-worktree")
EXECUTABLE = 0o755
OUTSIDE_TARGET = "../outside"


class UnwatchedEditTests(RepositoryCase):
    def flag(self, name: str, flag: str = "assume-unchanged") -> None:
        git(self.repo, ["update-index", f"--{flag}", name])

    def assert_edit_is_seen(self, name: str, other: str) -> None:
        put(self.repo / other, "x\n")
        reason = checkpoint.unavailable_reason(self.repo, dirty_ok=True)
        self.assertIn(name, str(reason))
        with self.assertRaises(checkpoint.CheckpointError) as caught:
            checkpoint.revert(self.repo)
        self.assertIn(name, str(caught.exception))
        self.assertFalse(git(self.repo, ["for-each-ref", "refs/overwatch"]))

    def test_a_file_git_is_told_not_to_watch_makes_a_revert_refuse(self) -> None:
        for flag in FLAGS:
            with self.subTest(flag=flag):
                self.flag("a.txt", flag)
                put(self.repo / "a.txt", "a person's edit\n")
                self.assert_edit_is_seen("a.txt", f"other-{flag}.txt")
                self.assertEqual(read(self.repo / "a.txt"), "a person's edit\n")
                git(self.repo, ["update-index", f"--no-{flag}", "a.txt"])
                git(self.repo, ["checkout", "--", "a.txt"])
                remove(self.repo / f"other-{flag}.txt")

    def test_a_flagged_file_that_equals_the_latest_commit_is_no_reason(self) -> None:
        self.flag("a.txt")
        self.assertIsNone(checkpoint.unavailable_reason(self.repo))

    def test_a_flagged_file_that_is_not_in_the_work_tree_is_no_reason(self) -> None:
        self.flag("a.txt")
        remove(self.repo / "a.txt")
        self.assertIsNone(checkpoint.unavailable_reason(self.repo, dirty_ok=True))

    def test_a_changed_mode_on_a_flagged_file_makes_a_revert_refuse(self) -> None:
        self.flag("a.txt")
        set_mode(self.repo / "a.txt", EXECUTABLE)
        self.assertEqual(git(self.repo, ["status", "--porcelain"]), "")
        self.assert_edit_is_seen("a.txt", "other.txt")
        self.assertEqual(mode_of(self.repo / "a.txt"), EXECUTABLE)

    def test_a_changed_mode_is_no_reason_when_git_is_told_to_ignore_modes(self) -> None:
        git(self.repo, ["config", "core.fileMode", "false"])
        self.flag("a.txt")
        set_mode(self.repo / "a.txt", EXECUTABLE)
        self.assertIsNone(checkpoint.unavailable_reason(self.repo))

    def test_a_flagged_file_replaced_by_a_dangling_link_makes_a_revert_refuse(self) -> None:
        self.flag("a.txt")
        remove(self.repo / "a.txt")
        link(self.repo / "a.txt", OUTSIDE_TARGET)
        self.assert_edit_is_seen("a.txt", "other.txt")
        self.assertTrue((self.repo / "a.txt").is_symlink())

    def test_a_flagged_file_replaced_by_a_link_to_a_file_makes_a_revert_refuse(self) -> None:
        put(self.repo / "b.txt", "b\n")
        git(self.repo, ["add", "b.txt"])
        git(self.repo, ["commit", "-q", "-m", "b"])
        self.flag("a.txt")
        remove(self.repo / "a.txt")
        link(self.repo / "a.txt", "b.txt")
        self.assert_edit_is_seen("a.txt", "other.txt")
        self.assertTrue((self.repo / "a.txt").is_symlink())

    def test_a_flagged_file_replaced_by_a_directory_makes_a_revert_refuse(self) -> None:
        self.flag("a.txt")
        remove(self.repo / "a.txt")
        make_dir(self.repo / "a.txt")
        put(self.repo / "a.txt" / "inner.txt", "kept\n")
        self.assert_edit_is_seen("a.txt", "other.txt")
        self.assertEqual(read(self.repo / "a.txt" / "inner.txt"), "kept\n")

    def test_a_flagged_link_that_equals_the_committed_one_is_no_reason(self) -> None:
        link(self.repo / "pointer", "a.txt")
        git(self.repo, ["add", "pointer"])
        git(self.repo, ["commit", "-q", "-m", "pointer"])
        self.flag("pointer")
        self.assertIsNone(checkpoint.unavailable_reason(self.repo))

    def test_a_flagged_link_that_names_another_target_makes_a_revert_refuse(self) -> None:
        link(self.repo / "pointer", "a.txt")
        git(self.repo, ["add", "pointer"])
        git(self.repo, ["commit", "-q", "-m", "pointer"])
        self.flag("pointer")
        remove(self.repo / "pointer")
        link(self.repo / "pointer", OUTSIDE_TARGET)
        self.assert_edit_is_seen("pointer", "other.txt")
        self.assertEqual((self.repo / "pointer").readlink(), Path(OUTSIDE_TARGET))

    def test_a_checkpoint_refuses_while_a_flagged_file_differs_from_the_latest_commit(self) -> None:
        self.flag("a.txt")
        put(self.repo / "a.txt", "a person's edit\n")
        put(self.repo / "other.txt", "x\n")
        head = git(self.repo, ["rev-parse", "HEAD"])
        with self.assertRaises(checkpoint.CheckpointError) as caught:
            checkpoint.checkpoint(self.repo)
        self.assertIn("a.txt", str(caught.exception))
        self.assertEqual(git(self.repo, ["rev-parse", "HEAD"]), head)
        self.assertEqual(git(self.repo, ["diff", "--cached", "--name-only"]), "")
        self.assertTrue(present(self.repo / "other.txt"))
