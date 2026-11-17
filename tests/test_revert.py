"""Tests of the TCR revert: what it restores and removes, the copy it saves first, and what it leaves alone, run against real git repositories.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import os
import unittest
import unittest.mock
from pathlib import Path

from checkpoint_repository import RepositoryCase, git, make_dir, present, put, remove, restore_git, set_environment, set_mode
import checkpoint
import saved_revert
from codex_hook import read


class RevertTests(RepositoryCase):
    def test_a_revert_restores_tracked_files_and_removes_new_ones_but_keeps_ignored_ones(self) -> None:
        put(self.repo / "a.txt", "broken\n")
        put(self.repo / "agent_new.py", "x\n")
        make_dir(self.repo / "pkg")
        put(self.repo / "pkg" / "m.py", "y\n")
        checkpoint.revert(self.repo)
        self.assertEqual(read(self.repo / "a.txt"), "base\n")
        self.assertFalse(present(self.repo / "agent_new.py"))
        self.assertFalse(present(self.repo / "pkg"))
        self.assertEqual(read(self.repo / "keep.log"), "ignored\n")
        self.assertEqual(git(self.repo, ["status", "--porcelain"]), "")

    def revert_leaves_head_and_index(self, save_ref: bool) -> str | None:
        """Discards work, reverts it, and checks that HEAD, the index listing and the status are as a clean tree has
        them; returns the ref the work was saved to."""
        self.discard_work()
        head, listing = git(self.repo, ["rev-parse", "HEAD"]), git(self.repo, ["ls-files", "-s"])
        saved = checkpoint.revert(self.repo, save_ref=save_ref)
        assert git(self.repo, ["rev-parse", "HEAD"]) == head, f"the revert moved HEAD from {head}"
        assert git(self.repo, ["ls-files", "-s"]) == listing, f"the revert changed the index listing {listing!r}"
        assert git(self.repo, ["status", "--porcelain"]) == "", f"the tree is not clean after the revert: {git(self.repo, ['status', '--porcelain'])!r}"
        return saved

    def test_a_revert_that_saves_keeps_the_discarded_work_in_a_ref_without_touching_head_or_the_index(self) -> None:
        self.discard_work()
        head = git(self.repo, ["rev-parse", "HEAD"])
        saved = checkpoint.revert(self.repo, save_ref=True)
        self.assertIsNotNone(saved)
        self.assertTrue(saved.startswith("refs/overwatch/reverted/"), saved)
        self.assertEqual(git(self.repo, ["rev-parse", "HEAD"]), head)
        self.assertEqual(git(self.repo, ["rev-parse", f"{saved}^"]), head)
        self.assertEqual(git(self.repo, ["show", f"{saved}:a.txt"]), "broken")
        self.assertEqual(git(self.repo, ["show", f"{saved}:agent_new.py"]), "x")
        self.assertEqual(git(self.repo, ["show", f"{saved}:pkg/m.py"]), "y")
        self.assertNotIn("b.txt", git(self.repo, ["ls-tree", "-r", "--name-only", saved]).split())
        self.assertNotIn("keep.log", git(self.repo, ["ls-tree", "-r", "--name-only", saved]).split())

    def test_a_revert_that_saves_leaves_head_the_index_and_the_tree_as_a_revert_that_does_not(self) -> None:
        self.assertIsNotNone(self.revert_leaves_head_and_index(save_ref=True))
        self.assertEqual(read(self.repo / "keep.log"), "ignored\n")

    def test_a_revert_that_does_not_save_makes_no_ref(self) -> None:
        self.assertIsNone(self.revert_leaves_head_and_index(save_ref=False))
        self.assertEqual(git(self.repo, ["for-each-ref", "refs/overwatch"]), "")
        self.assertEqual(read(self.repo / "keep.log"), "ignored\n")

    def test_a_revert_saves_by_default(self) -> None:
        self.discard_work()
        self.assertIsNotNone(checkpoint.revert(self.repo))
        self.assertEqual(len(git(self.repo, ["for-each-ref", "refs/overwatch/reverted"]).splitlines()), 1)

    def test_the_saved_ref_restores_the_work_with_one_checkout(self) -> None:
        self.discard_work()
        saved = checkpoint.revert(self.repo, save_ref=True)
        git(self.repo, ["checkout", saved, "--", "."])
        self.assertEqual(read(self.repo / "a.txt"), "broken\n")
        self.assertEqual(read(self.repo / "agent_new.py"), "x\n")
        self.assertEqual(read(self.repo / "pkg" / "m.py"), "y\n")

    def parents_of(self, ref: str) -> list[str]:
        return git(self.repo, ["rev-list", "--parents", "-n", "1", ref]).split()[1:]

    def test_a_version_staged_in_the_index_and_overwritten_in_the_tree_is_kept_in_the_saved_ref(self) -> None:
        put(self.repo / "a.txt", "staged\n")
        git(self.repo, ["add", "a.txt"])
        put(self.repo / "a.txt", "later\n")
        saved = checkpoint.revert(self.repo)
        self.assertEqual(git(self.repo, ["show", f"{saved}:a.txt"]), "later")
        self.assertEqual(len(self.parents_of(saved)), 2)
        self.assertEqual(git(self.repo, ["show", f"{saved}^2:a.txt"]), "staged")
        self.assertEqual(git(self.repo, ["rev-parse", f"{saved}^"]), git(self.repo, ["rev-parse", "HEAD"]))
        self.assertEqual(read(self.repo / "a.txt"), "base\n")

    def test_a_staged_new_file_that_is_gone_from_the_tree_is_kept_in_the_saved_ref(self) -> None:
        put(self.repo / "staged_new.py", "staged only\n")
        git(self.repo, ["add", "staged_new.py"])
        remove(self.repo / "staged_new.py")
        saved = checkpoint.revert(self.repo)
        self.assertEqual(git(self.repo, ["show", f"{saved}^2:staged_new.py"]), "staged only")

    def test_a_revert_saves_a_staged_change_even_when_the_tree_matches_the_latest_commit(self) -> None:
        put(self.repo / "a.txt", "staged\n")
        git(self.repo, ["add", "a.txt"])
        put(self.repo / "a.txt", "base\n")
        saved = checkpoint.revert(self.repo)
        self.assertIsNotNone(saved)
        self.assertEqual(git(self.repo, ["show", f"{saved}^2:a.txt"]), "staged")
        self.assertEqual(git(self.repo, ["diff", "--cached", "--name-only"]), "")

    def test_a_saved_ref_has_one_parent_when_the_index_adds_nothing_to_the_tree(self) -> None:
        self.discard_work()
        self.assertEqual(len(self.parents_of(checkpoint.revert(self.repo))), 1)
        put(self.repo / "a.txt", "same in both\n")
        git(self.repo, ["add", "a.txt"])
        self.assertEqual(len(self.parents_of(checkpoint.revert(self.repo))), 1)

    def test_a_staged_version_that_changes_while_the_work_is_saved_is_saved_as_it_changed(self) -> None:
        self.discard_work()
        edits: list[str] = []

        def stage_another_version() -> None:
            if not edits:
                edits.append("staged")
                put(self.repo / "a.txt", "staged during the save\n")
                git(self.repo, ["add", "a.txt"])
                put(self.repo / "a.txt", "broken\n")

        saved = checkpoint.revert(self.repo, after_save=stage_another_version)
        self.assertEqual(git(self.repo, ["show", f"{saved}^2:a.txt"]), "staged during the save")

    def test_a_revert_saves_the_work_in_a_repository_where_git_knows_no_identity(self) -> None:
        self.discard_work()
        no_guessing = {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "user.useConfigOnly", "GIT_CONFIG_VALUE_0": "true", "HOME": self.outside.name}
        without_identity = {name: value for name, value in os.environ.items() if not name.startswith(("GIT_AUTHOR_", "GIT_COMMITTER_"))} | no_guessing
        with unittest.mock.patch.dict(os.environ, without_identity, clear=True):
            saved = checkpoint.revert(self.repo, save_ref=True)
        self.assertEqual(read(self.repo / "a.txt"), "base\n")
        git(self.repo, ["checkout", saved, "--", "."])
        self.assertEqual(read(self.repo / "a.txt"), "broken\n")
        self.assertEqual(read(self.repo / "agent_new.py"), "x\n")
        self.assertEqual(git(self.repo, ["log", "-1", "--format=%an <%ae>", saved]), "overwatch <overwatch@localhost>")

    def test_a_saved_commit_keeps_the_identity_git_knows(self) -> None:
        self.discard_work()
        saved = checkpoint.revert(self.repo, save_ref=True)
        self.assertEqual(git(self.repo, ["log", "-1", "--format=%an", saved]), "t")

    def test_a_revert_that_cannot_save_changes_nothing(self) -> None:
        self.discard_work()
        put(self.repo / ".git" / "refs" / "overwatch", "a file where the refs directory should be\n")
        with self.assertRaises(checkpoint.CheckpointError):
            checkpoint.revert(self.repo, save_ref=True)
        self.assertEqual(read(self.repo / "a.txt"), "broken\n")
        self.assertEqual(read(self.repo / "agent_new.py"), "x\n")
        self.assertEqual(read(self.repo / "pkg" / "m.py"), "y\n")

    def test_a_file_written_after_the_snapshot_and_before_the_reset_is_in_the_saved_ref(self) -> None:
        self.discard_work()
        written: list[str] = []

        def write_late_file() -> None:
            assert not present(self.repo / "late.txt") or written, f"the late file was in {self.repo} before the seam wrote it"
            if not written:
                written.append("late.txt")
                put(self.repo / "late.txt", "written while the work was saved\n")
            assert present(self.repo / "late.txt"), f"the seam did not write the late file in {self.repo}"

        saved = checkpoint.revert(self.repo, after_save=write_late_file)
        self.assertEqual(git(self.repo, ["show", f"{saved}:late.txt"]), "written while the work was saved")
        self.assertEqual(git(self.repo, ["show", f"{saved}:a.txt"]), "broken")
        self.assertFalse(present(self.repo / "late.txt"))
        self.assertEqual(git(self.repo, ["status", "--porcelain"]), "")

    def test_a_file_written_after_the_last_listing_survives_the_revert_and_is_reported_as_left(self) -> None:
        """A revert removes only the untracked files it listed last, so a file written after that stays and is named as left."""
        self.discard_work()
        written: list[str] = []

        def write_after_the_last_listing() -> None:
            assert not written, f"the seam before the discard ran twice in {self.repo}"
            written.append("late.txt")
            put(self.repo / "late.txt", "written after the listing\n")
            make_dir(self.repo / "late_dir")
            put(self.repo / "late_dir" / "inner.txt", "inside a new directory\n")
            assert present(self.repo / "late.txt") and present(self.repo / "late_dir" / "inner.txt"), f"the seam wrote no late files in {self.repo}"

        with self.assertRaises(checkpoint.CheckpointError) as caught:
            checkpoint.revert(self.repo, before_discard=write_after_the_last_listing)
        self.assertIn("late.txt", str(caught.exception))
        self.assertIn("left", str(caught.exception))
        self.assertEqual(read(self.repo / "late.txt"), "written after the listing\n")
        self.assertEqual(read(self.repo / "late_dir" / "inner.txt"), "inside a new directory\n")
        self.assertEqual(read(self.repo / "a.txt"), "base\n")
        self.assertFalse(present(self.repo / "agent_new.py"))
        saved = git(self.repo, ["for-each-ref", "--format=%(refname)", "refs/overwatch/reverted"])
        self.assertNotIn("late.txt", git(self.repo, ["ls-tree", "-r", "--name-only", saved]))

    def test_a_revert_without_saving_also_keeps_a_file_written_after_the_listing(self) -> None:
        self.discard_work()
        with self.assertRaises(checkpoint.CheckpointError):
            checkpoint.revert(self.repo, save_ref=False, before_discard=lambda: put(self.repo / "late.txt", "late\n"))
        self.assertEqual(read(self.repo / "late.txt"), "late\n")
        self.assertFalse(present(self.repo / "agent_new.py"))

    def test_a_revert_removes_the_directories_of_the_files_it_removed_but_not_a_directory_with_other_files(self) -> None:
        make_dir(self.repo / "new_dir" / "deep")
        put(self.repo / "new_dir" / "deep" / "one.txt", "x\n")
        checkpoint.revert(self.repo)
        self.assertFalse(present(self.repo / "new_dir"))
        make_dir(self.repo / "kept_dir")
        put(self.repo / "kept_dir" / "ignored.log", "ignored\n")
        put(self.repo / "kept_dir" / "two.txt", "x\n")
        checkpoint.revert(self.repo)
        self.assertTrue(present(self.repo / "kept_dir" / "ignored.log"))
        self.assertFalse(present(self.repo / "kept_dir" / "two.txt"))

    def test_a_file_changed_after_the_snapshot_is_saved_as_it_was_changed(self) -> None:
        self.discard_work()
        edits: list[str] = []

        def change_a_discarded_file() -> None:
            assert present(self.repo / "agent_new.py"), f"the file to change was not in {self.repo}"
            if not edits:
                edits.append("changed")
                put(self.repo / "agent_new.py", "changed while the work was saved\n")
            assert len(edits) == 1, f"the file was changed {len(edits)} times, not once"

        saved = checkpoint.revert(self.repo, after_save=change_a_discarded_file)
        self.assertEqual(git(self.repo, ["show", f"{saved}:agent_new.py"]), "changed while the work was saved")

    def test_a_revert_deletes_nothing_when_files_keep_changing_while_the_work_is_saved(self) -> None:
        self.discard_work()
        counter = [0]

        def write_another_file() -> None:
            counter[0] += 1
            put(self.repo / f"flood{counter[0]}.txt", "again\n")
            assert present(self.repo / f"flood{counter[0]}.txt"), f"the seam did not write flood{counter[0]}.txt"
            assert counter[0] <= checkpoint.MAX_SAVE_ATTEMPTS, f"the revert tried {counter[0]} times, more than {checkpoint.MAX_SAVE_ATTEMPTS}"

        with self.assertRaises(checkpoint.CheckpointError) as caught:
            checkpoint.revert(self.repo, after_save=write_another_file)
        self.assertIn("kept changing", str(caught.exception))
        self.assertEqual(read(self.repo / "a.txt"), "broken\n")
        self.assertEqual(read(self.repo / "agent_new.py"), "x\n")
        self.assertTrue(all(present(self.repo / f"flood{number}.txt") for number in range(1, counter[0] + 1)))
        self.assertEqual(git(self.repo, ["for-each-ref", "refs/overwatch"]), "")

    def test_a_git_command_that_fails_while_the_work_is_saved_leaves_no_ref_and_discards_nothing(self) -> None:
        self.discard_work()
        listings = [0]
        listed = checkpoint.uncommitted

        def fail_the_second_listing(root: Path) -> list[str]:
            listings[0] += 1
            assert root.resolve() == self.repo.resolve(), f"the listing was asked for {root}, not {self.repo}"
            assert listings[0] <= checkpoint.MAX_SAVE_ATTEMPTS + 2, f"{listings[0]} listings were asked for after a failure on the second"
            if listings[0] == 2:
                raise checkpoint.CheckpointError("git took longer than 30 seconds")
            return listed(root)

        with (unittest.mock.patch.object(checkpoint, "uncommitted", fail_the_second_listing),
              unittest.mock.patch.object(saved_revert, "uncommitted", fail_the_second_listing),
              self.assertRaises(checkpoint.CheckpointError) as caught):
            checkpoint.revert(self.repo)
        self.assertIn("took longer", str(caught.exception))
        self.assertEqual(git(self.repo, ["for-each-ref", "refs/overwatch"]), "")
        self.assertEqual(read(self.repo / "a.txt"), "broken\n")
        self.assertEqual(read(self.repo / "agent_new.py"), "x\n")

    def test_a_revert_that_saves_nothing_new_makes_one_ref_and_tells_the_seam_once_per_check(self) -> None:
        self.discard_work()
        calls = [0]

        def count() -> None:
            calls[0] += 1
            assert calls[0] == 1, f"the seam ran {calls[0]} times for work that did not change"
            assert present(self.repo / "a.txt"), f"the discarded work is gone from {self.repo} before the seam ran"

        checkpoint.revert(self.repo, after_save=count)
        self.assertEqual(calls[0], 1)
        self.assertEqual(len(git(self.repo, ["for-each-ref", "refs/overwatch/reverted"]).splitlines()), 1)

    def test_two_reverts_in_a_row_keep_two_refs(self) -> None:
        put(self.repo / "a.txt", "first\n")
        first = checkpoint.revert(self.repo, save_ref=True)
        put(self.repo / "a.txt", "second\n")
        second = checkpoint.revert(self.repo, save_ref=True)
        self.assertNotEqual(first, second)
        self.assertEqual(git(self.repo, ["show", f"{first}:a.txt"]), "first")
        self.assertEqual(git(self.repo, ["show", f"{second}:a.txt"]), "second")

    def test_a_revert_goes_back_to_the_latest_checkpoint_not_to_the_start(self) -> None:
        put(self.repo / "a.txt", "green\n")
        checkpoint.checkpoint(self.repo)
        put(self.repo / "a.txt", "red\n")
        checkpoint.revert(self.repo)
        self.assertEqual(read(self.repo / "a.txt"), "green\n")

    def test_a_revert_from_a_subdirectory_cleans_the_whole_repository(self) -> None:
        make_dir(self.repo / "sub")
        put(self.repo / "sub" / "kept.txt", "tracked\n")
        git(self.repo, ["add", "-A"])
        git(self.repo, ["commit", "-q", "-m", "add sub"])
        put(self.repo / "root_new.txt", "x\n")
        put(self.repo / "sub" / "sub_new.txt", "x\n")
        checkpoint.revert(self.repo / "sub")
        self.assertFalse(present(self.repo / "root_new.txt"))
        self.assertFalse(present(self.repo / "sub" / "sub_new.txt"))
        self.assertEqual(git(self.repo, ["status", "--porcelain"]), "")

    def test_a_revert_with_no_commit_to_restore_changes_nothing(self) -> None:
        root = Path(self.outside.name)
        git(root, ["init", "-q", "-b", "main"])
        put(root / "a.txt", "work\n")
        with self.assertRaises(checkpoint.CheckpointError) as raised:
            checkpoint.revert(root)
        self.assertIn("no commit", str(raised.exception))
        self.assertEqual(read(root / "a.txt"), "work\n")

    def test_a_revert_leaves_edits_inside_a_submodule_alone_and_does_not_fail(self) -> None:
        """A checkpoint cannot commit what is inside a submodule, so a revert restores the repository around it and
        leaves the submodule's own files as they are, without raising after it has already changed the rest."""
        source = Path(self.outside.name)
        git(source, ["init", "-q", "-b", "main"])
        put(source / "s.txt", "inner\n")
        git(source, ["add", "-A"])
        git(source, ["commit", "-q", "-m", "inner"])
        git(self.repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", str(source), "libs"])
        git(self.repo, ["commit", "-q", "-m", "add the submodule"])
        put(self.repo / "libs" / "s.txt", "changed inside\n")
        put(self.repo / "a.txt", "broken\n")
        put(self.repo / "agent_new.py", "x\n")
        checkpoint.revert(self.repo)
        self.assertEqual(read(self.repo / "a.txt"), "base\n")
        self.assertFalse(present(self.repo / "agent_new.py"))
        self.assertEqual(read(self.repo / "libs" / "s.txt"), "changed inside\n")

    def test_git_location_variables_in_the_environment_do_not_redirect_a_revert(self) -> None:
        """A GIT_DIR left in the environment, as git sets it for its own hooks, must not make a revert in one
        repository act on another."""
        other = Path(self.outside.name)
        git(other, ["init", "-q", "-b", "main"])
        put(other / "o.txt", "other\n")
        git(other, ["add", "-A"])
        git(other, ["commit", "-q", "-m", "other"])
        put(self.repo / "a.txt", "broken\n")
        self.addCleanup(restore_git, set_environment({"GIT_DIR": str(other / ".git")}))
        checkpoint.revert(self.repo)
        self.assertEqual(read(self.repo / "a.txt"), "base\n")
        self.assertEqual(read(other / "o.txt"), "other\n")

    def test_an_unreadable_directory_stops_a_revert_before_it_changes_anything(self) -> None:
        put(self.repo / "a.txt", "dirty\n")
        make_dir(self.repo / "u")
        put(self.repo / "u" / "f.txt", "x\n")
        set_mode(self.repo / "u", 0)
        self.addCleanup(set_mode, self.repo / "u", 0o755)
        with self.assertRaises(checkpoint.CheckpointError):
            checkpoint.revert(self.repo)
        self.assertEqual(read(self.repo / "a.txt"), "dirty\n")


if __name__ == "__main__":
    unittest.main()
