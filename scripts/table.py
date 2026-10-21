#!/usr/bin/env python3
"""Writes hooks/table.ts from watchers.json, since a Claude Code plugin module cannot import JSON.

Run it after editing watchers.json; tests/test_codex.py fails while the two differ.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "watchers.json"
TARGET = ROOT / "hooks" / "table.ts"


def render() -> str:
    table = json.loads(SOURCE.read_text())
    return (
        "// Generated from watchers.json by `python3 scripts/table.py`. Edit that file, not this one.\n"
        f"export const TABLE = {json.dumps(table, indent=2, ensure_ascii=False)}\n"
    )


if __name__ == "__main__":
    TARGET.write_text(render())
