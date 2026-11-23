"""Runs workspace.content_fingerprint in a process of its own, for tests of what it does on a file that blocks a read or is huge.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from paths import ROOT

FINGERPRINT = "import sys, workspace; from pathlib import Path; print(workspace.content_fingerprint(Path(sys.argv[1]), sys.argv[2:]))"
MEASURED = "import resource, sys, workspace; from pathlib import Path; workspace.content_fingerprint(Path(sys.argv[1]), sys.argv[2:]); print(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)"


def run_digest(root: Path, names: list[str], seconds: float, program: str) -> subprocess.CompletedProcess[str]:
    """The finished process of program over the files names in root; a process that is still running after seconds seconds is killed and raises TimeoutExpired."""
    assert root.is_dir(), f"{root} is no directory to fingerprint files in"
    assert seconds > 0, f"{seconds} seconds leaves no time to answer"
    finished = subprocess.run([sys.executable, "-c", program, str(root), *names], capture_output=True, text=True, env={**os.environ, "PYTHONPATH": str(ROOT / "engine")}, timeout=seconds, check=False)
    assert isinstance(finished.returncode, int), f"the fingerprint ended with {finished.returncode!r}, not an exit code"
    return finished
