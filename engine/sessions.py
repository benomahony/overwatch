"""Where and how one session's state is kept in the data directory: its lock, its saved state, the marker an
editing tool leaves, and the logs of its checks' failures, each named by a digest so no path is shaped by the
session or the project, and kept only in a directory no one else can write.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager

from discovery import ConfigurationError
from messages import report_key
from records import REBUILT, Event, Report, Session, State, StateError, digest_of, state_from, state_json
from unix import exclusive, is_private


@contextmanager
def locked(path: Path, root: Path) -> Iterator[Session]:
    """The session whose state is kept at path, which must lie in root, for the block, while this process holds an
    exclusive flock on the session's log directory, released however the block ends. The lock orders overwatch's own
    hook processes; it grants or refuses no one access to anything. The directory is one the session keeps for its
    logs, so taking the lock leaves nothing behind, and root and the directories this makes are writable by the user
    alone, so only the user's own processes can take it."""
    path = in_data(path, root)
    session = Session(state=path, inventory=path.with_suffix(".baseline.json"), logs=path.with_suffix(""))
    assert len({session.state, session.inventory, session.logs}) == 3, f"session files of {path} share a name; give each its own suffix"
    assert session.state.parent == root, f"session {session.state} is outside {root}; name it with state_path"
    session.logs.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(session.logs, os.O_RDONLY)
    try:
        with exclusive(descriptor):
            yield session
    finally:
        os.close(descriptor)


def data_root(given: str | None) -> Path:
    """The directory overwatch keeps session state in, resolved and made when missing: given, the PLUGIN_DATA the
    agent host passes the hook, else ~/.cache/overwatch. A directory another user owns or can write is refused, so no
    one else can plant or read the state, and a relative one, so state never lands relative to wherever the hook
    was started."""
    if given is not None and not Path(given).is_absolute():
        raise ConfigurationError(f"PLUGIN_DATA is {given!r}, not an absolute path; set it to the plugin's data directory")
    root = Path(given or Path.home() / ".cache" / "overwatch").resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not is_private(root):
        raise ConfigurationError(f"data directory {root} is owned or writable by another user; set PLUGIN_DATA to a directory only you can write")
    assert root.is_absolute(), f"data root {root} is relative; resolve it"
    assert root == root.resolve(), f"data root {root} still holds a link or a parent step; resolve it"
    return root


def in_data(path: Path, root: Path) -> Path:
    """path resolved, or ConfigurationError when it lies outside root, the only place overwatch keeps state."""
    resolved = path.resolve()
    if not resolved.is_relative_to(root):
        raise ConfigurationError(f"state file {path} is outside {root}; set PLUGIN_DATA to the directory that holds it")
    assert resolved.is_absolute() and ".." not in resolved.parts, f"state file {resolved} is not a plain absolute path"
    assert resolved.is_relative_to(root), f"state file {resolved} escaped {root}"
    return resolved


def state_path(event: Event, cwd: Path, data: Path) -> Path:
    """Where in data the state of one session in one repository is kept: named by a digest of both, so neither
    shapes the path."""
    identity = f"{event.session_id}\0{cwd}"
    path = data / f"{hashlib.sha256(identity.encode()).hexdigest()}.json"
    assert path.parent == data, f"state path {path} is outside {data}; name it by digest alone"
    assert path.suffix == ".json", f"state path {path} is not JSON; save_state's temporary file swaps the suffix"
    return path


def touched_path(state: Path) -> Path:
    """The marker beside a session's state saying it has touched the workspace, starting an editing tool, since its
    state was last saved."""
    assert state.suffix == ".json", f"touched_path was given {state}; pass a session's state path from state_path"
    marker = state.with_suffix(".touched")
    assert marker.parent == state.parent and marker != state, f"touched marker {marker} must sit beside {state}"
    return marker


def load_state(session: Session) -> State:
    """The state saved in session, or an empty one when none was saved yet. A file whose digest does not match its
    state, or that is unreadable JSON or of another shape, is not one save_state wrote: it is replaced, and the
    session starts afresh and reruns its checks, as on its first event. Any other failure to read it is raised to
    the caller, which reports it."""
    try:
        saved = json.loads(session.state.read_text())
        value = saved.get("state") if isinstance(saved, dict) else None
        if not isinstance(saved, dict) or saved.get("digest") != digest_of(value):
            raise StateError(f"{session.state} has no digest matching its state{REBUILT}")
        state = state_from(value)
    except (FileNotFoundError, json.JSONDecodeError, StateError):
        state = State()
    assert session.state.parent == session.logs.parent, f"state {session.state} is not beside its logs {session.logs}; build the session with locked"
    assert session.state.suffix == ".json", f"state {session.state} is not a .json file; name it with state_path"
    return state


def save_state(session: Session, state: State) -> None:
    """Replaces the state of session with state in one step, writing it first to a new temporary file that only this
    process can name or read, in the same directory, and removing that file if the write fails. The state file is
    overwatch's own cache, which only overwatch reads and which it rebuilds by rerunning the checks, so replacing it
    loses nothing the user made. session comes from locked(), so this process holds its lock."""
    value = state_json(state)
    text = json.dumps({"digest": digest_of(value), "state": value})
    with tempfile.NamedTemporaryFile("w", dir=session.state.parent, prefix=f"{session.state.stem}.", suffix=".tmp", delete=False) as handle:
        temporary = Path(handle.name)
        try:
            handle.write(text)
        except OSError:
            temporary.unlink()
            raise
    assert temporary.parent == session.state.parent, f"state {session.state} was written through {temporary}, in another directory; write beside it"
    temporary.replace(session.state)
    assert not temporary.exists(), f"{temporary} was left behind; replace the state file with it"


def log_path(session: Session, report: Report, prefix: str = "") -> Path:
    """Where report's full output is kept in session.logs: named by prefix and a digest of the report's key, so each
    check has one log for each prefix."""
    log = session.logs / f"{prefix}{hashlib.sha256(report_key(report).encode()).hexdigest()[:16]}.log"
    assert log.parent == session.logs, f"log {log} is outside {session.logs}; name it by digest alone"
    assert log.name.startswith(prefix) and log.suffix == ".log", f"log {log} is not named {prefix}<digest>.log"
    return log


def write_log(session: Session, report: Report, prefix: str = "") -> Path:
    """Writes report's full output to its log_path in session.logs, keeping the output out of the conversation. Logs
    are overwatch's own cache of output a rerun reproduces, so replacing that check's earlier log loses nothing the
    user made. session comes from locked(), so this process holds its lock and no other is writing there."""
    log = log_path(session, report, prefix)
    log.write_text(report.text)
    assert log.read_text() == report.text, f"{log} does not hold {report.name}'s output as given; write it whole"
    assert log.parent == session.logs, f"wrote {report.name}'s output to {log}, outside {session.logs}"
    return log
