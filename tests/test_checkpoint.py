"""Tests of the TCR checkpoint and revert, run against real git repositories in temporary directories.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from paths import ROOT
import checkpoint
import codex
from test_codex import read

HOOK_MODE = 0o755
# What git leaves in its directory while an operation is unfinished, and what that operation is called.
UNFINISHED = {"MERGE_HEAD": "merge", "CHERRY_PICK_HEAD": "cherry-pick", "REVERT_HEAD": "revert", "BISECT_LOG": "bisect",
              "rebase-merge": "rebase", "rebase-apply": "rebase"}
# Git ignores the machine's own configuration, so its signing and global hooks do not run inside these tests.
GIT_ENVIRONMENT = {"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null",
                   "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
                   "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}
PACKAGE_FILE = "hooks/checkpoint.py"


def set_environment(values: dict[str, str]) -> dict[str, str | None]:
    """Sets values in this process's environment and returns what each variable held before, for restore_git."""
    saved = {name: os.environ.get(name) for name in values}
    os.environ.update(values)
    assert all(os.environ[name] == value for name, value in values.items()), f"the environment is {dict(os.environ)}, not {values}"
    assert set(saved) == set(values), f"saved {set(saved)} but set {set(values)}; save every variable"
    return saved


def isolate_git() -> dict[str, str | None]:
    """Sets GIT_ENVIRONMENT in this process and returns what each variable held before, for restore_git."""
    saved = set_environment(GIT_ENVIRONMENT)
    assert os.environ["GIT_CONFIG_GLOBAL"] == "/dev/null", "git would still read the machine's configuration"
    assert set(saved) == set(GIT_ENVIRONMENT), f"saved {set(saved)} but isolated {set(GIT_ENVIRONMENT)}"
    return saved


def restore_git(saved: dict[str, str | None]) -> None:
    """Puts back what isolate_git found: each variable's old value, or no variable where there was none."""
    for name, value in saved.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value
    assert all(os.environ.get(name) == value for name, value in saved.items()), f"git's environment was not restored to {saved}"
    assert all(name in os.environ or saved[name] is None for name in saved), f"a variable of {set(saved)} was lost on the way back"


def git(cwd: Path, argv: list[str]) -> str:
    """Runs git with argv in cwd and returns what it printed. Inside a test the environment is GIT_ENVIRONMENT."""
    assert os.environ.get("GIT_CONFIG_GLOBAL") == "/dev/null", "git would read the machine's configuration; run it inside a test's setUp"
    result = subprocess.run(["git", "-C", str(cwd), *argv], capture_output=True, text=True, check=True)
    assert result.returncode == 0, f"git {argv} exited {result.returncode}: {result.stderr}"
    assert isinstance(result.stdout, str), f"git {argv} printed {type(result.stdout)}, not text"
    return result.stdout.strip()


def put(path: Path, text: str) -> None:
    """Writes text to a fixture file in the test's own temporary directory, replacing what it held."""
    with path.open("w") as handle:
        handle.write(text)
    assert path.stat().st_size == len(text.encode()), f"{path} holds {path.stat().st_size} bytes of the {len(text.encode())} written"
    assert path.read_bytes() == text.encode(), f"{path} reads back differently from what was written"


def present(path: Path) -> bool:
    """Whether a file or directory exists at path."""
    found = path.exists()
    assert isinstance(found, bool), f"existence of {path} came back as {type(found)}, not a yes or no"
    assert found == (path.is_file() or path.is_dir()), f"{path} exists but is neither a file nor a directory"
    return found


def remove(path: Path) -> None:
    """Deletes one fixture file that exists."""
    assert path.is_file(), f"{path} is not a file to remove; remove only files the test made"
    path.unlink()
    assert not path.exists(), f"{path} is still there after it was removed"


def make_dir(path: Path) -> None:
    """Makes a fixture directory that does not exist yet."""
    assert not path.exists(), f"{path} exists already; give each fixture directory its own name"
    path.mkdir(parents=True)
    assert path.is_dir(), f"{path} was not made; check its parent is writable"


def clear_marker(location: Path) -> None:
    """Removes a marker that git leaves in its directory while an operation is unfinished: a file, or an empty directory."""
    assert location.exists(), f"{location} is not there to clear; make the marker first"
    if location.is_dir():
        location.rmdir()
    else:
        location.unlink()
    assert not location.exists(), f"{location} is still there after it was cleared"


def set_mode(path: Path, mode: int) -> None:
    """Sets the permission bits of a fixture file or directory, for tests of what git does when it cannot read one."""
    assert path.exists(), f"{path} is not there to change the mode of"
    path.chmod(mode)
    assert path.stat().st_mode & 0o777 == mode, f"{path} has mode {path.stat().st_mode & 0o777:o}, not {mode:o}"


def install_hook(repo: Path, name: str, body: str) -> None:
    """Installs an executable git hook named name in repo, running body as a shell script."""
    assert body.strip() != "", f"the hook {name} has an empty body; give it a command to run"
    assert (repo / ".git").is_dir(), f"{repo} has no .git directory, so the hook {name} would never run; install hooks in a repository"
    hook = repo / ".git" / "hooks" / name
    put(hook, f"#!/bin/sh\n{body}\n")
    hook.chmod(HOOK_MODE)
    assert os.access(hook, os.X_OK), f"the hook {hook} is not executable; chmod it"


class CheckpointTests(unittest.TestCase):
    def setUp(self) -> None:
        """A repository with one committed file, an ignore file, and an ignored log, and a directory outside any
        repository, each removed afterwards."""
        self.addCleanup(restore_git, isolate_git())
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name)
        self.outside = tempfile.TemporaryDirectory()
        self.addCleanup(self.outside.cleanup)
        git(self.repo, ["init", "-q", "-b", "main"])
        put(self.repo / ".gitignore", "*.log\nnode_modules/\n")
        put(self.repo / "a.txt", "base\n")
        git(self.repo, ["add", "-A"])
        git(self.repo, ["commit", "-q", "-m", "start"])
        put(self.repo / "keep.log", "ignored\n")
        assert git(self.repo, ["status", "--porcelain"]) == "", f"{self.repo} is not clean after setup"
        assert present(self.repo / "keep.log"), f"the ignored file was not written in {self.repo}"

    def test_the_module_is_in_the_package_file_list(self) -> None:
        package = json.loads(read(ROOT / "package.json"))
        self.assertIn(PACKAGE_FILE, package["files"])

    def test_a_clean_tree_is_clean(self) -> None:
        self.assertTrue(checkpoint.is_clean(self.repo))

    def test_an_edited_or_new_file_makes_the_tree_dirty_but_an_ignored_one_does_not(self) -> None:
        put(self.repo / "other.log", "ignored too\n")
        self.assertTrue(checkpoint.is_clean(self.repo))
        put(self.repo / "new.txt", "new\n")
        self.assertFalse(checkpoint.is_clean(self.repo))
        remove(self.repo / "new.txt")
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
        self.assertTrue(codex.moved_by_commits(self.repo, before, git(self.repo, ["rev-parse", "HEAD"])))

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

    def test_a_revert_goes_back_to_the_latest_checkpoint_not_to_the_start(self) -> None:
        put(self.repo / "a.txt", "green\n")
        checkpoint.checkpoint(self.repo)
        put(self.repo / "a.txt", "red\n")
        checkpoint.revert(self.repo)
        self.assertEqual(read(self.repo / "a.txt"), "green\n")

    def test_a_commit_hook_that_refuses_raises_and_leaves_the_work_in_place(self) -> None:
        install_hook(self.repo, "pre-commit", "echo refused >&2\nexit 1")
        put(self.repo / "a.txt", "green work\n")
        before = git(self.repo, ["rev-parse", "HEAD"])
        with self.assertRaises(checkpoint.CheckpointError) as raised:
            checkpoint.checkpoint(self.repo)
        self.assertIn("refused", str(raised.exception))
        self.assertEqual(git(self.repo, ["rev-parse", "HEAD"]), before)
        self.assertEqual(read(self.repo / "a.txt"), "green work\n")

    def start_a_conflicting_merge(self) -> None:
        """Leaves the repository in the middle of a merge whose two sides changed a.txt differently."""
        git(self.repo, ["checkout", "-q", "-b", "other"])
        put(self.repo / "a.txt", "other\n")
        git(self.repo, ["commit", "-qam", "other"])
        git(self.repo, ["checkout", "-q", "main"])
        put(self.repo / "a.txt", "main\n")
        git(self.repo, ["commit", "-qam", "main"])
        subprocess.run(["git", "-C", str(self.repo), "merge", "other"], capture_output=True, text=True, check=False)
        assert present(self.repo / ".git" / "MERGE_HEAD"), f"the merge in {self.repo} did not stop on a conflict"
        assert "<<<<<<<" in read(self.repo / "a.txt"), f"a.txt in {self.repo} holds no conflict markers"

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

    def test_file_names_are_written_as_they_are_in_the_message(self) -> None:
        put(self.repo / "my file.txt", "x\n")
        put(self.repo / "\u00fcn\u00ef.txt", "x\n")
        checkpoint.checkpoint(self.repo)
        subject = git(self.repo, ["log", "-1", "--format=%s"])
        self.assertIn("my file.txt", subject)
        self.assertIn("\u00fcn\u00ef.txt", subject)
        self.assertNotIn("\\303", subject)

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

    def test_a_revert_with_no_commit_to_restore_changes_nothing(self) -> None:
        root = Path(self.outside.name)
        git(root, ["init", "-q", "-b", "main"])
        put(root / "a.txt", "work\n")
        with self.assertRaises(checkpoint.CheckpointError) as raised:
            checkpoint.revert(root)
        self.assertIn("no commit", str(raised.exception))
        self.assertEqual(read(root / "a.txt"), "work\n")

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

    def test_a_checkpoint_on_a_detached_head_is_refused_and_keeps_the_work(self) -> None:
        git(self.repo, ["checkout", "-q", "--detach"])
        put(self.repo / "a.txt", "edited on no branch\n")
        before = git(self.repo, ["rev-parse", "HEAD"])
        with self.assertRaises(checkpoint.CheckpointError) as raised:
            checkpoint.checkpoint(self.repo)
        self.assertIn("detached", str(raised.exception))
        self.assertEqual(git(self.repo, ["rev-parse", "HEAD"]), before)
        self.assertEqual(read(self.repo / "a.txt"), "edited on no branch\n")

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

    def test_an_unreadable_directory_stops_a_revert_before_it_changes_anything(self) -> None:
        put(self.repo / "a.txt", "dirty\n")
        make_dir(self.repo / "u")
        put(self.repo / "u" / "f.txt", "x\n")
        set_mode(self.repo / "u", 0)
        self.addCleanup(set_mode, self.repo / "u", 0o755)
        with self.assertRaises(checkpoint.CheckpointError):
            checkpoint.revert(self.repo)
        self.assertEqual(read(self.repo / "a.txt"), "dirty\n")

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

    def test_a_directory_outside_a_git_tree_is_refused(self) -> None:
        with self.assertRaises(checkpoint.CheckpointError):
            checkpoint.is_clean(Path(self.outside.name))


if __name__ == "__main__":
    unittest.main()
