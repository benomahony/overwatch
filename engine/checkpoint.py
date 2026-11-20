"""TCR's two git operations: commit the whole workspace after a green result, and restore the latest commit after a
red one. Neither decides when to run; the hook that calls them does. Both refuse, before changing anything, in a
repository where either would do harm: an operation such as a merge is in progress, or an untracked repository sits
inside the workspace.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

# How long a git command may take, in seconds. A commit runs the repository's own hooks, which can be slow.
GIT_TIMEOUT = 120
# How many file names a checkpoint message lists before it says how many more there were.
MESSAGE_FILES = 5
MESSAGE_PREFIX = "tcr: "
# Files and directories in the git directory that exist while an operation is unfinished, with its name.
IN_PROGRESS = {"MERGE_HEAD": "merge", "CHERRY_PICK_HEAD": "cherry-pick", "REVERT_HEAD": "revert",
               "BISECT_LOG": "bisect", "rebase-merge": "rebase", "rebase-apply": "rebase"}


# Variables that point git at a repository other than the one in the working directory. Git sets some of them for
# its own hooks, so they can be in the environment overwatch runs in, and a reset would then act on the wrong repository.
GIT_LOCATION_VARIABLES = frozenset({"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"})


class CheckpointError(Exception):
    """A git operation of the checkpoint failed or was refused; the message says why and what was left as it was."""


def run_git(cwd: Path, argv: list[str], *, warnings_fail: bool = False) -> str:
    """Runs git with argv in cwd and returns what it printed, or raises CheckpointError with git's own message. Bytes
    that are not UTF-8, as in a file name Linux allows, come back as the surrogate characters that encode them again.
    Git finds the repository from cwd alone, whatever location variables the environment holds. With warnings_fail, a
    command that exits 0 but wrote to stderr, as git does for a directory it cannot read, fails too."""
    environment = {name: value for name, value in os.environ.items() if name not in GIT_LOCATION_VARIABLES}
    assert not GIT_LOCATION_VARIABLES & set(environment), f"git's environment still names a repository: {GIT_LOCATION_VARIABLES & set(environment)}"
    command = " ".join(argv)
    try:
        result = subprocess.run(["git", *argv], cwd=cwd, env=environment, capture_output=True, text=True, errors="surrogateescape",
                                timeout=GIT_TIMEOUT, check=False)
    except (OSError, subprocess.SubprocessError) as error:
        raise CheckpointError(f"git {command} could not run in {cwd}: {error}; check that git is installed") from error
    stderr = result.stderr.strip()
    if result.returncode != 0:
        raise CheckpointError(f"git {command} failed in {cwd}: {stderr or result.stdout.strip() or f'exit {result.returncode}'}")
    if warnings_fail and stderr:
        raise CheckpointError(f"git {command} warned in {cwd}: {stderr}")
    assert result.returncode == 0, f"git {argv} exited {result.returncode} but was not reported; raise CheckpointError"
    assert isinstance(result.stdout, str), f"git {argv} printed {type(result.stdout)}, not text"
    return result.stdout


def repository_root(cwd: Path) -> Path:
    """The top directory of the repository holding cwd, which every command here runs in so that none of them
    sees only a subdirectory. Raises CheckpointError outside a repository."""
    root = Path(run_git(cwd, ["rev-parse", "--show-toplevel"]).strip())
    assert root.is_absolute(), f"git gave the relative top directory {root} for {cwd}; expected an absolute path"
    assert root.resolve() == cwd.resolve() or root.resolve() in cwd.resolve().parents, f"{root} does not hold {cwd}"
    return root


def operation_in_progress(root: Path) -> str | None:
    """The name of the unfinished operation, such as merge or rebase, whose files are in the repository's git
    directory; None when there is none. A hard reset or a commit of everything would wreck it."""
    found: str | None = None
    for marker, name in IN_PROGRESS.items():
        listed = run_git(root, ["rev-parse", "--git-path", marker]).strip()
        located = Path(listed) if Path(listed).is_absolute() else root / listed
        if found is None and located.exists():
            found = name
    assert found is None or found in IN_PROGRESS.values(), f"found {found!r}, which no marker of {IN_PROGRESS} names"
    assert found is None or any(found == name for name in IN_PROGRESS.values()), f"{found!r} is not an operation name"
    return found


def nested_repositories(root: Path) -> list[str]:
    """The untracked directories, at any depth, in the repository at root that are repositories themselves: git lists
    one as a directory only because it is a repository. A commit of everything would record each as an empty link,
    and a clean would skip it."""
    untracked = run_git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0")
    nested = sorted(name for name in untracked if name.endswith("/") and (root / name / ".git").exists())
    assert all(name.endswith("/") for name in nested), f"{nested} include a name that is no directory"
    assert len(nested) <= len(untracked), f"{len(nested)} nested repositories among {len(untracked)} untracked paths"
    return nested


def submodules(root: Path) -> list[str]:
    """The paths of the submodules of the repository at root. A checkpoint can record only which commit each one is
    at, not the files inside it, and a hard reset does not go into them."""
    staged = run_git(root, ["ls-files", "--stage", "-z"]).split("\0")
    paths = sorted(entry.split("\t", 1)[1] for entry in staged if entry.startswith("160000 ") and "\t" in entry)
    assert all(not path.startswith("/") for path in paths), f"{paths} include an absolute path; git lists paths from the root"
    assert len(paths) <= len(staged), f"{len(paths)} submodules among {len(staged)} entries"
    return paths


def has_commit(root: Path) -> bool:
    """Whether the repository at root has a commit for HEAD to name."""
    assert root.is_dir(), f"{root} is not a directory to look for a commit in"
    try:
        named = run_git(root, ["rev-parse", "--verify", "-q", "HEAD"]).strip()
    except CheckpointError:
        return False
    assert len(named) in (40, 64), f"HEAD in {root} names {named!r}, which is neither a SHA-1 nor a SHA-256 object ID"
    return True


def on_branch(root: Path) -> bool:
    """Whether HEAD names a branch rather than a bare commit, which a commit made here would leave behind."""
    assert root.is_dir(), f"{root} is not a directory to look for a branch in"
    try:
        branch = run_git(root, ["symbolic-ref", "-q", "HEAD"]).strip()
    except CheckpointError:
        return False
    assert branch.startswith("refs/heads/"), f"HEAD in {root} names {branch!r}, which is no branch"
    return True


def is_clean(cwd: Path) -> bool:
    """Whether the repository at cwd has no change to a tracked file and no new file that its ignore rules leave
    out. A directory outside any repository raises CheckpointError."""
    listed = run_git(cwd, ["status", "--porcelain", "--untracked-files=all"]).strip()
    clean = listed == ""
    assert clean == (len(listed.splitlines()) == 0), f"status listed {listed!r} but clean is {clean}"
    assert isinstance(clean, bool), f"clean is {type(clean)}, not a yes or no"
    return clean


def unavailable_reason(cwd: Path) -> str | None:
    """Why TCR cannot start in the repository holding cwd, as one sentence, or None when it can. It starts only on a
    branch that has a commit and a clean tree, with no operation in progress and no untracked nested repository, so
    that no revert can discard work that was there before it."""
    root = repository_root(cwd)
    operation = operation_in_progress(root)
    nested = nested_repositories(root)
    committed = has_commit(root)
    reasons = [
        (not committed, "the repository has no commit to restore"),
        (committed and not on_branch(root), "HEAD is detached, so a checkpoint would belong to no branch"),
        (operation is not None, f"a {operation} is in progress"),
        (bool(nested), f"the untracked nested repository {', '.join(nested)} would not be restored"),
        (not is_clean(root), "the working tree has uncommitted changes that a revert would discard"),
    ]
    reason = next((text for applies, text in reasons if applies), None)
    assert reason is None or any(reason == text for _, text in reasons), f"reason {reason!r} is not one of the listed reasons"
    assert (reason is None) == (not any(applies for applies, _ in reasons)), f"reason {reason!r} disagrees with the checks"
    return reason


def uncommitted(root: Path) -> list[str]:
    """What still differs from HEAD in the repository at root: changed tracked files and untracked files, leaving out
    the files inside submodules and untracked nested repositories, which neither a checkpoint nor a revert covers."""
    inside = set(submodules(root))
    kept = set(nested_repositories(root))
    tracked = [name for name in run_git(root, ["diff", "--name-only", "-z", "HEAD"]).split("\0") if name and name not in inside]
    untracked = [name for name in run_git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0") if name and name not in kept]
    assert not set(tracked) & inside, f"{set(tracked) & inside} are submodules but were listed as changed files"
    assert not set(untracked) & kept, f"{set(untracked) & kept} are nested repositories but were listed as untracked files"
    return tracked + untracked


def message(files: list[str]) -> str:
    """The checkpoint's commit message: tcr: then up to MESSAGE_FILES file names, then how many more there were."""
    shown = [name.replace("\n", " ").replace("\t", " ") for name in files[:MESSAGE_FILES]]
    hidden = len(files) - len(shown)
    text = MESSAGE_PREFIX + ", ".join(shown) + (f" and {hidden} more" if hidden > 0 else "")
    assert text.startswith(MESSAGE_PREFIX) and "\n" not in text, f"message {text!r} is not one tcr: line"
    assert hidden == 0 or text.endswith(f"and {hidden} more"), f"message {text!r} does not say that {hidden} files were left out"
    return text


def refuse_unsafe(root: Path, action: str) -> None:
    """Raises CheckpointError when an operation is in progress, so that action, a commit or a revert, changes nothing."""
    operation = operation_in_progress(root)
    if operation is not None:
        raise CheckpointError(f"no {action}: a {operation} is in progress in {root}; finish or abort it first")
    assert operation is None, f"a {operation} in progress was not refused"
    assert root.is_dir(), f"{root} is not a directory to {action} in"


def checkpoint(cwd: Path) -> str | None:
    """Commits every file that is not ignored, new files included, and returns the new commit, or None when there
    was nothing to commit. The repository's own commit hooks and signing apply. When the commit fails, raises
    CheckpointError and leaves the changes staged, so no work is lost. Refuses while an operation is in progress or
    an untracked repository sits in the workspace."""
    root = repository_root(cwd)
    refuse_unsafe(root, "checkpoint")
    if has_commit(root) and not on_branch(root):
        raise CheckpointError(f"no checkpoint: HEAD is detached in {root}, so the commit would belong to no branch; switch to a branch first")
    nested = nested_repositories(root)
    if nested:
        raise CheckpointError(f"no checkpoint: the untracked nested repository {', '.join(nested)} would be committed as an empty link; ignore or remove it")
    run_git(root, ["add", "-A"])
    files = [name for name in run_git(root, ["diff", "--cached", "--name-only", "-z"]).split("\0") if name]
    if not files:
        return None
    before = run_git(root, ["rev-parse", "HEAD"]).strip() if has_commit(root) else ""
    try:
        run_git(root, ["commit", "-q", "-m", message(files)])
    except CheckpointError as error:
        raise CheckpointError(f"the checkpoint commit failed and its changes are left staged: {error}") from error
    head = run_git(root, ["rev-parse", "HEAD"]).strip()
    assert len(head) in (40, 64), f"HEAD {head!r} is neither a SHA-1 nor a SHA-256 object ID"
    assert head != before, f"the commit of {files} left HEAD at {before}; git reported success but made no commit"
    changed = uncommitted(root)
    if changed:
        raise CheckpointError(f"checkpoint {head} was made, but the commit hooks left {changed} changed and uncommitted; TCR cannot rely on a clean tree")
    return head


def revert(cwd: Path) -> None:
    """Restores the latest commit: tracked files as committed, and files and directories that are neither tracked
    nor ignored removed. Ignored files, untracked nested repositories and the files inside submodules stay. Checks everything first and changes
    nothing when there is no commit to restore or an operation is in progress."""
    root = repository_root(cwd)
    if not has_commit(root):
        raise CheckpointError(f"no revert: {root} has no commit to restore; nothing was changed")
    refuse_unsafe(root, "revert")
    run_git(root, ["clean", "-nfd"], warnings_fail=True)
    run_git(root, ["reset", "--hard", "HEAD"])
    run_git(root, ["clean", "-fd"])
    left = uncommitted(root)
    if left:
        raise CheckpointError(f"the revert in {root} left {left}; restore them by hand")
    assert not left, f"{root} still differs from HEAD in {left} after the revert"
    assert has_commit(root), f"{root} lost its commit during the revert"
