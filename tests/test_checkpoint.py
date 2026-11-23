"""Tests of the TCR checkpoint: what it commits, how it names the commit, and what it refuses, run against real git repositories.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import json
import unittest

from checkpoint_repository import RepositoryCase, git, install_hook, make_dir, put, remove_fixture_file
from paths import ROOT
import checkpoint
from codex_hook import read
from workspace import is_committed


class CheckpointTests(RepositoryCase):
    def test_the_module_ships_inside_the_engine_directory(self) -> None:
        package = json.loads(read(ROOT / "package.json"))
        self.assertIn("engine", package["files"])
        self.assertTrue((ROOT / "engine" / "checkpoint.py").is_file())

    def test_a_clean_tree_is_clean(self) -> None:
        self.assertTrue(checkpoint.is_clean(self.repo))

    def test_an_edited_or_new_file_makes_the_tree_dirty_but_an_ignored_one_does_not(self) -> None:
        put(self.repo / "other.log", "ignored too\n")
        self.assertTrue(checkpoint.is_clean(self.repo))
        put(self.repo / "new.txt", "new\n")
        self.assertFalse(checkpoint.is_clean(self.repo))
        remove_fixture_file(self.repo / "new.txt")
        put(self.repo / "a.txt", "edited\n")
        self.assertFalse(checkpoint.is_clean(self.repo))

    def test_a_checkpoint_commits_every_file_that_is_not_ignored(self) -> None:
        put(self.repo / "a.txt", "edited\n")
        put(self.repo / "new.txt", "new\n")
        put(self.repo / "later.log", "ignored\n")
        sha = checkpoint.checkpoint(self.repo)
        self.assertEqual(sha, git(self.repo, ["rev-parse", "HEAD"]))
        self.assertEqual(git(self.repo, ["status", "--porcelain"]), "")
        self.assertEqual(git(self.repo, ["show", "--name-only", "--format=", "HEAD"]).split(), ["a.txt", "new.txt"])

    def test_the_checkpoint_message_names_the_files_it_changed(self) -> None:
        put(self.repo / "a.txt", "edited\n")
        put(self.repo / "new.txt", "new\n")
        checkpoint.checkpoint(self.repo)
        self.assertEqual(git(self.repo, ["log", "-1", "--format=%s"]), "tcr: a.txt, new.txt")

    def test_a_renamed_file_is_named_under_both_its_names_in_the_message(self) -> None:
        git(self.repo, ["mv", "a.txt", "renamed.txt"])
        checkpoint.checkpoint(self.repo)
        subject = git(self.repo, ["log", "-1", "--format=%s"])
        self.assertIn("a.txt", subject, "the message leaves out the name the file had")
        self.assertIn("renamed.txt", subject, "the message leaves out the name the file has")

    def test_a_long_list_of_files_is_cut_in_the_message(self) -> None:
        for index in range(checkpoint.MESSAGE_FILES + 3):
            put(self.repo / f"f{index:02}.txt", "x\n")
        checkpoint.checkpoint(self.repo)
        subject = git(self.repo, ["log", "-1", "--format=%s"])
        self.assertTrue(subject.startswith("tcr: f00.txt"), subject)
        self.assertTrue(subject.endswith("and 3 more"), subject)

    def test_a_checkpoint_with_nothing_to_commit_makes_no_commit(self) -> None:
        before = git(self.repo, ["rev-parse", "HEAD"])
        self.assertIsNone(checkpoint.checkpoint(self.repo))
        self.assertEqual(git(self.repo, ["rev-parse", "HEAD"]), before)

    def test_a_checkpoint_leaves_only_commit_entries_so_the_baseline_survives_it(self) -> None:
        before = git(self.repo, ["rev-parse", "HEAD"])
        put(self.repo / "a.txt", "edited\n")
        checkpoint.checkpoint(self.repo)
        self.assertEqual(git(self.repo, ["reflog", "-1", "--format=%gs"]).split(":")[0], "commit")
        self.assertTrue(is_committed(self.repo, before, git(self.repo, ["rev-parse", "HEAD"])))

    def test_a_commit_hook_that_refuses_raises_and_leaves_the_work_in_place(self) -> None:
        install_hook(self.repo, "pre-commit", "echo refused >&2\nexit 1")
        put(self.repo / "a.txt", "green work\n")
        before = git(self.repo, ["rev-parse", "HEAD"])
        with self.assertRaises(checkpoint.CheckpointError) as raised:
            checkpoint.checkpoint(self.repo)
        self.assertIn("refused", str(raised.exception))
        self.assertEqual(git(self.repo, ["rev-parse", "HEAD"]), before)
        self.assertEqual(read(self.repo / "a.txt"), "green work\n")

    def test_file_names_are_written_as_they_are_in_the_message(self) -> None:
        put(self.repo / "my file.txt", "x\n")
        put(self.repo / "\u00fcn\u00ef.txt", "x\n")
        checkpoint.checkpoint(self.repo)
        subject = git(self.repo, ["log", "-1", "--format=%s"])
        self.assertIn("my file.txt", subject)
        self.assertIn("\u00fcn\u00ef.txt", subject)
        self.assertNotIn("\\303", subject)

    def test_a_checkpoint_on_a_detached_head_is_refused_and_keeps_the_work(self) -> None:
        git(self.repo, ["checkout", "-q", "--detach"])
        put(self.repo / "a.txt", "edited on no branch\n")
        before = git(self.repo, ["rev-parse", "HEAD"])
        with self.assertRaises(checkpoint.CheckpointError) as raised:
            checkpoint.checkpoint(self.repo)
        self.assertIn("detached", str(raised.exception))
        self.assertEqual(git(self.repo, ["rev-parse", "HEAD"]), before)
        self.assertEqual(read(self.repo / "a.txt"), "edited on no branch\n")

    def test_a_nested_repository_below_an_untracked_directory_is_not_committed(self) -> None:
        make_dir(self.repo / "x" / "y")
        git(self.repo / "x" / "y", ["init", "-q", "-b", "main"])
        put(self.repo / "x" / "y" / "f.txt", "1\n")
        git(self.repo / "x" / "y", ["add", "-A"])
        git(self.repo / "x" / "y", ["commit", "-q", "-m", "inner"])
        self.assertIn("nested", checkpoint.unavailable_reason(self.repo) or "")
        with self.assertRaises(checkpoint.CheckpointError):
            checkpoint.checkpoint(self.repo)
        self.assertNotIn("160000", git(self.repo, ["ls-files", "--stage"]))

    def test_a_commit_message_hook_that_rewrites_the_subject_does_not_fail_the_checkpoint(self) -> None:
        install_hook(self.repo, "commit-msg", 'printf "[T-1] %s" "$(cat "$1")" > "$1"')
        put(self.repo / "b.txt", "x\n")
        put(self.repo / "trailing ", "y\n")
        sha = checkpoint.checkpoint(self.repo)
        self.assertEqual(sha, git(self.repo, ["rev-parse", "HEAD"]))
        self.assertTrue(git(self.repo, ["log", "-1", "--format=%s"]).startswith("[T-1] tcr: "))

    def test_commit_hooks_that_change_files_after_staging_are_reported_not_hidden(self) -> None:
        install_hook(self.repo, "pre-commit", "echo formatted >> a.txt")
        put(self.repo / "a.txt", "edited\n")
        before = git(self.repo, ["rev-parse", "HEAD"])
        with self.assertRaises(checkpoint.CheckpointError) as raised:
            checkpoint.checkpoint(self.repo)
        self.assertIn("hooks", str(raised.exception))
        self.assertNotEqual(git(self.repo, ["rev-parse", "HEAD"]), before)

    def test_a_tracked_file_name_that_is_not_utf8_does_not_break_the_checks(self) -> None:
        """Linux allows file names that are not valid UTF-8, and git lists them as the bytes they are. They must reach
        the caller as text it can print, not as a decoding error raised in the middle of a revert. The name goes into
        the index directly, since macOS cannot create such a file."""
        name = "bad\udcff"
        blob = git(self.repo, ["rev-parse", "HEAD:a.txt"])
        git(self.repo, ["update-index", "--add", "--cacheinfo", f"100644,{blob},{name}"])
        git(self.repo, ["commit", "-q", "-m", "a name that is not UTF-8"])
        self.assertIn(name, checkpoint.uncommitted(self.repo))
        self.assertIsInstance(checkpoint.unavailable_reason(self.repo), str)


if __name__ == "__main__":
    unittest.main()
