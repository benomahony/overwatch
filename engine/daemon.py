#!/usr/bin/env python3
"""Runs one project's watchers for as long as anyone asks for their reports, and answers on a Unix socket in the data
directory. Every host's adapter is a client: the first to ask starts the daemon, a project only ever has one, and it
exits once no client has asked for a while, stopping its watchers.

A watcher with a watch command runs it for the daemon's life, after its full suite when it has one, and its latest
report is the last complete build the command printed. A watcher with only a full suite runs that once.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import socket
import socketserver
import subprocess
import sys
import threading
import time
from dataclasses import asdict
from pathlib import Path

from discovery import ConfigurationError, Watcher, find_watchers, key_of, subproject
import engine
from reading import last_build, read_report
from records import Report, report_from
from running import terminate
from unix import try_exclusive

# How long a daemon waits for its next client before it stops, and how long a client waits for one it started.
IDLE_SECONDS = 300.0
START_SECONDS = 10.0
# How often the daemon looks at how long it has been idle, and how often a waiting client tries the socket again.
TICK_SECONDS = 0.2
READ_CHUNK = 65_536


def socket_path(project: Path, root: Path) -> Path:
    """Where the daemon for project listens: in root, named by a digest of the project, so neither shapes the path."""
    assert project.is_absolute() and root.is_absolute(), f"project {project} or data directory {root} is relative; resolve both"
    digest = hashlib.blake2b(os.fsencode(str(project)), digest_size=10).hexdigest()
    path = engine.in_data(root / f"daemon-{digest}.sock", root)
    assert path.parent == root, f"daemon socket {path} is outside {root}; name it by digest alone"
    assert len(os.fsencode(str(path))) < 104, f"daemon socket {path} is too long for a Unix socket address; use a shorter data directory"
    return path


class Watching:
    """One watcher's commands in the project and the latest report they gave, read on a thread of its own."""

    def __init__(self, watcher: Watcher, project: Path) -> None:
        self.watcher = watcher
        self.cwd = subproject(project, watcher.get("dir", ""))
        self.report: Report | None = None
        self.process: subprocess.Popen[bytes] | None = None
        self.lock = threading.Lock()
        assert self.cwd.is_dir(), f"{watcher['name']} runs in {self.cwd}, which is not a directory"
        assert watcher.get("argv") or watcher.get("baseline"), f"{watcher['name']} has no command; find_watchers gives each one"

    def run(self) -> None:
        """Runs the full suite, when there is one, to its end, then the watch command, when there is one, until it
        exits or stop ends it."""
        baseline, argv = self.watcher.get("baseline"), self.watcher.get("argv")
        assert baseline or argv, f"{self.watcher['name']} has nothing to run; find_watchers gives each one a command"
        if baseline:
            self.follow(list(baseline))
        if argv:
            self.follow(list(argv))
        assert self.process is not None and self.process.poll() is not None, f"{self.watcher['name']} still runs after run returned"

    def follow(self, argv: list[str]) -> None:
        """Runs argv, taking each complete build it prints as the latest report, and the exit code's verdict when it
        ends with no summary."""
        assert argv and all(isinstance(part, str) for part in argv), f"{self.watcher['name']} was asked to run {argv!r}; pass its command"
        env = {**os.environ, **self.watcher["env"]} if "env" in self.watcher else None
        process = subprocess.Popen(argv, cwd=self.cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, env=env, start_new_session=True)
        assert process.stdout is not None, f"{argv[0]} started without an output pipe; open it with stdout=PIPE"
        with self.lock:
            self.process = process
        output = ""
        while chunk := os.read(process.stdout.fileno(), READ_CHUNK):
            output += chunk.decode(errors="replace")
            lines = output[:output.rfind("\n") + 1]
            report = read_report(self.watcher, lines)
            if report is not None:
                self.publish(report)
                output = last_build(self.watcher, lines)[1] + output[len(lines):]
        code = process.wait()
        ended = read_report(self.watcher, output, code)
        if ended is not None:
            self.publish(ended)
        assert process.returncode is not None, f"{argv[0]} has no exit code after wait"

    def publish(self, report: Report) -> None:
        """Makes report this watcher's latest."""
        assert report.name == self.watcher["name"], f"{report.name} was published as {self.watcher['name']}'s report"
        with self.lock:
            self.report = report
        assert self.report is report, f"{self.watcher['name']} did not keep the report just published"

    def latest(self) -> Report | None:
        """This watcher's latest report; None until its first complete build."""
        assert self.lock is not None, f"{self.watcher['name']} has no lock; build it with Watching()"
        with self.lock:
            report = self.report
        assert report is None or report.name == self.watcher["name"], f"{self.watcher['name']} holds {report.name}'s report"
        return report

    def stop(self) -> None:
        """Ends the command running now, and every process it started, which share its session."""
        with self.lock:
            process = self.process
        assert process is None or process.pid > 0, f"{self.watcher['name']} holds a process with no id"
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            terminate(process)
        assert process is None or process.returncode is not None, f"{self.watcher['name']} still runs after stop"


class Daemon:
    """The watchers of one project and when a client last asked about them."""

    def __init__(self, project: Path) -> None:
        assert project.is_dir(), f"the daemon was given {project}, which is not a project directory"
        self.watchings = [Watching(watcher, project) for watcher in find_watchers(project) if watcher.get("argv")]
        self.asked = time.monotonic()
        keys = {key_of(each.watcher["name"], each.watcher.get("dir")) for each in self.watchings}
        assert len(keys) == len(self.watchings), f"{project} gave the same watcher twice; find_watchers gives each once"

    def answer(self, request: dict[str, object]) -> dict[str, object]:
        """The reply to one client request: {"op": "latest"} gives every watcher's latest report."""
        assert isinstance(request, dict), f"request {request!r} is not a JSON object"
        self.asked = time.monotonic()
        if request.get("op") != "latest":
            return {"error": f"unknown request {request.get('op')!r}; ask for latest"}
        reports = [asdict(report) for report in (each.latest() for each in self.watchings) if report is not None]
        assert len(reports) <= len(self.watchings), f"{len(reports)} reports from {len(self.watchings)} watchers; give one each at most"
        return {"reports": reports, "watchers": len(self.watchings)}


class Server(socketserver.ThreadingUnixStreamServer):
    """The daemon's socket, holding the daemon its answers come from."""

    def __init__(self, path: Path, daemon: Daemon) -> None:
        assert not path.exists(), f"{path} already exists; unlink a stale socket before listening on it"
        self.daemon = daemon
        super().__init__(str(path), Answers)
        assert path.exists(), f"listening on {path} made no socket there"


class Answers(socketserver.StreamRequestHandler):
    """Reads one JSON request line from a client and writes the daemon's reply as one JSON line."""

    def handle(self) -> None:
        server = self.server
        assert isinstance(server, Server), f"answers came through {type(server).__name__}, not the daemon's Server"
        line = self.rfile.readline()
        try:
            request = json.loads(line or b"{}")
        except json.JSONDecodeError as error:
            request = {"op": f"unreadable request: {error}"}
        reply = server.daemon.answer(request if isinstance(request, dict) else {"op": repr(request)})
        self.wfile.write(json.dumps(reply).encode() + b"\n")
        assert isinstance(reply, dict), f"the daemon replied {reply!r}, not an object"


def serve(project: Path, root: Path, idle: float) -> None:
    """Runs project's watchers and answers clients until none has asked for idle seconds; returns at once when another
    daemon already serves project."""
    assert idle > 0, f"idle time {idle} must be positive; give the seconds a daemon may wait for a client"
    path = socket_path(project, root)
    lock = os.open(path.with_suffix(".lock"), os.O_RDWR | os.O_CREAT, 0o600)
    if not try_exclusive(lock):
        os.close(lock)
        return
    # The lock file names the daemon holding it, so whoever needs to can find it.
    os.ftruncate(lock, 0)
    os.write(lock, f"{os.getpid()}\n".encode())
    path.unlink(missing_ok=True)
    daemon = Daemon(project)
    for each in daemon.watchings:
        threading.Thread(target=each.run, daemon=True).start()
    server = Server(path, daemon)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        while time.monotonic() - daemon.asked < idle:
            time.sleep(TICK_SECONDS)
    finally:
        server.shutdown()
        server.server_close()
        for each in daemon.watchings:
            each.stop()
        path.unlink(missing_ok=True)
        os.close(lock)
    assert not path.exists(), f"{path} outlived its daemon; unlink it on the way out"


def start(project: Path, root: Path) -> None:
    """Starts a daemon for project in a session of its own, so it outlives the hook that started it."""
    assert project.is_dir() and root.is_dir(), f"cannot start a daemon for {project} with data in {root}; both must be directories"
    argv = [sys.executable, str(Path(__file__).resolve()), "serve", str(project), "--data", str(root)]
    # Spawned, not run under Popen, since nothing here waits for it: it is meant to outlive this process.
    quiet = [(os.POSIX_SPAWN_OPEN, descriptor, os.devnull, os.O_RDWR, 0) for descriptor in (0, 1, 2)]
    pid = os.posix_spawn(sys.executable, argv, os.environ, file_actions=quiet, setsid=True)
    assert pid > 0, f"starting {argv} gave no process"


def ask(project: Path, root: Path, request: dict[str, object]) -> dict[str, object]:
    """Sends request to project's daemon, starting one when none answers, and returns its reply."""
    assert isinstance(request, dict) and "op" in request, f"request {request!r} names no op; ask for one"
    path = socket_path(project, root)
    started = False
    for _ in range(int(START_SECONDS / TICK_SECONDS) + 1):
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.connect(str(path))
                client.sendall(json.dumps(request).encode() + b"\n")
                reply = json.loads(client.makefile("rb").readline())
            assert isinstance(reply, dict), f"the daemon at {path} replied {reply!r}, not an object"
            return reply
        except (FileNotFoundError, ConnectionRefusedError):
            if not started:
                start(project, root)
                started = True
            time.sleep(TICK_SECONDS)
    raise ConfigurationError(f"no overwatch daemon answered at {path} within {START_SECONDS:.0f}s; run {Path(__file__).name} serve {project} to see why")


def latest(project: Path, root: Path) -> list[Report]:
    """Every watcher's latest report in project, from its daemon; a watcher with no complete build yet has none."""
    assert project.is_absolute(), f"project {project} is relative; resolve it"
    reply = ask(project, root, {"op": "latest"})
    if "error" in reply:
        raise ConfigurationError(f"the overwatch daemon for {project} refused: {reply['error']}")
    reports = [report_from(value) for value in reply.get("reports", [])]
    assert all(isinstance(report, Report) for report in reports), f"the daemon for {project} sent reports {reply.get('reports')!r}"
    return reports


def main() -> None:
    """`daemon.py serve PROJECT --data DIR` runs a daemon; `daemon.py latest PROJECT --data DIR` prints its reports."""
    parser = argparse.ArgumentParser(description="Run or ask a project's overwatch daemon.")
    parser.add_argument("action", choices=("serve", "latest"))
    parser.add_argument("project", type=Path)
    parser.add_argument("--data", default=None, help="the data directory; PLUGIN_DATA or ~/.cache/overwatch when left out")
    parser.add_argument("--idle", type=float, default=IDLE_SECONDS, help="seconds with no client before the daemon stops")
    args = parser.parse_args()
    assert args.action in ("serve", "latest"), f"argparse let through action {args.action!r}"
    root = engine.data_root(args.data or os.environ.get("PLUGIN_DATA"))
    project = args.project.resolve()
    if args.action == "serve":
        # Killing the daemon ends it as running out of clients does, stopping its watchers on the way out.
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        serve(project, root, args.idle)
    else:
        print(json.dumps([asdict(report) for report in latest(project, root)]))
    assert project.is_absolute(), f"project {project} is relative; resolve it"


if __name__ == "__main__":
    main()
