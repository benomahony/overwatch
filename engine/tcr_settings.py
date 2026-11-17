"""The "tcr" object of .overwatch.json, read by the engine and by the checkpoint command alike, so that both give
the same error for the same mistake.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

from dataclasses import dataclass
from numbers import Real
from typing import Any

from discovery import OVERRIDE_PATH, ConfigurationError

SETTINGS_FIELD = "tcr"
SAVE_REVERTED_FIELD = "saveReverted"
HOST_LIMIT_FIELD = "hostLimitSeconds"
ALLOW_FIELD = "allow"
# The shortest time any host gives one hook run: 600 s in integrations/codex-hooks.json, and 550 s for the checker the
# in-process plugins start, engine/check.js's TIMEOUT_MS. A test holds this to those two files.
HOST_LIMIT_SECONDS = 550
WILDCARDS = frozenset("*/?[]")


@dataclass(frozen=True)
class Settings:
    """What the project's .overwatch.json says about how TCR behaves, apart from whether it runs."""
    save_reverted: bool
    host_limit_seconds: float
    allow: tuple[str, ...]


def setting_error(field: str, value: object, wanted: str) -> ConfigurationError:
    """The error for a "tcr" field of the wrong type: it names the field, what it holds and what it must hold."""
    error = ConfigurationError(f"{OVERRIDE_PATH} field '{SETTINGS_FIELD}.{field}' is {value!r}, not {wanted}")
    assert field in str(error) and OVERRIDE_PATH in str(error), f"the error {error} does not name the field {field} of {OVERRIDE_PATH}"
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


def read_settings(override: dict[str, Any]) -> Settings:
    """The project's "tcr" object: saveReverted, whether a revert keeps the work it discards in a git ref (true unless
    it says false); hostLimitSeconds, how long the host lets one hook run; and allow, the paths and globs that a
    checkpoint may commit although their name or content looks like a secret. ConfigurationError names the field that
    is wrong."""
    given = override.get(SETTINGS_FIELD, {})
    fields = (SAVE_REVERTED_FIELD, HOST_LIMIT_FIELD, ALLOW_FIELD)
    if not isinstance(given, dict):
        raise ConfigurationError(f"{OVERRIDE_PATH} field {SETTINGS_FIELD!r} is {given!r}, not an object; give it {', '.join(fields)}")
    unknown = sorted(set(given) - set(fields))
    if unknown:
        raise ConfigurationError(f"{OVERRIDE_PATH} field {SETTINGS_FIELD!r} has unknown fields {unknown}; use {', '.join(fields)}")
    save = given.get(SAVE_REVERTED_FIELD, True)
    limit = given.get(HOST_LIMIT_FIELD, HOST_LIMIT_SECONDS)
    if not isinstance(save, bool):
        raise setting_error(SAVE_REVERTED_FIELD, save, "a boolean; set it to true or false")
    if isinstance(limit, bool) or not isinstance(limit, Real) or limit <= 0:
        raise setting_error(HOST_LIMIT_FIELD, limit, "a positive number of seconds")
    settings = Settings(save, float(limit), validate_allow(given.get(ALLOW_FIELD, [])))
    assert limit > 0 and set(given) <= set(fields), f"read_settings accepted {given}"
    assert len(settings.allow) == len(given.get(ALLOW_FIELD, [])), f"read_settings kept {len(settings.allow)} of the allowed paths in {given}"
    return settings
