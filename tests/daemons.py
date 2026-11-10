"""Data directories for tests whose hooks start the watcher daemon.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import signal
import tempfile
import time
import unittest

# How long a stopped daemon may take to exit before cleanup removes its directory.
EXIT_SECONDS = 5.0
TICK_SECONDS = 0.05


def data_directory(test: unittest.TestCase) -> Path:
    """A new, empty data directory for test, under /tmp, since the daemon's Unix socket lives in it and a socket's
    path is limited to about a hundred bytes. When test ends, every daemon serving from it stops, then it is removed."""
    data = Path(tempfile.mkdtemp(dir="/tmp", prefix="ow")).resolve()
    test.addCleanup(shutil.rmtree, data)
    test.addCleanup(stop_daemons, data)
    assert data.is_dir() and not any(data.iterdir()), f"data directory {data} does not start empty"
    return data


def stop_daemons(data: Path) -> None:
    """Stops each daemon whose lock in data names it, and waits for it to exit, as an idle one would."""
    assert data.is_absolute(), f"stop_daemons was given {data}; pass the data directory's absolute path"
    pids = [int(text) for text in (lock.read_text().strip() for lock in data.glob("daemon-*.lock")) if text.isdigit()]
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            continue
    deadline = time.monotonic() + EXIT_SECONDS
    while any(is_running(pid) for pid in pids) and time.monotonic() < deadline:
        time.sleep(TICK_SECONDS)
    assert not any(is_running(pid) for pid in pids), f"daemons {pids} still serve {data} {EXIT_SECONDS}s after SIGTERM"


def is_running(pid: int) -> bool:
    """Whether a process with this id still runs. A test that runs the engine in-process is the parent of each daemon
    the engine starts, so a daemon that exited stays a zombie, which still takes signals, until the test reaps it."""
    assert pid > 0, f"is_running was asked about process {pid}; pass a real process id"
    try:
        if os.waitpid(pid, os.WNOHANG)[0] == pid:
            return False
    except ChildProcessError:
        pass  # Not this test's child: its own parent reaps it, and the signal below tells whether it still runs.
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def eventually(read, done, seconds: float = 10.0):
    """read() until done(its value) holds, or AssertionError with the last value once seconds pass."""
    assert seconds > 0, f"waiting {seconds}s is no wait; give a positive time"
    deadline = time.monotonic() + seconds
    value = read()
    while not done(value):
        if time.monotonic() > deadline:
            raise AssertionError(f"still {value!r} after {seconds}s")
        time.sleep(0.05)
        value = read()
    assert done(value), f"{value!r} was returned before it was done"
    return value
