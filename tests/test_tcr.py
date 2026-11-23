"""Tests of TCR mode in the Codex hook, driven through its stdin with real git repositories and a fixture check.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

import paths
from checkpoint_repository import git, install_hook, isolate_git, restore_git
from codex_hook import CodexHook, read, write

PASSING = "RESULT: PASS"
FAILING = "RESULT: FAIL"
EDITING = {"tool_name": "Edit"}


class TcrHookTests(CodexHook):
    def setUp(self) -> None:
        self.addCleanup(restore_git, isolate_git())
        CodexHook.setUp(self)
        assert os.environ["GIT_CONFIG_GLOBAL"] == "/dev/null", "the hook would read the machine's git configuration"
        assert (self.cwd / ".git").is_dir(), f"{self.cwd} is no repository for the hook to work in"

    def set_setting(self, name: str, value: object) -> None:
        settings = self.cwd / ".overwatch.json"
        text = read(settings)
        write(settings, json.dumps({**json.loads(text), name: value}), text)
        assert json.loads(read(settings))[name] == value, f"{settings} does not hold {name} as {value!r}"
        assert settings.exists(), f"{settings} is gone after the write"

    def start(self, result_text: str = PASSING, mode: str = "tcr", settings: dict[str, object] | None = None, branch: str | None = None) -> Path:
        """Commits a project whose check prints result_text, in the given mode and with the given further settings, on
        the given branch when there is one, and starts the session on it."""
        result, _ = self.configure()
        self.set_setting("mode", mode)
        for name, value in (settings or {}).items():
            self.set_setting(name, value)
        write(result, result_text)
        self.commit("start")
        if branch is not None:
            git(self.cwd, ["branch", "-m", branch])
        self.started = self.call("SessionStart")[0]
        assert read(result) == result_text, f"{result} holds {read(result)!r}, not the {result_text!r} the session started on"
        assert self.subjects() == ["start"], f"the session started on {self.subjects()}, not one start commit"
        return result

    def subjects(self) -> list[str]:
        subjects = git(self.cwd, ["log", "--format=%s"]).splitlines()
        assert subjects, f"{self.cwd} has no commit to list"
        assert all(subjects), f"a commit of {self.cwd} has an empty subject: {subjects}"
        return subjects

    def context(self, output: dict[str, object]) -> str:
        context = output.get("hookSpecificOutput", {})
        text = str(context.get("additionalContext", "")) if isinstance(context, dict) else ""
        assert isinstance(output, dict), f"the hook answered with {output!r}, not an object"
        assert text == "" or isinstance(context, dict), f"context {context!r} holds text but is no object"
        return text

    def test_an_edit_that_keeps_the_checks_green_is_committed(self) -> None:
        result = self.start()
        write(result, f"{PASSING} again", PASSING)
        output, _ = self.call("PostToolUse", **EDITING)
        self.assertEqual(self.subjects()[0], "tcr: result.txt")
        self.assertEqual(git(self.cwd, ["status", "--porcelain"]), "")
        self.assertNotIn("reverted", self.context(output))

    def test_an_edit_that_changes_no_content_makes_no_commit_and_leaves_tcr_on(self) -> None:
        result = self.start()
        write(result, PASSING, PASSING)
        output, _ = self.call("PostToolUse", **EDITING)
        self.assertEqual(self.subjects(), ["start"])
        self.assertNotIn("unavailable", self.context(output))
        write(result, f"{PASSING} again", PASSING)
        self.call("PostToolUse", **EDITING)
        self.assertEqual(self.subjects()[0], "tcr: result.txt")

    def test_an_edit_that_adds_a_failure_is_reverted_and_told(self) -> None:
        result = self.start()
        write(result, FAILING, PASSING)
        write(self.cwd / "extra.txt", "new")
        output, _ = self.call("PostToolUse", **EDITING)
        self.assertEqual(read(result), PASSING)
        self.assertFalse((self.cwd / "extra.txt").exists())
        self.assertEqual(self.subjects(), ["start"])
        self.assertIn("reverted", self.context(output))
        self.assertIn("`result.txt`", self.context(output))
        self.assertIn(FAILING, self.context(output))

    def test_a_failure_that_returns_after_a_revert_is_reverted_and_told_again(self) -> None:
        result = self.start()
        for _ in range(2):
            write(result, FAILING, PASSING)
            output, _ = self.call("PostToolUse", **EDITING)
            self.assertIn("reverted", self.context(output))
            self.assertEqual(read(result), PASSING)

    def test_inherited_failures_are_left_alone(self) -> None:
        self.start(FAILING)
        write(self.cwd / "notes.txt", "notes")
        self.call("PostToolUse", **EDITING)
        self.assertEqual(self.subjects()[0], "tcr: notes.txt")

    def test_blocked_inherited_failures_prevent_a_checkpoint_and_a_revert(self) -> None:
        result = self.start(FAILING)
        self.set_setting("gate", {"inherited": "block"})
        self.commit("block inherited failures")
        write(self.cwd / "notes.txt", "notes")
        self.call("PostToolUse", **EDITING)
        self.assertEqual(self.subjects()[0], "block inherited failures")
        self.assertEqual(read(self.cwd / "notes.txt"), "notes")
        self.assertEqual(read(result), FAILING)

    def test_an_unchanged_workspace_is_not_committed_again(self) -> None:
        result = self.start()
        write(result, f"{PASSING} again", PASSING)
        self.call("PostToolUse", **EDITING)
        self.call("PostToolUse", **EDITING)
        self.assertEqual(self.subjects(), ["tcr: result.txt", "start"])

    def test_an_overtaken_result_neither_commits_nor_reverts_and_the_next_edit_settles(self) -> None:
        self.start()
        runner = self.cwd / "check.py"
        text = read(runner)
        write(runner, text + "\nlate = Path(__file__).parent / 'late.txt'\nlate.exists() or late.write_text('late')\n", text)
        self.call("PostToolUse", **EDITING)
        self.assertEqual(self.subjects(), ["start"])
        self.assertTrue((self.cwd / "late.txt").exists())
        self.call("PostToolUse", **EDITING)
        self.assertEqual(self.subjects()[0], "tcr: check.py, late.txt")

    def test_a_dirty_tree_at_the_start_leaves_tcr_unavailable_and_nothing_is_modified(self) -> None:
        result, _ = self.configure()
        self.set_setting("mode", "tcr")
        write(result, PASSING)
        self.commit("start")
        write(self.cwd / "mine.txt", "mine")
        started, _ = self.call("SessionStart")
        self.assertIn("TCR is unavailable", self.context(started))
        self.assertIn("mine.txt", self.context(started))
        write(result, FAILING, PASSING)
        self.call("PostToolUse", **EDITING)
        self.assertEqual(read(result), FAILING)
        self.assertEqual(read(self.cwd / "mine.txt"), "mine")
        self.assertEqual(self.subjects(), ["start"])

    def test_a_change_made_outside_the_agent_pauses_tcr_until_the_tree_is_clean(self) -> None:
        result = self.start()
        write(self.cwd / "mine.txt", "mine")
        paused, _ = self.call("UserPromptSubmit")
        self.assertIn("TCR is unavailable", self.context(paused))
        write(result, FAILING, PASSING)
        self.call("PostToolUse", **EDITING)
        self.assertEqual(read(result), FAILING)
        self.assertEqual(read(self.cwd / "mine.txt"), "mine")
        write(result, PASSING, FAILING)
        self.commit("my own commit")
        resumed, _ = self.call("UserPromptSubmit")
        self.assertIn("TCR is on", self.context(resumed))
        write(result, FAILING, PASSING)
        self.call("PostToolUse", **EDITING)
        self.assertEqual(read(result), PASSING)

    def test_a_failed_checkpoint_commit_pauses_tcr_and_loses_nothing(self) -> None:
        result = self.start()
        install_hook(self.cwd, "pre-commit", "echo refused >&2\nexit 1")
        write(result, f"{PASSING} again", PASSING)
        output, _ = self.call("PostToolUse", **EDITING)
        self.assertIn("TCR is unavailable", self.context(output))
        self.assertEqual(git(self.cwd, ["diff", "--cached", "--name-only"]), "result.txt")
        self.assertEqual(self.subjects(), ["start"])
        write(result, FAILING, f"{PASSING} again")
        self.call("PostToolUse", **EDITING)
        self.assertEqual(read(result), FAILING)

    def test_a_new_upstream_commit_is_no_failure_of_the_agent_and_reverts_nothing(self) -> None:
        result = self.start()
        head = git(self.cwd, ["rev-parse", "HEAD"])
        tree = git(self.cwd, ["rev-parse", "HEAD^{tree}"])
        ahead = git(self.cwd, ["commit-tree", tree, "-p", head, "-m", "a teammate's commit"])
        git(self.cwd, ["update-ref", "refs/heads/teammate", ahead])
        git(self.cwd, ["branch", "--set-upstream-to=teammate"])
        write(result, f"{PASSING} again", PASSING)
        output, _ = self.call("PostToolUse", **EDITING)
        self.assertEqual(self.subjects()[0], "tcr: result.txt")
        self.assertNotIn("reverted", self.context(output))

    def test_a_check_that_cannot_run_here_neither_commits_nor_reverts(self) -> None:
        result = self.start()
        write(result, f"{FAILING} dns error", PASSING)
        self.call("PostToolUse", **EDITING)
        self.assertEqual(read(result), f"{FAILING} dns error")
        self.assertEqual(self.subjects(), ["start"])

    def test_a_change_seen_at_a_tool_that_does_not_edit_pauses_tcr_before_any_revert(self) -> None:
        result = self.start()
        write(self.cwd / "mine.txt", "mine")
        paused, _ = self.call("PostToolUse", tool_name="Read")
        self.assertIn("TCR is unavailable", self.context(paused))
        write(result, FAILING, PASSING)
        self.call("PostToolUse", **EDITING)
        self.assertEqual(read(result), FAILING)
        self.assertEqual(read(self.cwd / "mine.txt"), "mine")

    def test_a_failure_with_nothing_to_restore_is_told_and_nothing_is_reverted(self) -> None:
        result = self.start()
        write(self.cwd / "notes.txt", "notes")
        git(self.cwd, ["rm", "-q", "--cached", "result.txt"])
        write(self.cwd / ".gitignore", "result.txt\n")
        self.commit("ignore the result")
        self.call("UserPromptSubmit")
        write(result, FAILING, PASSING)
        os.utime(self.cwd / "notes.txt", (1, 1))
        output, _ = self.call("PostToolUse", **EDITING)
        self.assertEqual(self.subjects()[0], "ignore the result")
        self.assertEqual(read(result), FAILING)
        self.assertIn("failed after the latest change", self.context(output))

    def test_a_plugin_integration_gets_the_revert_notice_apart_from_its_context(self) -> None:
        result = self.start()
        write(result, FAILING, PASSING)
        output, _ = self.call("PostToolUse", tool_name="Edit", integration="opencode2")
        notices = output["overwatch"]["notices"]
        self.assertEqual(len(notices), 1)
        self.assertIn("TCR reverted", notices[0])
        self.assertIn(notices[0], self.context(output))

    def test_a_project_without_checks_says_so_and_commits_nothing(self) -> None:
        write(self.cwd / ".overwatch.json", json.dumps({"mode": "tcr"}))
        write(self.cwd / "notes.txt", "notes")
        self.commit("start")
        started, _ = self.call("SessionStart")
        self.assertIn("TCR is unavailable: no checks are configured", self.context(started))
        self.assertNotIn("TCR is on", self.context(started))
        write(self.cwd / "notes.txt", "more notes", "notes")
        self.call("PostToolUse", **EDITING)
        self.assertEqual(self.subjects(), ["start"])
        self.assertEqual(read(self.cwd / "notes.txt"), "more notes")

    def test_without_the_mode_nothing_is_committed_or_reverted(self) -> None:
        result = self.start(mode="tcr")
        settings = self.cwd / ".overwatch.json"
        text = read(settings)
        write(settings, json.dumps({key: value for key, value in json.loads(text).items() if key != "mode"}), text)
        self.commit("turn the mode off")
        write(result, FAILING, PASSING)
        off, _ = self.call("PostToolUse", **EDITING)
        self.assertEqual(read(result), FAILING)
        self.assertEqual(self.subjects()[0], "turn the mode off")
        self.assertIn("TCR is off", self.context(off))
        again, _ = self.call("PostToolUse", **EDITING)
        self.assertNotIn("TCR is off", self.context(again))

    def test_the_mode_coming_back_decides_again_whether_tcr_can_run(self) -> None:
        result = self.start()
        settings = self.cwd / ".overwatch.json"
        text = read(settings)
        write(settings, json.dumps({key: value for key, value in json.loads(text).items() if key != "mode"}), text)
        self.commit("turn the mode off")
        self.call("UserPromptSubmit")
        write(settings, text, read(settings))
        self.commit("turn the mode on")
        back, _ = self.call("UserPromptSubmit")
        self.assertIn("TCR is on", self.context(back))
        write(result, FAILING, PASSING)
        self.call("PostToolUse", **EDITING)
        self.assertEqual(read(result), PASSING)

    def test_an_unknown_mode_names_the_field(self) -> None:
        result, _ = self.configure()
        self.set_setting("mode", "fast")
        write(result, PASSING)
        output, _ = self.call("SessionStart")
        self.assertIn("mode", str(output["systemMessage"]))
        self.assertIn("tcr", str(output["systemMessage"]))


RENAMED_SETTINGS_FILE = "renamed.json"


def notices_with_a_renamed_settings_file() -> list[str]:
    """The two notices that name the settings file, as a process prints them once discovery calls that file RENAMED_SETTINGS_FILE."""
    program = (f"import sys; sys.path.insert(0, {str(paths.ROOT / 'engine')!r})\nimport discovery\ndiscovery.OVERRIDE_PATH = {RENAMED_SETTINGS_FILE!r}\n"
               "import tcr\nprint(tcr.CHECKS_OFF)\nprint(tcr.TCR_OFF)")
    return subprocess.run([sys.executable, "-I", "-c", program], capture_output=True, text=True, check=True).stdout.splitlines()


class NoticeTextTests(unittest.TestCase):
    def test_the_notices_name_the_settings_file_by_the_name_discovery_gives_it(self) -> None:
        self.assertEqual([RENAMED_SETTINGS_FILE in line for line in notices_with_a_renamed_settings_file()], [True, True])


if __name__ == "__main__":
    unittest.main()
