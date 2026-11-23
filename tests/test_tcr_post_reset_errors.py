"""Tests that every kind of exception raised after the reset still gives the revert notice, with the saved ref and the command that recovers the work, as valid JSON with exit code 0, and the traceback on stderr. The hook's main runs in a process of its own with one step after the reset made to raise.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import unittest

import paths
from codex_hook import HOOK_TIMEOUT
from bugs import UNEXPECTED_ERRORS
from fault_main import ERRORS, NOT_CONVERTED, OTHER_UNEXPECTED, SIGNALS, STEPS
from tcr_hardening_case import HardeningCase
from test_tcr import EDITING
from test_tcr_revert_faults import RevertFaultTests

FAULT_MAIN = paths.ROOT / "tests" / "fault_main.py"
SUCCESS = 0
EXPECTED_FAILURE = "OSError"
FAULT_SECONDS = HOOK_TIMEOUT * 4
OTHER_UNEXPECTED_STEP = "uncommitted"
BUG_EXIT = 1
SYSTEM_EXIT_STATUS = 1
SAVED_REFS = "refs/overwatch/reverted"
EXIT_AND_TRACEBACK = {
    "KeyboardInterrupt": (-signal.SIGINT, True),
    "MemoryError": (BUG_EXIT, True),
    "SystemExit(1)": (SYSTEM_EXIT_STATUS, False),
    "SystemExit(0)": (SUCCESS, False),
    "SIGTERM": (-signal.SIGTERM, False),
}


class PostResetErrorTests(HardeningCase):
    with_a_staged_copy = False

    start_a_revert = RevertFaultTests.start_a_revert

    def hook_with(self, step: str, error: str) -> subprocess.CompletedProcess[str]:
        payload = {"session_id": "session-1", "cwd": str(self.cwd), "hook_event_name": "PostToolUse", **EDITING}
        environment = {**os.environ, "PATH": f"{self.bin}{os.pathsep}{os.defpath}", "PLUGIN_DATA": str(self.data),
                       "PYTHONPATH": os.pathsep.join(str(paths.ROOT / directory) for directory in ("engine", "tests"))}
        return subprocess.run([sys.executable, str(FAULT_MAIN), step, error], input=json.dumps(payload), text=True, capture_output=True,
                              env=environment, timeout=FAULT_SECONDS, check=False)

    def test_whatever_is_raised_after_the_reset_the_notice_names_the_revert_the_ref_and_the_command_to_recover(self) -> None:
        raised = [(step, error) for step in STEPS for error in ERRORS] + [(OTHER_UNEXPECTED_STEP, error) for error in OTHER_UNEXPECTED]
        for step, error in raised:
            with self.subTest(step=step, error=error):
                self.setUp()
                self.start_a_revert()
                finished = self.hook_with(step, error)
                self.assertEqual(finished.returncode, SUCCESS, f"the hook exited with {finished.returncode}: {finished.stderr[-300:]}")
                told = json.dumps(json.loads(finished.stdout))
                refs = self.revert_refs()
                self.assertEqual(len(refs), 1, f"{len(refs)} refs were saved, not one")
                self.assertIn(refs[0], told, f"the notice does not name the saved ref: {told}")
                self.assertIn(f"git checkout {refs[0]} -- .", told, f"the notice does not give the command that recovers the work: {told}")
                self.assertNotIn("unexpected error", told, f"the revert was told as an unexpected error: {told}")
                self.assertTrue(error == EXPECTED_FAILURE or error in finished.stderr, f"the traceback of {error} is not on stderr: {finished.stderr[-300:]}")

    def test_every_kind_of_error_the_entry_point_treats_as_unexpected_is_one_of_those_the_test_raises(self) -> None:
        raised = tuple(type(error) for error in (*ERRORS.values(), *OTHER_UNEXPECTED.values()))
        for kind in UNEXPECTED_ERRORS:
            self.assertTrue(any(issubclass(error, kind) for error in raised), f"no error of {kind.__name__} is raised after the reset")

    def test_an_error_that_is_no_bug_and_no_failure_after_the_reset_ends_the_hook_with_no_json_and_no_ref_told(self) -> None:
        for error, (code, traceback) in EXIT_AND_TRACEBACK.items():
            with self.subTest(error=error):
                self.setUp()
                self.start_a_revert()
                finished = self.hook_with("uncommitted", error)
                self.assertEqual(finished.returncode, code, f"{error} exited with {finished.returncode}, not {code}: {finished.stderr[-300:]}")
                self.assertEqual(finished.stdout, "", f"{error} was told as JSON: {finished.stdout!r}")
                self.assertEqual("Traceback" in finished.stderr, traceback, f"{error} gave the traceback {finished.stderr[-300:]!r}, or none")
                self.assertNotIn(SAVED_REFS, finished.stderr, f"{error} told where the saved ref is")
                if error in SIGNALS:
                    self.assertEqual(finished.stderr, "", f"{error} ended the hook with text on stderr: {finished.stderr[-300:]!r}")

    def test_every_end_of_the_hook_that_is_not_converted_is_one_the_table_of_exits_lists(self) -> None:
        self.assertEqual(set(EXIT_AND_TRACEBACK), {*NOT_CONVERTED, *SIGNALS}, "an end of the hook that no error converts is not in the table of exits")


if __name__ == "__main__":
    unittest.main()
