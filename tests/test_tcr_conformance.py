"""Replay the TCR schedules that TLC computed from spec/Overwatch.tla through the real hook, in real git repositories.

Each schedule in tests/fixtures/tcr-traces.json names the model's actions and what holds after each one. The
replay maps every action of the model to what the hook sees: an edit writes the check's result file, the
checks, the checkpoint or the revert happen inside the hook that follows the edit, and a person's work is a file
written outside the hook. After each hook the repository and the saved state must agree with the model.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import json
import re
import unittest
from dataclasses import dataclass
from pathlib import Path

from paths import ROOT
import checkpoint
import engine
import saved_revert
import sessions
from codex_hook import CodexHook, read, write
from checkpoint_repository import git, install_hook, isolate_git, restore_git

TRACES = json.loads((ROOT / "tests/fixtures/tcr-traces.json").read_text())
PASSING = "RESULT: PASS"
FAILING = "RESULT: FAIL"
SESSION = "session-1"
HOOK_EVENTS = {"Start": "UserPromptSubmit", "Observe": "PostToolUse", "Checkpoint": "PostToolUse", "FailCommit": "PostToolUse",
               "Refuse": "PostToolUse", "Revert": "PostToolUse", "Hold": "PostToolUse", "Move": "PostToolUse"}
PULL_COMMAND = "git merge --ff-only teammate"
TEAMMATE_BRANCH = "teammate"
NO_HOOK_EVENTS = {"Build", "Read", "Quiet", "Complete", "Tick", "Timeout"}
# The schedule in which the check outlives its deadline: the fixture check sleeps from the agent's edit on.
TIMED_OUT = "a check that timed out holds the edit and never reverts it"
# The schedule in which a pull ends a hold: the agent's shell is an editing tool, and the hook leaves the pull it reads unjudged.
PULLED = "a pull after the person committed a held edit ends the hold"
CHECK_DEADLINE_SECONDS = 1
HANGING_CHECK = "import time\ntime.sleep(30)\n"
# The model's overtaken result needs an edit while the checks run, which the hook cannot see, since it runs after each edit.
OVERTAKEN = "a result that another edit overtook settles nothing until the next one"
# The schedules in which a second check, with no earlier result, first appears with the agent's edit: zanity, as a tool on PATH.
HELD = "a failing first result is held and the agent is told"
HELD_THEN_COMMITTED = "a held edit is committed by the person and the next edit that passes is committed"
HELD_WORSE = "a held check that gets worse is held again and never reverted"
HELD_SURVIVES = "a held edit survives a turn start and the next edit that passes is committed"
HELD_CHANGED = "a change to the tree while an edit is held stops TCR at the turn start"
HELD_THEN_JUDGED = "a held check that passed is judged again and a new failure is reverted"
LATE_CHECK = (HELD, HELD_THEN_COMMITTED, HELD_WORSE, HELD_SURVIVES, HELD_CHANGED, HELD_THEN_JUDGED, PULLED)

# The model's revert that cannot finish saving: files that change while the revert saves them need a write at that instant.
ABORTED_REVERT = "a revert whose files keep changing while it saves aborts and deletes nothing"
UNTRACKED = "a revert saves an untracked file too and leaves none in the tree"
ZANITY_PASSING = ("zanity: checked 1 file, no issues found.", 0)
SECRET = "-----BEGIN PRIVATE KEY-----\n"
SAVED_IN = re.compile(r"saved in `([^`]+)`")


def content(failures: list[str], version: int = 0) -> str:
    """What the check prints for a workspace version: a failure when the model's failures are not empty, and different for each version."""
    assert version >= 0, f"version {version} is before the first workspace version"
    assert all(isinstance(name, str) for name in failures), f"failures {failures} must be failure names, since the check prints only whether any exist"
    return f"{FAILING if failures else PASSING} v{version}"


@dataclass
class Replay:
    """What the replay of one schedule has done so far."""
    head: int = 0
    commits: int = 0
    committed: str = ""
    context: str = ""
    zanity: tuple[str, int] | None = None


class TcrConformanceTests(CodexHook):
    def setUp(self) -> None:
        self.addCleanup(restore_git, isolate_git())
        CodexHook.setUp(self)
        assert (self.cwd / ".git").is_dir(), f"{self.cwd} is no repository to replay in"
        assert len(TRACES) >= 10, f"the fixture holds {len(TRACES)} TCR schedules; regenerate it with scripts/model_traces.py"

    def put(self, path: Path, text: str) -> None:
        write(path, text, read(path) if path.exists() else None)
        assert read(path) == text, f"{path} does not hold {text!r} after the write"
        assert path.is_relative_to(self.cwd), f"{path} is outside the replayed repository {self.cwd}"

    def saved_state(self) -> dict:
        root = sessions.data_root(str(self.data))
        sent = engine.Event("PostToolUse", SESSION, str(self.cwd), "Edit", {}, "")
        state = json.loads(sessions.state_path(sent, self.cwd.resolve(), root).read_text())["state"]
        assert "tcr" in state and "held" in state, f"the saved state {sorted(state)} has no TCR or held field"
        assert state["tcr"] is None or isinstance(state["tcr"], str), f"the saved TCR {state['tcr']!r} is no text"
        return state

    def saved_tcr(self) -> str | None:
        tcr = self.saved_state()["tcr"]
        assert tcr is None or (isinstance(tcr, str) and tcr), f"the saved TCR {tcr!r} is neither absent nor a reason or the active marker"
        assert isinstance(self.cwd, Path), f"{self.cwd} is no path"
        return tcr

    def start(self, trace: dict) -> Path:
        result, _ = self.configure()
        settings = self.cwd / ".overwatch.json"
        deadline = {"timeout": CHECK_DEADLINE_SECONDS} if trace["name"] == TIMED_OUT else {}
        self.put(settings, json.dumps({**json.loads(read(settings)), "mode": "tcr", **deadline}))
        self.put(result, content(trace["truth"][0]))
        write(self.cwd / "notes.txt", "base")
        self.commit("start")
        if trace["person"] == "seen":
            write(self.cwd / "mine.txt", "mine")
        self.call("SessionStart")
        assert self.subjects() == ["start"], f"the replay starts with the commits {self.subjects()}"
        assert self.saved_tcr() is not None, "the session start saved no TCR decision"
        assert (self.cwd / "notes.txt").exists() and result.exists(), f"{self.cwd} lacks the files that the replay edits"
        return result

    def subjects(self) -> list[str]:
        subjects = git(self.cwd, ["log", "--format=%s"]).splitlines()
        assert subjects, f"{self.cwd} has no commit"
        assert all(subjects), f"a commit of {self.cwd} has an empty subject: {subjects}"
        return subjects

    def write_late_check(self, state: Replay, failures: list[str]) -> None:
        """The second check, which has no earlier result: zanity on PATH, failing or passing as the schedule says. Each
        failing edit has one more error than the last, so a check that gets worse is told from one that stays the same."""
        output, code = (f"zanity: {state.head} errors, 0 warnings in 1 files", 1) if failures else ZANITY_PASSING
        self.tool("zanity", output, code, replacing=state.zanity)
        state.zanity = (output, code)
        assert (self.bin / "zanity").exists(), f"the fake zanity is not in {self.bin}"
        assert state.zanity == (output, code), f"the replay recorded {state.zanity} for a zanity that prints {output!r} and exits {code}"

    def write_edit(self, trace: dict, state: Replay, event: str, result: Path) -> None:
        """An edit of the agent, or of a person, as the files that it changes."""
        state.head += 1
        failures = trace["truth"][state.head] if state.head < len(trace["truth"]) else []
        late = trace["name"] in LATE_CHECK
        self.put(result, content([] if late else failures, state.head))
        if late:
            self.write_late_check(state, failures)
        if trace["name"] == TIMED_OUT and event == "Edit":
            self.put(self.cwd / "check.py", HANGING_CHECK)
        if trace["name"] == UNTRACKED and event == "Edit":
            write(self.cwd / "new.txt", "the agent's new file")
        if event == "Outside":
            self.put(self.cwd / "notes.txt", "mine")
        assert read(result).endswith(f"v{state.head}"), f"{result} does not name version {state.head}"
        assert state.head <= len(trace["truth"]) + len(trace["events"]), f"head {state.head} is past the schedule {trace['name']}"

    def write_pull(self, trace: dict, state: Replay, result: Path) -> None:
        """The model's pull: a teammate's commit brings the next workspace version into a clean tree, as `git merge --ff-only`."""
        state.head += 1
        failures = trace["truth"][state.head] if state.head < len(trace["truth"]) else []
        assert git(self.cwd, ["status", "--porcelain"]) == "", f"{self.cwd} is not clean, and a pull needs a clean tree"
        branch = git(self.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).strip()
        git(self.cwd, ["checkout", "-q", "-b", TEAMMATE_BRANCH])
        self.put(result, content([] if trace["name"] in LATE_CHECK else failures, state.head))
        if trace["name"] in LATE_CHECK:
            self.write_late_check(state, failures)
        git(self.cwd, ["add", "-A"])
        git(self.cwd, ["commit", "-q", "-m", "a teammate's commit"])
        git(self.cwd, ["checkout", "-q", branch])
        git(self.cwd, ["merge", "-q", "--ff-only", TEAMMATE_BRANCH])
        assert read(result).endswith(f"v{state.head}"), f"the pull left {result} without version {state.head}"

    def run_hook(self, trace: dict, state: Replay, event: str, expected: dict, result: Path) -> None:
        """The hook that follows an event of the model, and what the repository and the saved state must then show."""
        if event == "FailCommit":
            install_hook(self.cwd, "pre-commit", "echo refused >&2\nexit 1")
        if event == "Refuse":
            write(self.cwd / "key.txt", SECRET)
        discarded = read(result)
        fields = {} if event == "Start" else {"tool_name": "Read" if event == "Observe" else "Edit"}
        if event == "Move":
            fields = {"tool_name": "Bash", "tool_input": {"command": PULL_COMMAND}}
        output, _ = self.call(HOOK_EVENTS[event], **fields)
        state.context = str(output.get("hookSpecificOutput", {}).get("additionalContext", ""))
        state.commits += event == "Checkpoint"
        state.committed = read(result) if event == "Checkpoint" else state.committed
        name = trace["name"]
        assert expected["tcr"] in ("active", "unavailable", "off"), f"{name}: the model's TCR {expected['tcr']!r} after {event} is none of its states"
        assert state.commits >= 0, f"{name}: {state.commits} checkpoints after {event}"
        self.assertEqual(self.saved_tcr() == "active", expected["tcr"] == "active", f"{name}: TCR after {event}")
        self.assertEqual(bool(self.saved_state()["held"]), expected["held"], f"{name}: held checks after {event}")
        self.assertEqual(git(self.cwd, ["status", "--porcelain"]) == "", expected["clean"], f"{name}: clean tree after {event}")
        self.assertEqual(self.saved_tcr() not in (None, "active"), expected["tcr"] == "unavailable", f"{name}: a reason for TCR to be unavailable after {event}")
        self.assertEqual(len(git(self.cwd, ["for-each-ref", "refs/overwatch/reverted"]).splitlines()), expected["saved"], f"{name}: saved refs after {event}")
        self.assertEqual("TCR held the edit" in state.context, event == "Hold", f"{name}: the notice of a held edit after {event}")
        checkpoints = sum(subject.startswith("tcr: ") for subject in self.subjects())
        self.assertEqual(checkpoints, state.commits, f"{name}: checkpoints after {event}")
        if event == "Revert":
            self.assertEqual(read(result), state.committed, f"{name}: the revert restored the checkpoint")
            saved = SAVED_IN.search(state.context)
            assert saved is not None and expected["saved"] >= 1, f"{name}: the revert did not say where it saved the discarded work: {state.context!r}"
            self.assertEqual(git(self.cwd, ["show", f"{saved.group(1)}:result.txt"]), discarded, f"{name}: the saved ref holds the discarded work")
            if name == UNTRACKED:
                self.assertEqual(git(self.cwd, ["show", f"{saved.group(1)}:new.txt"]), "the agent's new file", f"{name}: the saved ref holds the untracked file")
                self.assertFalse((self.cwd / "new.txt").exists(), f"{name}: the revert left the untracked file in the tree")
            state.head += 1

    def replay(self, trace: dict) -> None:
        assert len(trace["events"]) + 1 == len(trace["expected"]), f"{trace['name']}: {len(trace['expected'])} states for {len(trace['events'])} events"
        assert trace["person"] in ("none", "seen"), f"{trace['name']}: a person who is {trace['person']!r} at the start"
        result = self.start(trace)
        state = Replay(committed=content(trace["truth"][0]))
        for index, event in enumerate(trace["events"], 1):
            expected = trace["expected"][index]
            if event in ("Edit", "Outside"):
                self.write_edit(trace, state, event, result)
            elif event == "Move":
                self.write_pull(trace, state, result)
                self.run_hook(trace, state, event, expected, result)
            elif event == "Commit":
                git(self.cwd, ["add", "-A"])
                git(self.cwd, ["commit", "-q", "-m", "the person commits"])
                state.committed = read(result)
            elif event in HOOK_EVENTS:
                self.run_hook(trace, state, event, expected, result)
            elif event == "TellRevert":
                self.assertIn("reverted", state.context, f"{trace['name']}: the agent was not told of the revert")
            elif event == "TellHold":
                self.assertIn("held", state.context.lower(), f"{trace['name']}: the agent was not told of the held edit")
            else:
                self.assertIn(event, NO_HOOK_EVENTS, f"{trace['name']}: the replay does not know the event {event}")

    def test_every_schedule_that_the_hook_can_replay_holds(self) -> None:
        replayed = [trace for trace in TRACES if trace["name"] not in (OVERTAKEN, ABORTED_REVERT)]
        self.assertGreaterEqual(len(replayed), 19, f"only {[trace['name'] for trace in replayed]} are replayed")
        for position, trace in enumerate(replayed):
            with self.subTest(trace["name"]):
                if position:
                    CodexHook.setUp(self)
                self.replay(trace)

    def test_a_revert_whose_files_keep_changing_deletes_nothing_and_leaves_no_ref(self) -> None:
        """The model's aborted revert, replayed at checkpoint.revert: its after_save seam writes the files each time they are saved."""
        trace = next(trace for trace in TRACES if trace["name"] == ABORTED_REVERT)
        before, after = trace["expected"][-2], trace["expected"][-1]
        for kept in ("head", "saved", "clean"):
            self.assertEqual(after[kept], before[kept], f"the model changes {kept} in the step that aborts the revert")
        self.assertEqual(after["tcr"], "unavailable", f"the model leaves TCR {after['tcr']} after the aborted revert")
        edited = self.cwd / "notes.txt"
        writes: list[str] = []

        def change_while_saving() -> None:
            assert edited.exists(), f"{edited} is gone before the next write while saving"
            writes.append(f"changed while saving {len(writes)}")
            write(edited, writes[-1], read(edited))
            assert read(edited) == writes[-1], f"{edited} does not hold the write {writes[-1]!r}"

        write(edited, "base")
        self.commit("start")
        commits = self.subjects()
        write(edited, "an edit of the agent", "base")
        with self.assertRaises(checkpoint.CheckpointError):
            checkpoint.revert(self.cwd, after_save=change_while_saving)
        self.assertEqual(len(writes), checkpoint.MAX_SAVE_ATTEMPTS, f"the revert saved {len(writes)} times before it gave up")
        self.assertEqual(read(edited), writes[-1], "the aborted revert deleted the work that was being written")
        self.assertEqual(git(self.cwd, ["for-each-ref", saved_revert.SAVED_REF_PREFIX]).strip(), "", "the aborted revert left a saved ref")
        self.assertEqual(self.subjects(), commits, "the aborted revert changed the commits")

    def test_the_schedule_with_an_overtaken_result_is_in_the_fixture(self) -> None:
        names = [trace["name"] for trace in TRACES]
        for exempt in (OVERTAKEN, ABORTED_REVERT):
            self.assertIn(exempt, names, f"the schedule {exempt!r} no longer exists; remove the exemption")
        for late in LATE_CHECK:
            self.assertIn(late, names, f"the schedule {late!r} no longer exists; remove it from LATE_CHECK")


if __name__ == "__main__":
    unittest.main()
