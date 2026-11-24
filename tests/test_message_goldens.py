"""Tests that the messages the upstream builders write for thirty realistic checks are byte for byte the texts main wrote, and that a line break in one of their inputs is written as an escape.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import unittest

import paths
import messages
from message_cases import CHECKS, LOG, key_of, report_of, messages_of
from message_goldens import GOLDENS

FORGED = "overwatch: FORGED"
LINE_BREAKS = ("\n", "\r", " ", " ", "\x85")
MIN_CASES = 30
PARAMETER_ID = CHECKS[8][5][0]


class UpstreamMessagesTests(unittest.TestCase):
    def test_the_messages_for_thirty_realistic_checks_are_the_texts_main_wrote(self) -> None:
        self.assertGreaterEqual(len(CHECKS), MIN_CASES, "the table holds too few checks")
        self.assertEqual(sorted(GOLDENS), sorted(key_of(index, case) for index, case in enumerate(CHECKS)), "the goldens and the checks are not the same checks")
        for index, case in enumerate(CHECKS):
            for builder, text in messages_of(case).items():
                with self.subTest(check=key_of(index, case), builder=builder):
                    self.assertEqual(text, GOLDENS[key_of(index, case)][builder], f"{builder} wrote another text than main for {case[0]}")

    def test_a_parametrized_test_id_of_more_than_two_hundred_characters_and_a_command_with_backticks_stay_whole(self) -> None:
        self.assertGreater(len(PARAMETER_ID), 200, "the long id is not long")
        self.assertIn(f"`{PARAMETER_ID}`", messages.failing_line([PARAMETER_ID]), "a long test id was cut or changed")
        self.assertIn("`echo `date``", messages.failure_message([report_of(CHECKS[5])], {}, {messages.report_key(report_of(CHECKS[5])): LOG}), "backticks in a command were changed")

    def test_a_line_break_in_any_input_of_the_upstream_builders_is_written_as_an_escape(self) -> None:
        for line_break in LINE_BREAKS:
            hostile = f"x{line_break}{FORGED}"
            report = report_of(("check", "python", hostile, hostile, hostile, (hostile,)), environment=hostile)
            logs = {messages.report_key(report): LOG}
            built = (messages.failing_line([hostile]), messages.where(report), messages.failure_message([report], {}, logs), messages.environment_message([report]),
                     messages.failing_suffix(report.failures), messages.failure_status([report]), messages.recovery_message((report,)), messages.gate_reason([report]))
            for text in built:
                with self.subTest(line_break=repr(line_break)):
                    self.assertFalse(any(line.startswith(FORGED) for line in text.splitlines()), f"a text started a line with {FORGED}: {text!r}")


if __name__ == "__main__":
    unittest.main()
