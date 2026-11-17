"""Tests of TCR's settings and what it refuses to commit: the saved copy of a revert, the allowlist, a secret and a setting that is not valid.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import json
import unittest

from checkpoint_repository import git, put
from codex_hook import read, write
from test_tcr import EDITING, FAILING, PASSING
from tcr_hardening_case import AWS_KEY, HardeningCase


class SettingsTests(HardeningCase):
    def test_a_revert_saves_the_discarded_work_and_names_the_ref_by_default(self) -> None:
        result = self.start()
        write(result, FAILING, PASSING)
        write(self.cwd / "extra.txt", "new")
        output, _ = self.call("PostToolUse", **EDITING)
        [saved] = self.revert_refs()
        self.assertIn(saved, self.context(output))
        self.assertIn(f"git checkout {saved} -- .", self.context(output))
        self.assertEqual(git(self.cwd, ["show", f"{saved}:result.txt"]), FAILING)
        self.assertEqual(git(self.cwd, ["show", f"{saved}:extra.txt"]), "new")
        self.assertEqual(read(result), PASSING)
        self.assertFalse((self.cwd / "extra.txt").exists())
        self.assertEqual(git(self.cwd, ["status", "--porcelain"]), "")

    def test_a_revert_saves_nothing_and_says_the_work_is_gone_when_the_setting_is_false(self) -> None:
        result = self.start(settings={"tcr": {"saveReverted": False}})
        write(result, FAILING, PASSING)
        output, _ = self.call("PostToolUse", **EDITING)
        self.assertEqual(self.revert_refs(), [])
        self.assertIn("is gone", self.context(output))
        self.assertIn("saveReverted", self.context(output))
        self.assertEqual(read(result), PASSING)

    def test_an_allow_list_that_is_not_a_list_of_paths_names_the_field(self) -> None:
        self.start(settings={"tcr": {"allow": ".env"}})
        self.assertIn("tcr.allow", str(self.started["systemMessage"]))

    def test_a_green_edit_that_adds_a_secret_file_commits_nothing_and_tcr_is_unavailable(self) -> None:
        result = self.start()
        write(result, f"{PASSING} again", PASSING)
        write(self.cwd / ".env", "TOKEN=1\n")
        output, _ = self.call("PostToolUse", **EDITING)
        self.assertEqual(self.subjects(), ["start"])
        self.assertIn("TCR is unavailable", self.context(output))
        self.assertIn(".env (name pattern)", self.context(output))
        self.assertIn("tcr.allow", self.context(output))
        self.assertEqual(read(self.cwd / ".env"), "TOKEN=1\n")
        self.assertEqual(read(result), f"{PASSING} again")
        self.assertEqual(git(self.cwd, ["diff", "--cached", "--name-only"]), "")

    def test_a_secret_in_a_source_file_is_named_with_its_line(self) -> None:
        self.start()
        write(self.cwd / "src.py", f"one = 1\nkey = '{AWS_KEY}'\n")
        output, _ = self.call("PostToolUse", **EDITING)
        self.assertEqual(self.subjects(), ["start"])
        self.assertIn("src.py:2 (AWS access key)", self.context(output))

    def test_a_refused_checkpoint_does_not_revert_what_a_later_red_edit_leaves(self) -> None:
        result = self.start()
        write(self.cwd / ".env", "TOKEN=1\n")
        self.call("PostToolUse", **EDITING)
        write(result, FAILING, PASSING)
        self.call("PostToolUse", **EDITING)
        self.assertEqual(read(result), FAILING)
        self.assertEqual(read(self.cwd / ".env"), "TOKEN=1\n")

    def test_an_allowed_env_file_is_committed(self) -> None:
        self.start(settings={"tcr": {"allow": [".env"]}})
        write(self.cwd / ".env", "TOKEN=1\n")
        self.call("PostToolUse", **EDITING)
        self.assertEqual(self.subjects()[0], "tcr: .env")

    def test_a_generic_key_assignment_is_committed(self) -> None:
        self.start()
        write(self.cwd / "settings.py", 'api_key = "x"\n')
        self.call("PostToolUse", **EDITING)
        self.assertEqual(self.subjects()[0], "tcr: settings.py")

    def test_a_template_env_file_is_committed(self) -> None:
        self.start()
        write(self.cwd / ".env.example", "TOKEN=\n")
        self.call("PostToolUse", **EDITING)
        self.assertEqual(self.subjects()[0], "tcr: .env.example")

    def test_a_tcr_setting_that_is_not_an_object_names_the_field(self) -> None:
        self.start(settings={"tcr": "yes"})
        self.assertIn("'tcr'", str(self.started["systemMessage"]))

    def test_a_save_setting_that_is_not_a_boolean_names_the_field(self) -> None:
        self.start(settings={"tcr": {"saveReverted": "yes"}})
        self.assertIn("tcr.saveReverted", str(self.started["systemMessage"]))

    def test_an_unknown_tcr_setting_names_the_field(self) -> None:
        self.start(settings={"tcr": {"saveReverteds": True}})
        self.assertIn("saveReverteds", str(self.started["systemMessage"]))

    def test_a_host_limit_that_is_not_a_positive_number_names_the_field(self) -> None:
        for value in (0, -3, "long", True):
            with self.subTest(value=value):
                put(self.cwd / ".overwatch.json", json.dumps({"mode": "tcr", "tcr": {"hostLimitSeconds": value}}))
                self.assertIn("tcr.hostLimitSeconds", str(self.call("SessionStart")[0]["systemMessage"]))


if __name__ == "__main__":
    unittest.main()
