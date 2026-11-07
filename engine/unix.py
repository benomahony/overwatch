"""The POSIX calls overwatch's engine makes, kept here so the rest of the hook is platform-neutral: an exclusive
file lock, waiting on a pipe for a command's output, and whether the current user owns a file.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import fcntl
import os
import selectors
import shutil
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import IO

# How long one read of a command's output waits for more, in seconds, and the most it reads at once, in bytes.
READ_WAIT = 0.1
READ_CHUNK = 65_536


@contextmanager
def exclusive(descriptor: int) -> Iterator[None]:
    """Waits for, then holds, an exclusive flock on the open file or directory descriptor for the block, and releases
    it however the block ends. The descriptor stays open: closing it is the caller's."""
    assert descriptor >= 0, f"lock descriptor {descriptor} is not an open one; pass what os.open returned"
    fcntl.flock(descriptor, fcntl.LOCK_EX)
    try:
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
    assert os.fstat(descriptor) is not None, f"lock descriptor {descriptor} closed inside the block; leave closing it to the caller"


def output_selector(stdout: IO[bytes]) -> selectors.BaseSelector:
    """A selector that read_available waits on for a command's output; on POSIX a pipe can be selected on."""
    selector = selectors.DefaultSelector()
    key = selector.register(stdout, selectors.EVENT_READ)
    assert key.fileobj is stdout, f"selector registered {key.fileobj}, not the command's output; register stdout"
    assert key.events == selectors.EVENT_READ, f"selector waits for events {key.events}; wait only to read"
    return selector


def read_available(selector: selectors.BaseSelector) -> bytes:
    """Whatever the registered output holds within READ_WAIT seconds, up to READ_CHUNK bytes; nothing when it holds none."""
    selected = selector.select(timeout=READ_WAIT)
    if not selected:
        return b""
    key, _ = selected[0]
    assert len(selected) == 1, f"selector watched {len(selected)} outputs; register only the command's output"
    chunk = os.read(key.fd, READ_CHUNK)
    assert len(chunk) <= READ_CHUNK, f"read {len(chunk)} bytes; read at most READ_CHUNK at once"
    return chunk


def try_exclusive(descriptor: int) -> bool:
    """Takes an exclusive flock on the open descriptor without waiting, and whether it got it. The lock lasts until the
    descriptor closes, which the process's exit does too, so a process that holds it for life never releases it."""
    assert descriptor >= 0, f"lock descriptor {descriptor} is not an open one; pass what os.open returned"
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return False
    assert os.fstat(descriptor) is not None, f"lock descriptor {descriptor} closed while it was locked"
    return True


def is_private(path: Path) -> bool:
    """Whether the existing file or directory at path is the current user's alone to change: owned by them, and not
    writable by its group or anyone else."""
    status, user = path.stat(), os.getuid()
    private = status.st_uid == user and not status.st_mode & (stat.S_IWGRP | stat.S_IWOTH)
    assert status.st_uid >= 0 and user >= 0, f"{path} has owner id {status.st_uid} and the user id {user}; read them with stat and getuid"
    assert not private or status.st_uid == user, f"{path} owned by {status.st_uid} was called private for user {user}; compare the owner first"
    return private


def on_path(name: str) -> bool:
    """Whether an executable named name is on PATH: on POSIX, an executable file of that name in a PATH directory."""
    found = shutil.which(name)
    assert found is None or Path(found).name == name, f"PATH lookup for {name} found {found}; look up the bare name"
    assert found is None or os.access(found, os.X_OK), f"PATH lookup for {name} found {found}, which is not executable"
    return found is not None
