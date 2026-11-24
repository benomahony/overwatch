"""engine.py follow tells a session of each settled result as a hook would, waking the agent only for its own edits."""
from __future__ import annotations

import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import textwrap
import unittest

import paths
from daemons import data_directory, eventually, is_running, stop_daemons
import checkpoint
import engine

assert str(paths.ROOT / "engine") in sys.path, f"{paths.ROOT / 'engine'} is not on sys.path {sys.path}; paths puts engine/ there so engine imports by name"
ENGINE = paths.ROOT / "engine" / "engine.py"
# How long a test waits for follow to print the line it expects.
LINE_SECONDS = 20.0

# The fixture watcher: passes, then fails once the test writes the file it names, and keeps running.
WATCH = textwrap.dedent(
    """
    import sys, time
    from pathlib import Path
    print("RESULT: PASS", flush=True)
    while not Path(sys.argv[1]).exists():
        time.sleep(0.05)
    print("RESULT: FAIL", flush=True)
    time.sleep(60)
    """
)


class FollowTests(unittest.TestCase):
    def setUp(self) -> None:
        """A git project whose only watcher is the fixture, a data directory for its daemon, and no follower yet."""
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.project = (Path(temporary.name) / "project").resolve()
        self.project.mkdir()
        subprocess.run(["git", "init", "-q", str(self.project)], check=True)
        self.broken = Path(temporary.name) / "broken"
        script = Path(temporary.name) / "watch.py"
        script.write_text(WATCH)
        self.data = data_directory(self)
        override = {"argv": [sys.executable, str(script), str(self.broken)], "summary": "^RESULT:.*$", "failed": "FAIL", "settle": 0.05,
                    "watchers": {"zanity": {"enabled": False}, "git": {"enabled": False}}}
        (self.project / ".overwatch.json").write_text(json.dumps(override))
        self.event = {"hook_event_name": "Follow", "session_id": "follow", "cwd": str(self.project), "integration": "claude"}
        assert (self.project / ".git").is_dir() and not self.broken.exists(), f"fixture project {self.project} is not ready"

    def start_follower(self) -> subprocess.Popen[str]:
        """engine.py follow for the session, given its event on stdin as a shim gives it, stopped when the test ends."""
        follower = subprocess.Popen([sys.executable, str(ENGINE), "follow"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    text=True, env={**os.environ, "PLUGIN_DATA": str(self.data), "PATH": "/usr/bin:/bin"})
        assert follower.stdin is not None and follower.stdout is not None, "follow started without its pipes"
        follower.stdin.write(json.dumps(self.event))
        follower.stdin.close()
        self.addCleanup(stop_daemons, self.data)
        self.addCleanup(follower.stdout.close)
        self.addCleanup(follower.wait)
        self.addCleanup(follower.kill)
        return follower

    def next_line(self, follower: subprocess.Popen[str]) -> dict[str, object]:
        """The next line of JSON follow prints, or a failure once LINE_SECONDS pass without one."""
        assert follower.stdout is not None, "follow has no output pipe"
        selector = selectors.DefaultSelector()
        selector.register(follower.stdout, selectors.EVENT_READ)
        try:
            ready = selector.select(LINE_SECONDS)
        finally:
            selector.close()
        self.assertTrue(ready, f"follow printed nothing within {LINE_SECONDS}s")
        return json.loads(follower.stdout.readline())

    def hook(self, name: str, tool: str = "") -> dict[str, object]:
        """Sends one hook event for the session to the engine in this process, as the session's shim does."""
        event = engine.Event(name, "follow", str(self.project), tool, {}, "claude")
        return engine.process_event(event, self.data)

    def settle_baseline(self) -> None:
        """Starts the session with its first, passing result as the baseline, as a session start does."""
        self.assertEqual(self.hook("SessionStart").get("overwatch", {}).get("guarded"), False)

    def test_a_failure_after_the_agents_edit_is_told_and_wakes_it(self) -> None:
        self.settle_baseline()
        follower = self.start_follower()
        self.hook("PreToolUse", "Edit")
        self.break_build()
        line = self.next_line(follower)
        self.assertIn("RESULT: FAIL", json.dumps(line))
        self.assertEqual((line["overwatch"]["guarded"], line["overwatch"]["waking"]), (True, True))

    def test_another_process_failure_is_told_without_waking(self) -> None:
        self.settle_baseline()
        follower = self.start_follower()
        self.break_build()
        line = self.next_line(follower)
        self.assertIn("RESULT: FAIL", json.dumps(line))
        self.assertEqual((line["overwatch"]["guarded"], line["overwatch"]["waking"]), (True, False))

    def start_tcr_session(self) -> None:
        """Commits the project in TCR mode and starts the session on that clean commit, with its passing baseline."""
        override = json.loads((self.project / ".overwatch.json").read_text())
        (self.project / ".overwatch.json").write_text(json.dumps({**override, "mode": "tcr"}))
        git = ["git", "-C", str(self.project), "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"]
        subprocess.run([*git, "add", "-A"], check=True, capture_output=True)
        subprocess.run([*git, "commit", "-q", "-m", "start"], check=True, capture_output=True)
        for setting, value in (("user.name", "test"), ("user.email", "test@example.com")):
            subprocess.run(["git", "-C", str(self.project), "config", setting, value], check=True, capture_output=True)
        self.settle_baseline()
        assert json.loads((self.project / ".overwatch.json").read_text())["mode"] == "tcr", f"{self.project} does not run TCR"
        assert not subprocess.run(["git", "-C", str(self.project), "status", "--porcelain"], capture_output=True, text=True).stdout, f"{self.project} is not clean"

    def agent_writes(self, name: str) -> Path:
        """The agent's edit: a new file in the project, which the editing tool's PreToolUse has announced."""
        self.hook("PreToolUse", "Edit")
        edit = self.write_in_project(name, "the agent's edit\n")
        assert edit.read_text() == "the agent's edit\n", f"{edit} does not hold the edit"
        assert edit.name == name, f"the agent's edit is {edit.name}, not {name}"
        return edit

    def person_writes(self, name: str) -> Path:
        """A person's new file in the project, which no editing tool of the agent announced."""
        person = self.write_in_project(name, "a person's file\n")
        assert person.read_text() == "a person's file\n", f"{person} does not hold the person's file"
        assert person.name == name, f"the person's file is {person.name}, not {name}"
        return person

    def write_in_project(self, name: str, text: str) -> Path:
        """A new file in the project holding text."""
        written = self.project / name
        written.write_text(text)
        assert written.read_text() == text, f"{written} does not hold {text!r}"
        assert written.is_relative_to(self.project), f"{written} is outside the project {self.project}"
        return written

    def test_a_failure_the_follower_reads_is_never_judged_by_tcr(self) -> None:
        self.start_tcr_session()
        follower = self.start_follower()
        edit = self.agent_writes("edit.txt")
        self.break_build()
        line = self.next_line(follower)
        self.assertIn("RESULT: FAIL", json.dumps(line))
        self.assertNotIn("TCR reverted", json.dumps(line))
        self.assertTrue(edit.exists())

    def test_an_edit_the_follower_read_first_is_still_reverted_when_it_fails(self) -> None:
        self.start_tcr_session()
        follower = self.start_follower()
        edit = self.agent_writes("edit.txt")
        self.break_build()
        self.assertIn("RESULT: FAIL", json.dumps(self.next_line(follower)))
        output = self.hook("PostToolUse", "Edit")
        self.assertIn("TCR reverted", json.dumps(output))
        self.assertFalse(edit.exists())

    def test_an_edit_the_follower_read_first_is_still_committed_when_it_passes(self) -> None:
        self.start_tcr_session()
        edit = self.agent_writes("edit.txt")
        self.follower_reads()
        self.hook("PostToolUse", "Edit")
        self.assertEqual(checkpoint.run_git(self.project, ["log", "--format=%s"]).split("\n")[:2], ["tcr: edit.txt", "start"])
        self.assertTrue(edit.exists())

    def test_a_change_of_a_person_the_follower_read_first_still_pauses_tcr(self) -> None:
        self.start_tcr_session()
        person = self.person_writes("person.txt")
        self.follower_reads()
        output = self.hook("PostToolUse", "Read")
        self.assertIn("files changed outside the agent's edits", json.dumps(output))
        self.assertTrue(person.exists())

    def follower_reads(self) -> None:
        """What one pass of follow does with the reports the daemon already gave: reads them in the session's state and saves it."""
        event = engine.Event("Follow", "follow", str(self.project), "", {}, "claude")
        with engine.locked(engine.state_path(event, self.project, self.data), self.data) as session:
            read = engine.checked_state(session, self.project, followed=list(engine.load_state(session).reports))
            engine.save_state(session, read.current)
        assert read.current.fingerprint is not None, f"the follower read of {self.project} recorded no fingerprint"
        assert read.old.fingerprint != read.current.fingerprint, f"the follower read of {self.project} saw no change from the agent's edit"

    def test_follow_stops_with_the_process_that_started_it(self) -> None:
        pid = self.orphaned_follower()
        self.assertFalse(eventually(lambda: is_running(pid), lambda running: not running, 2 * engine.PARENT_SECONDS + 2))

    def orphaned_follower(self) -> int:
        """The id of a follower whose parent, a shell, exited while it was following, a few seconds after it started."""
        # The shell stays a few seconds, so follow starts as its child and is following when the shell exits.
        script = f"echo '{json.dumps(self.event)}' | '{sys.executable}' '{ENGINE}' follow & echo $!; sleep 3"
        shell = subprocess.Popen(["sh", "-c", script], stdout=subprocess.PIPE, text=True,
                                 env={**os.environ, "PLUGIN_DATA": str(self.data), "PATH": "/usr/bin:/bin"})
        assert shell.stdout is not None, "the shell started without its output pipe"
        self.addCleanup(shell.stdout.close)
        self.addCleanup(stop_daemons, self.data)
        pid = int(shell.stdout.readline())
        shell.wait()
        assert is_running(pid), f"follow {pid} ended before its parent did, so its stopping says nothing"
        return pid

    def break_build(self) -> None:
        """Makes the fixture watcher print a failing build."""
        self.broken.touch()
        assert self.broken.exists(), f"{self.broken} was not made"


if __name__ == "__main__":
    unittest.main()
