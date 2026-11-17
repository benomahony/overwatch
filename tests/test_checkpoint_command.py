"""Tests of the checkpoint's command line, which the Claude Code plugin runs in a process of its own, against real git repositories.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import unittest
import unittest.mock
from pathlib import Path

from checkpoint_repository import RepositoryCase, git, install_hook, present, put
from codex_hook import read
from paths import ROOT
import checkpoint
import checkpoint_command
import saved_revert

CLI_TIMEOUT = 60


class CheckpointCommandTests(RepositoryCase):
    def run_cli(self, command: str, directory: Path | None = None, *flags: str) -> subprocess.CompletedProcess[str]:
        """Runs engine/checkpoint.py as the Claude Code plugin does, in a process of its own."""
        done = subprocess.run([sys.executable, str(ROOT / "engine" / "checkpoint.py"), command, str(directory or self.repo), *flags],
                              capture_output=True, text=True, timeout=CLI_TIMEOUT)
        assert isinstance(done.stdout, str), f"the command {command} printed {type(done.stdout)}, not text"
        assert done.returncode in (0, 1), f"the command {command} exited {done.returncode}, which it never does"
        return done

    def cli(self, command: str, directory: Path | None = None, *flags: str) -> tuple[int, dict[str, object]]:
        """What engine/checkpoint.py exits with and the JSON it prints."""
        done = self.run_cli(command, directory, *flags)
        printed = json.loads(done.stdout)
        assert isinstance(printed, dict), f"the command {command} printed {done.stdout!r}, not a JSON object"
        assert "\n" not in done.stdout.strip(), f"the command {command} printed more than one line: {done.stdout!r}"
        return done.returncode, printed

    def test_the_command_line_tells_why_tcr_cannot_start_or_that_it_can(self) -> None:
        self.assertEqual(self.cli("reason"), (0, {"reason": None}))
        put(self.repo / "new.txt", "new\n")
        code, printed = self.cli("reason")
        self.assertEqual(code, 0)
        self.assertEqual(printed, {"reason": checkpoint.unavailable_reason(self.repo)})
        self.assertIn("uncommitted", str(printed["reason"]))

    def test_the_command_line_reason_with_held_ignores_an_uncommitted_tree_and_nothing_else(self) -> None:
        put(self.repo / "a.txt", "edited\n")
        self.assertEqual(self.cli("reason", None, "--held"), (0, {"reason": None}))
        self.assertIn("uncommitted", str(self.cli("reason")[1]["reason"]))
        git(self.repo, ["checkout", "-q", "--detach"])
        code, printed = self.cli("reason", None, "--held")
        self.assertEqual(code, 0)
        self.assertIn("detached", str(printed["reason"]))

    def test_the_command_line_reason_refuses_a_flag_it_does_not_know(self) -> None:
        code, printed = self.cli("reason", None, "--force")
        self.assertEqual(code, 1)
        self.assertIn("--held", str(printed["error"]))

    def test_the_command_line_fingerprint_changes_with_the_files_and_not_with_ignored_ones(self) -> None:
        first = self.cli("fingerprint")[1]["fingerprint"]
        put(self.repo / "later.log", "ignored\n")
        self.assertEqual(self.cli("fingerprint")[1]["fingerprint"], first)
        put(self.repo / "a.txt", "edited\n")
        self.assertNotEqual(self.cli("fingerprint")[1]["fingerprint"], first)

    def test_the_command_line_checkpoint_commits_and_names_the_commit(self) -> None:
        put(self.repo / "a.txt", "edited\n")
        self.assertEqual(self.cli("checkpoint"), (0, {"commit": git(self.repo, ["rev-parse", "HEAD"]), "refused": [], "changed": False}))
        self.assertEqual(git(self.repo, ["log", "-1", "--format=%s"]), "tcr: a.txt")
        self.assertEqual(self.cli("checkpoint"), (0, {"commit": None, "refused": [], "changed": False}))

    def test_the_command_line_reports_a_failed_commit_with_an_exit_code_and_keeps_the_changes_staged(self) -> None:
        install_hook(self.repo, "pre-commit", "echo refused >&2\nexit 1")
        put(self.repo / "a.txt", "edited\n")
        code, printed = self.cli("checkpoint")
        self.assertEqual(code, 1)
        self.assertIn("checkpoint commit failed", str(printed["error"]))
        self.assertEqual(git(self.repo, ["diff", "--cached", "--name-only"]), "a.txt")

    def test_the_command_line_refuses_a_secret_file_commits_nothing_and_names_it(self) -> None:
        before = git(self.repo, ["rev-parse", "HEAD"])
        put(self.repo / ".env", "API_KEY=sk-ant-api03-" + "A" * 40 + "\n")
        put(self.repo / "a.txt", "edited\n")
        code, printed = self.cli("checkpoint")
        self.assertEqual(code, 0)
        self.assertEqual(printed, {"commit": None, "refused": [{"path": ".env", "rule": checkpoint.NAME_RULE, "line": None}], "changed": False})
        self.assertEqual(git(self.repo, ["rev-parse", "HEAD"]), before)
        self.assertEqual(git(self.repo, ["diff", "--cached", "--name-only"]), "")
        self.assertEqual(read(self.repo / "a.txt"), "edited\n")

    def test_the_command_line_names_the_line_of_a_secret_a_file_holds(self) -> None:
        put(self.repo / "a.txt", "base\nsecond\nkey = sk-ant-api03-" + "A" * 40 + "\n")
        code, printed = self.cli("checkpoint")
        self.assertEqual(code, 0)
        self.assertIsNone(printed["commit"])
        refused = printed["refused"]
        self.assertEqual([(each["path"], each["line"]) for each in refused], [("a.txt", 3)])
        self.assertNotEqual(refused[0]["rule"], checkpoint.NAME_RULE)

    def test_the_command_line_commits_a_secret_file_the_project_allows(self) -> None:
        put(self.repo / ".overwatch.json", json.dumps({"tcr": {"allow": [".env"]}}))
        put(self.repo / ".env", "API_KEY=sk-ant-api03-" + "A" * 40 + "\n")
        code, printed = self.cli("checkpoint")
        self.assertEqual((code, printed["refused"]), (0, []))
        self.assertEqual(printed["commit"], git(self.repo, ["rev-parse", "HEAD"]))
        self.assertIn(".env", git(self.repo, ["show", "--name-only", "--format=", "HEAD"]).split())

    def test_the_command_line_names_a_setting_of_the_wrong_type_as_an_error(self) -> None:
        put(self.repo / ".overwatch.json", json.dumps({"tcr": {"allow": ".env"}}))
        put(self.repo / "a.txt", "edited\n")
        code, printed = self.cli("checkpoint")
        self.assertEqual(code, 1)
        self.assertIn("tcr.allow", str(printed["error"]))

    def test_the_command_line_commits_when_the_files_are_those_the_caller_judged(self) -> None:
        put(self.repo / "a.txt", "edited\n")
        judged = str(self.cli("fingerprint")[1]["fingerprint"])
        code, printed = self.cli("checkpoint", None, "--expect", judged)
        self.assertEqual((code, printed["changed"]), (0, False))
        self.assertEqual(printed["commit"], git(self.repo, ["rev-parse", "HEAD"]))

    def test_the_command_line_commits_nothing_when_the_files_changed_since_the_caller_judged_them(self) -> None:
        put(self.repo / "a.txt", "edited\n")
        judged = str(self.cli("fingerprint")[1]["fingerprint"])
        put(self.repo / "later.txt", "written after the judgement\n")
        before = git(self.repo, ["rev-parse", "HEAD"])
        self.assertEqual(self.cli("checkpoint", None, "--expect", judged), (0, {"commit": None, "refused": [], "changed": True}))
        self.assertEqual(git(self.repo, ["rev-parse", "HEAD"]), before)
        self.assertEqual(git(self.repo, ["diff", "--cached", "--name-only"]), "")
        self.assertEqual(read(self.repo / "later.txt"), "written after the judgement\n")

    def test_the_command_line_checkpoint_refuses_any_flag_but_expect_with_a_fingerprint(self) -> None:
        put(self.repo / "a.txt", "edited\n")
        for flags in (("--force",), ("--expect",), ("--expect", ""), ("--expect", "x", "--force")):
            code, printed = self.cli("checkpoint", None, *flags)
            self.assertEqual(code, 1, flags)
            self.assertIn("--expect", str(printed["error"]))
        self.assertEqual(git(self.repo, ["rev-list", "--count", "HEAD"]), "1")

    def test_the_command_line_names_an_empty_allowed_path_as_an_error_and_commits_nothing(self) -> None:
        put(self.repo / ".overwatch.json", json.dumps({"tcr": {"allow": [".env", ""]}}))
        put(self.repo / "a.txt", "edited\n")
        before = git(self.repo, ["rev-parse", "HEAD"])
        code, printed = self.cli("checkpoint")
        self.assertEqual(code, 1)
        self.assertIn("tcr.allow", str(printed["error"]))
        self.assertEqual(git(self.repo, ["rev-parse", "HEAD"]), before)

    def test_the_command_line_names_a_tcr_field_it_does_not_know_and_an_allowed_path_of_only_wildcards(self) -> None:
        put(self.repo / "a.txt", "edited\n")
        before = git(self.repo, ["rev-parse", "HEAD"])
        for tcr, wording in (({"bogus": 1}, "unknown fields ['bogus']"), ({"allow": ["**/*"]}, "only wildcards"), ({"hostLimitSeconds": 0}, "tcr.hostLimitSeconds")):
            put(self.repo / ".overwatch.json", json.dumps({"tcr": tcr}))
            code, printed = self.cli("checkpoint")
            self.assertEqual(code, 1, tcr)
            self.assertIn(wording, str(printed["error"]))
        self.assertEqual(git(self.repo, ["rev-parse", "HEAD"]), before)

    def test_the_command_line_revert_saves_what_it_removes_in_a_ref_by_default(self) -> None:
        self.assertEqual(self.cli("revert"), (0, {"reverted": False, "saved": None}))
        put(self.repo / "a.txt", "edited\n")
        put(self.repo / "new.txt", "new\n")
        code, printed = self.cli("revert")
        self.assertEqual((code, printed["reverted"]), (0, True))
        ref = str(printed["saved"])
        self.assertTrue(ref.startswith(saved_revert.SAVED_REF_PREFIX), ref)
        self.assertEqual(git(self.repo, ["show", f"{ref}:a.txt"]), "edited")
        self.assertEqual(git(self.repo, ["show", f"{ref}:new.txt"]), "new")
        self.assertEqual(read(self.repo / "a.txt"), "base\n")
        self.assertFalse(present(self.repo / "new.txt"))

    def test_the_command_line_revert_says_when_the_saved_ref_also_holds_a_staged_version(self) -> None:
        put(self.repo / "a.txt", "edited\n")
        code, printed = self.cli("revert")
        self.assertEqual((code, "staged" in printed), (0, False))
        put(self.repo / "a.txt", "staged\n")
        git(self.repo, ["add", "a.txt"])
        put(self.repo / "a.txt", "later\n")
        code, printed = self.cli("revert")
        self.assertEqual((code, printed["reverted"], printed.get("staged")), (0, True, True))
        self.assertEqual(git(self.repo, ["show", f"{printed['saved']}^2:a.txt"]), "staged")

    def test_the_command_line_revert_saves_nothing_when_told_not_to(self) -> None:
        put(self.repo / "a.txt", "edited\n")
        self.assertEqual(self.cli("revert", None, "--no-save-ref"), (0, {"reverted": True, "saved": None}))
        self.assertEqual(git(self.repo, ["for-each-ref", "refs/overwatch"]), "")
        self.assertEqual(read(self.repo / "a.txt"), "base\n")

    def test_the_command_line_names_a_directory_outside_a_repository_as_an_error(self) -> None:
        code, printed = self.cli("reason", Path(self.outside.name))
        self.assertEqual(code, 1)
        self.assertIn("error", printed)

    def test_the_command_line_refuses_a_command_or_a_flag_it_does_not_know(self) -> None:
        code, printed = self.cli("explode")
        self.assertEqual(code, 1)
        self.assertIn("usage", str(printed["error"]))
        put(self.repo / "a.txt", "edited\n")
        code, printed = self.cli("revert", None, "--force")
        self.assertEqual(code, 1)
        self.assertIn("--no-save-ref", str(printed["error"]))
        self.assertEqual(read(self.repo / "a.txt"), "edited\n")

    def test_the_command_line_refuses_a_flag_where_a_command_takes_none(self) -> None:
        put(self.repo / "a.txt", "edited\n")
        for command in ("fingerprint",):
            code, printed = self.cli(command, None, "--force")
            self.assertEqual(code, 1, command)
            self.assertIn("--content", str(printed["error"]))
        self.assertEqual(git(self.repo, ["rev-list", "--count", "HEAD"]), "1")

    def test_the_fingerprint_command_answers_a_content_digest_that_follows_the_contents(self) -> None:
        put(self.repo / "a.txt", "edited\n")
        os.utime(self.repo / "a.txt", ns=(1, 1))
        code, plain = self.cli("fingerprint", None)
        self.assertEqual((code, set(plain)), (0, {"fingerprint"}))
        code, first = self.cli("fingerprint", None, "--content")
        self.assertEqual(code, 0)
        os.utime(self.repo / "a.txt", ns=(1, 1))
        put(self.repo / "a.txt", "rewrit\n")
        os.utime(self.repo / "a.txt", ns=(1, 1))
        code, second = self.cli("fingerprint", None, "--content")
        self.assertEqual(first["fingerprint"] == second["fingerprint"] and first["content"] != second["content"], True, (first, second))

    def test_a_revert_that_names_other_files_than_the_ones_there_now_changes_nothing(self) -> None:
        put(self.repo / "a.txt", "edited\n")
        _, now = self.cli("fingerprint", None)
        code, printed = self.cli("revert", None, "--expect", "not-the-fingerprint")
        self.assertEqual((code, printed), (0, {"reverted": False, "saved": None, "changed": True}))
        self.assertEqual(read(self.repo / "a.txt"), "edited\n")
        code, printed = self.cli("revert", None, "--expect", str(now["fingerprint"]), "--no-save-ref")
        self.assertEqual((code, printed["reverted"]), (0, True))
        self.assertEqual(read(self.repo / "a.txt"), "base\n")

    def test_a_failure_of_any_kind_in_a_command_is_printed_as_json_and_never_as_a_traceback(self) -> None:
        for failure in (IndexError("boom"), AssertionError("boom"), OSError("boom"), ValueError("boom")):
            with self.subTest(type(failure).__name__):
                printed = io.StringIO()
                with unittest.mock.patch.dict(checkpoint_command.COMMANDS, {"reason": unittest.mock.Mock(side_effect=failure)}), contextlib.redirect_stdout(printed):
                    code = checkpoint_command.main(["reason", str(self.repo)])
                self.assertEqual(code, 1)
                answer = json.loads(printed.getvalue())
                self.assertIn("boom", answer["error"])
                self.assertIn(type(failure).__name__, answer["error"])


if __name__ == "__main__":
    unittest.main()
