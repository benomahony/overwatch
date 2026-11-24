"""Tests that each sweep over the host's steps names, as a literal, the exact number of steps it makes, and that the fixture asserts it.

A sweep whose scenario stopped reaching the host once played no run and passed: its loop began at NaN. Each call of `sweep(`, with or without type arguments, names the number of steps once in its own arguments as an integer literal above zero, a sweep entry names it in its own object, a test file that calls neither names an integer literal of `steps` in the file, and the fixture that plays the sweeps fails when the plain run makes any other number of steps, plays any other number of runs than the steps it shares, or runs its check any other number of times than once for the plain run and once for each run played. `tests/tcr-net-sweep-floor.test.ts` plays the fixture with a literal that is wrong, and with the right one, and shows that a sweep gives its check the plain run and each run it plays, for a share of the even steps and for one of the odd steps.

Its limits: a file that calls neither `sweep` nor `sweepEntries`, as `tests/tcr-boundaries.test.ts` that plays through a list of shapes, is held to one integer literal in the file, not to one for each shape; a number that is a literal but is not the plain run's is found only when the fixture runs; a `steps:` that stands in a nested object of the call, and a call of another name for `sweep`, are not told from the number the sweep takes (unverified).

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import re
import unittest

import paths
from codex_hook import read
from ts_source import calls, closing, masked

TESTS = paths.ROOT / "tests"
FIXTURE = TESTS / "fixtures" / "tcr-net.ts"
FLOOR = re.compile(r"\bsteps\s*:\s*[1-9][0-9_]*(?=\s*[,}])")
STEPS_KEY = re.compile(r"\bsteps\s*:")
SWEEP_CALL = re.compile(r"(?<![\w$])(?:sweep|sweepEntries)\s*(?:<[^()]*>)?\s*\(")
ENTRY = re.compile(r"^\s{2}\{\n\s{4}name:", re.MULTILINE)
SWEEPING = re.compile(r"\bsweep\(|\bsweepEntries\(|\bplay\(|\bthrowAt\b")


def sweeping_files() -> list[str]:
    """The test files, not the fixtures, that play runs with a step of the host throwing."""
    return sorted(path.name for path in TESTS.glob("*.test.ts") if SWEEPING.search(read(path)) and "fixtures/tcr-net" in read(path))


def names_one_floor(code: str) -> bool:
    """Whether code names `steps` once, as an integer literal above zero that nothing follows in its object, so that `6 * 2` and `12.5` are no floor."""
    return len(STEPS_KEY.findall(code)) == 1 and FLOOR.search(code) is not None


def without_floor(source: str) -> bool:
    """Whether a file that calls neither `sweep` nor `sweepEntries`, which the other tests hold to a floor of their own, has no integer literal of `steps`."""
    code = masked(source)
    return SWEEP_CALL.search(code) is None and FLOOR.search(code) is None


def sweeps_without_floor(source: str) -> int:
    """How many calls of `sweep(`, with or without type arguments, in source name no integer literal of steps once in their own arguments."""
    code = masked(source)
    return sum(1 for found in re.finditer(r"(?<![\w$])sweep\s*(?:<[^()]*>)?\s*\(", code) if not names_one_floor(code[found.end() - 1:closing(code, found.end() - 1) + 1]))


def entries_without_floor(source: str) -> int:
    """How many entries of an `ENTRIES` list name no `steps`."""
    return max(0, len(ENTRY.findall(source)) - len(re.findall(r"^\s{4}steps\s*:\s*[1-9][0-9_]*,", source, re.MULTILINE)))


class SweepFloorTests(unittest.TestCase):
    def test_every_sweeping_file_names_a_floor(self) -> None:
        files = sweeping_files()
        self.assertGreaterEqual(len(files), 7)
        self.assertEqual([name for name in files if without_floor(read(TESTS / name))], [], "a file that sweeps names no number of steps")

    def test_every_call_of_sweep_names_its_floor(self) -> None:
        self.assertEqual({name: sweeps_without_floor(read(TESTS / name)) for name in sweeping_files() if sweeps_without_floor(read(TESTS / name))}, {})

    def test_every_file_that_sweeps_entries_lists_some(self) -> None:
        files = [path for path in TESTS.glob("tcr-net-*.test.ts") if "sweepEntries(" in masked(read(path))]
        self.assertGreaterEqual(len(files), 4)
        self.assertEqual([path.name for path in files if not ENTRY.findall(read(path))], [])

    def test_every_entry_names_its_floor(self) -> None:
        self.assertEqual({path.name: entries_without_floor(read(path)) for path in TESTS.glob("tcr-net-*.test.ts") if entries_without_floor(read(path))}, {})

    def test_the_fixture_holds_the_two_lines_that_fail_a_sweep(self) -> None:
        code = masked(read(FIXTURE))
        self.assertIn("expect(plain.steps.length).toBe(scenario.steps)", code)
        self.assertIn("expect(played).toBe(shared)", code)
        self.assertIn("expect(checked).toBe(shared + 1)", code)

    def test_the_fixture_is_played_with_a_wrong_literal_by_a_test_of_its_own(self) -> None:
        source = read(TESTS / "tcr-net-sweep-floor.test.ts")
        self.assertEqual(len(re.findall(r"(?<![\w$])sweep\s*\(", masked(source))), 4)
        self.assertEqual(sweeps_without_floor(source), 0)

    def test_the_scan_rejects_a_file_that_plays_with_no_integer_literal(self) -> None:
        self.assertTrue(without_floor("await play({ $, project, entry })"))
        self.assertFalse(without_floor("await play({ steps: 12 })"))
        self.assertTrue(without_floor("steps: 0"))
        self.assertTrue(without_floor("await play({ steps: 6 * 2 })"))
        self.assertTrue(without_floor("await play({ steps: 12.5 })"))
        self.assertTrue(without_floor("// await play({ steps: 12 })\nawait play({ $ })"))

    def test_the_scan_counts_the_calls_of_sweep_that_name_no_integer_literal_once(self) -> None:
        self.assertEqual(sweeps_without_floor("await sweep({ $, project, steps: 3 }, a)\nawait sweep({ $, project }, b)"), 1)
        self.assertEqual(sweeps_without_floor("await sweep({ $, project, steps: 3 }, a)\nawait sweep({ $, project, steps: 4 }, b)"), 0)
        self.assertEqual(sweeps_without_floor("await sweep<Run>({ $, project }, check)"), 1)
        self.assertEqual(sweeps_without_floor("await sweep<Run>({ $, project, steps: 3 }, check)"), 0)
        self.assertEqual(sweeps_without_floor("await sweep({ $, project, steps: 6 * 2 }, check)"), 1)
        self.assertEqual(sweeps_without_floor("await sweep({ $, project, steps: 12.5 }, check)"), 1)
        self.assertEqual(sweeps_without_floor("await sweep({ $, project, steps: 3, steps: 4 }, check)"), 1)
        self.assertEqual(sweeps_without_floor("// await sweep({ $, project }, check)"), 0)

    def test_the_scan_counts_the_entries_that_name_no_floor(self) -> None:
        self.assertEqual(entries_without_floor("const E = [\n  {\n    name: 'a',\n    entry: x,\n  },\n]"), 1)


if __name__ == "__main__":
    unittest.main()
