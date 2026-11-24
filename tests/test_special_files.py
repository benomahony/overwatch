"""Tests that a revert answers, in bounded time and with a notice, when the changed files include a pipe, a socket, a link to a directory or a link that loops, or the workspace holds a pipe where a tracked file was.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import os
import socket
import sys
import unittest
import unittest.mock
from pathlib import Path
from collections.abc import Callable

import codex_hook
import paths
import test_special_project_files
import workspace
from codex_hook import CodexHook, write
from digest_process import FINGERPRINT, MEASURED, run_digest
from tcr_hardening_case import PROJECT_FILE, HardeningCase
from test_tcr import EDITING

SOCKET_NAME = "s.sock"
HANG_TIMEOUT = 1
START_AND_HANG_TIMEOUT = 5
HANGING_HOOK = "import time; time.sleep(60)"
HANGING_AFTER_START = """import io, json, pathlib, runpy, sys, time
payload = sys.stdin.read()
if json.loads(payload)["hook_event_name"] == "SessionStart":
    sys.stdin = io.StringIO(payload)
    runpy.run_path({real!r}, run_name="__main__")
else:
    pathlib.Path({calls!r}).open("a").write("hung\\n")
    time.sleep(60)
"""
HANGING_FINGERPRINT = """import pathlib, time
def content_fingerprint(root, names):
    pathlib.Path({calls!r}).open("a").write("hung\\n")
    time.sleep(60)
"""
DIGEST_SECONDS = 5
SPARSE_BYTES = 2 * 1024**3
MEBIBYTE = 1024**2
PAST_THE_LIMIT = workspace.CONTENT_READ_LIMIT + MEBIBYTE
DEVICES = (("null", "/dev/null"), ("zero", "/dev/zero"))
MAX_SECONDS_FOR_A_SPARSE_FILE = 1
MAX_RESIDENT_BYTES = 300 * 1024**2
RESIDENT_UNIT = 1 if sys.platform == "darwin" else 1024


def replace_with_pipe(case: HardeningCase) -> None:
    (case.cwd / "pyproject.toml").unlink()
    os.mkfifo(case.cwd / "pyproject.toml")


def add_pipe(case: HardeningCase) -> None:
    os.mkfifo(case.cwd / "pipe")


def add_socket(case: HardeningCase) -> None:
    listener = socket.socket(socket.AF_UNIX)
    case.addCleanup(listener.close)
    listener.bind(str(case.cwd / SOCKET_NAME))


def add_link_to_directory(case: HardeningCase) -> None:
    os.symlink(case.cwd / ".git", case.cwd / "linked")


def add_link_loop(case: HardeningCase) -> None:
    os.symlink("loop", case.cwd / "loop")


def replace_with_link_to_directory(case: HardeningCase) -> None:
    (case.cwd / "pyproject.toml").unlink()
    os.symlink(case.cwd / ".git", case.cwd / "pyproject.toml")


SPECIAL_FILES: dict[str, Callable[[HardeningCase], None]] = {
    "a pipe in place of a tracked file": replace_with_pipe,
    "a new pipe": add_pipe,
    "a socket": add_socket,
    "a new link to a directory": add_link_to_directory,
    "a link that loops": add_link_loop,
    "a tracked file replaced by a link to a directory": replace_with_link_to_directory,
}


class SpecialFilesTests(HardeningCase):
    def test_a_failing_edit_is_answered_with_a_notice_in_bounded_time_whatever_special_file_is_changed(self) -> None:
        for kind, make in SPECIAL_FILES.items():
            with self.subTest(kind):
                self.setUp()
                self.start_a_python_project()
                self.fail_pytest()
                make(self)
                write(self.cwd / "second.txt", "edit\n")
                output = self.call_that_fails_on_a_hang("PostToolUse", **EDITING)
                self.assertTrue(self.context(output), f"{kind}: the hook told the agent nothing")
            if self.hung:
                break
        self.assertEqual(PROJECT_FILE, "[project]\n", "the project file of the fixture changed")
        self.assertTrue(paths.ROOT.is_dir(), f"{paths.ROOT} is no directory")


class HangTests(HardeningCase):
    def test_a_hook_that_hangs_fails_the_call_after_one_timeout_and_marks_the_run_as_hung(self) -> None:
        hanging = self.cwd / "hang.py"
        write(hanging, HANGING_HOOK)
        with unittest.mock.patch.object(codex_hook, "HOOK", hanging), unittest.mock.patch.object(codex_hook, "HOOK_TIMEOUT", HANG_TIMEOUT):
            with self.assertRaises(AssertionError, msg="a hook that hung did not fail the call"):
                self.call_that_fails_on_a_hang("PostToolUse", **EDITING)
        self.assertTrue(self.hung, "a hook that hung did not mark the run as hung")


class StopAtFirstHangTests(HardeningCase):
    def spent_timeouts_on(self, test: unittest.TestCase, calls: Path) -> int:
        result = unittest.TestResult()
        test.run(result)
        self.assertEqual(len(result.failures), 1, f"{test} did not fail once on the hang: {len(result.failures)} failures, {len(result.errors)} errors")
        return calls.read_text().count("hung")

    def test_a_loop_over_special_files_spends_one_timeout_on_a_hook_that_hangs_in_every_case(self) -> None:
        calls = self.cwd.parent / "hook-calls"
        hanging = self.cwd.parent / "hang_after_start.py"
        write(hanging, HANGING_AFTER_START.format(real=str(codex_hook.HOOK), calls=str(calls)))
        loop = SpecialFilesTests("test_a_failing_edit_is_answered_with_a_notice_in_bounded_time_whatever_special_file_is_changed")
        with unittest.mock.patch.object(codex_hook, "HOOK", hanging), unittest.mock.patch.object(codex_hook, "HOOK_TIMEOUT", START_AND_HANG_TIMEOUT):
            self.assertEqual(self.spent_timeouts_on(loop, calls), 1, f"the loop over {len(SPECIAL_FILES)} special files did not stop at the first hang")

    def test_the_loop_over_the_readers_of_a_project_file_spends_one_timeout_on_a_reader_that_hangs_in_every_case(self) -> None:
        calls = self.cwd.parent / "reader-calls"
        write(self.cwd / "workspace.py", HANGING_FINGERPRINT.format(calls=str(calls)))
        loop = test_special_project_files.SpecialProjectFileTests("test_every_reader_of_a_project_file_answers_in_bounded_time_whatever_special_file_is_at_its_path")
        with unittest.mock.patch.object(test_special_project_files, "ENGINE", self.cwd), unittest.mock.patch.object(test_special_project_files, "READ_SECONDS", HANG_TIMEOUT):
            self.assertEqual(self.spent_timeouts_on(loop, calls), 1, "the loop over the readers did not stop at the first hang")


class ContentFingerprintTests(CodexHook):
    def test_the_fingerprint_of_a_pipe_answers_in_bounded_time(self) -> None:
        """A pipe with no writer is digested by its size and mode alone, and the process answers; it would wait for a writer forever if it read the pipe."""
        os.mkfifo(self.cwd / "pipe")
        finished = run_digest(self.cwd, ["pipe"], DIGEST_SECONDS, FINGERPRINT)
        self.assertEqual(finished.returncode, 0, f"the fingerprint of a pipe failed: {finished.stderr!r}")

    def test_the_fingerprint_of_a_two_gibibyte_sparse_file_takes_a_second_and_a_little_memory(self) -> None:
        """A sparse file of two gibibytes is read up to the limit of the fingerprint in chunks, so it takes at most a second and a little resident memory."""
        with (self.cwd / "big").open("wb") as big:
            big.truncate(SPARSE_BYTES)
        finished = run_digest(self.cwd, ["big"], MAX_SECONDS_FOR_A_SPARSE_FILE, MEASURED)
        self.assertEqual(finished.returncode, 0, f"the fingerprint of a sparse file failed: {finished.stderr!r}")
        self.assertLess(int(finished.stdout) * RESIDENT_UNIT, MAX_RESIDENT_BYTES, f"the fingerprint held {finished.stdout.strip()} of resident memory")

    def folder(self, name: str) -> Path:
        """A new folder of the test's own, for a file that a digest names."""
        folder = Path(self.temporary.name) / name
        folder.mkdir()
        assert folder.is_dir(), f"{folder} was not made"
        return folder

    def replace_with_pipe(self, name: str) -> None:
        """Makes the tracked file name in the project a pipe."""
        (self.cwd / name).unlink()
        os.mkfifo(self.cwd / name)
        assert not (self.cwd / name).is_file(), f"{name} is still a regular file"

    def digest_of_a_sparse_file_with_a_byte_at(self, offset: int | None) -> str:
        """The content digest of a file named big of PAST_THE_LIMIT bytes that holds zeros, and a one at offset when it is given."""
        folder = self.folder(f"offset{offset}")
        with (folder / "big").open("wb") as big:
            big.truncate(PAST_THE_LIMIT)
            if offset is not None:
                big.seek(offset)
                big.write(b"\x01")
        return workspace.content_fingerprint(folder, ["big"])

    def test_the_content_digest_reads_the_first_fifty_mebibytes_and_not_a_byte_after_them(self) -> None:
        """The README says so: a byte changed past the limit, with the size kept, is not seen; one changed before it is."""
        self.assertEqual(workspace.CONTENT_READ_LIMIT, 50 * MEBIBYTE, "the README says the digest reads 50 MiB")
        digests = {offset: self.digest_of_a_sparse_file_with_a_byte_at(offset) for offset in (None, 0, PAST_THE_LIMIT - 1)}
        self.assertEqual(digests[PAST_THE_LIMIT - 1], digests[None], "a change past the limit changed the digest")
        self.assertNotEqual(digests[0], digests[None], "a change in the first bytes did not change the digest")

    def test_the_content_digest_of_a_device_holds_its_size_and_mode_and_not_what_it_gives(self) -> None:
        """The README says so: two devices of the same size and mode, one that reads as empty and one that never stops giving zeros, have the same digest."""
        digests = []
        for name, target in DEVICES:
            folder = self.folder(name)
            (folder / "device").symlink_to(target)
            digests.append((os.stat(target).st_mode, workspace.content_fingerprint(folder, ["device"])))
        if digests[0][0] != digests[1][0]:
            self.skipTest("the two devices have different modes on this system")
        self.assertEqual(digests[0][1], digests[1][1], "the digest of a device depends on what it gives")

    def test_a_socket_is_digested_as_a_missing_file(self) -> None:
        """The README says so: the open of a socket fails, and the digest is the one of a name with no file."""
        with_socket, without = self.folder("with"), self.folder("without")
        listener = socket.socket(socket.AF_UNIX)
        self.addCleanup(listener.close)
        listener.bind(str(with_socket / SOCKET_NAME))
        self.assertEqual(workspace.content_fingerprint(with_socket, [SOCKET_NAME]), workspace.content_fingerprint(without, [SOCKET_NAME]), "a socket is not digested as missing")

    def test_a_pipe_is_opened_and_not_read(self) -> None:
        """The README says so: a pipe is not digested as missing, and what a writer put in it does not change the digest."""
        digests = []
        for name, content in (("empty", None), ("filled", b"bytes")):
            folder = self.folder(name)
            os.mkfifo(folder / "pipe")
            reader = os.open(folder / "pipe", os.O_RDONLY | os.O_NONBLOCK)
            self.addCleanup(os.close, reader)
            if content is not None:
                writer = os.open(folder / "pipe", os.O_WRONLY | os.O_NONBLOCK)
                self.addCleanup(os.close, writer)
                os.write(writer, content)
            digests.append(workspace.content_fingerprint(folder, ["pipe"]))
        self.assertEqual(digests[0], digests[1], "the digest of a pipe depends on what it holds")
        self.assertNotEqual(digests[0], workspace.content_fingerprint(self.folder("none"), ["pipe"]), "a pipe is digested as missing")

    def test_the_modification_time_of_a_pipe_changes_the_fingerprint_which_the_content_digest_does_not_see(self) -> None:
        """The README says so: a tracked file replaced by a pipe has the same content digest after a touch, and another fingerprint."""
        write(self.cwd / "tracked.txt", "x\n")
        self.git("add", "tracked.txt")
        self.replace_with_pipe("tracked.txt")
        before = workspace.fingerprint(self.cwd), workspace.content_fingerprint(self.cwd, ["tracked.txt"])
        os.utime(self.cwd / "tracked.txt", ns=(0, 0))
        after = workspace.fingerprint(self.cwd), workspace.content_fingerprint(self.cwd, ["tracked.txt"])
        self.assertNotEqual(after[0], before[0], "touching a pipe did not change the fingerprint")
        self.assertEqual(after[1], before[1], "touching a pipe changed the content digest")


if __name__ == "__main__":
    unittest.main()
