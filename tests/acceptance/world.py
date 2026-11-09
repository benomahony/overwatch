"""Acceptance contract: repair remains possible while a failure gate is closed."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from paths import ROOT

from .claude_steps import ClaudeSteps


class AcceptanceWorld(ClaudeSteps, unittest.TestCase):
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
            [sys.executable, str(ROOT / "integrations" / "codex.py")],
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
