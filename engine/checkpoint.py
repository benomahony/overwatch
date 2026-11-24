"""TCR's two git operations: commit the whole workspace after a green result, and restore the latest commit after a
red one. Neither decides when to run; the hook that calls them does. Both refuse, before changing anything, in a
repository where either would do harm: an operation such as a merge is in progress, or an untracked repository sits
inside the workspace.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import json
import sys
from collections.abc import Callable
from pathlib import Path

MINIMUM_PYTHON = (3, 11)
if sys.version_info < MINIMUM_PYTHON:
    print(json.dumps({"error": f"overwatch needs python {MINIMUM_PYTHON[0]}.{MINIMUM_PYTHON[1]} or newer; python3 on PATH is {sys.version_info[0]}.{sys.version_info[1]}"}))
    raise SystemExit(1)

from bugs import UNEXPECTED_ERRORS
from checkpoint_git import GIT_TIMEOUT, CheckpointError, GitExited, repository_root, run_git
from repository_state import (MESSAGE_FILES, UNWATCHED_REASON, current_branch, dirty_submodules, has_commit, is_clean, named, off_branch,
                              nested_repositories, refuse_unsafe, refuse_unwatched, staged_changes, unavailable_reason,
                              uncommitted, unwatched_edits)
from saved_revert import MAX_SAVE_ATTEMPTS, has_staged_copy, remove_untracked, save_discarded
from secrets_guard import (MAX_STAGED_BYTES, NAME_RULE, SIZE_RULE, UNREADABLE_RULE, Refused, Unreadable, added_lines, name_rule,
                           oversized_in_work_tree, refusals, staged_files)
from tcr_settings import validate_allow

__all__ = ["GIT_TIMEOUT", "MAX_SAVE_ATTEMPTS", "MAX_STAGED_BYTES", "MESSAGE_FILES", "NAME_RULE", "SIZE_RULE", "UNREADABLE_RULE",
           "RESET_DONE", "RESET_FAILED", "CheckpointError", "Refused", "RevertIncomplete", "Unreadable", "added_lines", "checkpoint", "current_branch", "dirty_submodules", "has_staged_copy", "is_clean",
           "name_rule", "named", "refusals", "repository_root", "revert", "run_git", "staged_files", "unavailable_reason", "uncommitted"]

MESSAGE_PREFIX = "tcr: "
EXPECTED_FAILURES = (CheckpointError, OSError)
RESET_HARD = ["reset", "--hard", "HEAD"]
RESET_DONE, RESET_FAILED, RESET_UNKNOWN = "done", "failed", "unknown"


class RevertIncomplete(CheckpointError):
    """The revert failed once it had started to discard the work, so the tree may be reset in part or whole; saved is the
    ref that holds the discarded work, or None when none was saved. reset is what the code knows of the reset command:
    RESET_DONE when it succeeded, RESET_FAILED when git ran it and it exited with an error, which may have restored some
    files, and RESET_UNKNOWN when it timed out or could not run, so nobody knows whether it ended."""

    def __init__(self, reason: str, saved: str | None, staged: bool = False, reset: str = RESET_UNKNOWN) -> None:
        assert reset in (RESET_DONE, RESET_FAILED, RESET_UNKNOWN), f"{reset!r} is no outcome of a reset"
        assert reason, "a revert that failed gave no reason"
        assert saved != "", f"the saved ref is {saved!r}, which names no saved work; pass None when nothing was saved"
        assert saved or not staged, "a staged copy is saved with the work, so there is none when nothing was saved"
        staged_copy = f" and `git checkout {saved}^2 -- .` for the version that was staged" if staged else ""
        recovery = f"; the discarded work is saved in `{saved}`, recover it with `git checkout {saved} -- .`{staged_copy}" if saved else ""
        super().__init__(reason + recovery)
        self.saved = saved
        self.reset = reset
        assert self.saved == saved, f"the revert failure holds {self.saved!r}, not the saved ref {saved!r}"


def message(files: list[str]) -> str:
    """The checkpoint's commit message: tcr: then up to MESSAGE_FILES file names, then how many more there were."""
    assert files, "a checkpoint message was asked for no file; there is nothing to commit"
    assert all(files), f"the files {files} include an empty name"
    return MESSAGE_PREFIX + named(files, quoted=False)


def unstage(root: Path) -> None:
    """Takes everything out of the index, leaving the work tree as it is. Raises CheckpointError when git cannot, and then the changes stay staged."""
    assert root.is_dir(), f"{root} is not a directory to unstage in"
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
    off = off_branch(root) if has_commit(root) else None
    if off:
        raise CheckpointError(f"no checkpoint: {off} in {root}, so the commit would belong to no branch; switch to a branch first")
    nested = nested_repositories(root)
    if nested:
        raise CheckpointError(f"no checkpoint: the untracked nested repository {named(nested)} would be committed as an empty link; ignore or remove it")
    refuse_unwatched(root, "checkpoint")
    too_large = oversized_in_work_tree(root)
    if too_large:
        raise Refused(too_large)
    run_git(root, ["add", "-A"])
    screened = False
    try:
        files = [name for name in run_git(root, ["diff", "--cached", "--name-only", "--no-renames", "-z"]).split("\0") if name]
        found = refusals(root, allow) if files else []
        screened = True
    finally:
        if not screened:
            unstage(root)
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
        raise CheckpointError(f"checkpoint {head} was made, but the commit hooks left {named(changed)} changed and uncommitted; TCR cannot rely on a clean tree")
    return head


def revert(cwd: Path, *, save_ref: bool = True, after_save: Callable[[], None] | None = None, before_discard: Callable[[str | None], None] | None = None) -> str | None:
    """Restores the latest commit: tracked files as committed, and files that are neither tracked nor ignored removed,
    with the directories that held only them. Ignored files, untracked nested repositories and the files inside
    submodules stay. Checks everything first and changes nothing when there is no commit to restore or an operation is in
    progress. Unless save_ref is false, the files it discards are first saved under a ref, which it returns, and saved
    again until a list of the files finds nothing new; a version that only the index holds is saved too, as the second
    parent of the saved commit; when that cannot be done, or git fails while it saves, the ref
    is deleted and nothing is reverted. It removes only the untracked files of that last list, so a new file written
    after it stays and is reported by CheckpointError; a file of the list or a tracked file changed after it is lost,
    which can take tens of milliseconds, because git has no way to reset and list in one step. before_discard runs
    after the last list, before anything is discarded, and is given the saved ref, or None. A failure after that raises RevertIncomplete, which names the ref."""
    root = repository_root(cwd)
    if not has_commit(root):
        raise CheckpointError(f"no revert: {root} has no commit to restore; nothing was changed")
    refuse_unsafe(root, "revert")
    refuse_unwatched(root, "revert")
    run_git(root, ["clean", "-nfd"], warnings_fail=True)
    names = uncommitted(root)
    saved, discarded = save_discarded(root, names, after_save) if save_ref and (names or staged_changes(root)) else (None, names)
    staged = saved is not None and has_staged_copy(root, saved)
    if before_discard is not None:
        before_discard(saved)
    reset = RESET_UNKNOWN
    try:
        try:
            run_git(root, RESET_HARD)
        except GitExited:
            reset = RESET_FAILED
            raise
        reset = RESET_DONE
        remove_untracked(root, discarded)
        left = uncommitted(root)
        assert has_commit(root), f"{root} lost its commit during the revert"
    except (*EXPECTED_FAILURES, *UNEXPECTED_ERRORS) as error:
        raise RevertIncomplete(f"the revert in {root} failed after it began to discard the work: {error}", saved, staged, reset) from error
    if left:
        raise RevertIncomplete(f"the revert in {root} left {named(left)}; restore them by hand", saved, staged, RESET_DONE)
    assert saved is None or save_ref, f"a revert saved {saved} without being asked to"
    return saved


if __name__ == "__main__":
    from checkpoint_command import main
    sys.exit(main(sys.argv[1:]))
