"""Acceptance contract: repair remains possible while a failure gate is closed."""
from __future__ import annotations

import json
from functools import partialmethod
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
CLEAN = "zanity: checked 1 file, no issues found.\n"
WARNINGS = "zanity: 0 errors and 29 warnings in 1 of 1 files\n"


class AcceptanceWorld(unittest.TestCase):
    def setUp(self) -> None:
        """An isolated git project with one Python file, a gate protecting git push and Publish, and a passing fake zanity."""
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.fixture_root = Path(temporary.name)
        self.project = Path(temporary.name) / "project"
        self.data = Path(temporary.name) / "state"
        self.bin = Path(temporary.name) / "bin"
        self.project.mkdir()
        self.bin.mkdir()
        subprocess.run(["git", "init", "-q", str(self.project)], check=True)
        self.source = self.project / "example.py"
        self.source.write_text("value = 1\n")
        self.result = self.project / "zanity-result.txt"
        self.result.write_text("zanity: checked 1 file, no issues found.\n")
        script = self.bin / "zanity"
        script.write_text(f"#!/bin/sh\ncat '{self.result}'\n")
        script.chmod(0o755)
        self.configure()
        assert (self.project / ".git").is_dir(), f"git init made no repository in {self.project}"
        assert os.access(script, os.X_OK), f"the fake zanity {script} is not executable"

    def fixture_read(self, path: Path) -> str:
        """Only read files owned by this test's automatically cleaned fixture."""
        resolved = path.resolve()
        assert resolved.is_relative_to(self.fixture_root.resolve()), f"{resolved} is outside the fixture {self.fixture_root}"
        text = resolved.read_text()
        assert len(text.encode()) == resolved.stat().st_size, f"{resolved} changed while it was read"
        return text

    def fixture_write(self, path: Path, text: str) -> None:
        """Only change files owned by this test's automatically cleaned fixture."""
        resolved = path.resolve()
        assert resolved.is_relative_to(self.fixture_root.resolve()), f"{resolved} is outside the fixture {self.fixture_root}"
        resolved.write_text(text)
        assert resolved.read_text() == text, f"{resolved} reads back differently from what was written"

    def configure(self, **gate: object) -> None:
        """Writes the project's gate: git push and Publish guarded by zanity, with gate's fields over those."""
        protected = [
            {"tool": "Bash", "command": r"\bgit\s+push\b", "checks": ["zanity"]},
            {"tool": "Publish", "checks": ["zanity"]},
        ]
        config = {"gate": {"protected_actions": protected, **gate}}
        assert set(gate) <= {"inherited", "protected_actions"}, f"gate fields {set(gate)} are not ones overwatch reads"
        (self.project / ".overwatch.json").write_text(json.dumps(config))
        assert json.loads((self.project / ".overwatch.json").read_text()) == config, f"{self.project}/.overwatch.json does not hold {config}"

    def hook(self, event: str, **fields: object) -> dict[str, object]:
        """Sends one hook event to the real command hook and returns its JSON answer."""
        payload = {"session_id": "acceptance", "cwd": str(self.project),
                   "hook_event_name": event, **fields}
        result = subprocess.run(
            [sys.executable, str(ROOT / "hooks" / "codex.py")],
            input=json.dumps(payload), text=True, capture_output=True, check=True,
            env={**os.environ, "PATH": f"{self.bin}:/usr/bin:/bin", "PLUGIN_DATA": str(self.data)},
            timeout=5,
        )
        output = json.loads(result.stdout)
        assert type(output) is dict, f"the hook answered {event} with {result.stdout[:80]}, not a JSON object"
        assert not result.stderr, f"the hook wrote to stderr for {event}: {result.stderr[-400:]}"
        return output

    def new_warnings(self) -> None:
        """The session starts clean, then an edit brings 29 warnings."""
        started = self.hook("SessionStart")
        self.result.write_text("zanity: 0 errors and 29 warnings in 1 of 1 files\n")
        edited = self.hook("PostToolUse", tool_name="Edit")
        assert "decision" not in started, f"a clean session start was refused: {started}"
        assert "29 warnings" in json.dumps(edited), f"the edit that brought 29 warnings was not reported: {edited}"

    def inspect_and_repair(self) -> None:
        """Inspects the project with every read-only and repair tool, then edits the source."""
        source = str(self.source)
        operations = [
            ("Glob", {"pattern": "**/*"}), ("Grep", {"pattern": "value"}),
            ("Read", {"file_path": source}), ("Edit", {"file_path": source}),
            ("Write", {"file_path": source}), ("apply_patch", {}),
            *(('Bash', {"command": command}) for command in
              ("rg --files", "cat example.py", "pytest", "zanity check . --watch --no-color")),
        ]
        self.responses = [self.hook("PreToolUse", tool_name=tool, tool_input=arguments)
                          for tool, arguments in operations]
        self.listing = [path.name for path in self.project.iterdir()]
        self.before_edit = self.fixture_read(self.source)
        self.fixture_write(self.source, "value = 2\n")
        assert len(self.responses) == len(operations) == 10, f"{len(self.responses)} answers for {len(operations)} operations"
        assert self.fixture_read(self.source) != self.before_edit, f"the edit left {self.source} as {self.before_edit!r}"

    def repair_operations_allowed(self) -> None:
        """Every inspection and repair went through, and the edit landed."""
        assert self.responses == [{}] * 10, f"inspection or repair was refused: {self.responses}"
        assert "example.py" in self.listing, f"listing {self.listing} does not show example.py"
        assert self.before_edit == "value = 1\n", f"the source read {self.before_edit!r} before the edit"
        assert self.fixture_read(self.source) == "value = 2\n", f"the source reads {self.fixture_read(self.source)!r} after the edit"

    def attempt_protected_actions(self) -> None:
        """Tries git push and Publish twice each."""
        attempts = [("Bash", {"command": "git push origin main"}), ("Publish", {})] * 2
        self.responses = [self.hook("PreToolUse", tool_name=tool, tool_input=arguments)
                          for tool, arguments in attempts]
        assert len(self.responses) == 4, f"{len(self.responses)} answers for 4 protected attempts"
        assert all(type(output) is dict for output in self.responses), f"answers {self.responses} are not all objects"

    def protected_actions_denied(self) -> None:
        """Every protected attempt was denied, naming the 29 warnings."""
        assert self.responses, "no protected attempts were made; run attempt_protected_actions first"
        for output in self.responses:
            decision = output.get("hookSpecificOutput", {})
            assert decision.get("permissionDecision") == "deny", f"a protected attempt was not denied: {output}"
            assert "29 warnings" in decision.get("permissionDecisionReason", ""), f"the denial does not name the 29 warnings: {output}"

    def attempt_completion(self) -> None:
        """Tries to stop three times, once as a continuation."""
        self.responses = [self.hook("Stop"), self.hook("Stop", stop_hook_active=True), self.hook("Stop")]
        assert len(self.responses) == 3, f"{len(self.responses)} answers for 3 Stop attempts"
        assert all(type(output) is dict for output in self.responses), f"answers {self.responses} are not all objects"

    def completion_denied(self) -> None:
        """Each Stop attempt was refused."""
        decisions = [output.get("decision") for output in self.responses]
        assert len(decisions) == 3, f"{len(decisions)} Stop answers; run attempt_completion first"
        assert decisions == ["block"] * 3, f"Stop attempts were answered {decisions}, not all refused"

    def report_success(self) -> None:
        """zanity passes again and the agent's check run reports it."""
        self.fixture_write(self.result, "zanity: checked 1 file, no issues found.\n")
        output = self.hook("PostToolUse", tool_name="Bash", tool_input={"command": "zanity check ."})
        assert "decision" not in output, f"a passing check run was refused: {output}"
        assert "29 warnings" not in json.dumps(output), f"a passing check run still reports the warnings: {output}"

    def gates_cleared(self) -> None:
        """Stop and Publish both go through once zanity passes."""
        stopped, published = self.hook("Stop"), self.hook("PreToolUse", tool_name="Publish", tool_input={})
        assert "decision" not in stopped, f"Stop was refused after zanity passed: {stopped}"
        assert published == {}, f"Publish was refused after zanity passed: {published}"

    def inherited_warnings(self) -> None:
        """The session starts with 29 warnings already there."""
        self.fixture_write(self.result, "zanity: 0 errors and 29 warnings in 1 of 1 files\n")
        started = self.hook("SessionStart")
        assert "decision" not in started, f"the session start was refused: {started}"
        assert "inherited backlog" in json.dumps(started), f"the session start did not report the inherited backlog: {started}"

    def strict_inherited_policy(self) -> None:
        """The project's gate blocks on inherited findings too."""
        self.configure(inherited="block")
        gate = json.loads(self.fixture_read(self.project / ".overwatch.json"))["gate"]
        assert gate["inherited"] == "block", f"the gate is {gate}, not blocking inherited findings"
        assert len(gate["protected_actions"]) == 2, f"the strict gate lost its protected actions: {gate}"

    def inherited_findings_guarded(self) -> None:
        """Inherited findings refuse Stop and Publish but not Read."""
        assert self.stop_response.get("decision") == "block", f"Stop went through on inherited findings: {self.stop_response}"
        assert self.publish_response.get("hookSpecificOutput", {}).get("permissionDecision") == "deny", f"Publish went through on inherited findings: {self.publish_response}"
        assert self.read_response == {}, f"Read was refused on inherited findings: {self.read_response}"

    def attempt_completion_and_publication(self) -> None:
        """Tries to stop, to publish and to read."""
        self.stop_response = self.hook("Stop")
        self.publish_response = self.hook("PreToolUse", tool_name="Publish", tool_input={})
        self.read_response = self.hook("PreToolUse", tool_name="Read", tool_input={})
        assert type(self.stop_response) is dict, f"Stop was answered {self.stop_response}"
        assert self.read_response == {} or "hookSpecificOutput" in self.read_response, f"Read was answered {self.read_response}"

    def inherited_findings_allowed(self) -> None:
        """Inherited findings leave Stop and Publish open."""
        assert "decision" not in self.stop_response, f"Stop was refused on inherited findings: {self.stop_response}"
        assert self.publish_response == {}, f"Publish was refused on inherited findings: {self.publish_response}"

    def git(self, *argv: str) -> str:
        """Runs git in the project and returns what it printed."""
        completed = subprocess.run(["git", "-C", str(self.project), *argv], capture_output=True, text=True, check=True)
        assert completed.returncode == 0, f"git {argv} exited {completed.returncode}: {completed.stderr}"
        assert isinstance(completed.stdout, str), f"git {argv} printed {type(completed.stdout)}, not text"
        return completed.stdout.strip()

    def subjects(self) -> list[str]:
        """The subjects of the project's commits, newest first."""
        subjects = self.git("log", "--format=%s").splitlines()
        assert subjects, f"the project {self.project} has no commit"
        assert all(subjects), f"a commit of {self.project} has no subject: {subjects}"
        return subjects

    def tcr_project(self, result: str = CLEAN, dirty: bool = False) -> None:
        """The project in TCR mode, committed with the check result, and its session started; when dirty, with a file
        nobody committed at the start."""
        for name, value in (("user.name", "test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false"), ("core.hooksPath", "/dev/null")):
            self.git("config", name, value)
        settings = self.project / ".overwatch.json"
        self.fixture_write(settings, json.dumps({**json.loads(self.fixture_read(settings)), "mode": "tcr"}))
        self.fixture_write(self.result, result)
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "start")
        if dirty:
            self.fixture_write(self.project / "notes.txt", "mine\n")
        self.started = self.hook("SessionStart")
        assert self.subjects() == ["start"], f"the project has commits {self.subjects()}, not only start"
        assert self.git("status", "--porcelain") == ("?? notes.txt" if dirty else ""), f"the project starts with {self.git('status', '--porcelain')!r}"

    tcr_inherited_project = partialmethod(tcr_project, result=WARNINGS)
    tcr_dirty_project = partialmethod(tcr_project, dirty=True)

    def edit(self, result: str | None = None) -> None:
        """The agent edits the source, and then the checks report result when one is given."""
        self.fixture_write(self.source, "value = 2\n")
        if result is not None:
            self.fixture_write(self.result, result)
        self.answer = self.hook("PostToolUse", tool_name="Edit")
        assert self.fixture_read(self.result) in (result, CLEAN, WARNINGS), f"the check result is {self.fixture_read(self.result)!r}, not one the edit set"
        assert type(self.answer) is dict, f"the edit was answered {self.answer}"

    edit_keeping_checks_green = partialmethod(edit)
    edit_adding_warnings = partialmethod(edit, result=WARNINGS)

    def edit_while_checks_run(self) -> None:
        """The checks take so long that the agent edits again: the check itself writes the later file, once."""
        later = self.project / "later.txt"
        self.fixture_write(self.bin / "zanity", f"#!/bin/sh\n[ -e '{later}' ] || echo later > '{later}'\ncat '{self.result}'\n")
        self.edit(result=WARNINGS)
        assert later.exists(), f"the checks did not write {later}, so the edit was not overtaken"
        assert self.fixture_read(self.source) == "value = 2\n", f"the source reads {self.fixture_read(self.source)!r}, not the edit"

    def a_commit_hook_refuses(self) -> None:
        """The repository's commit hook refuses every commit."""
        hooks = self.fixture_root / "hooks"
        hooks.mkdir()
        refusing = hooks / "pre-commit"
        self.fixture_write(refusing, "#!/bin/sh\necho refused >&2\nexit 1\n")
        refusing.chmod(0o755)
        self.git("config", "core.hooksPath", str(hooks))
        assert os.access(refusing, os.X_OK), f"the hook {refusing} is not executable"
        assert self.git("config", "core.hooksPath") == str(hooks), "git does not run the refusing hook"

    def change_is_committed_as_a_checkpoint(self) -> None:
        """The edit is the newest commit and nothing is left uncommitted."""
        assert self.subjects()[0] == "tcr: example.py", f"the commits are {self.subjects()}, not a checkpoint of example.py first"
        assert self.git("status", "--porcelain") == "", f"the project still has {self.git('status', '--porcelain')!r} uncommitted"

    def edit_is_reverted_and_told(self) -> None:
        """The source is back at the checkpoint, no commit was made, and the agent is told the new warnings."""
        assert self.fixture_read(self.source) == "value = 1\n", f"the source reads {self.fixture_read(self.source)!r}, not the checkpoint's"
        assert self.subjects() == ["start"], f"the commits are {self.subjects()}, not only start"
        assert "29 warnings" in json.dumps(self.answer), f"the agent was not told the warnings: {self.answer}"

    def edit_is_neither_committed_nor_reverted(self) -> None:
        """The edit stays in the working tree, uncommitted."""
        assert self.fixture_read(self.source) == "value = 2\n", f"the source reads {self.fixture_read(self.source)!r}, not the edit"
        assert self.subjects() == ["start"], f"the commits are {self.subjects()}, not only start"

    def tcr_is_reported_unavailable(self) -> None:
        """The session start told the agent that TCR is unavailable, and no revert discarded the edit or the file."""
        assert "TCR is unavailable" in json.dumps(self.started), f"the session start did not report it: {self.started}"
        assert self.fixture_read(self.project / "notes.txt") == "mine\n", "the uncommitted file was changed"
        self.edit_is_neither_committed_nor_reverted()

    def commit_failure_pauses_tcr(self) -> None:
        """The agent is told TCR is unavailable, the change stays staged, and no commit was made."""
        assert "TCR is unavailable" in json.dumps(self.answer), f"the agent was not told: {self.answer}"
        assert self.git("diff", "--cached", "--name-only") == "example.py", "the change is not staged"
        assert self.subjects() == ["start"], f"the commits are {self.subjects()}, not only start"

    def warnings_increase(self) -> None:
        """An edit takes the warnings from 29 to 30."""
        self.fixture_write(self.result, "zanity: 0 errors and 30 warnings in 1 of 1 files\n")
        output = self.hook("PostToolUse", tool_name="Edit")
        assert "decision" not in output, f"the edit itself was refused: {output}"
        assert "30 warnings" in json.dumps(output), f"the edit that added a warning was not reported: {output}"

    def new_findings_guarded(self) -> None:
        """Stop is refused once findings grow."""
        stopped = self.hook("Stop")
        assert stopped.get("decision") == "block", f"Stop went through with new findings: {stopped}"
        assert "30 warnings" in stopped.get("reason", ""), f"the refusal does not name the 30 warnings: {stopped}"

    def commit_everything(self, message: str) -> None:
        """Commits the project's files as the agent's shell tool would, ignoring the machine's git configuration."""
        git = ["git", "-C", str(self.project), "-c", "user.name=test", "-c", "user.email=test@example.com",
               "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"]
        subprocess.run([*git, "add", "-A"], check=True, capture_output=True)
        subprocess.run([*git, "commit", "-q", "-m", message], check=True, capture_output=True)
        listed = subprocess.run([*git, "log", "--format=%s", "-1"], check=True, capture_output=True, text=True).stdout.strip()
        left = subprocess.run([*git, "status", "--porcelain"], check=True, capture_output=True, text=True).stdout.strip()
        assert listed == message, f"the last commit says {listed!r}, not {message!r}; commit something new"
        assert left == "", f"committing {message!r} left {left!r} uncommitted; commit every file"

    def committed_clean_session(self) -> None:
        """The project's files are committed and the session starts with a passing check."""
        self.commit_everything("start clean")
        started = self.hook("SessionStart")
        assert "decision" not in started, f"a clean session start was refused: {started}"
        assert "inherited backlog" not in json.dumps(started), f"a clean session start reported backlog: {started}"

    def break_and_commit_in_one_step(self) -> None:
        """One shell step brings 29 warnings and commits them."""
        self.fixture_write(self.result, "zanity: 0 errors and 29 warnings in 1 of 1 files\n")
        self.commit_everything("break the check")
        assert "29 warnings" in self.fixture_read(self.result), f"{self.result} lost the 29 warnings the step brings"
        self.responses = [self.hook("PostToolUse", tool_name="Bash"), self.hook("Stop")]
        assert len(self.responses) == 2, f"{len(self.responses)} answers for the step and the Stop attempt"

    def commit_does_not_hide_failure(self) -> None:
        """The warnings were reported as new, not as inherited backlog, and Stop is refused."""
        reported, stopped = self.responses
        assert "29 warnings" in json.dumps(reported), f"the step that brought 29 warnings was not reported: {reported}"
        assert "inherited backlog" not in json.dumps(reported), f"the new warnings were taken as inherited backlog: {reported}"
        assert stopped.get("decision") == "block", f"Stop went through with new warnings: {stopped}"

    def passing_go_required(self) -> None:
        """Publish is guarded by a passing Go project instead of zanity."""
        self.configure(protected_actions=[{"tool": "Publish", "checks": ["go"]}])
        self.fixture_write(self.project / "go.mod", "module example.com/passing\n")
        go = self.bin / "go"
        self.fixture_write(go, "#!/bin/sh\necho 'ok example.com/passing 0.1s'\n")
        go.chmod(0o755)
        assert os.access(go, os.X_OK), f"the fake go {go} is not executable"
        assert (self.project / "go.mod").is_file(), f"{self.project} has no go.mod to mark it a Go project"

    def publication_allowed_completion_guarded(self) -> None:
        """Publish goes through on passing Go while zanity's warnings still refuse Stop."""
        assert self.publish_response == {}, f"Publish was refused with Go passing: {self.publish_response}"
        assert self.stop_response.get("decision") == "block", f"Stop went through with zanity failing: {self.stop_response}"

    def checker_cannot_run(self) -> None:
        """zanity's fake now exits 97 before printing anything."""
        self.fixture_write(self.result, "zanity: checked 1 file, no issues found.\n")
        self.fixture_write(self.bin / "zanity", "#!/bin/sh\nexit 97\n")
        assert os.access(self.bin / "zanity", os.X_OK), f"the fake zanity {self.bin / 'zanity'} is no longer executable"
        assert "exit 97" in self.fixture_read(self.bin / "zanity"), f"the fake zanity in {self.bin} still runs its checks"

    def list_files(self) -> None:
        """Lists the project's files with rg."""
        self.response = self.hook("PreToolUse", tool_name="Bash", tool_input={"command": "rg --files"})
        assert type(self.response) is dict, f"listing files was answered {self.response}"
        assert self.response.get("hookSpecificOutput", {}).get("permissionDecision") != "deny", f"listing files was denied: {self.response}"

    def inspection_did_not_run_checks(self) -> None:
        """Listing files left the saved report as it was, without rerunning zanity."""
        assert self.response == {}, f"listing files was answered {self.response}"
        state = json.loads(self.fixture_read(next(self.data.glob("*.json"))))["state"]
        assert state["reports"][0]["summary"] == "zanity: 0 errors and 29 warnings in 1 of 1 files", f"the saved report changed to {state['reports'][0]['summary']}"

    def claude_new_failure(self) -> None:
        """Prepare a real Claude hook chain with a passing baseline followed by warnings."""
        assert not hasattr(self, "claude_steps"), f"Start in a fresh acceptance world; existing transcript: {getattr(self, 'claude_steps', None)!r}"
        assert (ROOT / "tests" / "fixtures" / "gating.ts").is_file(), "Claude scenarios require the shared watcher fixture"
        self.claude_phase = "ready"
        self.claude_steps = [
            "await $.session.start(start)",
            "await clock.advance(500)",
            "await $.tool.call({ tool: 'Edit', file_path: '/repo/example.py', old_string: 'a', new_string: 'b' })",
            "await clock.advance(1000)",
            "await $.turn.start({ text: 'finish', turnId: 't1' })",
            "prompts.length = 0",
            "calls.length = 0",
        ]

    def prepare_claude_steps(self, *, expected_phase: str, phase: str, steps: tuple[str, ...]) -> None:
        """Compose an action only after its required scenario phase has been prepared."""
        assert self.claude_phase == expected_phase, f"Expected {expected_phase}, got {self.claude_phase}"
        assert self.claude_steps and steps, "Prepare the watcher and supply executable action steps"
        self.claude_phase = phase
        self.claude_steps.extend(steps)

    def verify_claude(self, *, phase: str, expectations: tuple[str, ...]) -> None:
        """Run the scenario transcript and its observable outcome assertions once."""
        assert self.claude_phase == phase, f"Expected {phase}, got {self.claude_phase}"
        assert not (self.fixture_root / "claude-plugin").exists(), "Verify each transcript once"
        self.claude_steps.extend(expectations)
        self.run_claude_scenario()

    claude_empty_corrections = partialmethod(prepare_claude_steps, expected_phase='ready', phase='guarded', steps=(
        'await $.turn.complete(ended)',
        'expect(prompts.length).toBe(1)',
        'for (let i = 0; i < 3; i++) {',
        'await $.turn.start({ text: prompts[0]!, turnId: `retry-${i}` })',
        'await $.turn.complete({ ...ended, turnId: `retry-${i}` })',
        '}',
    ))

    def claude_clean_session(self) -> None:
        """A real Claude hook chain whose checks start clean, with no edit of the session's to follow."""
        assert not hasattr(self, "claude_steps"), f"Start in a fresh acceptance world; existing transcript: {getattr(self, 'claude_steps', None)!r}"
        self.claude_phase = "clean"
        self.claude_steps = ["await $.session.start(start)", "await clock.advance(300)"]

    claude_outside_changes = partialmethod(prepare_claude_steps, expected_phase='clean', phase='outside', steps=(
        'await clock.advance(1200)',
        "await $.turn.start({ text: 'what does this module do?', turnId: 'q1' })",
        "await $.turn.complete({ ...ended, turnId: 'q1' })",
        "setReport('zanity: 0 errors and 31 warnings in 1 of 1 files\\n')",
        'await clock.advance(1000)',
        "await $.turn.start({ text: prompts[0] ?? 'next', turnId: 'q2' })",
        "await $.turn.complete({ ...ended, turnId: 'q2' })",
        "setReport('zanity: 0 errors and 33 warnings in 1 of 1 files\\n')",
        'await clock.advance(1000)',
        "await $.turn.start({ text: 'and this one?', turnId: 'q3' })",
        "await $.turn.complete({ ...ended, turnId: 'q3' })",
    ))

    claude_outside_changes_correct_once = partialmethod(verify_claude, phase='outside', expectations=(
        'expect(prompts.length).toBe(1)',
        "expect(prompts.filter(text => text.includes('after the latest change'))).toEqual([])",
        "expect(calls).toEqual([])",
    ))

    claude_inspecting_corrections = partialmethod(prepare_claude_steps, expected_phase='ready', phase='inspected', steps=(
        'await $.turn.complete(ended)',
        'expect(prompts.length).toBe(1)',
        'for (let i = 0; i < 3; i++) {',
        'await $.turn.start({ text: prompts[0]!, turnId: `inspect-${i}` })',
        "await $.tool.call({ tool: 'Read', file_path: '/repo/example.py' })",
        "await $.tool.call({ tool: 'Bash', command: 'zanity check .' })",
        'await $.turn.complete({ ...ended, turnId: `inspect-${i}` })',
        '}',
    ))

    claude_inspection_does_not_repeat = partialmethod(verify_claude, phase='inspected', expectations=(
        'expect(prompts.length).toBe(1)',
        "expect(calls).toEqual(['Read', 'Bash', 'Read', 'Bash', 'Read', 'Bash'])",
    ))

    claude_loop_stops = partialmethod(verify_claude, phase='guarded', expectations=(
        'expect(prompts.length).toBe(1)',
        "expect(calls).toEqual([])",
        "try { await $.tool.call({ tool: 'Publish' }) } catch {}",
        "expect(calls).toEqual([])",
    ))

    def claude_work_resumes(self) -> None:
        """While an empty correction remains guarded, start a new turn and inspect the project."""
        assert self.claude_phase == "ready", "Resume work only after preparing a failing turn"
        self.claude_empty_corrections()
        assert self.claude_phase == "guarded", "Work must resume after the empty correction remains guarded"
        self.claude_phase = "resumed"
        self.claude_steps.extend([
            "await $.turn.start({ text: 'investigate', turnId: 'investigate' })",
            "await $.tool.call({ tool: 'Read', file_path: '/repo/example.py' })",
            "await $.turn.complete({ ...ended, turnId: 'investigate' })",
        ])

    claude_correction_resumes = partialmethod(verify_claude, phase='resumed', expectations=(
        "expect(calls).toEqual(['Read'])",
        'expect(prompts.length).toBe(2)',
        "expect(prompts[1]).toContain('29 warnings')",
    ))

    claude_abort = partialmethod(prepare_claude_steps, expected_phase='ready', phase='aborted', steps=(
        "await $.turn.complete({ ...ended, reason: 'aborted', isAborted: true })",
    ))

    claude_abort_settles = partialmethod(verify_claude, phase='aborted', expectations=(
        'expect(prompts).toEqual([])',
        "expect(calls).toEqual(['complete'])",
    ))

    def claude_denied_tools(self) -> None:
        """A rejected publication attempt does not count as completed work."""
        assert self.claude_phase == "ready", "Prepare the failing turn before testing denied tools"
        self.claude_empty_corrections()
        assert self.claude_phase == "guarded", "First exercise the unchanged completion guard"
        self.claude_steps.extend([
            "await $.turn.start({ text: 'publish', turnId: 'publish' })",
            "for (let i = 0; i < 3; i++) {",
            "try { await $.tool.call({ tool: 'Publish' }) } catch {}",
            "await $.turn.complete({ ...ended, turnId: 'publish' })",
            "}",
        ])

    claude_denials_do_not_restart = partialmethod(verify_claude, phase='guarded', expectations=(
        'expect(prompts.length).toBe(1)',
        "expect(calls).toEqual([])",
    ))

    def claude_findings_change(self) -> None:
        """New findings arrive while an unchanged correction remains guarded."""
        assert self.claude_phase == "ready", "Prepare the watcher before changing findings"
        self.claude_empty_corrections()
        assert self.claude_phase == "guarded", "Exercise the retry limit before reporting new findings"
        self.claude_phase = "changed"
        self.claude_steps.extend([
            "await $.turn.start({ text: 'review changed findings', turnId: 'changed' })",
            "await $.tool.call({ tool: 'Edit', file_path: '/repo/example.py', old_string: 'a', new_string: 'b' })",
            "setReport('zanity: 0 errors and 30 warnings in 1 of 1 files\\n')",
            "await clock.advance(1000)",
            "await $.turn.complete({ ...ended, turnId: 'changed' })",
            "await $.turn.start({ text: prompts[1]!, turnId: 'changed-retry' })",
            "await $.turn.complete({ ...ended, turnId: 'changed-retry' })",
        ])

    claude_changed_findings_get_one_correction = partialmethod(verify_claude, phase='changed', expectations=(
        'expect(prompts.length).toBe(2)',
        "expect(prompts[1]).toContain('30 warnings')",
        "expect(calls).toEqual(['Edit'])",
    ))

    claude_checks_recover = partialmethod(prepare_claude_steps, expected_phase='ready', phase='recovered', steps=(
        'await $.turn.complete(ended)',
        "await $.turn.start({ text: prompts[0]!, turnId: 'repair' })",
        'repair()',
        'await clock.advance(1000)',
        "await $.tool.call({ tool: 'Publish' })",
        "await $.turn.complete({ ...ended, turnId: 'repair' })",
    ))

    claude_recovery_releases_gate = partialmethod(verify_claude, phase='recovered', expectations=(
        'expect(prompts.length).toBe(1)',
        "expect(calls).toEqual(['Publish', 'complete'])",
    ))

    claude_abort_correction = partialmethod(prepare_claude_steps, expected_phase='ready', phase='correction-aborted', steps=(
        'await $.turn.complete(ended)',
        "await $.turn.start({ text: prompts[0]!, turnId: 'correction' })",
        "await $.turn.complete({ ...ended, turnId: 'correction', isAborted: true })",
        'await clock.advance(1000)',
    ))

    claude_interrupted_correction_stays_stopped = partialmethod(verify_claude, phase='correction-aborted', expectations=(
        'expect(prompts.length).toBe(1)',
        "expect(calls).toEqual(['complete'])",
    ))

    claude_api_error = partialmethod(prepare_claude_steps, expected_phase='ready', phase='api-error', steps=(
        "await $.turn.complete({ ...ended, reason: 'error', isAborted: false })",
        'await clock.advance(1000)',
    ))

    claude_api_error_settles = partialmethod(verify_claude, phase='api-error', expectations=(
        'expect(prompts).toEqual([])',
        "expect(calls).toEqual(['complete'])",
    ))

    claude_resume_after_interruption = partialmethod(prepare_claude_steps, expected_phase='ready', phase='user-resumed', steps=(
        "await $.turn.complete({ ...ended, reason: 'aborted', isAborted: true })",
        'await clock.advance(1000)',
        'expect(prompts).toEqual([])',
        "await $.turn.start({ text: 'continue investigation', turnId: 'user-resumed' })",
        "await $.tool.call({ tool: 'Read', file_path: '/repo/example.py' })",
        "await $.turn.complete({ ...ended, turnId: 'user-resumed' })",
    ))

    claude_user_resume_reports_again = partialmethod(verify_claude, phase='user-resumed', expectations=(
        'expect(prompts.length).toBe(1)',
        "expect(prompts[0]).toContain('29 warnings')",
        "expect(calls).toEqual(['complete', 'Read'])",
    ))

    claude_repeat_failure_cycle = partialmethod(prepare_claude_steps, expected_phase='ready', phase='failed-again', steps=(
        'await $.turn.complete(ended)',
        "await $.turn.start({ text: prompts[0]!, turnId: 'repair-cycle' })",
        'repair()',
        'await clock.advance(1000)',
        "await $.turn.complete({ ...ended, turnId: 'repair-cycle' })",
        "expect(calls).toEqual(['complete'])",
        "await $.turn.start({ text: 'review next change', turnId: 'failed-again' })",
        "setReport('zanity: 0 errors and 29 warnings in 1 of 1 files\\n')",
        'await clock.advance(1000)',
        "await $.turn.complete({ ...ended, turnId: 'failed-again' })",
        "await $.turn.start({ text: prompts[1]!, turnId: 'retry-again' })",
        "await $.turn.complete({ ...ended, turnId: 'retry-again' })",
    ))

    claude_repeat_failure_is_fresh = partialmethod(verify_claude, phase='failed-again', expectations=(
        'expect(prompts.length).toBe(2)',
        "expect(prompts[1]).toContain('29 warnings')",
        "expect(calls).toEqual(['complete'])",
    ))

    def claude_two_watchers(self) -> None:
        """Use two independent watcher outputs and retain the configured Zanity publication scope."""
        assert not hasattr(self, 'claude_steps'), f"Configure both watchers before preparing transcript {getattr(self, 'claude_steps', None)!r}"
        self.claude_with_zig = True
        self.claude_new_failure()
        assert self.claude_phase == 'ready', "Both watchers must start before exercising mixed recovery"

    claude_mixed_recovery = partialmethod(prepare_claude_steps, expected_phase='ready', phase='mixed-recovery', steps=(
        'await $.turn.complete(ended)',
        "expect(prompts[0]).toContain('zig')",
        "expect(prompts[0]).toContain('zanity')",
        "await $.turn.start({ text: 'repair zanity', turnId: 'partial-repair' })",
        'repair()',
        'await clock.advance(1000)',
        "await $.tool.call({ tool: 'Publish' })",
        "await $.turn.complete({ ...ended, turnId: 'partial-repair' })",
        'expect(prompts.length).toBe(2)',
        "expect(prompts[1]).toContain('zig')",
        "expect(prompts[1]).not.toContain('zanity')",
        "expect(calls).toEqual(['Publish'])",
        "await $.turn.start({ text: 'repair zig', turnId: 'all-repaired' })",
        "setZigReport('Build Summary: 3/3 steps succeeded; 1/1 tests passed\\n')",
        'await clock.advance(1000)',
        "await $.turn.complete({ ...ended, turnId: 'all-repaired' })",
    ))

    claude_mixed_gates_follow_reports = partialmethod(verify_claude, phase='mixed-recovery', expectations=(
        'expect(prompts.length).toBe(2)',
        "expect(calls).toEqual(['Publish', 'complete'])",
    ))

    claude_restart_session = partialmethod(prepare_claude_steps, expected_phase='ready', phase='restarted', steps=(
        'await $.turn.complete(ended)',
        "await $.turn.start({ text: prompts[0]!, turnId: 'old-correction' })",
        "await $.turn.complete({ ...ended, turnId: 'old-correction', reason: 'aborted', isAborted: true })",
        'expect(prompts.length).toBe(1)',
        '// fresh hook instance after restart',
        'await $.session.start(start)',
        'await clock.advance(500)',
        "await $.tool.call({ tool: 'Edit', file_path: '/repo/example.py', old_string: 'a', new_string: 'b' })",
        'calls.length = 0',
        'await clock.advance(1000)',
        'await clock.advance(1000)',
        'expect(prompts.length).toBe(1)',
        "await $.turn.start({ text: prompts[0]!, turnId: 'new-session' })",
        "await $.turn.complete({ ...ended, turnId: 'new-session' })",
    ))

    claude_restarted_session_corrects = partialmethod(verify_claude, phase='restarted', expectations=(
        'expect(prompts.length).toBe(2)',
        "expect(prompts[1]).toContain('29 warnings')",
        'expect(calls).toEqual([])',
    ))

    claude_resume_session = partialmethod(prepare_claude_steps, expected_phase='ready', phase='session-resumed', steps=(
        'await $.turn.complete(ended)',
        "await $.turn.start({ text: prompts[0]!, turnId: 'old-correction' })",
        "await $.turn.complete({ ...ended, turnId: 'old-correction', reason: 'aborted', isAborted: true })",
        "const resuming = $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })",
        'await clock.advance(1000)',
        'await resuming',
        'prompts.length = 0',
        'calls.length = 0',
        'await clock.advance(500)',
        "await $.tool.call({ tool: 'Edit', file_path: '/repo/example.py', old_string: 'a', new_string: 'b' })",
        'calls.length = 0',
        'await clock.advance(1000)',
        'expect(prompts.length).toBe(1)',
        "await $.turn.start({ text: prompts[0]!, turnId: 'resumed-session' })",
        "await $.turn.complete({ ...ended, turnId: 'resumed-session' })",
    ))

    claude_resumed_session_corrects = partialmethod(verify_claude, phase='session-resumed', expectations=(
        'expect(prompts.length).toBe(2)',
        "expect(prompts[1]).toContain('29 warnings')",
        'expect(calls).toEqual([])',
    ))

    def run_claude_scenario(self) -> None:
        """Run the accumulated DSL steps against the plugin in an isolated Claude test directory."""
        executable = shutil.which("claude")
        assert executable is not None, "Claude Code is required to verify Claude acceptance scenarios"
        plugin = self.fixture_root / "claude-plugin"
        plugin.mkdir()
        shutil.copytree(ROOT / "hooks", plugin / "hooks", ignore=shutil.ignore_patterns("__pycache__"))
        (plugin / ".claude-plugin").mkdir()
        shutil.copyfile(ROOT / ".claude-plugin" / "plugin.json", plugin / ".claude-plugin" / "plugin.json")
        # The fixture keeps its place beside hooks/, so its imports of the hooks resolve as they do in the repository.
        (plugin / "tests" / "fixtures").mkdir(parents=True)
        shutil.copyfile(ROOT / "tests" / "fixtures" / "gating.ts", plugin / "tests" / "fixtures" / "gating.ts")
        fixture = json.dumps("./tests/fixtures/gating")
        bodies = "\n".join(self.claude_steps).split("// fresh hook instance after restart")
        source = f'''
import {{ expect, test }} from 'claude-code/testing'
import {{ start, ended, gatingProject }} from {fixture}
'''
        for number, body in enumerate(bodies):
            source += f'''
test('Claude acceptance scenario {number + 1}', async ($, on) => {{
  const {{ clock, calls, prompts, setReport, setZigReport, repair }} = gatingProject(on, {{ withZig: {str(getattr(self, 'claude_with_zig', False)).lower()} }})
  try {{
    {body}
  }} finally {{
    const ending = $.session.end({{ reason: 'prompt_input_exit', sessionId: 's1', resume: {{ id: 's1' }} }})
    await clock.advance(1000)
    await ending
  }}
}})
'''
        (plugin / "scenario.test.ts").write_text(source)
        result = subprocess.run([executable, "plugin", "test", str(plugin)],
                                text=True, capture_output=True, timeout=30)
        assert result.returncode == 0, result.stdout + result.stderr
