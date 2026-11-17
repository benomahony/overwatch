"""The checkpoint's command line, for callers that are not Python: each command runs one operation of checkpoint.py on the
repository holding a directory and prints its answer as one JSON line.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

from checkpoint import SCREENING_FAILURES, CheckpointError, Refused, checkpoint, repository_root, revert, unavailable_reason, uncommitted
from discovery import ConfigurationError
from saved_revert import has_staged_copy
from tcr_settings import read_settings
from workspace import content_fingerprint, fingerprint

HELD_FLAG = "--held"
CONTENT_FLAG = "--content"
EXPECT_FLAG = "--expect"
NO_SAVE_REF_FLAG = "--no-save-ref"
FAILURE = 1


def reason_answer(cwd: Path, flags: tuple[str, ...]) -> dict[str, object]:
    """Why TCR cannot start in the repository holding cwd, or null when it can. With HELD_FLAG the caller holds an edit
    it knows of, so a tree that differs from HEAD is no obstacle; any other obstacle still is."""
    unknown = [flag for flag in flags if flag != HELD_FLAG]
    if unknown:
        raise CheckpointError(f"reason takes {HELD_FLAG} and nothing else, got {unknown}")
    reason = unavailable_reason(cwd, dirty_ok=HELD_FLAG in flags)
    assert reason is None or reason, "the reason TCR cannot start is empty text"
    assert reason is None or "\n" not in reason, f"the reason {reason!r} spans lines; the answer is one JSON line"
    return {"reason": reason}


def fingerprint_of(cwd: Path, flags: tuple[str, ...]) -> dict[str, object]:
    """The workspace fingerprint of the repository holding cwd, as the engine computes it. With CONTENT_FLAG it also
    answers a digest of the contents of the files that differ from HEAD, which tells an edit whose files kept their size
    and time from the same files."""
    unknown = [flag for flag in flags if flag != CONTENT_FLAG]
    if unknown:
        raise CheckpointError(f"fingerprint takes {CONTENT_FLAG} and nothing else, got {unknown}")
    root = repository_root(cwd)
    value = fingerprint(root)
    assert value and value == value.strip(), f"the fingerprint of {root} is {value!r}; it must be text without spaces around it"
    assert root.is_dir(), f"{root} is not a directory to fingerprint"
    if CONTENT_FLAG not in flags:
        return {"fingerprint": value}
    return {"fingerprint": value, "content": content_fingerprint(root, uncommitted(root))}


def allowlist(root: Path) -> tuple[str, ...]:
    """The paths and globs `"tcr": {"allow": [...]}` in the repository's .overwatch.json lets a checkpoint commit although
    their name or content looks like a secret; none when the file or the setting is absent. The settings are read as the
    hook reads them, so a mistake in them is the same ConfigurationError, naming the field."""
    try:
        settings = json.loads((root / ".overwatch.json").read_text())
    except FileNotFoundError:
        return ()
    except (OSError, json.JSONDecodeError) as error:
        raise CheckpointError(f"could not read {root / '.overwatch.json'}: {error}") from error
    allow = read_settings(settings if isinstance(settings, dict) else {}).allow
    assert isinstance(allow, tuple), f"tcr.allow read as {type(allow)}, not a tuple of paths"
    assert all(entry.strip() for entry in allow), f"tcr.allow {allow} holds an empty entry, which would name every path"
    return allow


def expected_fingerprint(flags: tuple[str, ...]) -> str | None:
    """The fingerprint that EXPECT_FLAG names, or None when the caller expects none. Any other flag is a CheckpointError."""
    if not flags:
        return None
    if len(flags) != 2 or flags[0] != EXPECT_FLAG or not flags[1]:
        raise CheckpointError(f"checkpoint takes {EXPECT_FLAG} FINGERPRINT and nothing else, got {list(flags)}")
    assert flags[1] == flags[1].strip(), f"the expected fingerprint {flags[1]!r} has spaces around it"
    assert flags[0] == EXPECT_FLAG, f"the flag {flags[0]!r} is not {EXPECT_FLAG}"
    return flags[1]


def checkpoint_answer(cwd: Path, flags: tuple[str, ...]) -> dict[str, object]:
    """Commits as checkpoint does and answers with the commit, or, when the checkpoint was refused, with each refusal and no
    commit. A caller that names the fingerprint of the files it judged gets no commit and `changed` when the files differ
    from it now; only the moments between that look and the staging of the files are left open."""
    expected = expected_fingerprint(flags)
    root = repository_root(cwd)
    if expected is not None and fingerprint(root) != expected:
        return {"commit": None, "refused": [], "changed": True}
    try:
        commit = checkpoint(root, allow=allowlist(root))
    except Refused as refused:
        return {"commit": None, "refused": [{"path": each.path, "rule": each.rule, "line": each.line} for each in refused.refusals], "changed": False}
    assert commit is None or len(commit) in (40, 64), f"the checkpoint named {commit!r}, which is no commit"
    assert root.is_dir(), f"{root} is not the repository the checkpoint was made in"
    return {"commit": commit, "refused": [], "changed": False}


def revert_answer(cwd: Path, flags: tuple[str, ...]) -> dict[str, object]:
    """Reverts as revert does, saving what it discards in a ref unless asked not to, and answers whether it changed the
    files and the ref that holds what it removed, with `staged` when that ref also holds a version that only the index held,
    in its second parent. A tree that already matches the latest commit is left alone. A caller
    that names the fingerprint of the files it judged gets nothing reverted and `changed` when the files differ from it now."""
    try:
        expected = expected_fingerprint(tuple(flag for flag in flags if flag != NO_SAVE_REF_FLAG))
    except CheckpointError as error:
        raise CheckpointError(f"revert takes {NO_SAVE_REF_FLAG} and {EXPECT_FLAG} FINGERPRINT and nothing else, got {list(flags)}") from error
    root = repository_root(cwd)
    if expected is not None and fingerprint(root) != expected:
        return {"reverted": False, "saved": None, "changed": True}
    reverted = bool(uncommitted(root))
    saved = revert(cwd, save_ref=NO_SAVE_REF_FLAG not in flags) if reverted else None
    assert reverted or saved is None, f"a revert that changed nothing named the ref {saved}"
    assert not reverted or not uncommitted(root), f"{root} still differs from HEAD after a revert that said it restored it"
    answer: dict[str, object] = {"reverted": reverted, "saved": saved}
    if saved is not None and has_staged_copy(root, saved):
        answer["staged"] = True
    return answer


COMMANDS: dict[str, Callable[[Path, tuple[str, ...]], dict[str, object]]] = {
    "reason": reason_answer,
    "fingerprint": fingerprint_of,
    "checkpoint": checkpoint_answer,
    "revert": revert_answer,
}


def main(argv: list[str]) -> int:
    """Runs one command of COMMANDS on the repository holding the directory argv names, for callers that are not Python,
    and prints its answer as one JSON line. A command it does not know, a refusal or a failure prints its error as JSON
    and exits FAILURE."""
    if len(argv) < 2 or argv[0] not in COMMANDS:
        print(json.dumps({"error": f"usage: checkpoint.py {{{'|'.join(COMMANDS)}}} DIRECTORY [FLAGS]; got {argv}"}))
        return FAILURE
    try:
        answer = COMMANDS[argv[0]](Path(argv[1]), tuple(argv[2:]))
    except ConfigurationError as error:
        print(json.dumps({"error": str(error)}))
        return FAILURE
    except SCREENING_FAILURES as error:
        print(json.dumps({"error": str(error) if isinstance(error, CheckpointError) else f"{argv[0]} stopped on an unexpected {type(error).__name__}: {error}"}))
        return FAILURE
    assert "\n" not in json.dumps(answer), f"the answer to {argv[0]} spans lines; print it as one JSON line"
    assert isinstance(answer, dict), f"the answer to {argv[0]} is {answer!r}, not a JSON object"
    print(json.dumps(answer))
    return 0
