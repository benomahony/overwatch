#!/usr/bin/env python3
"""Writes tests/fixtures/git-commands.ts from git-commands.json, since a Claude Code plugin test cannot import JSON.

The JSON lists the shell commands the Python and the TypeScript command readers must both tell apart; run this after
editing it, and tests/test_codex.py fails while the two differ.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "tests" / "fixtures" / "git-commands.json"
TARGET = ROOT / "tests" / "fixtures" / "git-commands.ts"
HEADER = "// Generated from git-commands.json by `python3 scripts/git_commands.py`. Edit that file, not this one.\n"
GROUPS = ("bringing", "commits", "unseen")


def render_commands() -> str:
    """Returns the TypeScript module for git-commands.ts: the header, then git-commands.json as one exported constant."""
    corpus = json.loads(SOURCE.read_text())
    assert isinstance(corpus, dict) and set(corpus) == set(GROUPS), f"{SOURCE.name} holds {sorted(corpus) if isinstance(corpus, dict) else type(corpus).__name__}, not {GROUPS}; keep exactly those groups"
    assert all(isinstance(command, str) for group in GROUPS for command in corpus[group]), f"{SOURCE.name} has a command that is not a string; write each as text"
    module = f"{HEADER}export const COMMANDS = {json.dumps(corpus, indent=2, ensure_ascii=False)}\n"
    assert json.loads(module.removeprefix(f"{HEADER}export const COMMANDS = ")) == corpus, f"{TARGET.name} would not round-trip {SOURCE.name}; check the json.dumps options"
    assert module.startswith(HEADER) and module.endswith("}\n"), f"{TARGET.name} lost its header or closing brace; render both"
    return module


if __name__ == "__main__":
    TARGET.write_text(render_commands())
