"""Tests of the secrets guard and the other limits of a checkpoint and a revert on odd input: line endings, a diff the guard
cannot read, a size over the limit, a git failure and files that git does not watch.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import runpy
import sys
import tempfile
import time
import unittest
import unittest.mock
from pathlib import Path

import paths
import checkpoint
import secrets_guard
import tcr
import test_tcr
from codex_hook import HOOK, CodexHook, read, write
from checkpoint_repository import git, isolate_git, remove_fixture_file, restore_git
from test_checkpoint_guard import timed
from test_tcr import EDITING, FAILING
from tcr_hardening_case import AWS_KEY

ONE_MEBIBYTE = 1024 * 1024
OVERSIZED_BYTES = checkpoint.MAX_STAGED_BYTES + ONE_MEBIBYTE
SECONDS_FOR_A_REFUSAL = 5.0
BYTES_READ_FOR_A_REFUSAL = ONE_MEBIBYTE
CRAFTED_FILE = b"\x00\r+\r-\r@@ -1 +1 @@\r\n"
KEY_LINE = AWS_KEY.encode()
LINE_ENDINGS = {
    "a lone carriage return": (b"x\r" + KEY_LINE + b"\n", 1),
    "a carriage return and a line feed": (b"a\r\nb\r\n" + KEY_LINE + b"\r\n", 3),
    "both mixed": (b"a\rb\n" + KEY_LINE + b"\r\n", 2),
    "old Macintosh endings only": (b"a\rb\r" + KEY_LINE + b"\r", 1),
}
UNREADABLE_DIFF = "@@ -1 +1 @@\n"
ENCODED_KEYS = {
    "UTF-16 with a byte order mark": ("x\n" + AWS_KEY + "\n").encode("utf-16"),
    "UTF-16 little endian without a mark": ("x\n" + AWS_KEY + "\n").encode("utf-16-le"),
    "UTF-16 big endian without a mark": ("x\n" + AWS_KEY + "\n").encode("utf-16-be"),
}
SECRET_NAMES = (".pgpass", ".git-credentials", "release.keystore", "terraform.tfstate", "secrets.yml", "kubeconfig", "sub/kubeconfig")
OLD_PYTHON = (3, 9, 0)

RAW_HEADER_NAME = ":100644 100644 " + "a" * 40 + " " + "b" * 40 + " M"
ODD_NAMES = {
    "a colon first": ":x",
    "the shape of a raw header": RAW_HEADER_NAME,
    "a space": "has space.txt",
    "a line feed": "has\nline.txt",
    "unicode": "caf\u00e9\u2603.txt",
    "a colon in the middle": "a:b.txt",
}

TRUNCATED_DIFF = "+++ b/f.txt\n@@ -0,0 +1,2 @@\n+one\n"


def put_data(path: Path, data: bytes) -> None:
    """Puts bytes in a fixture file in a test's own temporary directory, which must not hold the file yet."""
    assert not path.exists(), f"{path} exists already; give each fixture file its own name"
    with path.open("xb") as handle:
        handle.write(data)
    assert data_of(path) == data, f"{path} reads back differently from what was put there"


def data_of(path: Path) -> bytes:
    """The bytes of a fixture file."""
    assert path.is_file(), f"{path} is no fixture file to read"
    with path.open("rb") as handle:
        data = handle.read()
    assert isinstance(data, bytes), f"{path} gave {type(data)}, not bytes"
    return data


def put_oversized(path: Path) -> None:
    """Makes a file over MAX_STAGED_BYTES that takes no disk space, as a sparse file, so a test does not wait for a write."""
    assert not path.exists(), f"{path} exists already; give each fixture file its own name"
    with path.open("xb") as handle:
        handle.truncate(OVERSIZED_BYTES)
    assert path.stat().st_size == OVERSIZED_BYTES, f"{path} is {path.stat().st_size} bytes, not {OVERSIZED_BYTES}"


class GuardCaseTests(unittest.TestCase):
    def setUp(self) -> None:
        assert (paths.ROOT / "engine" / "checkpoint.py").is_file(), f"{paths.ROOT} holds no engine to test"
        self.addCleanup(restore_git, isolate_git())
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.unborn = tempfile.TemporaryDirectory()
        self.addCleanup(self.unborn.cleanup)
        self.repo, self.empty = Path(self.temporary.name), Path(self.unborn.name)
        git(self.empty, ["init", "-q", "-b", "main"])
        git(self.repo, ["init", "-q", "-b", "main"])
        put_data(self.repo / "a.txt", b"base\n")
        git(self.repo, ["add", "-A"])
        git(self.repo, ["commit", "-q", "-m", "start"])
        assert git(self.repo, ["status", "--porcelain"]) == "", f"{self.repo} is not clean after setup"

    def checkpoint_once(self) -> None:
        """Runs a checkpoint that must be refused, and keeps the refusal in self.refused."""
        with self.assertRaises(checkpoint.Refused) as caught:
            checkpoint.checkpoint(self.repo)
        self.refused = caught.exception
        assert isinstance(self.refused, checkpoint.Refused), f"{self.refused!r} is no refusal"
        assert self.refused.refusals, f"{self.refused!r} refused nothing"

    def refusals(self) -> list[str]:
        found = [refusal.text() for refusal in checkpoint.refusals(self.repo, ())]
        assert all(isinstance(text, str) and text for text in found), f"a refusal came back as no text: {found}"
        assert len(set(found)) == len(found), f"a refusal came back twice: {found}"
        return found

    def test_every_staged_file_is_listed_with_its_own_path_whatever_its_name_starts_with(self) -> None:
        for label, name in ODD_NAMES.items():
            with self.subTest(label):
                put_data(self.repo / name, b"content\n")
                git(self.repo, ["add", "-A"])
                listed = [path for _, _, path in checkpoint.staged_files(self.repo)]
                git(self.repo, ["reset", "-q"])
                remove_fixture_file(self.repo / name)
                self.assertEqual(listed, [name])

    def test_a_type_change_to_a_colon_name_is_listed_once(self) -> None:
        link = self.repo / ":link"
        link.symlink_to("a.txt")
        git(self.repo, ["add", "-A"])
        git(self.repo, ["commit", "-q", "-m", "link"])
        remove_fixture_file(link)
        put_data(link, b"now a file\n")
        git(self.repo, ["add", "-A"])
        self.assertEqual([(mode, path) for mode, _, path in checkpoint.staged_files(self.repo)], [("100644", ":link")])

    def test_a_checkpoint_of_a_file_named_like_a_raw_header_commits_it(self) -> None:
        for name in (":x", RAW_HEADER_NAME):
            put_data(self.repo / name, b"content\n")
        self.assertIsNotNone(checkpoint.checkpoint(self.repo))
        self.assertEqual(git(self.repo, ["status", "--porcelain"]), "")

    def test_a_bug_while_screening_unstages_everything_and_surfaces_as_itself(self) -> None:
        put_data(self.repo / "new.txt", b"content\n")
        with unittest.mock.patch.object(checkpoint, "refusals", side_effect=IndexError("boom")):
            with self.assertRaises(IndexError) as caught:
                checkpoint.checkpoint(self.repo)
        self.assertIn("boom", str(caught.exception))
        self.assertEqual(git(self.repo, ["diff", "--cached", "--name-only"]), "")
        self.assertEqual(read(self.repo / "new.txt"), "content\n")

    def test_a_git_failure_while_screening_unstages_everything_and_raises_a_checkpoint_error(self) -> None:
        put_data(self.repo / "new.txt", b"content\n")
        with unittest.mock.patch.object(checkpoint, "refusals", side_effect=checkpoint.CheckpointError("git went wrong")):
            with self.assertRaises(checkpoint.CheckpointError) as caught:
                checkpoint.checkpoint(self.repo)
        self.assertIn("git went wrong", str(caught.exception))
        self.assertEqual(git(self.repo, ["diff", "--cached", "--name-only"]), "")
        self.assertEqual(read(self.repo / "new.txt"), "content\n")

    def test_a_failure_to_unstage_is_reported_and_the_work_stays_staged(self) -> None:
        put_data(self.repo / "new.txt", b"content\n")

        def lock_the_index_then_fail(root: Path, allow: tuple[str, ...]) -> list[object]:
            put_data(root / ".git" / "index.lock", b"")
            raise checkpoint.CheckpointError("git went wrong")

        with unittest.mock.patch.object(checkpoint, "refusals", lock_the_index_then_fail):
            with self.assertRaises(checkpoint.CheckpointError) as caught:
                checkpoint.checkpoint(self.repo)
        self.assertIn("index.lock", str(caught.exception))
        remove_fixture_file(self.repo / ".git" / "index.lock")
        self.assertEqual(git(self.repo, ["diff", "--cached", "--name-only"]), "new.txt")
        self.assertEqual(read(self.repo / "new.txt"), "content\n")

    def test_a_secret_is_found_whatever_line_endings_the_file_has(self) -> None:
        for number, (label, (content, line)) in enumerate(LINE_ENDINGS.items()):
            with self.subTest(endings=label):
                name = f"cfg{number}.txt"
                put_data(self.repo / name, content)
                git(self.repo, ["add", "-A"])
                self.assertEqual(self.refusals(), [f"{name}:{line} (AWS access key)"])
                git(self.repo, ["reset", "-q"])
                remove_fixture_file(self.repo / name)

    def test_a_file_that_looks_like_a_diff_to_a_reader_of_carriage_returns_is_read_whole(self) -> None:
        put_data(self.repo / "f.dat", CRAFTED_FILE)
        git(self.repo, ["add", "-A"])
        self.assertEqual(self.refusals(), [])
        self.assertIsNotNone(checkpoint.checkpoint(self.repo))

    def test_a_diff_that_cannot_be_read_refuses_the_files_it_could_not_scan_and_raises_no_assertion(self) -> None:
        put_data(self.repo / "f.txt", b"harmless\n")
        git(self.repo, ["add", "-A"])
        real = checkpoint.run_git
        with unittest.mock.patch.object(secrets_guard, "run_git", lambda cwd, argv, **kwargs: UNREADABLE_DIFF if "--text" in argv else real(cwd, argv, **kwargs)):
            self.assertEqual(self.refusals(), [f"f.txt ({checkpoint.UNREADABLE_RULE})"])

    def test_a_truncated_diff_raises_a_checkpoint_error_not_an_assertion(self) -> None:
        with self.assertRaises(checkpoint.Unreadable):
            list(checkpoint.added_lines(TRUNCATED_DIFF))

    def test_an_oversized_new_file_is_refused_before_git_reads_it(self) -> None:
        put_oversized(self.repo / "big.bin")
        objects = git(self.repo, ["count-objects"])
        elapsed = timed(self.checkpoint_once)
        self.assertEqual([refusal.text() for refusal in self.refused.refusals], [f"big.bin ({checkpoint.SIZE_RULE})"])
        self.assertEqual(git(self.repo, ["count-objects"]), objects, "git stored the oversized file before refusing it")
        self.assertEqual(git(self.repo, ["diff", "--cached", "--name-only"]), "")
        self.assertLess(elapsed, SECONDS_FOR_A_REFUSAL)

    def test_an_oversized_staged_file_is_not_read_for_secrets(self) -> None:
        put_oversized(self.repo / "big.bin")
        with (self.repo / "big.bin").open("r+b") as handle:
            handle.write(KEY_LINE + b"\n")
        git(self.repo, ["add", "-A"])
        printed: list[int] = []
        real = checkpoint.run_git

        def counting(cwd: Path, argv: list[str], **kwargs: object) -> str:
            output = real(cwd, argv, **kwargs)
            printed.append(len(output))
            assert argv and printed[-1] >= 0, f"git was run with {argv} and printed {printed[-1]} characters"
            assert isinstance(output, str), f"git {argv} printed {output!r}"
            return output

        with unittest.mock.patch.object(secrets_guard, "run_git", counting):
            self.assertEqual(self.refusals(), [f"big.bin ({checkpoint.SIZE_RULE})"])
        self.assertLess(sum(printed), BYTES_READ_FOR_A_REFUSAL)

    def test_a_file_that_replaces_a_symlink_is_screened_like_a_new_file(self) -> None:
        for name, content, expected in (("x", KEY_LINE + b"\n", ["x:1 (AWS access key)"]), (".env", b"harmless\n", [".env (name pattern)"])):
            with self.subTest(name=name):
                os.symlink("a.txt", self.repo / name)
                git(self.repo, ["add", "-A"])
                git(self.repo, ["commit", "-q", "-m", f"link {name}"])
                remove_fixture_file(self.repo / name)
                put_data(self.repo / name, content)
                git(self.repo, ["add", "-A"])
                self.assertEqual(git(self.repo, ["diff", "--cached", "--raw", "--no-renames"]).split()[4], "T")
                self.assertEqual(self.refusals(), expected)
                git(self.repo, ["reset", "-q"])
                remove_fixture_file(self.repo / name)
                git(self.repo, ["rm", "-q", "--cached", "--", name])
                git(self.repo, ["commit", "-q", "-m", f"drop {name}"])

    def test_a_secret_in_a_file_with_a_wide_encoding_is_found(self) -> None:
        for number, (label, content) in enumerate(ENCODED_KEYS.items()):
            with self.subTest(encoding=label):
                name = f"wide{number}.txt"
                put_data(self.repo / name, content)
                git(self.repo, ["add", "-A"])
                self.assertEqual(self.refusals(), [f"{name}:2 (AWS access key)"])
                git(self.repo, ["reset", "-q"])
                remove_fixture_file(self.repo / name)

    def test_an_encrypted_private_key_is_found(self) -> None:
        put_data(self.repo / "k.txt", b"-----BEGIN " + b"ENCRYPTED PRIVATE KEY-----\nabc\n")
        git(self.repo, ["add", "-A"])
        self.assertEqual(self.refusals(), ["k.txt:1 (private key)"])

    def test_more_names_that_say_secrets_are_refused(self) -> None:
        for name in SECRET_NAMES:
            with self.subTest(name=name):
                self.assertEqual(checkpoint.name_rule(name), checkpoint.NAME_RULE)

    def test_an_allowed_file_stays_allowed_when_git_prefixes_its_diff_with_the_side(self) -> None:
        git(self.repo, ["config", "diff.mnemonicPrefix", "true"])
        put_data(self.repo / "k.txt", KEY_LINE + b"\n")
        self.assertIsNotNone(checkpoint.checkpoint(self.repo, allow=("k.txt",)))

    def test_the_guard_reads_the_committed_bytes_and_not_what_a_diff_driver_makes_of_them(self) -> None:
        git(self.repo, ["config", "diff.scrub.textconv", "sh -c 'echo clean' scrub"])
        put_data(self.repo / ".gitattributes", b"*.sec diff=scrub\n")
        git(self.repo, ["add", ".gitattributes"])
        git(self.repo, ["commit", "-q", "-m", "driver"])
        put_data(self.repo / "k.sec", KEY_LINE + b"\n")
        git(self.repo, ["add", "-A"])
        self.assertEqual(self.refusals(), ["k.sec:1 (AWS access key)"])

    def test_the_checkpoint_module_says_python_3_11_is_needed_on_an_older_python(self) -> None:
        printed = io.StringIO()
        with unittest.mock.patch.object(sys, "version_info", OLD_PYTHON), contextlib.redirect_stdout(printed), self.assertRaises(SystemExit) as stopped:
            runpy.run_path(str(paths.ROOT / "engine" / "checkpoint.py"), run_name="not_main")
        self.assertEqual(stopped.exception.code, 1)
        self.assertIn("python 3.11", json.loads(printed.getvalue())["error"].lower())

    def test_a_repository_with_no_commit_says_so_even_when_the_tree_is_dirty(self) -> None:
        put_data(self.empty / "new.txt", b"x\n")
        self.assertEqual(checkpoint.unavailable_reason(self.empty), "the repository has no commit to restore")


class GuardCaseHookTests(CodexHook):
    setUp = test_tcr.TcrHookTests.setUp
    set_setting = test_tcr.TcrHookTests.set_setting
    start = test_tcr.TcrHookTests.start
    subjects = test_tcr.TcrHookTests.subjects
    context = test_tcr.TcrHookTests.context

    def test_a_secret_behind_a_carriage_return_is_refused_through_the_hook(self) -> None:
        self.start()
        put_data(self.cwd / "cfg.txt", b"x\r" + KEY_LINE + b"\n")
        output, _ = self.call("PostToolUse", **EDITING)
        self.assertEqual(self.subjects(), ["start"])
        self.assertIn("cfg.txt:1 (AWS access key)", self.context(output))

    def test_a_crafted_file_does_not_crash_the_hook(self) -> None:
        self.start()
        put_data(self.cwd / "f.dat", CRAFTED_FILE)
        output, _ = self.call("PostToolUse", **EDITING)
        self.assertEqual(self.subjects()[0], "tcr: f.dat")
        self.assertNotIn("unexpected", str(output))

    def test_a_git_failure_while_reverting_is_told_and_does_not_crash_the_hook(self) -> None:
        result = self.start()
        write(result, FAILING, test_tcr.PASSING)
        git(self.cwd, ["config", "diff.algorithm", "nonsense"])
        output, _ = self.call("PostToolUse", **EDITING)
        git(self.cwd, ["config", "--unset", "diff.algorithm"])
        self.assertIn("TCR is unavailable", self.context(output))
        self.assertIn("diff.algorithm", self.context(output))
        self.assertEqual(self.subjects(), ["start"])
        self.assertEqual(read(result), FAILING)

    def call_here(self, event: str, **fields: object) -> dict[str, object]:
        """Sends one hook event to the hook script inside this process, so that a test can make a module of the engine fail."""
        payload = json.dumps({"session_id": "session-1", "cwd": str(self.cwd), "hook_event_name": event, **fields})
        printed = io.StringIO()
        environment = {"PATH": f"{self.bin}{os.pathsep}{os.defpath}", "PLUGIN_DATA": str(self.data)}
        with unittest.mock.patch.dict(os.environ, environment), unittest.mock.patch.object(sys, "stdin", io.StringIO(payload)), \
                unittest.mock.patch.object(tcr, "PROCESS_STARTED", time.monotonic()), unittest.mock.patch.object(tcr, "PROCESS_STARTED_WALL", time.time()):
            with contextlib.redirect_stdout(printed), contextlib.suppress(SystemExit):
                runpy.run_path(str(HOOK), run_name="__main__")
        assert printed.getvalue().strip(), f"the hook printed nothing for the event {event}"
        output = json.loads(printed.getvalue())
        assert isinstance(output, dict), f"the hook printed {printed.getvalue()!r}, which is no JSON object"
        return output

    def test_a_git_failure_in_the_checkpoint_is_told_and_pauses_tcr_without_a_traceback(self) -> None:
        self.start()
        put_data(self.cwd / "new.txt", b"content\n")
        with unittest.mock.patch.object(checkpoint, "refusals", side_effect=checkpoint.CheckpointError("boom")):
            output = self.call_here("PostToolUse", **EDITING)
        self.assertIn("TCR is unavailable", self.context(output))
        self.assertIn("boom", self.context(output))
        self.assertEqual(git(self.cwd, ["diff", "--cached", "--name-only"]), "")

    def test_a_file_system_failure_in_the_checkpoint_step_pauses_tcr_and_is_told(self) -> None:
        self.start()
        put_data(self.cwd / "new.txt", b"content\n")
        with unittest.mock.patch.object(checkpoint, "checkpoint", side_effect=OSError("boom")):
            output = self.call_here("PostToolUse", **EDITING)
        self.assertIn("TCR stopped on OSError: boom", self.context(output))

    def test_a_bug_in_the_checkpoint_step_propagates_and_is_not_turned_into_a_tcr_notice(self) -> None:
        self.start()
        put_data(self.cwd / "new.txt", b"content\n")
        for bug in (AssertionError("boom"), IndexError("boom"), RuntimeError("boom")):
            with self.subTest(bug=type(bug).__name__), unittest.mock.patch.object(checkpoint, "checkpoint", side_effect=bug):
                with self.assertRaises(type(bug), msg="a bug in the checkpoint step was caught; let it propagate"):
                    self.call_here("PostToolUse", **EDITING)


if __name__ == "__main__":
    unittest.main()
