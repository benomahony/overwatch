"""One watcher's commands as the daemon runs them: its full suite, then its watch command, read on a thread of its
own, with the latest complete report they printed and what a client needs to tell whether it is still at work.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import os
from pathlib import Path
import signal
import subprocess
import threading

from discovery import Watcher, subproject
from reading import command_line, last_build, read_report
from records import Report
from running import terminate

READ_CHUNK = 65_536


class Watching:
    """One watcher's commands in the project and the latest report they gave, read on a thread of its own."""

    def __init__(self, watcher: Watcher, project: Path) -> None:
        self.watcher = watcher
        self.cwd = subproject(project, watcher.get("dir", ""))
        self.report: Report | None = None
        self.process: subprocess.Popen[bytes] | None = None
        # How many chunks of output the watcher's commands have printed, so a client can tell it is still reporting.
        self.chunks = 0
        # How many reports the watcher has published, so a client following it can ask for the next.
        self.generation = 0
        # Why the watcher's command could not start, which a client is told as the direct run tells it; None once one runs.
        self.failure: str | None = None
        self.thread: threading.Thread | None = None
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
        if argv and self.cannot_start() is None:
            self.follow(list(argv))
        assert self.cannot_start() is not None or self.process is not None and self.process.poll() is not None, f"{self.watcher['name']} still runs after run returned"

    def start(self) -> None:
        """Runs the watcher's commands on a thread of its own: its full suite and watch command the first time, and
        after that its watch command alone, since a watch command that exited has stopped watching. Its old report
        is dropped, as it no longer covers the files."""
        argv = self.watcher.get("argv")
        assert argv, f"{self.watcher['name']} has no watch command; the daemon runs only watchers with one"
        assert self.thread is None or not self.thread.is_alive(), f"{self.watcher['name']} is started while it runs"
        first = self.thread is None
        with self.lock:
            self.report = None
            self.failure = None
        self.thread = threading.Thread(target=self.run if first else lambda: self.follow(list(argv)), daemon=True)
        self.thread.start()

    def cannot_start(self) -> str | None:
        """Why the watcher's command could not start, as the direct run says it; None when it started."""
        assert self.lock is not None, f"{self.watcher['name']} has no lock; build it with Watching()"
        with self.lock:
            failure = self.failure
        assert failure is None or failure.startswith("could not start "), f"{self.watcher['name']} failed to start with {failure!r}; set it only in follow, from could not start and the command"
        return failure

    def is_running(self) -> bool:
        """Whether the watcher's commands still run, so it still watches the files."""
        assert self.thread is not None, f"{self.watcher['name']} was never started; start it before asking"
        alive = self.thread.is_alive()
        with self.lock:
            process = self.process
        # follow waits for its command before its thread ends, so a watcher that stopped running has no live command.
        assert alive or process is None or process.poll() is not None, f"{self.watcher['name']}'s thread ended with its command still running"
        return alive

    def follow(self, argv: list[str]) -> None:
        """Runs argv, taking each complete build it prints as the latest report, and the exit code's verdict when it
        ends having printed none. A build it printed is not replaced by the exit of a run that already reported."""
        assert argv and all(isinstance(part, str) for part in argv), f"{self.watcher['name']} was asked to run {argv!r}; pass its command"
        env = {**os.environ, **self.watcher["env"]} if "env" in self.watcher else None
        try:
            process = subprocess.Popen(argv, cwd=self.cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, env=env, start_new_session=True)
        except OSError as error:
            with self.lock:
                self.failure = f"could not start {command_line(argv)}: {error}"
            return
        assert process.stdout is not None, f"{argv[0]} started without an output pipe; open it with stdout=PIPE"
        with self.lock:
            self.process = process
        output = ""
        reported = False
        while chunk := os.read(process.stdout.fileno(), READ_CHUNK):
            with self.lock:
                self.chunks += 1
            output += chunk.decode(errors="replace")
            lines = output[:output.rfind("\n") + 1]
            report = read_report(self.watcher, lines)
            if report is not None:
                self.publish(report)
                reported = True
                output = last_build(self.watcher, lines)[1] + output[len(lines):]
        code = process.wait()
        # A watch command that exits is run again, so each run closes its pipe rather than leaving it to the collector.
        process.stdout.close()
        ended = read_report(self.watcher, output, None if reported else code)
        if ended is not None:
            self.publish(ended)
        assert process.returncode is not None, f"{argv[0]} has no exit code after wait"

    def publish(self, report: Report) -> None:
        """Makes report this watcher's latest."""
        assert report.name == self.watcher["name"], f"{report.name} was published as {self.watcher['name']}'s report"
        with self.lock:
            self.report = report
            self.generation += 1
        assert self.report is report, f"{self.watcher['name']} did not keep the report just published"

    def published(self) -> int:
        """How many reports this watcher has published."""
        assert self.lock is not None, f"{self.watcher['name']} has no lock; build it with Watching()"
        with self.lock:
            generation = self.generation
        assert generation >= 0, f"{self.watcher['name']} has published {generation} reports; count up from 0"
        return generation

    def latest(self) -> Report | None:
        """This watcher's latest report; None until its first complete build."""
        assert self.lock is not None, f"{self.watcher['name']} has no lock; build it with Watching()"
        with self.lock:
            report = self.report
        assert report is None or report.name == self.watcher["name"], f"{self.watcher['name']} holds {report.name}'s report"
        return report

    def activity(self) -> tuple[int, str]:
        """What changes while this watcher works: the output it has printed, and each process its running command
        started with the CPU time each has used; the same twice over means it did nothing in between."""
        with self.lock:
            chunks, process = self.chunks, self.process
        running = process is not None and process.poll() is None
        # The command leads its own session, so its process group holds every process it started.
        table = subprocess.run(["ps", "-o", "pid=,time=", "-g", str(process.pid)], capture_output=True, text=True).stdout if running else ""
        assert chunks >= 0, f"{self.watcher['name']} counted {chunks} chunks of output; count up from 0"
        processes = " ".join(sorted(table.split("\n")))
        assert running or processes == "", f"{self.watcher['name']} lists processes {processes!r} with no command running"
        return chunks, processes

    def stop(self) -> None:
        """Ends the command running now, and every process it started, which share its session."""
        with self.lock:
            process = self.process
        assert process is None or process.pid > 0, f"{self.watcher['name']} holds a process with no id"
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            terminate(process)
        assert process is None or process.returncode is not None, f"{self.watcher['name']} still runs after stop"
