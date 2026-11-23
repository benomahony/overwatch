"""Tests of what the notices say, as the README does: when a revert is told as one, how files are named, and what is written as an escape.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import unittest

import paths
import safe_text
import tcr_texts
from checkpoint import RESET_FAILED, RESET_UNKNOWN
SAVED_REF = "refs/overwatch/reverted/x"
CHARACTERS_OF_THE_SUMMARY_EXCEPTION = {"ESC": "\x1b", "NBSP": "\u00a0", "ZWSP": "\u200b", "bidirectional control": "\u202e", "line break": "\n"}


class ReadmeNoticeTests(unittest.TestCase):
    def test_a_reset_nobody_knows_to_have_ended_is_told_as_an_attempt_with_no_claim_about_the_files(self) -> None:
        facts = tcr_texts.Facts(RESET_UNKNOWN, ["a.txt"], ["a.txt"])
        told = tcr_texts.interrupted_attempt(facts, tcr_texts.Recovery(SAVED_REF, False, []))
        self.assertIn("TCR tried to revert", told, "a reset nobody knows to have ended is told as a revert")
        self.assertNotIn("unchanged", told, "the notice claims the files are unchanged")

    def test_an_attempt_lists_the_files_the_second_listing_lacks_as_now_as_head_has_them_and_not_as_restored(self) -> None:
        facts = tcr_texts.Facts(RESET_FAILED, ["a.txt", "b.txt"], ["b.txt"])
        told = tcr_texts.interrupted_attempt(facts, tcr_texts.Recovery(SAVED_REF, False, []))
        self.assertIn("Now as HEAD has them: `a.txt`.", told, "the notice does not say which file is as HEAD has it")
        self.assertIn("Still changed: `b.txt`.", told, "the notice does not say which file is still changed")
        self.assertNotIn("Restored", told, "the notice of an attempt says a file was restored")

    def test_a_summary_with_a_raw_esc_nbsp_zwsp_bidirectional_control_or_line_break_is_written_with_escapes(self) -> None:
        for kind, character in CHARACTERS_OF_THE_SUMMARY_EXCEPTION.items():
            with self.subTest(kind):
                written = safe_text.safe_line(f"a{character}b")
                self.assertNotIn(character, written, f"{kind} is written raw")
                self.assertEqual(written.startswith("a\\") and written.endswith("b"), True, f"{kind} is not written as an escape: {written!r}")


if __name__ == "__main__":
    unittest.main()
