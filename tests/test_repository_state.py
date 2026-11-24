"""Tests of what the checkpoint and the revert say about a repository: whether TCR can start in it, and the submodules and nested repositories in it.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import contextlib
import io
import subprocess
import unittest
from pathlib import Path

from checkpoint_repository import UNFINISHED, RepositoryCase, clear_marker, git, make_dir, present, put, put_bytes
import checkpoint
import repository_state
import tcr
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

    def test_a_head_that_names_a_remote_branch_is_not_on_a_branch_and_tcr_is_unavailable(self) -> None:
        """A symbolic HEAD at a ref outside refs/heads is no branch: a checkpoint made there would belong to none."""
        git(self.repo, ["update-ref", "refs/remotes/origin/main", "HEAD"])
        git(self.repo, ["symbolic-ref", "HEAD", "refs/remotes/origin/main"])
        self.assertIsNotNone(repository_state.off_branch(self.repo), "a remote branch was taken for a branch")
        self.assertIsNone(repository_state.current_branch(self.repo), "a remote branch was named as the current branch")
        reason = checkpoint.unavailable_reason(self.repo) or ""
        self.assertIn("HEAD is not on a branch (it names `refs/remotes/origin/main`)", reason, "TCR is available on a HEAD that names no branch, or the reason does not name the ref")
        self.assertNotIn("detached", reason, "a HEAD that names a ref is called detached")
        with self.assertRaises(checkpoint.CheckpointError, msg="a checkpoint was made on a HEAD that names no branch") as raised:
            checkpoint.checkpoint(self.repo)
        self.assertIn("HEAD is not on a branch (it names `refs/remotes/origin/main`)", str(raised.exception), "the refusal does not name the ref")
        self.assertNotIn("detached", str(raised.exception), "the refusal calls a HEAD that names a ref detached")

    def test_a_head_that_names_a_ref_with_quotes_and_backticks_is_refused_and_named_with_its_backtick_escaped(self) -> None:
        ref = "refs/remotes/o`x\"y'z"
        git(self.repo, ["update-ref", ref, "HEAD"])
        git(self.repo, ["symbolic-ref", "HEAD", ref])
        self.assertIn("(it names `refs/remotes/o\\x60x\"y'z`)", checkpoint.unavailable_reason(self.repo) or "", "the reason leaves out a ref with quotes and backticks, or leaves its backtick unescaped")

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

    def stop_a_sequence_on_a_conflict(self, operation: str) -> None:
        """Starts a cherry-pick or revert of two commits that stops on a conflict in a.txt, which the person then resolves
        and commits, leaving the second step of the sequence undone."""
        git(self.repo, ["checkout", "-q", "-b", "other"])
        put(self.repo / "a.txt", "first\n")
        git(self.repo, ["commit", "-qam", "first"])
        put(self.repo / "b.txt", "second\n")
        git(self.repo, ["add", "b.txt"])
        git(self.repo, ["commit", "-qm", "second"])
        if operation == "cherry-pick":
            git(self.repo, ["checkout", "-q", "main"])
            put(self.repo / "a.txt", "main\n")
            git(self.repo, ["commit", "-qam", "main"])
            steps = ["other~1", "other"]
        else:
            put(self.repo / "a.txt", "later\n")
            git(self.repo, ["commit", "-qam", "later"])
            steps = ["other~2", "other~1"]
        subprocess.run(["git", "-C", str(self.repo), operation, *steps], capture_output=True, text=True, check=False)
        assert present(self.repo / ".git" / "sequencer"), f"the {operation} of {steps} in {self.repo} did not leave a sequence"
        put(self.repo / "a.txt", "resolved\n")
        git(self.repo, ["add", "a.txt"])
        git(self.repo, ["commit", "-q", "--no-edit"])
        assert not any(present(self.repo / ".git" / marker) for marker in ("CHERRY_PICK_HEAD", "REVERT_HEAD")), f"the {operation} step in {self.repo} is still open"
        assert present(self.repo / ".git" / "sequencer"), f"the sequence of the {operation} ended with the committed step"

    def work_in_a_stopped_sequence(self, operation: str) -> str:
        """Stops a sequence of operation between steps, writes c.txt in it, and returns what TCR says about the repository."""
        self.stop_a_sequence_on_a_conflict(operation)
        put(self.repo / "c.txt", "work in the middle of the sequence\n")
        return checkpoint.unavailable_reason(self.repo) or ""

    def test_a_cherry_pick_stopped_between_steps_is_refused_by_name(self) -> None:
        self.assertIn("a cherry-pick is in progress", self.work_in_a_stopped_sequence("cherry-pick"))
        with self.assertRaises(checkpoint.CheckpointError):
            checkpoint.checkpoint(self.repo)
        with self.assertRaises(checkpoint.CheckpointError):
            checkpoint.revert(self.repo)
        self.assertEqual(read(self.repo / "c.txt"), "work in the middle of the sequence\n")

    def test_a_revert_stopped_between_steps_is_refused_by_name(self) -> None:
        self.assertIn("a revert is in progress", self.work_in_a_stopped_sequence("revert"))
        with self.assertRaises(checkpoint.CheckpointError):
            checkpoint.checkpoint(self.repo)
        with self.assertRaises(checkpoint.CheckpointError):
            checkpoint.revert(self.repo)
        self.assertEqual(read(self.repo / "c.txt"), "work in the middle of the sequence\n")

    def test_a_sequencer_todo_with_a_subject_that_is_not_utf8_still_names_the_operation(self) -> None:
        make_dir(self.repo / ".git" / "sequencer")
        put_bytes(self.repo / ".git" / "sequencer" / "todo", b"pick abc1234 caf\xe9 subject\n")
        self.assertIn("a cherry-pick is in progress", checkpoint.unavailable_reason(self.repo) or "")

    def test_a_sequencer_left_with_no_todo_says_how_to_clear_it(self) -> None:
        make_dir(self.repo / ".git" / "sequencer")
        reason = checkpoint.unavailable_reason(self.repo) or ""
        self.assertIn("a cherry-pick or revert is in progress", reason)
        self.assertIn("`git cherry-pick --quit`", reason)
        self.assertIn("`git revert --quit`", reason)

    def test_a_stopped_cherry_pick_says_to_finish_it_or_quit_it(self) -> None:
        reason = self.work_in_a_stopped_sequence("cherry-pick")
        self.assertIn("a cherry-pick is in progress", reason)
        self.assertIn("`git cherry-pick --quit`", reason)
        self.assertNotIn("`git revert --quit`", reason)

    def test_tcr_is_unavailable_in_a_repository_with_no_commit(self) -> None:
        git(Path(self.outside.name), ["init", "-q", "-b", "main"])
        self.assertIn("no commit", checkpoint.unavailable_reason(Path(self.outside.name)) or "")

    def test_tcr_is_unavailable_while_an_untracked_nested_repository_is_present(self) -> None:
        make_dir(self.repo / "nested")
        git(self.repo / "nested", ["init", "-q"])
        put(self.repo / "nested" / "f.txt", "x\n")
        self.assertIn("nested", checkpoint.unavailable_reason(self.repo) or "")

    def add_a_submodule(self) -> None:
        """Commits a submodule at libs, made from a repository outside this one."""
        source = Path(self.outside.name)
        git(source, ["init", "-q", "-b", "main"])
        put(source / "s.txt", "inner\n")
        git(source, ["add", "-A"])
        git(source, ["commit", "-q", "-m", "inner"])
        git(self.repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", str(source), "libs"])
        git(self.repo, ["commit", "-q", "-m", "add the submodule"])
        assert checkpoint.unavailable_reason(self.repo) is None, f"{self.repo} is not available to TCR after its submodule was added"

    def test_a_dirty_submodule_is_named_in_the_reason_tcr_is_unavailable(self) -> None:
        self.add_a_submodule()
        put(self.repo / "libs" / "new.txt", "inside\n")
        self.assertEqual(checkpoint.uncommitted(self.repo), [])
        self.assertIn("libs", checkpoint.unavailable_reason(self.repo) or "")

    def test_the_submodules_that_hold_changes_are_listed_by_path(self) -> None:
        self.add_a_submodule()
        self.assertEqual(checkpoint.dirty_submodules(self.repo), [])
        put(self.repo / "libs" / "new.txt", "inside\n")
        put(self.repo / "a.txt", "broken\n")
        self.assertEqual(checkpoint.dirty_submodules(self.repo), ["libs"])
        checkpoint.revert(self.repo)
        self.assertEqual(checkpoint.dirty_submodules(self.repo), ["libs"])

    def test_no_reader_that_lists_paths_lists_one_twice_for_a_file_staged_as_deleted_and_present_again(self) -> None:
        git(self.repo, ["rm", "-q", "--cached", "a.txt"])
        put(self.repo / "a.txt", "edited\n")
        put(self.repo / "new.txt", "new\n")
        make_dir(self.repo / "nested")
        git(self.repo / "nested", ["init", "-q", "-b", "main"])
        reads = {"uncommitted": repository_state.uncommitted, "nested_repositories": repository_state.nested_repositories, "submodules": repository_state.submodules,
                 "dirty_submodules": repository_state.dirty_submodules, "unwatched_edits": repository_state.unwatched_edits}
        readers = {name: read_paths(self.repo) for name, read_paths in reads.items()}
        self.assertIn("a.txt", readers["uncommitted"], "the file staged as deleted and present again was not listed as changed")
        for name, listed in readers.items():
            self.assertEqual(listed, list(dict.fromkeys(listed)), f"{name} lists a path twice: {listed}")

    def test_the_listing_made_after_a_failed_reset_answers_none_for_a_root_it_cannot_list_and_does_not_raise(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            gone = tcr.uncommitted_now(self.repo / "gone")
            relative = tcr.uncommitted_now(Path("relative"))
        self.assertEqual(gone, (None, False), "a root that is no directory was listed, or its absence was told as a bug")
        self.assertEqual(relative, (None, True), "a relative root was listed, or its use was not told as a bug")
        self.assertEqual(tcr.uncommitted_now(self.repo), ([], False), "a clean repository was not listed as empty")

    def test_a_directory_outside_a_git_tree_is_refused(self) -> None:
        with self.assertRaises(checkpoint.CheckpointError):
            checkpoint.is_clean(Path(self.outside.name))


if __name__ == "__main__":
    unittest.main()
