"""Tests of what the code does where the README says so: what an edit does under `gate.inherited` set to `block`, what an old Python gets, what a file in an encoding that does not write ASCII as itself does to the guard, and what `enabled` set to false does.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import codecs
import json
import subprocess
import tempfile
import unittest
import unittest.mock
from pathlib import Path

import paths
import checkpoint
import checkpoint_repository
import tcr
import test_tcr
from codex_hook import read, write
from discovery import ConfigurationError, read_override
from tcr_hardening_case import AWS_KEY, HardeningCase

OLDER_INTERPRETERS = ("python3.9", "python3.10", "/usr/bin/python3")
MINIMUM_PYTHON = (3, 11)
MINIMUM_INTERPRETER = f"python{MINIMUM_PYTHON[0]}.{MINIMUM_PYTHON[1]}"
COMPILED_DIRECTORIES = ("engine", "integrations")
COMPILE_SOURCES_FROM_STDIN = "import json, sys\nfor name, source in json.load(sys.stdin).items():\n    compile(source, name, 'exec')\n"
NO_JSON_LEFT = 1


def python_sources(root: Path, directories: tuple[str, ...]) -> dict[str, str]:
    """The text of each Python file directly in each of the directories below root, by its path from root; a directory that is missing or holds no Python file is a failure, as compileall's own exit code is 0 for a missing one."""
    sources = {}
    for directory in directories:
        found = sorted((root / directory).glob("*.py"))
        assert found, f"{root / directory} is missing or holds no Python file to compile"
        sources.update({str(path.relative_to(root)): read(path) for path in found})
    return sources


class ReadmeBehaviorTests(checkpoint_repository.RepositoryCase):
    def test_an_interpreter_older_than_the_minimum_gets_the_message_and_exit_code_the_readme_gives(self) -> None:
        older = [path for path in OLDER_INTERPRETERS if self.is_older_than_minimum(path)]
        if not older:
            self.skipTest("no Python older than 3.11 is installed")
        finished = self.run_hook_with(older[0])
        self.assertEqual(finished.returncode, NO_JSON_LEFT, f"the hook exited {finished.returncode}: {finished.stderr[-300:]}")
        self.assertIn("overwatch needs python 3.11 or newer", json.loads(finished.stdout)["error"])

    def test_a_secret_in_a_file_of_an_encoding_that_does_not_write_ascii_as_itself_is_not_refused_and_one_in_a_listed_encoding_is(self) -> None:
        unseen = "EBCDIC"
        seen = "UTF-16"
        line = f"x\n{AWS_KEY}\n"
        self.assertEqual(self.refusals_of_a_file_holding(f"{unseen}.txt", line.encode(CODECS_THAT_DO_NOT_WRITE_ASCII_AS_ITSELF[unseen])), [], f"the README says a file in {unseen} is not refused")
        self.assertEqual(self.refusals_of_a_file_holding(f"{seen}.txt", line.encode(CODECS_THE_GUARD_READS[seen])), [f"{seen}.txt:2 (AWS access key)"], f"the README says a file in {seen} is refused")

    def refusals_of_a_file_holding(self, name: str, data: bytes) -> list[str]:
        """What the guard refuses when only a new file called name, with exactly data in it, is staged."""
        path = self.repo / name
        path.write_bytes(data)
        checkpoint_repository.git(self.repo, ["add", "-A"])
        found = [refusal.text() for refusal in checkpoint.refusals(self.repo, ())]
        checkpoint_repository.git(self.repo, ["reset", "-q"])
        path.unlink()
        return found

    def test_the_minimum_python_compiles_the_engine_and_the_hooks(self) -> None:
        if not self.is_exactly_the_minimum(MINIMUM_INTERPRETER):
            self.skipTest(f"{MINIMUM_INTERPRETER} is not installed; only the real interpreter finds syntax that a newer one adds, such as quotes nested in an f-string")
        sources = python_sources(paths.ROOT, COMPILED_DIRECTORIES)
        finished = self.compile_with(MINIMUM_INTERPRETER, sources)
        self.assertEqual(finished.returncode, 0, f"{MINIMUM_INTERPRETER} does not compile the engine: {finished.stderr[-400:]}")

    def test_a_missing_directory_to_compile_is_a_failure(self) -> None:
        found, error = self.sources_of_a_tree_with_only_the_engine()
        self.assertEqual(found, ["engine/a.py"])
        self.assertIn("missing or holds no Python file", error)

    @staticmethod
    def sources_of_a_tree_with_only_the_engine() -> tuple[list[str], str]:
        """The files python_sources finds in a tree that has an engine directory only, and the failure it raises for the compiled directories."""
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / "engine").mkdir()
            write(Path(root) / "engine" / "a.py", "x = 1\n")
            found = list(python_sources(Path(root), ("engine",)))
            try:
                python_sources(Path(root), COMPILED_DIRECTORIES)
            except AssertionError as failure:
                return found, str(failure)
        return found, ""

    @staticmethod
    def compile_with(interpreter: str, sources: dict[str, str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run([interpreter, "-I", "-c", COMPILE_SOURCES_FROM_STDIN], input=json.dumps(sources), capture_output=True, text=True, check=False)

    def run_hook_with(self, interpreter: str) -> subprocess.CompletedProcess[str]:
        event = json.dumps({"session_id": "s", "cwd": str(self.repo), "hook_event_name": "SessionStart"})
        return subprocess.run([interpreter, str(paths.ROOT / "integrations" / "codex.py")], input=event, capture_output=True, text=True, check=False)

    @staticmethod
    def is_exactly_the_minimum(interpreter: str) -> bool:
        try:
            shown = subprocess.run([interpreter, "-c", "import sys; print(sys.version_info[0], sys.version_info[1])"], capture_output=True, text=True, check=False)
        except OSError:
            return False
        return shown.returncode == 0 and tuple(int(part) for part in shown.stdout.split()) == MINIMUM_PYTHON

    @staticmethod
    def is_older_than_minimum(interpreter: str) -> bool:
        try:
            shown = subprocess.run([interpreter, "-c", "import sys; print(sys.version_info[0], sys.version_info[1])"], capture_output=True, text=True, check=False)
        except OSError:
            return False
        parts = shown.stdout.split()
        return shown.returncode == 0 and len(parts) == 2 and (int(parts[0]), int(parts[1])) < MINIMUM_PYTHON


CODECS_THAT_DO_NOT_WRITE_ASCII_AS_ITSELF = {"EBCDIC": "cp037"}
CODECS_THE_GUARD_READS = {"UTF-16": "utf-16"}


def override_with_a_byte_order_mark() -> dict:
    """What the engine reads from an .overwatch.json that starts with a UTF-8 byte order mark."""
    with tempfile.TemporaryDirectory() as root:
        (Path(root) / ".overwatch.json").write_bytes(codecs.BOM_UTF8 + b'{"mode": "tcr"}')
        return read_override(Path(root))


class OverrideByteOrderMarkTests(unittest.TestCase):
    def test_the_engine_refuses_an_override_that_starts_with_a_byte_order_mark(self) -> None:
        with self.assertRaisesRegex(ConfigurationError, "could not read"):
            override_with_a_byte_order_mark()


class ReadmeHookBehaviorTests(HardeningCase):
    def test_a_protected_branch_gets_the_notice_and_the_notice_comes_once(self) -> None:
        self.start(test_tcr.PASSING, branch=min(tcr.PROTECTED_BRANCHES))
        self.assertIn("checkpoints land on it", self.context(self.started))
        next_turn, _ = self.call("UserPromptSubmit")
        self.assertNotIn("checkpoints land on", self.context(next_turn))

    def test_blocked_inherited_failures_keep_tcr_on_and_a_later_clean_edit_commits_everything(self) -> None:
        result = self.start(test_tcr.FAILING)
        self.set_setting("gate", {"inherited": "block"})
        self.commit("block inherited failures")
        write(self.cwd / "notes.txt", "notes")
        blocked, _ = self.call("PostToolUse", **test_tcr.EDITING)
        self.assertEqual(self.subjects()[0], "block inherited failures", f"an edit under block was committed or reverted: {self.context(blocked)}")
        self.assertEqual(read(self.cwd / "notes.txt"), "notes")
        next_turn, _ = self.call("UserPromptSubmit")
        self.assertNotIn("TCR is unavailable", self.context(next_turn))
        write(self.cwd / "more.txt", "more")
        self.call("PostToolUse", **test_tcr.EDITING)
        self.assertEqual(self.subjects()[0], "block inherited failures", "a second edit under block was committed")
        write(result, test_tcr.PASSING, test_tcr.FAILING)
        self.call("PostToolUse", **test_tcr.EDITING)
        self.assertEqual(self.subjects()[0], "tcr: more.txt, notes.txt, result.txt", "the edit that fixed the failure did not commit the earlier edits")

    def test_with_enabled_false_a_failing_edit_is_neither_committed_nor_reverted(self) -> None:
        result = self.start(test_tcr.PASSING)
        self.set_setting("enabled", False)
        self.commit("turn overwatch off")
        write(result, test_tcr.FAILING, test_tcr.PASSING)
        self.call("PostToolUse", **test_tcr.EDITING)
        self.assertEqual(read(result), test_tcr.FAILING, "a failing edit was reverted with enabled false")
        self.assertEqual(self.subjects()[0], "turn overwatch off", "an edit was committed with enabled false")

    def test_with_enabled_false_the_turn_start_says_every_check_is_off_and_not_that_none_is_configured(self) -> None:
        self.start(test_tcr.PASSING)
        self.set_setting("enabled", False)
        self.commit("turn overwatch off")
        next_turn, _ = self.call("UserPromptSubmit")
        told = self.context(next_turn)
        self.assertIn(f"TCR is unavailable: {tcr.CHECKS_OFF}", told)
        self.assertNotIn(tcr.NO_CHECKS, told)


if __name__ == "__main__":
    unittest.main()
