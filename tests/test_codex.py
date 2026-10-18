from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "hooks" / "codex.py"
HOOKS_CONFIG = ROOT / "hooks" / "codex-hooks.json"
CODEX_MANIFEST = ROOT / ".codex-plugin" / "plugin.json"
CLAUDE_MANIFEST = ROOT / ".claude-plugin" / "plugin.json"


def write(path: Path, text: str) -> None:
    path.write_text(text)


def read(path: Path) -> str:
    return path.read_text()


class CodexHookTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.cwd = Path(self.temporary.name) / "project"
        self.data = Path(self.temporary.name) / "data"
        self.cwd.mkdir()

    def configure(self, *, watch: bool = False) -> tuple[Path, Path]:
        result = self.cwd / "result.txt"
        count = self.cwd / "count.txt"
        runner = self.cwd / "check.py"
        runner.write_text(
            textwrap.dedent(
                f"""
                from pathlib import Path
                import time

                count = Path({str(count)!r})
                count.write_text(str(int(count.read_text()) + 1) if count.exists() else "1")
                print(Path({str(result)!r}).read_text(), flush=True)
                {"time.sleep(30)" if watch else ""}
                """
            )
        )
        command = [sys.executable, str(runner)]
        config = {
            "name": "fixture",
            "summary": "^RESULT:.*$",
            "failed": "FAIL",
            "argv" if watch else "baseline": command,
        }
        (self.cwd / ".overwatch.json").write_text(json.dumps(config))
        return result, count

    def call(self, event: str, **fields: object) -> tuple[dict[str, object], float]:
        payload = {
            "session_id": "session-1",
            "cwd": str(self.cwd),
            "hook_event_name": event,
            **fields,
        }
        environment = {
            **os.environ,
            "PATH": "/usr/bin:/bin",
            "PLUGIN_DATA": str(self.data),
        }
        started = time.monotonic()
        process = subprocess.run(
            [sys.executable, str(HOOK)],
            input=json.dumps(payload),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            timeout=5,
            check=True,
        )
        return json.loads(process.stdout), time.monotonic() - started

    def test_failure_is_context_at_start_and_blocks_stop(self) -> None:
        result, count = self.configure()
        write(result, "details\nRESULT: FAIL")

        started, _ = self.call("SessionStart", source="startup")
        context = started["hookSpecificOutput"]
        self.assertIn("details", context["additionalContext"])
        self.assertEqual(started["systemMessage"], "Overwatch: fixture ✗ RESULT: FAIL")
        self.assertNotIn("decision", started)

        stopped, _ = self.call("Stop", stop_hook_active=False)
        self.assertEqual(stopped["decision"], "block")
        self.assertEqual(stopped["systemMessage"], "Overwatch: fixture ✗ RESULT: FAIL")
        self.assertIn("RESULT: FAIL", stopped["reason"])
        self.assertEqual(read(count), "1", "an unchanged workspace should use the cached report")

    def test_changed_workspace_reruns_and_reports_recovery(self) -> None:
        result, count = self.configure()
        write(result, "RESULT: FAIL")
        self.call("SessionStart", source="startup")

        write(result, "RESULT: PASS")
        recovered, _ = self.call("PostToolUse", tool_name="apply_patch")
        self.assertIn("green again", recovered["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(read(count), "2")

        stopped, _ = self.call("Stop", stop_hook_active=False)
        self.assertEqual(stopped, {})
        self.assertEqual(read(count), "2")

    def test_watch_command_stops_after_its_first_report(self) -> None:
        result, _ = self.configure(watch=True)
        write(result, "RESULT: PASS")

        output, elapsed = self.call("SessionStart", source="startup")
        self.assertEqual(output, {})
        self.assertLess(elapsed, 3)

    def test_enabled_false_runs_nothing(self) -> None:
        write(self.cwd / ".overwatch.json", json.dumps({"enabled": False}))
        output, _ = self.call("SessionStart", source="startup")
        self.assertEqual(output, {})

    def test_invalid_override_warns_without_blocking_codex(self) -> None:
        write(self.cwd / ".overwatch.json", "not json")
        output, _ = self.call("Stop", stop_hook_active=False)
        self.assertIn("systemMessage", output)
        self.assertNotIn("decision", output)

    def test_every_codex_hook_has_a_branded_status_message(self) -> None:
        config = json.loads(read(HOOKS_CONFIG))
        handlers = [
            handler
            for groups in config["hooks"].values()
            for group in groups
            for handler in group["hooks"]
        ]

        self.assertTrue(handlers)
        for handler in handlers:
            self.assertRegex(handler.get("statusMessage", ""), r"^Overwatch: ")

    def test_codex_overlay_registers_the_hook_config(self) -> None:
        codex = json.loads(read(CODEX_MANIFEST))
        claude = json.loads(read(CLAUDE_MANIFEST))

        self.assertFalse((ROOT / "plugin.json").exists(), "a root Agent Plugin manifest suppresses Codex hooks")
        self.assertEqual(codex["version"], claude["version"])
        self.assertEqual(codex["hooks"], "./hooks/codex-hooks.json")
        self.assertEqual(codex["interface"]["displayName"], "Overwatch")


if __name__ == "__main__":
    unittest.main()
