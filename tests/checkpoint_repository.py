"""What the tests of the TCR checkpoint and revert share: a real git repository in a temporary directory, and the helpers that write and read it.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import os
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path

import paths
import checkpoint
from codex_hook import read

assert str(paths.ROOT / "engine") in sys.path, f"{paths.ROOT / 'engine'} is not on sys.path {sys.path}; paths puts engine/ there so engine imports by name"
HOOK_MODE = 0o755
# What git leaves in its directory while an operation is unfinished, and what that operation is called.
UNFINISHED = {"MERGE_HEAD": "merge", "CHERRY_PICK_HEAD": "cherry-pick", "REVERT_HEAD": "revert", "BISECT_LOG": "bisect",
              "rebase-merge": "rebase", "rebase-apply": "rebase"}
# Git ignores the machine's own configuration, so its signing and global hooks do not run inside these tests.
GIT_ENVIRONMENT = {"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null",
                   "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
                   "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}


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


def link(path: Path, target: str) -> None:
    """Makes a fixture symbolic link at path that names target, which need not exist."""
    assert not path.exists() and not path.is_symlink(), f"{path} exists already; give each fixture link its own name"
    path.symlink_to(target)
    assert path.is_symlink() and os.readlink(path) == target, f"{path} is no link to {target}"


def mode_of(path: Path) -> int:
    """The permission bits of a fixture file, whether or not it is a link that leads anywhere."""
    assert path.exists() or path.is_symlink(), f"{path} is not there to read the mode of"
    return path.lstat().st_mode & 0o777


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


class RepositoryCase(unittest.TestCase):
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

    def discard_work(self) -> None:
        """Gives the repository a changed tracked file, a deleted tracked file, a new file and a nested folder with a
        new file, besides the ignored log."""
        put(self.repo / "b.txt", "tracked\n")
        git(self.repo, ["add", "b.txt"])
        git(self.repo, ["commit", "-q", "-m", "second"])
        put(self.repo / "a.txt", "broken\n")
        remove(self.repo / "b.txt")
        put(self.repo / "agent_new.py", "x\n")
        make_dir(self.repo / "pkg")
        put(self.repo / "pkg" / "m.py", "y\n")
        assert sorted(checkpoint.uncommitted(self.repo)) == ["a.txt", "agent_new.py", "b.txt", "pkg/m.py"], "the fixture work is not what the tests expect"
        assert present(self.repo / "keep.log"), f"the ignored file is gone from {self.repo} before the revert"

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
