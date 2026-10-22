"""Acceptance contract: repair remains possible while a failure gate is closed."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class FailureGatingAcceptanceTests(unittest.TestCase):
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
        path.relative_to(self.fixture_root)
        return path.read_text()

    def fixture_write(self, path: Path, text: str) -> None:
        """Only change files owned by this test's automatically cleaned fixture."""
        path.relative_to(self.fixture_root)
        path.write_text(text)

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

    def test_inspection_edits_and_check_commands_remain_available(self) -> None:
        self.new_warnings()
        operations = [
            ("Glob", {"pattern": "**/*"}), ("Grep", {"pattern": "value"}),
            ("Read", {"file_path": str(self.source)}),
            ("Edit", {"file_path": str(self.source)}),
            ("Write", {"file_path": str(self.source)}), ("apply_patch", {}),
            ("Bash", {"command": "rg --files"}),
            ("Bash", {"command": "cat example.py"}),
            ("Bash", {"command": "pytest"}),
            ("Bash", {"command": "zanity check . --watch --no-color"}),
        ]
        for tool, arguments in operations:
            with self.subTest(tool=tool, arguments=arguments):
                self.assertEqual(self.hook("PreToolUse", tool_name=tool, tool_input=arguments), {})
        self.assertIn("example.py", [path.name for path in self.project.iterdir()])
        self.assertEqual(self.fixture_read(self.source), "value = 1\n")
        self.fixture_write(self.source, "value = 2\n")
        self.assertEqual(self.fixture_read(self.source), "value = 2\n")

    def test_protected_actions_are_denied_on_every_attempt(self) -> None:
        self.new_warnings()
        for tool, arguments in [("Bash", {"command": "git push origin main"}), ("Publish", {})] * 2:
            with self.subTest(tool=tool):
                output = self.hook("PreToolUse", tool_name=tool, tool_input=arguments)
                decision = output.get("hookSpecificOutput", {})
                self.assertEqual(decision.get("permissionDecision"), "deny")
                self.assertIn("29 warnings", decision.get("permissionDecisionReason", ""))

    def test_completion_remains_guarded_during_stop_continuation(self) -> None:
        self.new_warnings()
        self.assertEqual(self.hook("Stop").get("decision"), "block")
        self.assertEqual(self.hook("Stop", stop_hook_active=True).get("decision"), "block")
        self.assertEqual(self.hook("Stop").get("decision"), "block")

    def test_success_clears_completion_and_protected_action_gates(self) -> None:
        self.new_warnings()
        self.assertEqual(self.hook("Stop").get("decision"), "block")
        self.fixture_write(self.result, "zanity: checked 1 file, no issues found.\n")
        self.hook("PostToolUse", tool_name="Bash", tool_input={"command": "zanity check ."})
        self.assertNotIn("decision", self.hook("Stop"))
        self.assertEqual(self.hook("PreToolUse", tool_name="Publish", tool_input={}), {})

    def test_inherited_backlog_stays_allowed_under_default_policy(self) -> None:
        self.fixture_write(self.result, "zanity: 0 errors and 29 warnings in 1 of 1 files\n")
        self.hook("SessionStart")
        self.assertNotIn("decision", self.hook("Stop"))
        self.assertEqual(self.hook("PreToolUse", tool_name="Publish", tool_input={}), {})
        self.fixture_write(self.result, "zanity: 0 errors and 30 warnings in 1 of 1 files\n")
        self.hook("PostToolUse", tool_name="Edit")
        self.assertEqual(self.hook("Stop").get("decision"), "block")

    def test_strict_inherited_policy_guards_completion_and_publication(self) -> None:
        self.configure(inherited="block")
        self.fixture_write(self.result, "zanity: 0 errors and 29 warnings in 1 of 1 files\n")
        self.hook("SessionStart")
        self.assertEqual(self.hook("Stop").get("decision"), "block")
        output = self.hook("PreToolUse", tool_name="Publish", tool_input={})
        self.assertEqual(output.get("hookSpecificOutput", {}).get("permissionDecision"), "deny")
        self.assertEqual(self.hook("PreToolUse", tool_name="Read", tool_input={}), {})

    def test_protection_can_be_scoped_to_relevant_checks(self) -> None:
        self.configure(protected_actions=[{"tool": "Publish", "checks": ["go"]}])
        self.fixture_write(self.project / "go.mod", "module example.com/passing\n")
        go = self.bin / "go"
        self.fixture_write(go, "#!/bin/sh\necho 'ok example.com/passing 0.1s'\n")
        go.chmod(0o755)
        self.new_warnings()
        self.assertEqual(self.hook("PreToolUse", tool_name="Publish", tool_input={}), {})
        self.assertEqual(self.hook("Stop").get("decision"), "block")

    def test_pretool_diagnostics_do_not_start_checks(self) -> None:
        self.new_warnings()
        self.fixture_write(self.result, "zanity: checked 1 file, no issues found.\n")
        script = self.bin / "zanity"
        self.fixture_write(script, "#!/bin/sh\nexit 97\n")
        output = self.hook("PreToolUse", tool_name="Bash", tool_input={"command": "rg --files"})
        self.assertEqual(output, {})
        state = json.loads(self.fixture_read(next(self.data.glob("*.json"))))
        self.assertEqual(state["reports"][0]["summary"], "zanity: 0 errors and 29 warnings in 1 of 1 files")


if __name__ == "__main__":
    unittest.main()
