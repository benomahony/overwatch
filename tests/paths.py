"""Puts hooks/ and scripts/ on the import path, as running them directly does, so tests import them by name."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

for directory in (ROOT / "hooks", ROOT / "scripts"):
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))
