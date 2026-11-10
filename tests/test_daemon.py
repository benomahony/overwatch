"""The daemon runs a project's watchers for as long as clients ask, with one daemon per project."""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from pathlib import Path

import paths
import daemon

assert str(paths.ROOT / "engine") in sys.path, f"{paths.ROOT / 'engine'} is not on sys.path {sys.path}; paths puts engine/ there so daemon imports by name"

# The fixture watcher: names its process, fails, then passes once the test lets it, and keeps running.
WATCH = textwrap.dedent(
    """
    import os, sys, time
    from pathlib import Path
    Path(sys.argv[1]).write_text(str(os.getpid()))
    print("RESULT: FAIL", flush=True)
    while not Path(sys.argv[2]).exists():
        time.sleep(0.05)
    print("RESULT: PASS", flush=True)
    time.sleep(60)
    """
)


def eventually(read, done, seconds: float = 10.0):
    """read() until done(its value) holds, or AssertionError with the last value once seconds pass."""
    assert seconds > 0, f"waiting {seconds}s is no wait; give a positive time"
    deadline = time.monotonic() + seconds
    value = read()
    while not done(value):
        if time.monotonic() > deadline:
            raise AssertionError(f"still {value!r} after {seconds}s")
        time.sleep(0.05)
        value = read()
    assert done(value), f"{value!r} was returned before it was done"
    return value


class DaemonTests(unittest.TestCase):
    def setUp(self) -> None:
        """A git project whose .overwatch.json runs the fixture watcher, and a short private data directory, since a
        Unix socket's path is limited to about a hundred bytes."""
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.project = (Path(self.temporary.name) / "project").resolve()
        self.project.mkdir()
        subprocess.run(["git", "init", "-q", str(self.project)], check=True)
        self.data = Path(tempfile.mkdtemp(dir="/tmp", prefix="ow")).resolve()
        self.addCleanup(shutil.rmtree, self.data)
        self.pid = Path(self.temporary.name) / "watcher.pid"
        self.fixed = Path(self.temporary.name) / "fixed"
        self.other = Path(self.temporary.name) / "other.py"
        self.result = Path(self.temporary.name) / "result.txt"
        script = Path(self.temporary.name) / "watch.py"
        script.write_text(WATCH)
        # The checkers on this machine's PATH are turned off, so the fixture is the project's only watcher.
        override = {"name": "fixture", "argv": [sys.executable, str(script), str(self.pid), str(self.fixed)],
                    "summary": "^RESULT:.*$", "failed": "FAIL",
                    "watchers": {"zanity": {"enabled": False}, "git": {"enabled": False}}}
        (self.project / ".overwatch.json").write_text(json.dumps(override))
        assert (self.project / ".git").is_dir(), f"git init made no repository in {self.project}"
        assert self.data.is_dir() and not any(self.data.iterdir()), f"data directory {self.data} does not start empty"

    def serving(self, idle: float) -> threading.Thread:
        """A daemon for the project on a thread of the test's, once its socket answers."""
        thread = threading.Thread(target=daemon.serve, args=(self.project, self.data, idle), daemon=True)
        thread.start()
        eventually(lambda: daemon.socket_path(self.project, self.data).exists(), bool)
        return thread

    def summaries(self) -> list[str]:
        return [report.summary for report in daemon.latest(self.project, self.data)]

    def will_report(self, result: str) -> None:
        """Sets what a watcher given by watch_with prints as its result, its next time."""
        self.result.write_text(result)

    def let_it_pass(self) -> None:
        """Tells the fixture watcher to print a passing build."""
        self.fixed.touch()

    def watcher_pid(self) -> int:
        """The fixture watcher's process id, once it has started."""
        return int(eventually(lambda: self.pid.read_text() if self.pid.exists() else "", bool))

    def daemon_pid(self) -> int:
        """The process id the project's daemon wrote into the lock it holds."""
        lock = daemon.socket_path(self.project, self.data).with_suffix(".lock")
        return int(eventually(lambda: lock.read_text().strip() if lock.exists() else "", bool))

    def test_latest_follows_the_watch_commands_newest_build(self) -> None:
        self.serving(idle=10)
        self.assertEqual(eventually(self.summaries, lambda value: value == ["RESULT: FAIL"]), ["RESULT: FAIL"])
        self.let_it_pass()
        self.assertEqual(eventually(self.summaries, lambda value: value == ["RESULT: PASS"]), ["RESULT: PASS"])

    def test_a_second_daemon_for_the_project_returns_at_once(self) -> None:
        self.serving(idle=10)
        second = threading.Thread(target=daemon.serve, args=(self.project, self.data, 60), daemon=True)
        second.start()
        second.join(timeout=5)
        self.assertFalse(second.is_alive())
        self.assertEqual(self.summaries(), eventually(self.summaries, lambda value: value == ["RESULT: FAIL"]))

    def test_an_idle_daemon_stops_its_watchers_and_its_socket(self) -> None:
        thread = self.serving(idle=1)
        pid = self.watcher_pid()
        thread.join(timeout=10)
        self.assertFalse(thread.is_alive())
        self.assertFalse(daemon.socket_path(self.project, self.data).exists())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_latest_starts_a_daemon_that_stops_its_watchers_when_killed(self) -> None:
        eventually(self.summaries, lambda value: value == ["RESULT: FAIL"])
        holder, watcher = self.daemon_pid(), self.watcher_pid()
        self.assertNotEqual(holder, os.getpid())
        os.kill(holder, signal.SIGTERM)
        eventually(lambda: self.alive(watcher), lambda alive: not alive)
        self.assertFalse(daemon.socket_path(self.project, self.data).exists())

    def watch_with(self, source: str) -> None:
        """Makes the project's only watcher run source, a Python script, in place of the fixture watcher."""
        self.other.write_text(textwrap.dedent(source))
        override = json.loads((self.project / ".overwatch.json").read_text())
        override["argv"] = [sys.executable, str(self.other), str(self.result)]
        (self.project / ".overwatch.json").write_text(json.dumps(override))
        assert override["argv"][1] == str(self.other), f"the override runs {override['argv']}, not {self.other}"

    def settled(self) -> list[str]:
        return [report.summary for report in daemon.latest(self.project, self.data, "settled")]

    def test_settled_waits_for_the_first_build_instead_of_answering_with_none(self) -> None:
        self.watch_with("""
            import time
            time.sleep(1.5)
            print("RESULT: FAIL", flush=True)
            time.sleep(60)
            """)
        self.serving(idle=10)
        self.assertEqual(self.summaries(), [])
        self.assertEqual(self.settled(), ["RESULT: FAIL"])

    def test_settled_after_a_change_gives_the_build_that_followed_it(self) -> None:
        self.serving(idle=10)
        self.assertEqual(self.settled(), ["RESULT: FAIL"])
        self.let_it_pass()
        self.assertEqual(self.settled(), ["RESULT: PASS"])

    def test_settled_runs_an_exited_watch_command_again_and_keeps_its_build(self) -> None:
        self.will_report("FAIL")
        self.watch_with("""
            import sys
            from pathlib import Path
            print("RESULT: " + Path(sys.argv[1]).read_text(), flush=True)
            sys.exit(1)
            """)
        self.serving(idle=10)
        self.assertEqual(self.settled(), ["RESULT: FAIL"])
        self.will_report("PASS")
        self.assertEqual(self.settled(), ["RESULT: PASS"])

    @staticmethod
    def alive(pid: int) -> bool:
        """Whether a process with this id still runs."""
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        return True


if __name__ == "__main__":
    unittest.main()
