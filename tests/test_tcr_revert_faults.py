"""Tests that, whatever fails during a TCR revert, the notice says the work was reverted if and only if the work tree was reset, and names the ref that saved the work. Real git repositories, and every git command run after the revert starts failing in turn, the reset itself included.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import contextlib
import io
import re
import shutil
import subprocess
import tempfile
import unittest
import unittest.mock
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from checkpoint_repository import git, make_dir, put, rename_fixture_file, set_mode
import checkpoint
import paths
import tcr
from checkpoint_git import GIT_TIMEOUT, CheckpointError
from codex_hook import read, write
from git_faults import EXITS_WITH_AN_ERROR, NthGitCall
from test_tcr import EDITING
from tcr_hardening_case import FAILING_PYTEST, HardeningCase, PROJECT_FILE

RESET_COMMAND = ["git", "reset", "--hard", "HEAD"]
COMMANDS_BEFORE_THE_RESET = 52
READ_ONLY_DIRECTORY, WRITABLE_DIRECTORY = 0o555, 0o755
SOCKETS = "*.sock"
REAL_RUN = subprocess.run
EDITED_PROJECT_FILE = PROJECT_FILE + "# edited\n"
STAGED_VERSION = "staged\n"
LONG_FILE = "".join(f"line {number}\n" for number in range(20))
NORMAL, REFUSED, TIMES_OUT_BEFORE, TIMES_OUT_AFTER = "normal", "refused", "times out before", "times out after"
RESET_DONE, RESET_FAILED, RESET_UNKNOWN = "the reset succeeded", "the reset exited with an error", "nobody knows whether the reset ended"
STEPS_AFTER_THE_RESET = (("remove_untracked", checkpoint, checkpoint.remove_untracked), ("uncommitted", checkpoint, checkpoint.uncommitted), ("has_commit", checkpoint, checkpoint.has_commit))


class Fault:
    """What fails in a revert: the reset command, as git does when it refuses (a lock on the index) or times out, before
    or after it ran, and for kind NORMAL the command at position fail_at after the reset, which times out. It wraps
    subprocess.run, which every git command of the engine goes through, the workspace's own included."""

    def __init__(self, cwd: Path, kind: str, fail_at: int | None = None) -> None:
        self.lock = cwd / ".git" / "index.lock"
        self.kind = kind
        self.fail_at = fail_at
        self.reset_ran = False
        self.reset_result = RESET_UNKNOWN
        self.after = 0
        self.fired = False

    def timeout(self, argv: list[str]) -> subprocess.TimeoutExpired:
        self.fired = True
        return subprocess.TimeoutExpired(argv, GIT_TIMEOUT)

    def runner(self) -> Callable[..., subprocess.CompletedProcess[Any]]:
        """A subprocess.run that counts the commands after the reset, fails the one a fault names, and makes the reset fail."""
        def counted(argv: list[str], *arguments: object, **options: object) -> subprocess.CompletedProcess[Any]:
            is_reset = argv[:4] == RESET_COMMAND
            if self.reset_ran and not is_reset:
                self.after += 1
                if self.after == self.fail_at:
                    raise self.timeout(argv)
            if is_reset and self.kind == TIMES_OUT_BEFORE:
                self.reset_ran = True
                raise self.timeout(argv)
            if is_reset and self.kind == REFUSED:
                put(self.lock, "")
                self.fired = True
            try:
                result = REAL_RUN(argv, *arguments, **options)
            finally:
                if is_reset:
                    self.lock.unlink(missing_ok=True)
                    self.reset_ran = True
            if is_reset:
                self.reset_result = RESET_DONE if result.returncode == 0 else RESET_FAILED
            if is_reset and self.kind == TIMES_OUT_AFTER:
                self.reset_result = RESET_UNKNOWN
                raise self.timeout(argv)
            return result

        return counted


class RevertFaultTests(HardeningCase):
    with_a_staged_copy = False

    def start_a_revert(self) -> None:
        """A committed project whose check fails, an edit of a tracked file and a new file: the revert resets the first and removes the second.
        With a staged copy, the index also holds another version of the new file than the tree does."""
        self.start_a_python_project(self.project_settings)
        self.fail_pytest()
        write(self.cwd / "pyproject.toml", EDITED_PROJECT_FILE, PROJECT_FILE)
        if self.with_a_staged_copy:
            write(self.cwd / "second.txt", STAGED_VERSION)
            git(self.cwd, ["add", "second.txt"])
        write(self.cwd / "second.txt", "edit\n", STAGED_VERSION if self.with_a_staged_copy else None)

    def start_an_untracked_only_revert(self) -> Path:
        """A committed project whose check fails and whose only edits are untracked: a new file, and a file in a read-only directory that git clean cannot remove. With a staged copy, the index holds another version of the new file than the tree does."""
        self.start_a_python_project()
        self.fail_pytest()
        if self.with_a_staged_copy:
            write(self.cwd / "a.txt", STAGED_VERSION)
            git(self.cwd, ["add", "a.txt"])
        write(self.cwd / "a.txt", "edit\n", STAGED_VERSION if self.with_a_staged_copy else None)
        locked = self.cwd / "locked"
        make_dir(locked)
        put(locked / "inside.txt", "edit\n")
        set_mode(locked, READ_ONLY_DIRECTORY)
        self.addCleanup(set_mode, locked, WRITABLE_DIRECTORY)
        return locked

    def assert_the_staged_copy_is_told_when_there_is_one(self, told: str, label: str) -> None:
        """A saved ref has a second parent exactly when the index held a version the tree did not; the notice of a revert names `<ref>^2` and the command that recovers it then, and neither otherwise."""
        for ref in self.revert_refs():
            parents = len(git(self.cwd, ["rev-list", "--parents", "-n", "1", ref]).split()) - 1
            self.assertEqual(parents == 2, self.with_a_staged_copy, f"{label}: the saved ref has {parents} parents where the scenario {'stages' if self.with_a_staged_copy else 'does not stage'} a copy")
            self.assertEqual(f"`{ref}^2`" in told, self.with_a_staged_copy, f"{label}: the notice {'leaves out' if self.with_a_staged_copy else 'names'} the staged copy {ref}^2: {told!r}")
            self.assertEqual(f"git checkout {ref}^2 -- ." in told, self.with_a_staged_copy, f"{label}: the notice {'leaves out' if self.with_a_staged_copy else 'gives'} the command that recovers the staged copy: {told!r}")

    def tree_was_reset(self) -> bool:
        """Whether the tracked file the edit changed is as HEAD has it, which only a reset does."""
        text = read(self.cwd / "pyproject.toml")
        assert text in (PROJECT_FILE, EDITED_PROJECT_FILE), f"pyproject.toml holds {text!r}, which neither the commit nor the edit wrote"
        return text == PROJECT_FILE

    @contextlib.contextmanager
    def fault(self, injected: Fault) -> Iterator[None]:
        with unittest.mock.patch.object(subprocess, "run", injected.runner()), contextlib.redirect_stderr(io.StringIO()):
            yield

    def revert_with(self, injected: Fault) -> str:
        with self.fault(injected):
            output = self.call_here("PostToolUse", **EDITING)
        return self.context(output)

    def assert_only_the_clean_files_are_listed_as_restored(self, told: str, label: str) -> None:
        """Every file the notice lists as restored is clean in the tree, and every file still changed is not listed as restored."""
        listing = re.search(r"Restored: ((?:`[^`]+`(?:, )?)+)\.", told)
        listed = re.findall(r"`([^`]+)`", listing.group(1)) if listing else []
        dirty = [*git(self.cwd, ["diff", "--name-only", "--no-renames", "HEAD"]).splitlines(), *git(self.cwd, ["ls-files", "--others", "--exclude-standard"]).splitlines()]
        self.assertEqual([name for name in listed if name in dirty], [], f"{label}: files listed as restored are still changed: {told!r}")

    def assert_the_notice_matches_the_tree(self, told: str, label: str, *, reverted: bool) -> None:
        """The notice says the work was reverted if and only if the reset command succeeded, which the test knows from the fault it injected, names every saved ref either way, TCR is unavailable, no held edit is recorded, and the next turn start turns TCR on only for a clean tree."""
        self.assertEqual("TCR reverted" in told, reverted, f"{label}: the reset {'succeeded' if reverted else 'did not succeed or is not known to have'}, and the notice said: {told!r}")
        for ref in self.revert_refs():
            self.assertIn(ref, told, f"{label}: the notice does not name the saved ref {ref}: {told!r}")
        self.assert_the_staged_copy_is_told_when_there_is_one(told, label)
        self.assert_only_the_clean_files_are_listed_as_restored(told, label)
        state = self.saved_state()
        self.assertNotEqual(state["tcr"], "active", f"{label}: TCR stayed active after the failure")
        self.assertIsNone(state["held_fingerprint"], f"{label}: a held edit was recorded for a revert that failed")
        clean = git(self.cwd, ["status", "--porcelain"]) == ""
        next_turn = self.context(self.call_here("UserPromptSubmit"))
        self.assertEqual("TCR is on" in next_turn, clean, f"{label}: the tree is {'clean' if clean else 'dirty'} and the next turn start said: {next_turn!r}")

    def snapshot(self) -> Callable[[], None]:
        """Copies the project and the data directory now, and returns what puts the copies back, so that each fault starts from the same revert."""
        folders = (self.cwd, self.data)
        saved = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, saved)
        without_sockets = shutil.ignore_patterns(SOCKETS)
        for index, folder in enumerate(folders):
            shutil.copytree(folder, saved / str(index), symlinks=True, ignore=without_sockets)

        def restore() -> None:
            for index, folder in enumerate(folders):
                for child in folder.iterdir():
                    if not child.match(SOCKETS):
                        shutil.rmtree(child) if child.is_dir() else child.unlink()
                shutil.copytree(saved / str(index), folder, symlinks=True, ignore=without_sockets, dirs_exist_ok=True)

        return restore

    def test_a_git_command_that_fails_after_the_reset_still_tells_the_agent_of_the_revert_and_the_ref(self) -> None:
        self.start_a_revert()
        restore = self.snapshot()
        counting = Fault(self.cwd, NORMAL)
        self.revert_with(counting)
        self.assertGreater(counting.after, 0, "no git command ran after the reset, so there is nothing to fail")
        self.assertEqual(len(self.revert_refs()), 1, "the counted revert saved no ref")
        for position in range(1, counting.after + 1):
            restore()
            with self.subTest(failing_command_after_the_reset=position):
                failing = Fault(self.cwd, NORMAL, fail_at=position)
                told = self.revert_with(failing)
                self.assertTrue(failing.fired, f"command {position} after the reset never ran, so it did not fail")
                self.assertTrue(self.tree_was_reset(), "the reset did not run, so what follows it was not tested")
                self.assert_the_notice_matches_the_tree(told, f"git command {position} after the reset", reverted=True)

    def test_a_reset_that_git_refuses_or_that_times_out_is_never_told_as_a_revert_even_when_it_ran(self) -> None:
        self.start_a_revert()
        restore = self.snapshot()
        for kind, ran in ((REFUSED, False), (TIMES_OUT_BEFORE, False), (TIMES_OUT_AFTER, True)):
            restore()
            with self.subTest(reset=kind):
                failing = Fault(self.cwd, kind)
                told = self.revert_with(failing)
                self.assertTrue(failing.fired, f"the reset was not made to fail for {kind}")
                self.assertEqual(self.tree_was_reset(), ran, f"the tree was {'not ' if ran else ''}reset where {kind} was injected")
                self.assert_the_notice_matches_the_tree(told, f"the reset {kind}", reverted=False)
                self.assertTrue(ran or (self.cwd / "second.txt").exists(), f"the new file is gone though the reset {kind} before it ran")

    def test_a_revert_that_git_refused_names_the_failing_check_and_where_its_output_is(self) -> None:
        self.start_a_revert()
        failing = Fault(self.cwd, REFUSED)
        told = self.revert_with(failing)
        logs = [log for log in self.data.rglob("*") if log.is_file() and FAILING_PYTEST in read(log)]
        self.assertEqual(len(logs), 1, "the failing check's output was not written to one log")
        self.assertIn("TCR tried to revert", told, "the refused reset was told as a revert")
        self.assertIn("python", told.split("TCR is unavailable")[0], "the notice of the refused revert does not name the failing check")
        self.assertIn(str(logs[0]), told, "the notice of the refused revert does not give the log of the failing check")

    def test_each_read_that_fails_before_the_reset_and_that_the_docs_name_reverts_nothing_leaves_the_edit_in_the_tree_and_says_so(self) -> None:
        cause = "git status could not run: timed out"
        failing_reads = {"the submodule list": (checkpoint, "dirty_submodules", CheckpointError(cause)), "the log of the failing check": (tcr, "write_log", OSError(cause))}
        self.start_a_revert()
        restore = self.snapshot()
        for name, (module, function, error) in failing_reads.items():
            restore()
            with self.subTest(read=name):
                with unittest.mock.patch.object(module, function, side_effect=error):
                    told = self.context(self.call_here("PostToolUse", **EDITING))
                self.assertFalse(self.tree_was_reset(), f"the tracked edit was reverted though {name} failed before the reset")
                self.assertTrue((self.cwd / "second.txt").exists(), f"the new file was removed though {name} failed before the reset")
                self.assertNotIn("TCR reverted", told, "the notice claims a revert, and none was made")
                self.assertIn("TCR is unavailable", told, "the agent was not told that TCR is unavailable")
                self.assertIn(cause, told, "the notice does not say what failed")
                self.assertNotEqual(self.saved_state()["tcr"], "active", "TCR stayed active after the failure")
                next_turn = self.context(self.call_here("UserPromptSubmit"))
                self.assertNotIn("TCR is on", next_turn, "the next turn start turned TCR on for a tree that still holds the failing edit")

    def test_a_revert_runs_no_more_than_the_known_number_of_git_commands_before_the_reset(self) -> None:
        self.start_a_revert()
        with NthGitCall(None, EXITS_WITH_AN_ERROR) as counting, contextlib.redirect_stderr(io.StringIO()):
            self.call_here("PostToolUse", **EDITING)
        position = next(position for position, argv in enumerate(counting.commands) if argv[1:5] == RESET_COMMAND[1:])
        self.assertLessEqual(position, COMMANDS_BEFORE_THE_RESET, f"{position} git commands ran before the reset, where {COMMANDS_BEFORE_THE_RESET} ran when this was written")

    def test_a_renamed_file_is_told_as_restored_under_both_its_names_staged_or_not(self) -> None:
        """A revert lists as restored both the name a renamed file had and the name it has, whether the rename is staged, staged and edited, or not staged."""
        put(self.cwd / "old.txt", LONG_FILE)
        self.start_a_python_project()
        self.fail_pytest()
        write(self.cwd / "pyproject.toml", EDITED_PROJECT_FILE, PROJECT_FILE)
        restore = self.snapshot()

        def stage_the_rename() -> None:
            git(self.cwd, ["mv", "old.txt", "new.txt"])

        def stage_the_rename_and_edit_the_new_name() -> None:
            git(self.cwd, ["mv", "old.txt", "new.txt"])
            write(self.cwd / "new.txt", LONG_FILE + "edit\n", LONG_FILE)

        def rename_without_staging() -> None:
            rename_fixture_file(self.cwd / "old.txt", self.cwd / "new.txt")

        for name, rename in (("staged", stage_the_rename), ("staged and edited", stage_the_rename_and_edit_the_new_name), ("not staged", rename_without_staging)):
            restore()
            with self.subTest(rename=name):
                rename()
                told = self.context(self.call_here("PostToolUse", **EDITING))
                self.assertEqual(read(self.cwd / "old.txt"), LONG_FILE, "the revert did not bring the old name back")
                self.assertFalse((self.cwd / "new.txt").exists(), "the revert left the new name")
                self.assertIn("Restored: ", told, "the revert was not told")
                restored = re.findall(r"`([^`]+)`", told.split("Restored: ")[1].split(".\n")[0].split(". ")[0])
                self.assertEqual(sorted(restored), ["new.txt", "old.txt", "pyproject.toml"], f"the notice does not name both names of the renamed file: {told!r}")

    def test_a_file_written_after_the_last_listing_is_told_as_changed_after_it_with_no_cause(self) -> None:
        self.start_a_revert()
        original = checkpoint.has_staged_copy
        late = self.cwd / "late.py"

        def writes_a_file_once_the_files_were_listed(root: Path, ref: str) -> bool:
            if not late.exists():
                put(late, "late\n")
            return original(root, ref)

        with unittest.mock.patch.object(checkpoint, "has_staged_copy", writes_a_file_once_the_files_were_listed):
            told = self.context(self.call_here("PostToolUse", **EDITING))
        self.assertTrue(late.exists(), "the file written after the listing was removed, so nothing was left changed")
        self.assertIn("Changed after TCR listed the files: `late.py`", told, "the notice does not say the file changed after the listing")
        self.assertNotIn("git could not restore", told, "the notice names a cause it does not know")

    def test_a_revert_that_git_refused_and_saved_no_copy_does_not_say_the_discarded_work_is_gone(self) -> None:
        self.start_a_python_project({"tcr": {"saveReverted": False}})
        self.fail_pytest()
        write(self.cwd / "pyproject.toml", EDITED_PROJECT_FILE, PROJECT_FILE)
        failing = Fault(self.cwd, REFUSED)

        def writes_a_file_before_the_revert(root: Path) -> list[str]:
            put(self.cwd / "late.txt", "late\n")
            return []

        with unittest.mock.patch.object(checkpoint, "dirty_submodules", writes_a_file_before_the_revert):
            told = self.revert_with(failing)
        self.assertTrue(failing.fired, "the reset was not refused")
        self.assertNotIn("TCR reverted", told, "the notice claims a revert where the reset was refused and no file came back")
        self.assertIn("Changed after TCR listed the files: `late.txt`", told, "the notice does not name the file written after the listing")
        self.assertNotIn("is gone", told, "the notice says the discarded work is gone where the files are still changed")
        self.assertIn("No copy was saved", told, "the notice does not say that no copy was saved")

    def test_a_reset_git_refuses_and_a_listing_that_fails_after_it_makes_no_claim_about_the_files_and_names_the_ref(self) -> None:
        self.start_a_revert()
        failing = Fault(self.cwd, REFUSED)
        original = checkpoint.uncommitted

        def fails_once_the_reset_was_tried(root: Path) -> list[str]:
            if failing.reset_ran:
                raise CheckpointError("git diff could not run: timed out")
            return original(root)

        with unittest.mock.patch.object(checkpoint, "uncommitted", fails_once_the_reset_was_tried):
            told = self.revert_with(failing)
        self.assertFalse(self.tree_was_reset(), "the refused reset changed the tree")
        self.assertNotIn("TCR reverted", told, "the notice claims a revert, and nothing says it happened")
        self.assertIn("TCR tried to revert", told)
        self.assertIn(self.revert_refs()[0], told, "the notice leaves out the ref that saved the work")
        self.assertNotEqual(self.saved_state()["tcr"], "active", "TCR stayed active after a revert nobody can vouch for")

    def test_a_bug_in_each_step_after_the_reset_still_tells_the_agent_of_the_revert_and_the_ref(self) -> None:
        self.start_a_revert()
        restore = self.snapshot()
        for name, module, original in STEPS_AFTER_THE_RESET:
            restore()
            with self.subTest(step=name):
                fault = Fault(self.cwd, NORMAL)
                raised: list[bool] = []

                def fails_once_after_the_reset(*arguments: object, **options: object) -> object:
                    if fault.reset_ran and not raised:
                        raised.append(True)
                        raise AssertionError(f"injected into {name}")
                    return original(*arguments, **options)

                with unittest.mock.patch.object(module, name, fails_once_after_the_reset):
                    told = self.revert_with(fault)
                self.assertTrue(raised, f"{name} was not reached after the reset")
                self.assertTrue(self.tree_was_reset(), "the reset never ran")
                self.assert_the_notice_matches_the_tree(told, name, reverted=True)

    def test_an_untracked_file_that_git_clean_cannot_remove_still_tells_the_agent_of_the_revert_and_the_ref(self) -> None:
        self.start_a_revert()
        locked = self.cwd / "locked"
        make_dir(locked)
        put(locked / "inside.txt", "edit\n")
        set_mode(locked, READ_ONLY_DIRECTORY)
        self.addCleanup(set_mode, locked, WRITABLE_DIRECTORY)
        told = self.context(self.call_here("PostToolUse", **EDITING))
        self.assertTrue((locked / "inside.txt").exists(), "git clean removed a file in a read-only directory, so nothing failed")
        self.assertIn("TCR reverted", told)
        self.assertIn(self.revert_refs()[0], told)
        self.assertIn("TCR is unavailable", told)

    def test_a_head_that_git_cannot_name_does_not_stop_the_revert_and_the_state_keeps_the_head_the_hook_started_on(self) -> None:
        self.start_a_revert()
        head = git(self.cwd, ["rev-parse", "HEAD"])
        with unittest.mock.patch.object(tcr, "commit_of", return_value=None):
            told = self.context(self.call_here("PostToolUse", **EDITING))
        self.assertTrue(self.tree_was_reset(), "the revert did not happen")
        self.assertIn("TCR reverted", told, "the agent was not told of the revert")
        self.assertIn(self.revert_refs()[0], told, "the notice leaves out the ref that saved the work")
        self.assertEqual(self.saved_state()["head"], head, "the state was not saved with the head the hook started on")

    def test_a_pull_after_a_revert_whose_head_git_could_not_name_is_a_head_move_and_its_failures_are_not_the_agents(self) -> None:
        """A revert that read no HEAD saves the HEAD its hook started on, so a pull before the next hook is seen as one and that hook judges nothing."""
        self.start_a_revert()
        head = git(self.cwd, ["rev-parse", "HEAD"])
        with unittest.mock.patch.object(tcr, "commit_of", return_value=None):
            self.call_here("PostToolUse", **EDITING)
        self.assertTrue(self.tree_was_reset(), "the revert did not happen")
        self.assertEqual(self.saved_state()["head"], head, "the state lost the HEAD the hook started on")
        branch = git(self.cwd, ["branch", "--show-current"])
        git(self.cwd, ["checkout", "-q", "-b", "pulled"])
        put(self.cwd / "pulled.txt", "from the remote\n")
        git(self.cwd, ["add", "pulled.txt"])
        git(self.cwd, ["commit", "-q", "-m", "pulled"])
        git(self.cwd, ["checkout", "-q", branch])
        git(self.cwd, ["merge", "-q", "--ff-only", "pulled"])
        write(self.cwd / "pyproject.toml", EDITED_PROJECT_FILE, PROJECT_FILE)
        told = self.context(self.call_here("PostToolUse", **EDITING))
        self.assertNotIn("TCR reverted", told, "the agent's edit was reverted for failures the pulled code may have brought")
        self.assertEqual(read(self.cwd / "pyproject.toml"), EDITED_PROJECT_FILE, "the agent's edit is gone")

    def test_a_revert_of_untracked_files_only_that_git_clean_fails_on_is_told_as_a_revert_because_a_file_was_removed(self) -> None:
        locked = self.start_an_untracked_only_revert()
        told = self.context(self.call_here("PostToolUse", **EDITING))
        self.assertTrue((locked / "inside.txt").exists(), "git clean removed a file in a read-only directory, so nothing failed")
        self.assertFalse((self.cwd / "a.txt").exists(), "the new file is still there, so the revert removed no file")
        self.assertIn("TCR reverted", told, "the notice does not tell of a revert that removed a file")
        self.assertNotIn("unchanged", told, "the notice says the files are unchanged where a file was removed")
        self.assertIn(self.revert_refs()[0], told, "the notice leaves out the ref that saved the work")
        self.assertIn("TCR is unavailable", told)
        self.assert_the_notice_matches_the_tree(told, "untracked files only", reverted=True)

    def test_a_reset_that_cannot_unlink_a_tracked_file_names_as_now_clean_only_the_files_that_are(self) -> None:
        sub = self.cwd / "sub"
        make_dir(sub)
        put(sub / "t.txt", "committed\n")
        self.start_a_python_project()
        self.fail_pytest()
        write(self.cwd / "pyproject.toml", EDITED_PROJECT_FILE, PROJECT_FILE)
        write(sub / "t.txt", "edit\n", "committed\n")
        put(self.cwd / "second.txt", "edit\n")
        set_mode(sub, READ_ONLY_DIRECTORY)
        self.addCleanup(set_mode, sub, WRITABLE_DIRECTORY)
        told = self.context(self.call_here("PostToolUse", **EDITING))
        self.assertTrue(self.tree_was_reset(), "the reset did not restore the file in the writable directory")
        self.assertEqual(git(self.cwd, ["status", "--porcelain"]).count("sub/t.txt"), 1, "the file in the read-only directory was restored, so the reset did not fail")
        self.assertNotIn("TCR reverted", told, "the notice claims a revert where git exited with an error")
        self.assertIn("Now as HEAD has them: `pyproject.toml`", told, "the notice does not name the file that is as HEAD has it")
        self.assertIn("Still changed: `sub/t.txt`", told, "the notice does not name the file that is still changed")
        self.assert_only_the_clean_files_are_listed_as_restored(told, "a tracked file in a read-only directory")

    def test_a_tracked_file_that_is_staged_deleted_and_present_again_is_listed_once_and_the_hook_tells_the_attempt(self) -> None:
        sub = self.cwd / "sub"
        make_dir(sub)
        put(sub / "t.txt", "committed\n")
        self.start_a_python_project()
        self.fail_pytest()
        write(self.cwd / "pyproject.toml", EDITED_PROJECT_FILE, PROJECT_FILE)
        write(sub / "t.txt", "edit\n", "committed\n")
        git(self.cwd, ["rm", "--cached", "sub/t.txt"])
        set_mode(sub, READ_ONLY_DIRECTORY)
        self.addCleanup(set_mode, sub, WRITABLE_DIRECTORY)
        told = self.context(self.call_here("PostToolUse", **EDITING))
        self.assertIn("TCR tried to revert", told, "the hook did not tell the agent of the attempt")
        self.assertIn("Still changed: `sub/t.txt`", told, "the notice does not name the file that is still changed")
        self.assertEqual(checkpoint.uncommitted(self.cwd).count("sub/t.txt"), 1, "the file is listed twice")

    def test_a_bug_in_the_text_of_the_answer_after_a_revert_propagates_and_leaves_the_work_in_its_saved_ref(self) -> None:
        """The accepted limit of docs: a bug in building the text, which nothing after the reset needs git for, ends the hook with its traceback and tells the agent nothing of the revert."""
        self.start_a_revert()
        restore = self.snapshot()
        for module, name in ((tcr, "restoration"), (tcr, "revert_message"), (tcr, "told")):
            restore()
            with self.subTest(step=name):
                with unittest.mock.patch.object(module, name, unittest.mock.Mock(side_effect=AssertionError("injected"))):
                    with self.assertRaises(AssertionError, msg=f"a bug in {name} was caught; let it propagate"):
                        self.call_here("PostToolUse", **EDITING)
                self.assertFalse((self.cwd / "second.txt").exists(), "the revert did not happen, so the work is not at risk")
                self.assertTrue(self.revert_refs(), "the reverted work was not saved in a ref")


if __name__ == "__main__":
    unittest.main()
