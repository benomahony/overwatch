"""Tests of how the Codex hook takes a HEAD move: a fresh baseline for a move that can bring in files, as a pull,
checkout or squash merge can, and the baseline kept for one made by commits alone.
Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""

from __future__ import annotations

import json
import unittest

from codex_hook import CodexHook, read, write
import gating
import git_commands


class HeadMoveTests(CodexHook):
    def test_an_edit_committed_in_the_same_step_is_a_new_failure(self) -> None:
        result, _ = self.configure()
        write(result, "RESULT: PASS")
        self.git("add", "-A")
        self.git("commit", "-qm", "init")
        self.call("SessionStart")
        write(result, "RESULT: FAIL", "RESULT: PASS")
        self.git("commit", "-qam", "break")
        failed, _ = self.call("PostToolUse", tool_name="Bash")
        self.assertIn("Full output:", failed["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.call("Stop")[0]["decision"], "block")

    def test_a_checkout_that_moves_head_takes_a_fresh_baseline(self) -> None:
        result, _ = self.configure()
        write(result, "RESULT: PASS")
        self.git("add", "-A")
        self.git("commit", "-qm", "init")
        self.git("checkout", "-qb", "other")
        write(result, "RESULT: FAIL", "RESULT: PASS")
        self.git("commit", "-qam", "other")
        self.git("checkout", "-q", "-")
        self.call("SessionStart")
        self.git("checkout", "-q", "other")
        moved, _ = self.call("PostToolUse", tool_name="Bash")
        self.assertIn("inherited backlog", moved["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.call("Stop")[0], {})

    def squash_and_commit(self, command: str) -> dict[str, object]:
        """A branch that breaks the check, squash-merged and committed in one step that the hook is told ran
        command. Returns the hook's answer to that step."""
        result, _ = self.configure()
        write(result, "RESULT: PASS")
        self.git("add", "-A")
        self.git("commit", "-qm", "init")
        self.git("checkout", "-qb", "other")
        write(result, "RESULT: FAIL", "RESULT: PASS")
        self.git("commit", "-qam", "other")
        self.git("checkout", "-q", "-")
        self.call("SessionStart")
        self.git("merge", "-q", "--squash", "other")
        self.git("commit", "-qm", "squash other")
        answer, _ = self.call("PostToolUse", tool_name="Bash", tool_input={"command": command})
        assert read(result).startswith("RESULT: FAIL"), f"{result} reads {read(result)!r}; the squash brings in the failure"
        return answer

    def test_a_squash_merge_committed_in_the_same_step_takes_a_fresh_baseline(self) -> None:
        answer = self.squash_and_commit("git merge --squash other && git commit -m squash")
        self.assertIn("inherited backlog", answer["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.call("Stop")[0], {})

    def test_a_commit_message_that_names_a_merge_is_still_a_commit(self) -> None:
        answer = self.squash_and_commit('git commit -m "merge other"')
        self.assertIn("Full output:", answer["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.call("Stop")[0]["decision"], "block")

    def test_a_squash_merge_inside_bash_dash_c_takes_a_fresh_baseline(self) -> None:
        answer = self.squash_and_commit('bash -lc "git merge --squash other && git commit -m squash"')
        self.assertIn("inherited backlog", answer["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.call("Stop")[0], {})

    def test_a_squash_merge_in_a_subshell_takes_a_fresh_baseline(self) -> None:
        answer = self.squash_and_commit("(git merge --squash other && git commit -m squash)")
        self.assertIn("inherited backlog", answer["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.call("Stop")[0], {})

    def test_a_commit_between_two_edits_leaves_the_second_failure_new(self) -> None:
        result, _ = self.configure()
        write(result, "RESULT: PASS")
        self.git("add", "-A")
        self.git("commit", "-qm", "init")
        self.call("SessionStart")
        write(result, "RESULT: PASS again", "RESULT: PASS")
        self.git("commit", "-qam", "still green")
        self.assertEqual(self.call("PostToolUse", tool_name="Bash", tool_input={"command": "git commit -qam x"})[0], {})
        write(result, "RESULT: FAIL", "RESULT: PASS again")
        failed, _ = self.call("PostToolUse", tool_name="Edit")
        self.assertIn("Full output:", failed["hookSpecificOutput"]["additionalContext"])

    def test_commands_that_bring_in_files_are_told_from_commits(self) -> None:
        corpus = json.loads(read(git_commands.SOURCE))
        self.assertEqual(read(git_commands.TARGET), git_commands.render_commands(),
                         "run python3 scripts/git_commands.py after editing git-commands.json")
        for command in corpus["bringing"]:
            self.assertTrue(gating.brings_in_files(command), command)
        for command in corpus["commits"] + corpus["unseen"]:
            self.assertFalse(gating.brings_in_files(command), command)


if __name__ == "__main__":
    unittest.main()
