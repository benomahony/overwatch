"""The allow list of the "tcr" object of .overwatch.json, and the error for a mistake in it.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

from discovery import OVERRIDE_PATH, ConfigurationError

SETTINGS_FIELD = "tcr"
ALLOW_FIELD = "allow"
WILDCARDS = frozenset("*/?[]")


def setting_error(field: str, value: object, wanted: str) -> ConfigurationError:
    """The error for a "tcr" field of the wrong type: it names the field, what it holds and what it must hold."""
    error = ConfigurationError(f"{OVERRIDE_PATH} field '{SETTINGS_FIELD}.{field}' is {value!r}, not {wanted}")
    assert field, "the error names no field"
    assert wanted, f"the error {error} does not say what the field must hold"
    return error


def validate_allow(allow: object) -> tuple[str, ...]:
    """The allowlist as a tuple of paths and globs, or ConfigurationError when it is not a list of texts that each name
    something: an entry that is empty, or only wildcards, would allow every file."""
    named = isinstance(allow, (list, tuple)) and all(isinstance(entry, str) and entry.strip() and not set(entry.strip()) <= WILDCARDS for entry in allow)
    if not named:
        raise setting_error(ALLOW_FIELD, list(allow) if isinstance(allow, tuple) else allow, "a list of paths or globs that name files; an entry may not be empty or only wildcards")
    entries = tuple(allow)
    assert all(entry.strip() for entry in entries), f"validate_allow kept an empty entry in {entries}"
    assert all(not set(entry.strip()) <= WILDCARDS for entry in entries), f"validate_allow kept an entry of only wildcards in {entries}"
    return entries
