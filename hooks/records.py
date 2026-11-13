"""The records overwatch's Codex hook keeps between events, and how they are read back from the JSON it saves:
a hook event, a check's report and first result, a session's files and its state. A saved file of another shape
raises StateError, and the session starts afresh.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import asdict, dataclass, field
from pathlib import Path

# What a StateError adds: what happens next, and what to do when it keeps happening.
REBUILT = "; the session starts afresh and reruns its checks, and if this repeats, delete the state files under PLUGIN_DATA"


OVERRIDE_PATH = ".overwatch.json"
# Tools that can change the workspace, by the names Codex, OpenCode and Pi give them. A change first seen at any other
# event came from another process, since each of these is followed by its own PostToolUse.
EDITING_TOOLS = frozenset({"apply_patch", "Bash", "bash", "Edit", "edit", "MultiEdit", "powershell", "shell", "Write", "write"})


class ConfigurationError(Exception):
    """The project, its .overwatch.json or the hook event cannot be used; the message says what to change."""


class StateError(ValueError):
    """The saved state does not have the shape save_state writes, so the session starts afresh."""


@dataclass(frozen=True)
class Event:
    """One hook event as read_event checked it: the fields overwatch reads, each a string, and the tool's input."""
    hook_event_name: str
    session_id: str
    cwd: str
    tool_name: str
    tool_input: object
    integration: str = ""


@dataclass(frozen=True)
class Report:
    """One check's result, as read_report reads it from the check's output."""
    name: str
    language: str
    command: str
    dir: str | None
    summary: str
    failed: bool
    failures: tuple[str, ...]
    environment: str | None
    text: str


@dataclass(frozen=True)
class First:
    """A check's first result in the session, its baseline: whether it failed, with what, and its summary."""
    failed: bool
    failures: tuple[str, ...]
    summary: str


@dataclass(frozen=True)
class Session:
    """The files of one session in one repository, named from the state file's path: the state, the triage
    inventory and the directory of full logs, whose lock orders the session's hooks. Only locked() makes one, and
    only for the block in which this process holds that lock, so a function given a Session writes files no other
    overwatch process is writing."""
    state: Path
    inventory: Path
    logs: Path


@dataclass(frozen=True)
class State:
    """What one session in one repository knows between hook events. Saved by save_state, read back by state_from."""
    reports: tuple[Report, ...] = ()
    baseline: Mapping[str, First] = field(default_factory=dict)
    failed: bool = False
    told: str | None = None
    signatures: tuple[str, ...] = ()
    inherited: str = "allow"
    fingerprint: str | None = None
    # The commit whose results established the current baselines; None in an unborn repository or older state.
    head: str | None = None
    environment: tuple[str, ...] = ()
    tcr: str | None = None


def string_tuple(value: object, where: str) -> tuple[str, ...]:
    """value as a tuple of strings, or StateError naming where it was read when it is not a list of strings."""
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise StateError(f"{where} must be a list of strings, not {type(value).__name__}{REBUILT}")
    strings = tuple(value)
    assert len(strings) == len(value), f"{where} kept {len(strings)} of {len(value)} strings; copy every item with tuple()"
    assert list(strings) == value, f"{where} reordered its strings; keep them in order"
    return strings


def check_fields(value: dict[str, object], names: tuple[str, ...], optional: tuple[str, ...], where: str) -> None:
    """Raises StateError naming each field of value that is not what save_state writes: each of names a string, each
    of optional a string or null, failed a boolean, and no field outside names, optional, failed and failures."""
    unexpected = sorted(set(value) - {*names, *optional, "failed", "failures"})
    if unexpected:
        raise StateError(f"{where} has fields {unexpected} save_state never writes{REBUILT}")
    given = {name: value.get(name) for name in (*names, *optional)}
    wrong = [name for name, item in given.items() if not isinstance(item, str) and not (item is None and name in optional)]
    if not isinstance(value.get("failed"), bool):
        wrong.append("failed")
    if wrong:
        raise StateError(f"{where} has fields {wrong} of the wrong type{REBUILT}")
    assert all(isinstance(value[name], str) for name in names), f"{where} passed with a field of {names} that is not a string; add it to the type check above"
    assert isinstance(value["failed"], bool), f"{where} passed with failed {value['failed']}, not a boolean; check it before returning"


def report_from(value: object) -> Report:
    """A report as save_state wrote it, or StateError naming the fields that do not match."""
    if not isinstance(value, dict):
        raise StateError(f"a saved report is a JSON {type(value).__name__}, not an object{REBUILT}")
    check_fields(value, ("name", "language", "command", "summary", "text"), ("dir", "environment"), "a saved report")
    report = Report(name=value["name"], language=value["language"], command=value["command"], dir=value.get("dir"),
                    summary=value["summary"], failed=value["failed"],
                    failures=string_tuple(value.get("failures"), f"saved report {value['name']}'s failures"),
                    environment=value.get("environment"), text=value["text"])
    assert report.name == value["name"] and report.failed == value["failed"], f"saved report {value['name']} changed while read; copy each field as save_state wrote it"
    assert list(report.failures) == value["failures"], f"saved report {report.name} lost failures; keep each in order"
    return report


def first_from(key: str, value: object) -> First:
    """A check's saved first result, or StateError naming the check whose entry does not match."""
    if not isinstance(value, dict):
        raise StateError(f"the baseline of {key!r} is a JSON {type(value).__name__}, not an object{REBUILT}")
    check_fields(value, ("summary",), (), f"the baseline of {key!r}")
    first = First(value["failed"], string_tuple(value.get("failures"), f"the baseline of {key!r}'s failures"), value["summary"])
    assert first.summary == value["summary"], f"the baseline of {key!r} changed its summary while read; copy it as save_state wrote it"
    assert list(first.failures) == value["failures"], f"the baseline of {key!r} lost failures; keep each in order"
    return first


def state_from(value: object) -> State:
    """A state as save_state wrote it, or StateError naming the part that does not match."""
    if not isinstance(value, dict):
        raise StateError(f"the saved state is a JSON {type(value).__name__}, not an object{REBUILT}")
    reports, baseline, gate = value.get("reports", []), value.get("baseline", {}), value.get("gate", {})
    told, fingerprint, head, tcr = value.get("told"), value.get("fingerprint"), value.get("head"), value.get("tcr")
    if not isinstance(reports, list) or not isinstance(baseline, dict) or not isinstance(gate, dict):
        raise StateError(f"the saved state's reports, baseline or gate is not a list, object and object{REBUILT}")
    if not isinstance(value.get("failed", False), bool) or not all(item is None or isinstance(item, str) for item in (told, fingerprint, head, tcr)):
        raise StateError(f"the saved state's failed, told, fingerprint, head or tcr has the wrong type{REBUILT}")
    if gate.get("inherited", "allow") not in ("allow", "block"):
        raise StateError(f"the saved state's gate.inherited is {gate.get('inherited')}, not allow or block{REBUILT}")
    state = State(
        reports=tuple(report_from(report) for report in reports),
        baseline={key: first_from(key, first) for key, first in baseline.items()},
        failed=value.get("failed", False),
        told=told,
        signatures=string_tuple(value.get("signatures", []), "the saved state's signatures"),
        inherited=gate.get("inherited", "allow"),
        fingerprint=fingerprint,
        head=head,
        environment=string_tuple(value.get("environment", []), "the saved state's environment"),
        tcr=tcr,
    )
    assert len(state.reports) == len(reports) and set(state.baseline) == set(baseline), f"state kept {len(state.reports)} of {len(reports)} reports or lost baseline entries; read every saved entry"
    assert state.fingerprint == fingerprint, f"state changed its fingerprint {fingerprint} while read; copy it as saved"
    return state


def digest_of(value: object) -> str:
    """The digest overwatch stores beside the JSON it saves, state or inventory, so it can tell a file it wrote whole
    from any other when it reads one back."""
    digest = hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
    assert len(digest) == 64, f"state digest {digest} is not a SHA-256 hex digest"
    assert digest == digest.lower(), f"state digest {digest} is not lower-case hex; use hexdigest"
    return digest


def state_json(state: State) -> dict[str, object]:
    """state as save_state writes it, the shape state_from reads."""
    value: dict[str, object] = {
        "reports": [asdict(report) for report in state.reports],
        "baseline": {key: asdict(first) for key, first in state.baseline.items()},
        "failed": state.failed,
        "told": state.told,
        "signatures": list(state.signatures),
        "gate": {"inherited": state.inherited},
        "fingerprint": state.fingerprint,
        "head": state.head,
        "environment": list(state.environment),
        "tcr": state.tcr,
    }
    assert len(value["reports"]) == len(state.reports), f"state JSON holds {len(value['reports'])} of {len(state.reports)} reports; write every report"
    assert value["gate"] == {"inherited": state.inherited}, f"state JSON gate {value['gate']} does not hold {state.inherited}; write the gate as state_from reads it"
    return value
