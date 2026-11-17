"""What state a repository is in for TCR: whether it has a commit and a branch, what differs from HEAD, and why TCR cannot start in it.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import os
import stat
from pathlib import Path

from checkpoint_git import CheckpointError, GitIO, repository_root, run_git

# How many file names a checkpoint message lists before it says how many more there were.
MESSAGE_FILES = 5
SKIP_WORKTREE_TAG = "S"
# The modes git records for a link, a plain file, an executable file and a submodule.
SYMLINK_MODE = "120000"
REGULAR_MODE = "100644"
EXECUTABLE_MODE = "100755"
SUBMODULE_MODE = "160000"
EXECUTABLE_BITS = 0o111
UNWATCHED_REASON = "{files} is marked assume-unchanged or skip-worktree and differs from HEAD, so git does not show the edit and a revert would overwrite it"
# Files and directories in the git directory that exist while an operation is unfinished, with its name.
IN_PROGRESS = {"MERGE_HEAD": "merge", "CHERRY_PICK_HEAD": "cherry-pick", "REVERT_HEAD": "revert",
               "BISECT_LOG": "bisect", "rebase-merge": "rebase", "rebase-apply": "rebase"}


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


def unavailable_reason(cwd: Path, *, dirty_ok: bool = False) -> str | None:
    """Why TCR cannot start in the repository holding cwd, as one sentence, or None when it can. It starts only on a
    branch that has a commit and a clean tree, with no operation in progress and no untracked nested repository, so
    that no revert can discard work that was there before it. With dirty_ok, uncommitted changes are no reason: the
    caller knows whose they are."""
    root = repository_root(cwd)
    operation = operation_in_progress(root)
    nested = nested_repositories(root)
    committed = has_commit(root)
    clean = is_clean(root) or dirty_ok
    changed = uncommitted(root) if committed and not clean else []
    unwatched = unwatched_edits(root) if committed else []
    reasons = [
        (not committed, "the repository has no commit to restore"),
        (committed and not on_branch(root), "HEAD is detached, so a checkpoint would belong to no branch"),
        (operation is not None, f"a {operation} is in progress"),
        (bool(unwatched), UNWATCHED_REASON.format(files=named(unwatched))),
        (bool(nested), f"the untracked nested repository {', '.join(nested)} would not be restored"),
        (not clean, "the working tree has uncommitted changes that a revert would discard" + (f": {named(changed)}" if changed else "")),
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


def staged_changes(root: Path) -> bool:
    """Whether the repository's index differs from HEAD, which a hard reset would undo."""
    assert root.is_dir(), f"{root} is not a directory to look for staged changes in"
    listed = run_git(root, ["diff", "--cached", "--name-only"]).strip()
    assert "\0" not in listed, f"git listed {listed!r} with a NUL where it was asked for lines"
    return listed != ""


def committed_entry(root: Path, name: str) -> tuple[str, str] | None:
    """The mode and object ID that HEAD records for the file name, or None when HEAD has no such file."""
    listed = run_git(root, ["ls-tree", "-z", "HEAD", "--", name]).split("\0")[0]
    if not listed:
        return None
    description, _, recorded = listed.partition("\t")
    mode, _, object_id = description.split(" ")
    assert recorded == name, f"HEAD lists {recorded!r} where {name!r} was asked for"
    assert mode in (SYMLINK_MODE, REGULAR_MODE, EXECUTABLE_MODE, SUBMODULE_MODE), f"HEAD records {name!r} with the mode {mode}, which is no file or link"
    return mode, object_id


def honours_modes(root: Path) -> bool:
    """Whether git in root tells an executable file from a plain one; false where core.fileMode is off."""
    try:
        setting = run_git(root, ["config", "--type=bool", "--get", "core.fileMode"]).strip()
    except CheckpointError:
        return True
    assert setting in ("true", "false"), f"git gave core.fileMode as {setting!r}, not a yes or no"
    assert root.is_dir(), f"{root} is not a directory to read the configuration of"
    return setting == "true"


def worktree_entry(root: Path, name: str) -> tuple[str, str] | None:
    """The mode and object ID that the file, link or other thing at name in the work tree would have as a git entry,
    looking at a link itself and not at what it points to; None when nothing is there, as in a sparse checkout. Anything
    that is neither a file nor a link gets the empty mode, which equals no entry of HEAD."""
    assert name and not name.startswith("/"), f"{name!r} is not a path below {root}"
    try:
        found = (root / name).lstat()
    except FileNotFoundError:
        return None
    assert stat.S_ISLNK(found.st_mode) or (root / name).exists(), f"{name!r} is neither a link nor a thing that exists in {root}"
    if stat.S_ISLNK(found.st_mode):
        return SYMLINK_MODE, run_git(root, ["hash-object", "--stdin"], io=GitIO(stdin=os.readlink(root / name))).strip()
    if not stat.S_ISREG(found.st_mode):
        return "", ""
    mode = EXECUTABLE_MODE if found.st_mode & EXECUTABLE_BITS else REGULAR_MODE
    assert mode in (REGULAR_MODE, EXECUTABLE_MODE), f"{name!r} was given the mode {mode}, which is neither plain nor executable"
    return mode, run_git(root, ["hash-object", "--", name]).strip()


def differs_from_head(root: Path, name: str, modes_count: bool) -> bool:
    """Whether the file at name in the work tree differs from what HEAD records for it, in content, in mode when
    modes_count, or in being a link or a file. A name that is not in the work tree differs from nothing."""
    assert name and not name.startswith("/"), f"{name!r} is not a path below {root}"
    now = worktree_entry(root, name)
    if now is None:
        return False
    committed = committed_entry(root, name)
    assert committed is None or len(committed[1]) == len(now[1]) or now == ("", ""), f"{name!r} has object IDs of different kinds: {committed} and {now}"
    if committed is not None and not modes_count and {now[0], committed[0]} <= {REGULAR_MODE, EXECUTABLE_MODE}:
        return now[1] != committed[1]
    return now != committed


def unwatched_edits(root: Path) -> list[str]:
    """The tracked files that git was told not to look at, as `assume-unchanged` or `skip-worktree` does, and that differ
    from HEAD now in content, mode or kind: a person's edit to one is not in `git status`, and a hard reset would
    overwrite it. A flagged file that is not in the work tree, as in a sparse checkout, or that equals HEAD, holds
    nothing to lose."""
    entries = [entry for entry in run_git(root, ["ls-files", "-v", "-z"]).split("\0") if len(entry) > 2]
    flagged = [entry[2:] for entry in entries if entry[0].islower() or entry[0] == SKIP_WORKTREE_TAG]
    modes_count = honours_modes(root) if flagged else True
    edited = [name for name in flagged if differs_from_head(root, name, modes_count)]
    assert all(worktree_entry(root, name) is not None for name in edited), f"{edited} are listed as edited but are not in {root}"
    assert len(edited) <= len(flagged), f"{len(edited)} edited files among {len(flagged)} flagged ones"
    return edited


def refuse_unwatched(root: Path, action: str) -> None:
    """Raises CheckpointError when a file that git was told not to watch differs from HEAD, so that action, a commit or a
    revert, changes nothing: git leaves such an edit out of a commit, and a hard reset would overwrite it."""
    unwatched = unwatched_edits(root) if has_commit(root) else []
    if unwatched:
        raise CheckpointError(f"no {action}: {UNWATCHED_REASON.format(files=named(unwatched))}; nothing was changed")
    assert not unwatched, f"edited flagged files {unwatched} were not refused"
    assert root.is_dir(), f"{root} is not a directory to {action} in"


def dirty_submodules(root: Path) -> list[str]:
    """The submodules of the repository at root whose own files differ from what the repository records: neither a
    checkpoint nor a revert goes into them."""
    inside = set(submodules(root))
    entries = run_git(root, ["status", "--porcelain=v1", "-z", "--ignore-submodules=none"]).split("\0")
    dirty = sorted({entry[3:] for entry in entries if len(entry) > 3 and entry[3:] in inside})
    assert set(dirty) <= inside, f"{set(dirty) - inside} are listed as submodules but are none"
    assert len(dirty) <= len(inside), f"{len(dirty)} dirty submodules among {len(inside)}"
    return dirty


def named(files: list[str]) -> str:
    """Up to MESSAGE_FILES file names on one line, then how many more there were."""
    shown = [name.replace("\n", " ").replace("\t", " ") for name in files[:MESSAGE_FILES]]
    hidden = len(files) - len(shown)
    text = ", ".join(shown) + (f" and {hidden} more" if hidden > 0 else "")
    assert "\n" not in text, f"the names {text!r} are not on one line"
    assert hidden == 0 or text.endswith(f"and {hidden} more"), f"names {text!r} do not say that {hidden} files were left out"
    return text


def current_branch(root: Path) -> str | None:
    """The name of the branch HEAD names; None on a detached HEAD."""
    try:
        branch = run_git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).strip()
    except CheckpointError:
        return None
    assert branch and "\n" not in branch, f"HEAD in {root} names the branch {branch!r}, which is no name"
    assert on_branch(root), f"{branch!r} was named as the branch, but HEAD in {root} is detached"
    return branch


def refuse_unsafe(root: Path, action: str) -> None:
    """Raises CheckpointError when an operation is in progress, so that action, a commit or a revert, changes nothing."""
    operation = operation_in_progress(root)
    if operation is not None:
        raise CheckpointError(f"no {action}: a {operation} is in progress in {root}; finish or abort it first")
    assert operation is None, f"a {operation} in progress was not refused"
    assert root.is_dir(), f"{root} is not a directory to {action} in"
