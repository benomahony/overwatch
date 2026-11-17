"""Tests of what TCR does when a revert may lose work, a start cannot be trusted or the host's time runs out, driven through the Codex hook with real git repositories.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import unittest
import unittest.mock
from pathlib import Path

from checkpoint_repository import git, isolate_git, make_dir, put, restore_git, set_environment, set_mode
from paths import ROOT
import checkpoint
import discovery
import tcr
import workspace
from codex_hook import read, write
from test_tcr import EDITING, FAILING, PASSING
from tcr_hardening_case import EXECUTABLE, FAILING_PYTEST, HardeningCase, PASSING_PYTEST, PROJECT_FILE


class HardeningTests(HardeningCase):
    def test_the_start_of_the_next_turn_after_a_revert_does_not_say_there_are_no_checks(self) -> None:
        result = self.start()
        write(result, FAILING, PASSING)
        self.call("PostToolUse", **EDITING)
        next_turn, _ = self.call("UserPromptSubmit")
        self.assertNotIn("TCR is unavailable", self.context(next_turn))
        write(result, FAILING, PASSING)
        again, _ = self.call("PostToolUse", **EDITING)
        self.assertIn("TCR reverted", self.context(again))

    def test_an_edit_whose_checks_used_up_the_host_limit_is_left_alone_and_the_agent_is_told(self) -> None:
        self.start_a_python_project({"tcr": {"hostLimitSeconds": tcr.MIN_SECONDS_LEFT + 1}})
        self.make_pytest_slow()
        output = self.edit("slow.txt")
        self.assertEqual(self.subjects(), ["start"])
        self.assertTrue((self.cwd / "slow.txt").exists())
        self.assertIn("seconds the host gives a hook", self.context(output))

    def test_the_same_slow_checks_leave_time_enough_under_the_default_limit(self) -> None:
        self.start_a_python_project()
        self.make_pytest_slow()
        self.edit("slow.txt")
        self.assertEqual(self.subjects()[0], "tcr: slow.txt")

    def test_the_branch_main_is_named_when_tcr_starts(self) -> None:
        self.start(branch="main")
        self.assertIn("`main`", self.context(self.started))
        self.assertIn("checkpoints", self.context(self.started))

    def test_the_branch_master_is_named_when_tcr_starts(self) -> None:
        self.start(branch="master")
        self.assertIn("`master`", self.context(self.started))

    def test_another_branch_is_not_named(self) -> None:
        self.start(branch="feature")
        self.assertNotIn("checkpoints land on", self.context(self.started))
        self.assertIn("TCR is on", self.context(self.started))

    def test_files_that_a_check_wrote_are_named_in_the_reason_tcr_is_unavailable(self) -> None:
        result, _ = self.configure()
        runner = self.cwd / "check.py"
        text = read(runner)
        write(runner, text + "\nPath(__file__).parent.joinpath('artifact.log').write_text('x')\n", text)
        self.set_setting("mode", "tcr")
        write(result, PASSING)
        self.commit("start")
        started, _ = self.call("SessionStart")
        self.assertIn("TCR is unavailable", self.context(started))
        self.assertIn("artifact.log", self.context(started))
        self.assertIn("the checks changed the files while they ran", self.context(started))
        self.assertIn("add what a check writes to .gitignore", self.context(started))

    def test_a_revert_that_raises_makes_tcr_unavailable_with_the_error_and_leaves_the_files_and_commits(self) -> None:
        self.start_a_python_project()
        self.fail_pytest()
        write(self.cwd / "bad.txt", "edit\n")
        failing = unittest.mock.Mock(side_effect=checkpoint.CheckpointError("git took longer than 30 seconds"))
        with unittest.mock.patch.object(checkpoint, "revert", failing):
            output = self.call_here("PostToolUse", **EDITING)
        self.assertIn("TCR is unavailable: git took longer than 30 seconds", self.context(output))
        self.assertEqual(read(self.cwd / "bad.txt"), "edit\n")
        self.assertEqual(self.subjects(), ["start"])
        self.assertEqual(self.revert_refs(), [])
        again = self.call_here("PostToolUse", **EDITING)
        self.assertNotIn("TCR reverted", self.context(again))

    def test_a_revert_that_is_given_up_because_files_keep_changing_reverts_nothing_and_says_so(self) -> None:
        """The revert the hook asks for is given up after its saves, and the hook tells the agent so without reverting."""
        self.start_a_python_project()
        self.fail_pytest()
        write(self.cwd / "bad.txt", "edit\n")
        real_revert = checkpoint.revert
        written = [0]

        def write_another_file() -> None:
            written[0] += 1
            assert written[0] <= checkpoint.MAX_SAVE_ATTEMPTS, f"the revert saved {written[0]} times, more than {checkpoint.MAX_SAVE_ATTEMPTS}"
            write(self.cwd / f"flood{written[0]}.txt", "again\n")
            assert (self.cwd / f"flood{written[0]}.txt").exists(), f"flood{written[0]}.txt was not written to {self.cwd}"

        def revert_while_files_change(cwd: Path, *, save_ref: bool = True) -> str | None:
            assert save_ref, "the hook asked for a revert that does not save, so the files cannot keep changing while it saves"
            assert cwd.resolve() == self.cwd.resolve(), f"the hook reverted {cwd}, not {self.cwd}"
            return real_revert(cwd, save_ref=save_ref, after_save=write_another_file)

        with unittest.mock.patch.object(checkpoint, "revert", revert_while_files_change):
            output = self.call_here("PostToolUse", **EDITING)
        self.assertEqual(written[0], checkpoint.MAX_SAVE_ATTEMPTS)
        self.assertIn("TCR is unavailable", self.context(output))
        self.assertIn("kept changing", self.context(output))
        self.assertNotIn("TCR reverted", self.context(output))
        self.assertEqual(read(self.cwd / "bad.txt"), "edit\n")
        self.assertEqual(self.revert_refs(), [])

    def test_files_that_a_check_writes_during_a_turn_are_named_with_the_check_and_the_advice(self) -> None:
        self.start_a_python_project()
        put(self.bin / "pytest", f"#!/bin/sh\necho 'artifact' > artifact.txt\necho '{PASSING_PYTEST}'\n")
        set_mode(self.bin / "pytest", EXECUTABLE)
        output = self.edit("second.txt")
        self.assertIn("the check python wrote files (artifact.txt)", self.context(output))
        self.assertIn("add them to .gitignore", self.context(output))
        self.assertEqual(self.subjects(), ["start"])
        self.assertTrue((self.cwd / "second.txt").exists())

    def test_a_failing_check_when_no_file_differs_from_the_checkpoint_is_held_and_the_agent_is_told_there_is_nothing_to_revert(self) -> None:
        self.start_a_python_project()
        self.fail_pytest()
        text = read(self.cwd / "pyproject.toml")
        write(self.cwd / "pyproject.toml", text, text)
        output = self.call("PostToolUse", **EDITING)[0]
        self.assertIn("TCR left the latest change uncommitted and unreverted", self.context(output))
        self.assertIn("python reported === 1 failed", self.context(output))
        self.assertIn("no file differs from the latest checkpoint, so there is nothing to revert", self.context(output))
        self.assertEqual(self.subjects(), ["start"])

    def test_a_revert_needs_the_time_for_its_git_calls_while_a_commit_needs_only_a_margin(self) -> None:
        limit = tcr.REVERT_SECONDS_LEFT - 1
        self.start_a_python_project({"tcr": {"hostLimitSeconds": limit}})
        self.fail_pytest()
        held = self.edit("bad.txt")
        self.assertIn("TCR held the edit", self.context(held))
        self.assertIn(f"reverting needs {tcr.REVERT_SECONDS_LEFT} more", self.context(held))
        self.assertEqual(read(self.cwd / "bad.txt"), "edit\n")
        self.assertEqual(self.revert_refs(), [])
        self.tool("pytest", PASSING_PYTEST, 0, replacing=(FAILING_PYTEST, 1))
        self.edit("good.txt")
        self.assertEqual(self.subjects()[0], "tcr: bad.txt, good.txt")
        self.assertEqual(git(self.cwd, ["status", "--porcelain"]), "")

    def test_a_revert_goes_ahead_when_the_limit_leaves_the_time_it_needs(self) -> None:
        self.start_a_python_project({"tcr": {"hostLimitSeconds": tcr.REVERT_SECONDS_LEFT + tcr.MIN_SECONDS_LEFT}})
        self.fail_pytest()
        output = self.edit("bad.txt")
        self.assertIn("TCR reverted", self.context(output))
        self.assertFalse((self.cwd / "bad.txt").exists())

    def test_a_revert_says_which_submodule_it_left_alone_instead_of_claiming_a_clean_tree(self) -> None:
        """A change inside a submodule that a revert cannot undo is named in the message, which does not say the tree is clean."""
        source = Path(self.temporary.name) / "inner"
        make_dir(source)
        git(source, ["init", "-q", "-b", "main"])
        put(source / "s.txt", "inner\n")
        git(source, ["add", "-A"])
        git(source, ["commit", "-q", "-m", "inner"])
        write(self.cwd / ".overwatch.json", json.dumps({"mode": "tcr"}))
        write(self.cwd / "pyproject.toml", PROJECT_FILE)
        self.tool("pytest", PASSING_PYTEST, 0)
        git(self.cwd, ["add", "-A"])
        git(self.cwd, ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "start"])
        git(self.cwd, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", str(source), "libs"])
        self.commit("add the submodule")
        self.assertIn("TCR is on", self.context(self.call("SessionStart")[0]))
        self.fail_pytest()
        write(self.cwd / "libs" / "new.txt", "inside\n")
        write(self.cwd / "bad.txt", "edit\n")
        output = self.call("PostToolUse", **EDITING)[0]
        self.assertIn("TCR reverted", self.context(output))
        self.assertIn("Restored: `bad.txt`", self.context(output))
        self.assertIn("not restored", self.context(output))
        self.assertIn("`libs`", self.context(output))
        self.assertTrue((self.cwd / "libs" / "new.txt").exists())

    def test_a_revert_message_names_the_command_for_the_staged_version_only_when_one_was_saved(self) -> None:
        ref = "refs/overwatch/reverted/20261117T000000000000Z"
        self.assertNotIn("^2", tcr.restoration(["a.txt"], ref, [], staged=False))
        self.assertIn(f"`git checkout {ref}^2 -- .`", tcr.restoration(["a.txt"], ref, [], staged=True))

    def test_an_edit_the_agent_made_while_the_first_checks_ran_is_named_as_the_reason_tcr_is_unavailable(self) -> None:
        write(self.cwd / ".overwatch.json", json.dumps({"mode": "tcr"}))
        write(self.cwd / "pyproject.toml", PROJECT_FILE)
        self.tool("pytest", PASSING_PYTEST, 0)
        self.commit("start")
        self.call("PreToolUse", **EDITING)
        write(self.cwd / "early.txt", "edit\n")
        started, _ = self.call("SessionStart")
        self.assertIn("TCR is unavailable", self.context(started))
        self.assertIn("the agent edited while the first checks ran", self.context(started))
        self.assertNotIn("a check wrote", self.context(started))
        self.assertEqual(self.subjects(), ["start"])

    def test_a_person_resetting_a_checkpoint_loses_nothing_to_a_later_failing_edit(self) -> None:
        self.start_a_python_project()
        self.edit("first.txt")
        git(self.cwd, ["reset", "-q", "--soft", "HEAD~1"])
        next_turn, _ = self.call("UserPromptSubmit")
        self.assertIn("TCR is unavailable", self.context(next_turn))
        self.tool("pytest", FAILING_PYTEST, 1, replacing=(PASSING_PYTEST, 0))
        output = self.edit("second.txt")
        self.assertNotIn("TCR reverted", self.context(output))
        self.assertEqual(read(self.cwd / "first.txt"), "edit\n")
        self.assertEqual(read(self.cwd / "second.txt"), "edit\n")
        self.assertEqual(self.subjects(), ["start"])


class TimeBudgetTests(unittest.TestCase):
    def test_tcr_acts_only_with_time_left_for_git_before_the_host_stops_the_hook(self) -> None:
        last_good = tcr.HOST_LIMIT_SECONDS - tcr.MIN_SECONDS_LEFT
        limit = tcr.HOST_LIMIT_SECONDS
        needed = tcr.MIN_SECONDS_LEFT
        self.assertTrue(tcr.has_time_for_git(started=100.0, now=100.0 + last_good - 1, limit=limit, needed=needed))
        self.assertFalse(tcr.has_time_for_git(started=100.0, now=100.0 + last_good + 1, limit=limit, needed=needed))
        self.assertFalse(tcr.has_time_for_git(started=100.0, now=100.0 + limit + 1, limit=limit, needed=needed))

    def test_a_revert_needs_a_save_for_each_attempt_and_the_reset_and_the_clean_at_the_longest_git_takes(self) -> None:
        self.assertEqual(tcr.REVERT_SECONDS_LEFT, (checkpoint.MAX_SAVE_ATTEMPTS + 2) * checkpoint.GIT_TIMEOUT)
        revert_start = tcr.HOST_LIMIT_SECONDS - tcr.REVERT_SECONDS_LEFT
        self.assertTrue(tcr.has_time_for_git(100.0, 100.0 + revert_start - 1, tcr.HOST_LIMIT_SECONDS, tcr.REVERT_SECONDS_LEFT))
        self.assertFalse(tcr.has_time_for_git(100.0, 100.0 + revert_start + 1, tcr.HOST_LIMIT_SECONDS, tcr.REVERT_SECONDS_LEFT))

    def test_the_host_limit_is_the_shortest_one_a_host_gives_the_hook(self) -> None:
        hooks = json.loads(read(ROOT / "integrations" / "codex-hooks.json"))
        limits = [hook["timeout"] for groups in hooks["hooks"].values() for group in groups for hook in group["hooks"]]
        found = re.search(r"const TIMEOUT_MS = ([\d_]+)", read(ROOT / "engine" / "check.js"))
        self.assertIsNotNone(found)
        checker = int(found.group(1).replace("_", "")) // 1000
        self.assertEqual(tcr.HOST_LIMIT_SECONDS, min([*limits, checker]))
        self.assertGreaterEqual(tcr.MIN_SECONDS_LEFT, checkpoint.GIT_TIMEOUT)

    def setUp(self) -> None:
        self.addCleanup(restore_git, isolate_git())
        self.fake = tempfile.TemporaryDirectory()
        self.addCleanup(self.fake.cleanup)
        self.repo = tempfile.TemporaryDirectory()
        self.addCleanup(self.repo.cleanup)
        git(Path(self.repo.name), ["init", "-q"])
        assert (Path(self.repo.name) / ".git").is_dir(), f"{self.repo.name} is no repository to list the files of"
        assert Path(self.fake.name).is_dir() and not any(Path(self.fake.name).iterdir()), f"{self.fake.name} is not an empty directory for the fake git"

    def test_a_listing_that_takes_too_long_says_so(self) -> None:
        script = Path(self.fake.name) / "git"
        put(script, f'#!/bin/sh\n[ "$1" = ls-files ] && exec sleep {workspace.GIT_TIMEOUT * 4}\nexec {shutil.which("git")} "$@"\n')
        set_mode(script, EXECUTABLE)
        self.addCleanup(restore_git, set_environment({"PATH": f"{self.fake.name}{os.pathsep}{os.environ['PATH']}"}))
        with self.assertRaises(discovery.ConfigurationError) as caught:
            workspace.workspace_files(Path(self.repo.name))
        self.assertIn(f"took more than {workspace.GIT_TIMEOUT} seconds", str(caught.exception))
        self.assertIn("does nothing, TCR included", str(caught.exception))


class SettlingTests(unittest.TestCase):
    def test_an_edit_with_no_check_to_read_is_not_settled(self) -> None:
        current = tcr.State(fingerprint="files:digest", reports=())
        self.assertFalse(tcr.settles_edit(current, True))
        assert not current.reports, f"{current} holds reports; this test needs none"


if __name__ == "__main__":
    unittest.main()
