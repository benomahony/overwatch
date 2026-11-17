"""What a TCR revert does with the work it discards: saving it under a ref, and removing the files that were not tracked.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import os
import tempfile
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from checkpoint_git import CheckpointError, GitIO, run_git
from repository_state import uncommitted

# How many times a revert saves the files again when they changed while it saved them.
MAX_SAVE_ATTEMPTS = 3
# How many paths one git clean is given, so that a long list stays under the limit on the length of a command.
CLEAN_BATCH = 200
SAVED_REF_PREFIX = "refs/overwatch/reverted/"
SAVED_REF_TIME = "%Y%m%dT%H%M%S%fZ"
SAVED_MESSAGE = "overwatch: work that a TCR revert discarded"
STAGED_MESSAGE = "overwatch: the version that a TCR revert discarded from the index"
# Who the saved commit is by when git knows no one: the commit only holds the discarded work, and is nobody's own.
FALLBACK_IDENTITY = (("GIT_AUTHOR_NAME", "overwatch"), ("GIT_AUTHOR_EMAIL", "overwatch@localhost"),
                     ("GIT_COMMITTER_NAME", "overwatch"), ("GIT_COMMITTER_EMAIL", "overwatch@localhost"))


def snapshot_tree(root: Path, names: list[str]) -> str:
    """The tree of HEAD with the files in names as they are in the workspace now, made in a temporary index so that HEAD,
    the repository's index and the workspace stay as they are."""
    with tempfile.TemporaryDirectory() as directory:
        index, listing = Path(directory) / "index", Path(directory) / "paths"
        run_git(root, ["read-tree", "HEAD"], io=GitIO(index=index))
        if names:
            listing.write_bytes(b"\0".join(os.fsencode(name) for name in names))
            run_git(root, ["--literal-pathspecs", "add", "-A", "--pathspec-from-file", str(listing), "--pathspec-file-nul"], io=GitIO(index=index))
        tree = run_git(root, ["write-tree"], io=GitIO(index=index)).strip()
    assert len(tree) in (40, 64), f"git wrote the tree {tree!r}, which is neither a SHA-1 nor a SHA-256 object ID"
    assert names or tree == run_git(root, ["rev-parse", "HEAD^{tree}"]).strip(), f"a snapshot of no files is not the tree of HEAD in {root}"
    return tree


def identity_for_saved_commit(root: Path) -> tuple[tuple[str, str], ...]:
    """Nothing when git knows who the author and the committer are, as the person set them; otherwise FALLBACK_IDENTITY,
    so that a repository without a configured identity can still save the work a revert discards."""
    assert root.is_dir(), f"{root} is not a directory to ask git for an identity in"
    try:
        run_git(root, ["var", "GIT_AUTHOR_IDENT"])
        run_git(root, ["var", "GIT_COMMITTER_IDENT"])
    except CheckpointError:
        return FALLBACK_IDENTITY
    assert not FALLBACK_IDENTITY or FALLBACK_IDENTITY[0][0] == "GIT_AUTHOR_NAME", "the fallback identity does not start with the author's name"
    return ()


def staged_copy(root: Path, tree: str) -> str | None:
    """The tree of the repository's index when it holds a version that neither HEAD nor tree holds, so that a revert,
    which resets the index too, would lose it; None when the index adds nothing."""
    staged = run_git(root, ["write-tree"]).strip()
    head_tree = run_git(root, ["rev-parse", "HEAD^{tree}"]).strip()
    assert len(staged) in (40, 64), f"git wrote the tree {staged!r}, which is neither a SHA-1 nor a SHA-256 object ID"
    assert len(head_tree) == len(staged), f"the tree of HEAD {head_tree!r} and the index tree {staged!r} are of different object ID kinds"
    return None if staged in (tree, head_tree) else staged


def has_staged_copy(root: Path, ref: str) -> bool:
    """Whether the saved commit at ref has a second parent, the commit that holds the index's version of the files."""
    assert ref.startswith(SAVED_REF_PREFIX), f"{ref} is not a ref below {SAVED_REF_PREFIX}, so it names no saved commit"
    try:
        run_git(root, ["rev-parse", "--verify", "-q", f"{ref}^2"])
    except CheckpointError:
        return False
    assert run_git(root, ["rev-parse", f"{ref}^2^"]).strip() == run_git(root, ["rev-parse", f"{ref}^"]).strip(), f"the staged commit of {ref} is not on top of the same HEAD"
    return True


def point_ref_at(root: Path, ref: str, trees: tuple[str, str | None], *, is_new: bool) -> None:
    """Makes ref name a commit of the first tree on top of HEAD, with a second parent that holds the second tree, the
    staged one, when there is one; a new ref must not exist yet."""
    tree, staged = trees
    io = GitIO(environment=identity_for_saved_commit(root))
    parents = ["-p", "HEAD"]
    if staged is not None:
        parents += ["-p", run_git(root, ["commit-tree", staged, "-p", "HEAD", "-m", STAGED_MESSAGE], io=io).strip()]
    commit = run_git(root, ["commit-tree", tree, *parents, "-m", SAVED_MESSAGE], io=io).strip()
    run_git(root, ["update-ref", ref, commit, *([""] if is_new else [])])
    assert run_git(root, ["rev-parse", ref]).strip() == commit, f"{ref} does not name the saved commit {commit}"
    assert run_git(root, ["rev-parse", f"{ref}^"]).strip() == run_git(root, ["rev-parse", "HEAD"]).strip(), f"{ref} is not on top of HEAD"
    assert has_staged_copy(root, ref) == (staged is not None), f"{ref} disagrees with the staged tree {staged!r} about a second parent"


def save_discarded(root: Path, names: list[str], after_save: Callable[[], None] | None) -> tuple[str, list[str]]:
    """Saves the files in names, which a revert would discard, under a new ref below SAVED_REF_PREFIX, and returns the
    ref and the files that were saved. Anyone can write a file while that takes time, so after each save it lists the
    files again and saves again when they differ, until a list gives the tree already saved, MAX_SAVE_ATTEMPTS times at
    most; then it deletes the ref and raises CheckpointError, so that the caller deletes nothing. A version that only
    the index holds is saved too, as the second parent of the commit. after_save runs after each save, before the
    list."""
    tree = snapshot_tree(root, names)
    staged = staged_copy(root, tree)
    ref = SAVED_REF_PREFIX + datetime.now(timezone.utc).strftime(SAVED_REF_TIME)
    point_ref_at(root, ref, (tree, staged), is_new=True)
    assert ref.startswith(SAVED_REF_PREFIX), f"the ref {ref} is not below {SAVED_REF_PREFIX}"
    try:
        for _ in range(MAX_SAVE_ATTEMPTS):
            if after_save is not None:
                after_save()
            names = uncommitted(root)
            later = snapshot_tree(root, names)
            later_staged = staged_copy(root, later)
            if (later, later_staged) == (tree, staged):
                return ref, names
            tree, staged = later, later_staged
            point_ref_at(root, ref, (tree, staged), is_new=False)
        raise CheckpointError(f"the files in {root} kept changing while the work was saved, so nothing was reverted; stop what writes to them and try again")
    except CheckpointError:
        run_git(root, ["update-ref", "-d", ref])
        assert not run_git(root, ["for-each-ref", ref]).strip(), f"the ref {ref} is still there after the save was given up"
        raise


def remove_untracked(root: Path, names: list[str]) -> None:
    """Removes the files in names that are neither tracked nor ignored, and the directories that held them and are empty
    now. A file that is not in names stays, even in the same directory, so that what was written after names was listed
    is not lost."""
    assert root.is_dir() and not any(name.startswith("/") for name in names), f"{names} are not paths below {root}"
    assert all(name for name in names), f"{names} include an empty path, which git clean would read as every file"
    for start in range(0, len(names), CLEAN_BATCH):
        run_git(root, ["--literal-pathspecs", "clean", "-fd", "--", *names[start:start + CLEAN_BATCH]])
    directories = sorted({parent for name in names for parent in (root / name).parents if parent != root and root in parent.parents}, key=lambda path: -len(path.parts))
    for directory in directories:
        try:
            directory.rmdir()
        except OSError:
            continue
