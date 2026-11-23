"""Runs engine/engine.py in a real process whose event handling fails with a given error, for tests of what the entry point does with a bug.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from paths import ROOT

PROCESS_SECONDS = 60
PREVIEW_CHARACTERS = 40


def run_engine_that_fails_with(error: Exception, event: str) -> subprocess.CompletedProcess[str]:
    """The finished process of engine.main given event on stdin, with process_event replaced by one that raises error."""
    assert type(error).__name__ in repr(error), f"{error!r} does not name its type, so the process could not raise it again; pass a plain exception"
    assert event.startswith("{"), f"event {event[:PREVIEW_CHARACTERS]!r} is not a JSON object; the engine reads one from stdin"
    script = f"import engine\ndef broken(*arguments, **options):\n    raise {error!r}\nengine.process_event = broken\nengine.main()"
    finished = subprocess.run([sys.executable, "-c", script], input=event, capture_output=True, text=True,
                              env={**os.environ, "PYTHONPATH": str(ROOT / "engine")}, timeout=PROCESS_SECONDS, check=False)
    assert isinstance(finished.returncode, int), f"the engine process ended with {finished.returncode!r}, not an exit code"
    return finished


def run_engine_that_answers(output: dict[str, object], event: str) -> subprocess.CompletedProcess[bytes]:
    """The finished process of engine.main given event on stdin, with process_event replaced by one that gives output, and a stdout that encodes strictly as ASCII-safe UTF-8 would not need."""
    assert event.startswith("{"), f"event {event[:PREVIEW_CHARACTERS]!r} is not a JSON object; the engine reads one from stdin"
    script = f"import engine\nengine.process_event = lambda *arguments, **options: {output!r}\nengine.main()"
    finished = subprocess.run([sys.executable, "-c", script], input=event.encode(), capture_output=True, timeout=PROCESS_SECONDS, check=False,
                              env={**os.environ, "PYTHONPATH": str(ROOT / "engine"), "PYTHONIOENCODING": "utf-8:strict"})
    assert isinstance(finished.returncode, int), f"the engine process ended with {finished.returncode!r}, not an exit code"
    return finished


def run_triage(inventory: Path) -> subprocess.CompletedProcess[str]:
    """The finished triage command given the inventory file at inventory."""
    assert inventory.is_file(), f"{inventory} is no inventory file to give triage"
    finished = subprocess.run([sys.executable, str(ROOT / "engine" / "triage.py"), str(inventory)], capture_output=True, text=True, timeout=PROCESS_SECONDS, check=False)
    assert isinstance(finished.returncode, int), f"triage ended with {finished.returncode!r}, not an exit code"
    return finished


def run_engine_on_strict_stdin(event: bytes) -> subprocess.CompletedProcess[bytes]:
    """The finished engine given the bytes event on a stdin that decodes strictly, whatever the locale of the machine."""
    assert event, "no bytes were given for the engine to read"
    finished = subprocess.run([sys.executable, str(ROOT / "engine" / "engine.py")], input=event, capture_output=True, timeout=PROCESS_SECONDS, check=False,
                              env={**os.environ, "PYTHONPATH": str(ROOT / "engine"), "PYTHONIOENCODING": "utf-8:strict"})
    assert isinstance(finished.returncode, int), f"the engine ended with {finished.returncode!r}, not an exit code"
    return finished
