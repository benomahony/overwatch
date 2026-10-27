#!/usr/bin/env python3
"""Writes hooks/table.ts from watchers.json, since a Claude Code plugin module cannot import JSON.

Run it after editing watchers.json; tests/test_codex.py fails while the two differ.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from types import MappingProxyType

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "watchers.json"
TARGET = ROOT / "hooks" / "table.ts"


HEADER = "// Generated from watchers.json by `python3 scripts/table.py`. Edit that file, not this one.\n"
SECTIONS = {"search": dict, "environment": list, "watchers": list, "checkers": list}


def parse(text: str) -> Mapping[str, object]:
    """Parses watchers.json, raising ValueError that names the section or entry to fix when its shape is wrong."""
    try:
        table = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError(f"{SOURCE.name} is not valid JSON at line {error.lineno}; fix it there") from error
    if not isinstance(table, dict):
        raise ValueError(f"{SOURCE.name} must hold an object with {sorted(SECTIONS)}; it holds a {type(table).__name__}")
    for section, kind in SECTIONS.items():
        if not isinstance(table.get(section), kind):
            raise ValueError(f"{SOURCE.name} needs a {section!r} {kind.__name__}; add or fix it")
    for entry in [*table["watchers"], *table["checkers"]]:
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str) or not isinstance(entry.get("marker"), str):
            raise ValueError(f"every watcher and checker in {SOURCE.name} needs a string name and marker; fix {entry}")
    shapes = {section: type(table[section]).__name__ for section in SECTIONS}
    assert shapes == {section: kind.__name__ for section, kind in SECTIONS.items()}, f"parse accepted sections shaped {shapes}; its checks above missed one"
    unnamed = [entry for entry in [*table["watchers"], *table["checkers"]] if not entry["name"]]
    assert not unnamed, f"parse accepted entries with empty names {unnamed}; require a non-empty name above"
    return MappingProxyType(table)


def render() -> str:
    """Returns the TypeScript module for hooks/table.ts: the header, then watchers.json as one exported constant."""
    table = parse(SOURCE.read_text())
    body = json.dumps(dict(table), indent=2, ensure_ascii=False)
    module = f"{HEADER}export const TABLE = {body}\n"
    assert json.loads(module.removeprefix(f"{HEADER}export const TABLE = ")) == table, f"{TARGET.name} would not round-trip {SOURCE.name}; check the json.dumps options"
    assert module.count("\n") == body.count("\n") + 2, f"{TARGET.name} has {module.count(chr(10))} lines for a {body.count(chr(10)) + 1} line table; only the header and export line belong around it"
    return module


if __name__ == "__main__":
    TARGET.write_text(render())
