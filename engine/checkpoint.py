"""TCR's two git operations: commit the whole workspace after a green result, and restore the latest commit after a
red one. Neither decides when to run; the hook that calls them does. Both refuse, before changing anything, in a
repository where either would do harm: an operation such as a merge is in progress, or an untracked repository sits
inside the workspace.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import contextlib
import json
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

MINIMUM_PYTHON = (3, 11)
if sys.version_info < MINIMUM_PYTHON:
    print(json.dumps({"error": f"overwatch needs python {MINIMUM_PYTHON[0]}.{MINIMUM_PYTHON[1]} or newer; python3 on PATH is {sys.version_info[0]}.{sys.version_info[1]}"}))
    raise SystemExit(1)

from checkpoint_git import GIT_TIMEOUT, CheckpointError, repository_root, run_git
from repository_state import (MESSAGE_FILES, UNWATCHED_REASON, current_branch, dirty_submodules, has_commit, is_clean, named,
                              nested_repositories, on_branch, refuse_unsafe, refuse_unwatched, staged_changes, unavailable_reason,
                              uncommitted, unwatched_edits)
from saved_revert import MAX_SAVE_ATTEMPTS, has_staged_copy, remove_untracked, save_discarded
from secrets_guard import (MAX_STAGED_BYTES, NAME_RULE, SIZE_RULE, UNREADABLE_RULE, Refused, Unreadable, added_lines, name_rule,
                           oversized_in_work_tree, refusals, staged_files)
from tcr_settings import validate_allow

__all__ = ["GIT_TIMEOUT", "MAX_SAVE_ATTEMPTS", "MAX_STAGED_BYTES", "MESSAGE_FILES", "NAME_RULE", "SIZE_RULE", "UNREADABLE_RULE",
           "CheckpointError", "Refused", "Unreadable", "added_lines", "checkpoint", "current_branch", "dirty_submodules", "has_staged_copy", "is_clean",
           "name_rule", "named", "refusals", "repository_root", "revert", "run_git", "staged_files", "unavailable_reason", "uncommitted"]

MESSAGE_PREFIX = "tcr: "
SCREENING_FAILURES = (CheckpointError, AssertionError, ValueError, LookupError, TypeError, OSError, subprocess.SubprocessError, RuntimeError)


def message(files: list[str]) -> str:
    """The checkpoint's commit message: tcr: then up to MESSAGE_FILES file names, then how many more there were."""
    text = MESSAGE_PREFIX + named(files)
    assert text.startswith(MESSAGE_PREFIX) and "\n" not in text, f"message {text!r} is not one tcr: line"
    assert text.count(MESSAGE_PREFIX) == 1 or any(MESSAGE_PREFIX in name for name in files), f"message {text!r} repeats the prefix"
    return text


def unstage(root: Path) -> None:
    """Takes everything out of the index, leaving the work tree as it is; a failure to do so is left for the commit to report."""
    assert root.is_dir(), f"{root} is not a directory to unstage in"
    with contextlib.suppress(CheckpointError):
        run_git(root, ["reset", "-q"])
    assert root.is_dir(), f"{root} went away while its index was emptied"


def checkpoint(cwd: Path, allow: tuple[str, ...] = ()) -> str | None:
    """Commits every file that is not ignored, new files included, and returns the new commit, or None when there
    was nothing to commit. The repository's own commit hooks and signing apply. When the commit fails, raises
    CheckpointError and leaves the changes staged, so no work is lost. Refuses while an operation is in progress or
    an untracked repository sits in the workspace, and while a file that git was told not to watch differs from HEAD,
    because git would leave that edit out of the commit. When a file is named like a secret, adds a high-confidence secret
    or is over MAX_STAGED_BYTES, and no entry of allow names it for the first two, raises Refused, commits nothing and
    unstages everything, so the work tree is as the edit left it. An allowlist with an entry that is empty or only
    wildcards raises ConfigurationError, as the hook does for the same file."""
    allow = validate_allow(allow)
    root = repository_root(cwd)
    refuse_unsafe(root, "checkpoint")
    if has_commit(root) and not on_branch(root):
        raise CheckpointError(f"no checkpoint: HEAD is detached in {root}, so the commit would belong to no branch; switch to a branch first")
    nested = nested_repositories(root)
    if nested:
        raise CheckpointError(f"no checkpoint: the untracked nested repository {', '.join(nested)} would be committed as an empty link; ignore or remove it")
    refuse_unwatched(root, "checkpoint")
    too_large = oversized_in_work_tree(root)
    if too_large:
        raise Refused(too_large)
    run_git(root, ["add", "-A"])
    try:
        files = [name for name in run_git(root, ["diff", "--cached", "--name-only", "-z"]).split("\0") if name]
        found = refusals(root, allow) if files else []
    except SCREENING_FAILURES as error:
        unstage(root)
        if isinstance(error, CheckpointError):
            raise
        raise CheckpointError(f"no checkpoint: screening the staged files failed with {type(error).__name__}: {error}; nothing was committed and the changes are unstaged") from error
    if not files:
        return None
    if found:
        run_git(root, ["reset", "-q"])
        raise Refused(found)
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


def revert(cwd: Path, *, save_ref: bool = True, after_save: Callable[[], None] | None = None, before_discard: Callable[[], None] | None = None) -> str | None:
    """Restores the latest commit: tracked files as committed, and files that are neither tracked nor ignored removed,
    with the directories that held only them. Ignored files, untracked nested repositories and the files inside
    submodules stay. Checks everything first and changes nothing when there is no commit to restore or an operation is in
    progress. Unless save_ref is false, the files it discards are first saved under a ref, which it returns, and saved
    again until a list of the files finds nothing new; a version that only the index holds is saved too, as the second
    parent of the saved commit; when that cannot be done, or git fails while it saves, the ref
    is deleted and nothing is reverted. It removes only the untracked files of that last list, so a new file written
    after it stays and is reported by CheckpointError; a file of the list or a tracked file changed after it is lost,
    which can take tens of milliseconds, because git has no way to reset and list in one step. before_discard runs
    after the last list, before anything is discarded."""
    root = repository_root(cwd)
    if not has_commit(root):
        raise CheckpointError(f"no revert: {root} has no commit to restore; nothing was changed")
    refuse_unsafe(root, "revert")
    refuse_unwatched(root, "revert")
    run_git(root, ["clean", "-nfd"], warnings_fail=True)
    names = uncommitted(root)
    saved, discarded = save_discarded(root, names, after_save) if save_ref and (names or staged_changes(root)) else (None, names)
    if before_discard is not None:
        before_discard()
    run_git(root, ["reset", "--hard", "HEAD"])
    remove_untracked(root, discarded)
    left = uncommitted(root)
    if left:
        raise CheckpointError(f"the revert in {root} left {left}; restore them by hand")
    assert not left, f"{root} still differs from HEAD in {left} after the revert"
    assert has_commit(root), f"{root} lost its commit during the revert"
    assert saved is None or save_ref, f"a revert saved {saved} without being asked to"
    return saved


if __name__ == "__main__":
    from checkpoint_command import main
    sys.exit(main(sys.argv[1:]))
