"""Which watchers a project runs: the table in watchers.json, the project's .overwatch.json, and the markers and
sub-projects that select each language's watcher.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import json
import os
from pathlib import Path, PurePosixPath
import re
from typing import Any, Required, TypedDict

from unix import is_private, on_path


OVERRIDE_PATH = ".overwatch.json"


# The table every runtime reads; patterns are JavaScript regexes that Python reads the same way.
# Alternatives of one language are tried in order: the first whose marker, and tool if it needs one, are present runs.
TABLE: dict[str, Any] = json.loads((Path(__file__).resolve().parent.parent / "watchers.json").read_text())


class Watcher(TypedDict, total=False):
    """A check overwatch can run: a watchers.json entry, whose fields scripts/table.py checks, after apply_override,
    which checks each field it takes from .overwatch.json. Patterns are regular expressions as strings, argv and
    baseline lists of strings, and dir a POSIX path relative to the repository."""
    name: Required[str]
    marker: Required[str]
    language: str
    requires: str
    argv: list[str] | None
    baseline: list[str] | None
    summary: str
    failed: str
    result: str
    failure: str
    dir: str
    env: dict[str, str]


WATCHERS: tuple[Watcher, ...] = tuple(TABLE["watchers"])


CHECKERS: tuple[Watcher, ...] = tuple(TABLE["checkers"])


# A language the project's root lacks is looked for in the directories this many levels down, leaving out hidden ones
# and these.
SEARCH_DEPTH: int = TABLE["search"]["depth"]


SEARCH_SKIP: frozenset[str] = frozenset(TABLE["search"]["skip"])


class ConfigurationError(Exception):
    """The project, its .overwatch.json or the hook event cannot be used; the message says what to change."""


def read_override(cwd: Path) -> dict[str, Any]:
    """The project's .overwatch.json, which may name commands to run, so it is read only when the user running the
    hook owns it; none when there is none."""
    path = cwd / OVERRIDE_PATH
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as error:
        raise ConfigurationError(f"could not read {path}: {error}; fix the JSON in it") from error
    if not is_private(path):
        raise ConfigurationError(f"{path} is owned or writable by another user, so its commands are not run; make it yours alone with chmod go-w or remove it")
    if not isinstance(value, dict):
        raise ConfigurationError(f"{path} must contain a JSON object")
    assert path.name == OVERRIDE_PATH, f"read {path} instead of {OVERRIDE_PATH}; build the path from cwd and OVERRIDE_PATH"
    assert all(isinstance(key, str) for key in value), f"{path} gave keys {list(value)}; read it with json.loads"
    return value


def string_list(value: Any, field: str) -> list[str] | None:
    """value as a list of strings, None when it is absent, or ConfigurationError naming field when it is neither."""
    assert field in ("argv", "baseline"), f"string_list was asked for field {field}; only argv and baseline are lists of strings"
    if value is None:
        return None
    strings = [item for item in value if isinstance(item, str)] if isinstance(value, list) else None
    if strings is None or len(strings) != len(value):
        raise ConfigurationError(f"{OVERRIDE_PATH} field {field!r} must be an array of strings")
    assert strings == value, f"{field} kept {len(strings)} of {len(value)} items; reject any item that is not a string"
    return strings


# The settings a watcher takes in seconds, each with what it times.
SECONDS = {"timeout": "a check may run", "settle": "a watch command must stay inactive to have settled"}


def seconds_of(watcher: Watcher, field: str, default: float) -> float:
    """The watcher's setting field in seconds, which apply_override checked, else default."""
    assert field in SECONDS and default > 0, f"seconds_of was asked for {field!r} with default {default}; ask for one of {sorted(SECONDS)} with a positive default"
    seconds = watcher.get(field, default)
    assert isinstance(seconds, (int, float)) and seconds > 0, f"{watcher.get('name')} has {field} {seconds!r}; apply_override checks it is a positive number"
    return float(seconds)


def apply_override(watcher: Watcher, override: dict[str, Any]) -> Watcher:
    result = dict(watcher)
    result["language"] = watcher.get("language", watcher["name"])
    for field in (field for field in ("name", "summary", "failed", "argv", "baseline", *SECONDS) if field in override):
        value = override[field]
        if field in ("argv", "baseline"):
            result[field] = string_list(value, field)
        elif field in SECONDS:
            # bool is an int in Python, and true seconds is no time anyone means.
            if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
                raise ConfigurationError(f"{OVERRIDE_PATH} field {field!r} is {value!r}; give the seconds {SECONDS[field]} as a positive number")
            result[field] = value
        elif isinstance(value, str):
            result[field] = value
        else:
            raise ConfigurationError(f"{OVERRIDE_PATH} field {field!r} must be a string")
    try:
        for field in ("summary", "result", "failure"):
            if field in result:
                re.compile(result[field], re.MULTILINE)
        if "failed" in result:
            re.compile(result["failed"])
    except re.error as error:
        raise ConfigurationError(f"invalid regular expression in {OVERRIDE_PATH}: {error}") from error
    assert result["language"] == language_of(watcher), f"override changed {watcher['name']}'s language to {result['language']}; overrides may not set it"
    assert set(result) >= set(watcher), f"override dropped {set(watcher) - set(result)} from {watcher['name']}; copy every field of the watcher"
    return result


SETTINGS = ("enabled", "argv", "baseline", "summary", "failed", "env", *SECONDS)


def settings_of(name: str, override: dict[str, Any]) -> dict[str, Any]:
    """The settings .overwatch.json gives the watchers.json entry called name under "watchers", each field checked
    for its type; empty when it gives none."""
    assert name in {entry["name"] for entry in (*WATCHERS, *CHECKERS)}, f"settings_of was asked for {name!r}; pass a watchers.json entry's name"
    assert isinstance(override, dict), f"settings_of was given {override!r}; pass what read_override returned"
    entries = override.get("watchers", {})
    if not isinstance(entries, dict):
        raise ConfigurationError(f"{OVERRIDE_PATH} field 'watchers' is {entries!r}, not an object; key it by watchers.json names")
    settings = entries.get(name, {})
    if not isinstance(settings, dict):
        raise ConfigurationError(f"{OVERRIDE_PATH} watchers.{name} is {settings!r}, not an object; give it {', '.join(SETTINGS)}")
    unknown = sorted(set(settings) - set(SETTINGS))
    if unknown:
        raise ConfigurationError(f"{OVERRIDE_PATH} watchers.{name} has unknown fields {unknown}; use {', '.join(SETTINGS)}")
    if not isinstance(settings.get("enabled", True), bool):
        raise ConfigurationError(f"{OVERRIDE_PATH} watchers.{name}.enabled is {settings['enabled']!r}, not a boolean; set it to true or false")
    env = settings.get("env", {})
    if not isinstance(env, dict) or not all(isinstance(value, str) for value in env.values()):
        raise ConfigurationError(f"{OVERRIDE_PATH} watchers.{name}.env is {env!r}; make it an object of string values")
    assert set(settings) <= set(SETTINGS), f"settings_of accepted {sorted(settings)} for {name}; refuse fields outside SETTINGS"
    return settings


def configure(watcher: Watcher, override: dict[str, Any]) -> Watcher | None:
    """The watcher with the settings .overwatch.json gives its watchers.json name under "watchers", its env merged
    over the entry's; None when they turn it off. A sub-project's watcher takes its entry's settings."""
    name = watcher["name"]
    settings = settings_of(name, override)
    if settings.get("enabled") is False:
        return None
    env = settings.get("env", {})
    result = apply_override(watcher, {field: settings[field] for field in ("argv", "baseline", "summary", "failed", *SECONDS) if field in settings})
    if env or "env" in watcher:
        result["env"] = {**watcher.get("env", {}), **env}
    assert result["name"] == name, f"settings for {name} renamed it {result['name']}; keep the entry's name"
    assert all(result["env"][key] == value for key, value in env.items()), f"{name}'s env {result.get('env')} lost the project's {env}; merge it over the entry's"
    return result


def language_of(watcher: Watcher) -> str:
    """The language a watcher checks: its language field, else its name. Watchers come from watchers.json, whose
    entries scripts/table.py checks, or through apply_override, which checks each field it takes from .overwatch.json;
    a language that is still not a non-empty string is reported as a configuration error."""
    language = watcher.get("language", watcher.get("name"))
    if not isinstance(language, str) or not language:
        raise ConfigurationError(f"watcher {watcher.get('name')!r} has language {language!r}; set a non-empty language or name in watchers.json")
    assert language in (watcher.get("language"), watcher.get("name")), f"watcher {watcher.get('name')} got language {language}, neither its language nor its name"
    assert "language" in watcher or language == watcher.get("name"), f"watcher {watcher.get('name')} got language {language}; fall back to its name"
    return language


def marker_in(directory: Path, marker: str) -> Path:
    """The path of marker inside directory. Markers come from watchers.json alone, and each must be a relative path
    with no parent steps, so a marker can only name a file within the directory it is looked for in."""
    relative = PurePosixPath(marker)
    if not marker or relative.is_absolute() or ".." in relative.parts:
        raise ConfigurationError(f"marker {marker!r} must be a relative path inside the project; fix it in watchers.json")
    path = directory.joinpath(*relative.parts)
    assert path.is_relative_to(directory), f"marker {marker} resolved to {path}, outside {directory}"
    assert path.name == relative.name, f"marker {marker} became {path}; join its parts in order"
    return path


def subproject(cwd: Path, directory: str) -> Path:
    """The directory a sub-project path names inside cwd. Overwatch writes sub-project paths in POSIX form, the form
    find_subprojects builds, and joins them part by part, so the platform's own separator is used."""
    parts = PurePosixPath(directory).parts
    path = cwd.joinpath(*parts)
    assert path.is_relative_to(cwd), f"sub-project {directory} is outside {cwd}; keep sub-project paths relative"
    assert len(path.parts) == len(cwd.parts) + len(parts), f"sub-project {directory} joined to {path}; join each part once"
    return path


def first_present(alternatives: list[Watcher], directory: Path) -> Watcher | None:
    """The first of a language's alternatives whose marker is in directory and whose tool, if it needs one, is on PATH."""
    assert len({language_of(watcher) for watcher in alternatives}) <= 1, f"alternatives span {[watcher['name'] for watcher in alternatives]}; pass one language's"
    present = next((watcher for watcher in alternatives
                    if marker_in(directory, watcher["marker"]).exists() and ("requires" not in watcher or on_path(watcher["requires"]))), None)
    assert present is None or directory.is_dir(), f"found {present['name'] if present else ''} in {directory}, which is not a directory"
    return present


def find_subprojects(cwd: Path) -> list[str]:
    """The directories SEARCH_DEPTH levels down, relative to cwd as POSIX paths, nearest and then alphabetically
    first. Links are not followed, so a link to a directory is not searched on any platform."""
    found: list[str] = []
    parents = [""]
    for _ in range(SEARCH_DEPTH):
        level: list[str] = []
        for parent in parents:
            try:
                entries = list(os.scandir(subproject(cwd, parent)))
            except OSError:
                continue
            for entry in entries:
                if entry.is_dir(follow_symlinks=False) and not entry.name.startswith(".") and entry.name not in SEARCH_SKIP:
                    level.append(PurePosixPath(parent, entry.name).as_posix())
        level.sort()
        found.extend(level)
        parents = level
    assert len(set(found)) == len(found), f"subprojects {found} repeat a directory; visit each parent once"
    assert all(part.count("/") < SEARCH_DEPTH for part in found), f"subprojects {found} go past {SEARCH_DEPTH} levels; stop at SEARCH_DEPTH"
    return found


def alternatives_of(language: str, override: dict[str, Any]) -> list[Watcher]:
    """The language's watchers.json entries in order, configured by .overwatch.json, leaving out those it turns off."""
    assert any(language_of(watcher) == language for watcher in WATCHERS), f"alternatives_of was asked for {language!r}, which no watchers.json entry checks"
    assert isinstance(override, dict), f"alternatives_of was given {override!r}; pass what read_override returned"
    configured = [configure(watcher, override) for watcher in WATCHERS if language_of(watcher) == language]
    kept = [watcher for watcher in configured if watcher is not None]
    assert all(language_of(watcher) == language for watcher in kept), f"alternatives of {language} include {[watcher['name'] for watcher in kept]}; keep one language's"
    return kept


def find_project_watchers(cwd: Path, override: dict[str, Any]) -> list[Watcher]:
    # One watcher for each language the project has, or else for each sub-project that has it, one not inside
    # another that does; the override applies to the first. Sub-projects are POSIX paths relative to cwd, joined
    # onto it part by part, so they read the same on every platform.
    found: list[Watcher] = []
    subprojects: list[str] | None = None
    for language in dict.fromkeys(language_of(watcher) for watcher in WATCHERS):
        alternatives = alternatives_of(language, override)
        at_root = first_present(alternatives, cwd)
        if at_root is not None:
            found.append(apply_override(at_root, override if not found else {}))
            continue
        if subprojects is None:
            subprojects = find_subprojects(cwd)
        claimed: list[str] = []
        for directory in subprojects:
            if any(PurePosixPath(directory).is_relative_to(parent) for parent in claimed):
                continue
            watcher = first_present(alternatives, subproject(cwd, directory))
            if watcher is None:
                continue
            claimed.append(directory)
            labelled = {**watcher, "language": language, "name": f"{watcher['name']} {directory}", "dir": directory}
            found.append(apply_override(labelled, override if not found else {}))
    keys = [key_of(watcher["name"], watcher.get("dir")) for watcher in found]
    assert len(set(keys)) == len(keys), f"watchers {keys} repeat a check; find each language once per directory"
    assert not any(Path(watcher.get("dir", "")).is_absolute() for watcher in found), f"watchers {keys} hold an absolute dir; keep dirs relative to {cwd}"
    return found


def find_watchers(cwd: Path) -> list[Watcher]:
    """The watchers and checkers to run in cwd, after its .overwatch.json override."""
    override = read_override(cwd)
    if override.get("enabled") is False:
        return []
    if "enabled" in override and not isinstance(override["enabled"], bool):
        raise ConfigurationError(f"{OVERRIDE_PATH} field 'enabled' is {override['enabled']!r}, not a boolean; set it to true or false")

    found = find_project_watchers(cwd, override)
    if not found:
        argv = string_list(override.get("argv"), "argv")
        baseline = string_list(override.get("baseline"), "baseline")
        complete = isinstance(override.get("summary"), str) and isinstance(override.get("failed"), str)
        if (argv is not None or baseline) and complete:
            found.append(apply_override(
                {"name": "project", "language": "project", "marker": OVERRIDE_PATH, "summary": r"$^", "failed": r"$^"},
                override,
            ))

    # A checker runs wherever its executable is on PATH.
    for checker in CHECKERS:
        configured = configure(checker, override)
        if configured is not None and on_path(checker["marker"]):
            found.append(dict(configured))
    assert all("name" in watcher for watcher in found), f"found {found} with an unnamed watcher; give every watcher a name in watchers.json"
    keys = [key_of(watcher["name"], watcher.get("dir")) for watcher in found]
    assert len(set(keys)) == len(found), f"found {keys} in {cwd}; add each checker only when no watcher has its name"
    return found


def key_of(name: str, directory: str | None) -> str:
    """What identifies a check across runs: its name and the sub-project it ran in, joined by a NUL neither can hold."""
    if "\0" in name or "\0" in (directory or ""):
        raise ConfigurationError(f"check {name!r} in {directory!r} holds a NUL character; remove it from its name in .overwatch.json")
    key = f"{name}\0{directory or ''}"
    assert key.split("\0") == [name, directory or ""], f"key {key!r} does not split back into {name!r} and {directory!r}"
    assert key.count("\0") == 1, f"key {key!r} holds {key.count(chr(0))} separators; join exactly two fields"
    return key
