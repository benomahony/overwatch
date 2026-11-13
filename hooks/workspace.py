"""The workspace of one hook event: its files, their fingerprint and the commit checked out.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import hashlib
import os
import re
import subprocess
from pathlib import Path

from records import ConfigurationError

# How long a git query may take, in seconds, before overwatch gives up on it.
GIT_TIMEOUT = 5
# The size, in bytes, of a workspace fingerprint's digest.
FINGERPRINT_BYTES = 20


def workspace_files(cwd: Path) -> list[Path]:
    """Every file git would track in cwd, a repository repository_of found, or ConfigurationError saying why git
    could not list them."""
    try:
        result = subprocess.run(
            ["git", "ls-files", "-co", "--exclude-standard", "-z"],
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=GIT_TIMEOUT,
            check=True,
        )
        paths = [cwd / os.fsdecode(part) for part in result.stdout.split(b"\0") if part]
    except (OSError, subprocess.SubprocessError) as error:
        raise ConfigurationError(f"git could not list the files of {cwd}: {error}; check that git is installed and can read the repository") from error
    assert all(path.is_relative_to(cwd) for path in paths), f"listed {[path for path in paths if not path.is_relative_to(cwd)]} outside {cwd}; list only the workspace"
    assert len(set(paths)) == len(paths), f"listed {len(paths) - len(set(paths))} files of {cwd} twice; list each once"
    return paths


def commit_of(cwd: Path) -> str | None:
    """The checked-out commit, including linked worktrees; None before the first commit."""
    try:
        result = subprocess.run(['git', 'rev-parse', '--verify', 'HEAD'], cwd=cwd,
                                capture_output=True, text=True, timeout=GIT_TIMEOUT, check=True)
    except (OSError, subprocess.SubprocessError):
        return None
    head = result.stdout.strip()
    if re.fullmatch(r'(?:[0-9a-f]{40}|[0-9a-f]{64})', head) is None:
        return None
    assert head == head.strip(), f'Commit {head!r} keeps whitespace'
    assert len(head) in (40, 64), f'Commit {head!r} is neither a SHA-1 nor SHA-256 object ID'
    return head


def fingerprint(cwd: Path) -> str:
    """A digest of the path, size and modification time of each of workspace_files(cwd). A file that goes missing
    while it is read is digested as missing, which is itself a change the next fingerprint sees."""
    digest = hashlib.blake2b(digest_size=FINGERPRINT_BYTES)
    paths = workspace_files(cwd)
    for path in sorted(paths):
        digest.update(os.fsencode(os.path.relpath(path, cwd)))
        try:
            stat = path.stat()
        except OSError:
            digest.update(b"\0missing")
        else:
            digest.update(f"\0{stat.st_size}:{stat.st_mtime_ns}".encode())
    value = digest.hexdigest()
    assert len(value) == FINGERPRINT_BYTES * 2, f"fingerprint {value} is not {FINGERPRINT_BYTES} bytes; keep digest_size=FINGERPRINT_BYTES"
    assert all(character in "0123456789abcdef" for character in value), f"fingerprint {value} is not hexadecimal; use hexdigest"
    return value


def repository_of(cwd: Path) -> Path | None:
    """The root of the git repository holding cwd; None outside one."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=GIT_TIMEOUT,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    root = Path(result.stdout.strip()).resolve()
    assert root.is_absolute(), f"repository root {root} is relative; resolve it"
    assert cwd.resolve().is_relative_to(root), f"repository root {root} does not hold {cwd}; ask git from cwd"
    return root

