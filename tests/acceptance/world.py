"""Acceptance contract: repair remains possible while a failure gate is closed."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class AcceptanceWorld(unittest.TestCase):
    def setUp(self) -> None:
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

    def fixture_read(self, path: Path) -> str:
        """Only read files owned by this test's automatically cleaned fixture."""
        resolved = path.resolve()
        resolved.relative_to(self.fixture_root.resolve())
        return resolved.read_text()

    def fixture_write(self, path: Path, text: str) -> None:
        """Only change files owned by this test's automatically cleaned fixture."""
        resolved = path.resolve()
        resolved.relative_to(self.fixture_root.resolve())
        resolved.write_text(text)

    def configure(self, **gate: object) -> None:
        protected = [
            {"tool": "Bash", "command": r"\bgit\s+push\b", "checks": ["zanity"]},
            {"tool": "Publish", "checks": ["zanity"]},
        ]
        config = {"gate": {"protected_actions": protected, **gate}}
        (self.project / ".overwatch.json").write_text(json.dumps(config))

    def hook(self, event: str, **fields: object) -> dict[str, object]:
        payload = {"session_id": "acceptance", "cwd": str(self.project),
                   "hook_event_name": event, **fields}
        result = subprocess.run(
            [sys.executable, str(ROOT / "hooks" / "codex.py")],
            input=json.dumps(payload), text=True, capture_output=True, check=True,
            env={**os.environ, "PATH": f"{self.bin}:/usr/bin:/bin", "PLUGIN_DATA": str(self.data)},
            timeout=5,
        )
        return json.loads(result.stdout)

    def new_warnings(self) -> None:
        self.hook("SessionStart")
        self.result.write_text("zanity: 0 errors and 29 warnings in 1 of 1 files\n")
        self.hook("PostToolUse", tool_name="Edit")

    def inspect_and_repair(self) -> None:
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

    def repair_operations_allowed(self) -> None:
        self.assertEqual(self.responses, [{}] * 10)
        self.assertIn("example.py", self.listing)
        self.assertEqual(self.before_edit, "value = 1\n")
        self.assertEqual(self.fixture_read(self.source), "value = 2\n")

    def attempt_protected_actions(self) -> None:
        attempts = [("Bash", {"command": "git push origin main"}), ("Publish", {})] * 2
        self.responses = [self.hook("PreToolUse", tool_name=tool, tool_input=arguments)
                          for tool, arguments in attempts]

    def protected_actions_denied(self) -> None:
        for output in self.responses:
            decision = output.get("hookSpecificOutput", {})
            self.assertEqual(decision.get("permissionDecision"), "deny")
            self.assertIn("29 warnings", decision.get("permissionDecisionReason", ""))

    def attempt_completion(self) -> None:
        self.responses = [self.hook("Stop"), self.hook("Stop", stop_hook_active=True), self.hook("Stop")]

    def completion_denied(self) -> None:
        self.assertEqual([output.get("decision") for output in self.responses], ["block"] * 3)

    def report_success(self) -> None:
        self.fixture_write(self.result, "zanity: checked 1 file, no issues found.\n")
        self.hook("PostToolUse", tool_name="Bash", tool_input={"command": "zanity check ."})

    def gates_cleared(self) -> None:
        self.assertNotIn("decision", self.hook("Stop"))
        self.assertEqual(self.hook("PreToolUse", tool_name="Publish", tool_input={}), {})

    def inherited_warnings(self) -> None:
        self.fixture_write(self.result, "zanity: 0 errors and 29 warnings in 1 of 1 files\n")
        self.hook("SessionStart")

    def strict_inherited_policy(self) -> None:
        self.configure(inherited="block")

    def inherited_findings_guarded(self) -> None:
        self.assertEqual(self.stop_response.get("decision"), "block")
        self.assertEqual(self.publish_response.get("hookSpecificOutput", {}).get("permissionDecision"), "deny")
        self.assertEqual(self.read_response, {})

    def attempt_completion_and_publication(self) -> None:
        self.stop_response = self.hook("Stop")
        self.publish_response = self.hook("PreToolUse", tool_name="Publish", tool_input={})
        self.read_response = self.hook("PreToolUse", tool_name="Read", tool_input={})

    def inherited_findings_allowed(self) -> None:
        self.assertNotIn("decision", self.stop_response)
        self.assertEqual(self.publish_response, {})

    def warnings_increase(self) -> None:
        self.fixture_write(self.result, "zanity: 0 errors and 30 warnings in 1 of 1 files\n")
        self.hook("PostToolUse", tool_name="Edit")

    def new_findings_guarded(self) -> None:
        self.assertEqual(self.hook("Stop").get("decision"), "block")

    def passing_go_required(self) -> None:
        self.configure(protected_actions=[{"tool": "Publish", "checks": ["go"]}])
        self.fixture_write(self.project / "go.mod", "module example.com/passing\n")
        go = self.bin / "go"
        self.fixture_write(go, "#!/bin/sh\necho 'ok example.com/passing 0.1s'\n")
        go.chmod(0o755)

    def publication_allowed_completion_guarded(self) -> None:
        self.assertEqual(self.publish_response, {})
        self.assertEqual(self.stop_response.get("decision"), "block")

    def checker_cannot_run(self) -> None:
        self.fixture_write(self.result, "zanity: checked 1 file, no issues found.\n")
        self.fixture_write(self.bin / "zanity", "#!/bin/sh\nexit 97\n")

    def list_files(self) -> None:
        self.response = self.hook("PreToolUse", tool_name="Bash", tool_input={"command": "rg --files"})

    def inspection_did_not_run_checks(self) -> None:
        self.assertEqual(self.response, {})
        state = json.loads(self.fixture_read(next(self.data.glob("*.json"))))
        self.assertEqual(state["reports"][0]["summary"], "zanity: 0 errors and 29 warnings in 1 of 1 files")
