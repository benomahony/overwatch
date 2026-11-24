"""Tests that no test of the plugin runs with the runner's default limit: each test file declares its tests with `longTest`, or with `test` and an options argument that holds its own `timeoutMs`.

A test that plays turns on a mock clock takes between one and five seconds on an idle machine and more on a busy one, and the runner's default limit of five seconds failed one of them in a loaded run. The scan reads every tests/*.test.ts and every tests/fixtures/*.ts with the tokenizer of ts_source.py and the argument structure of each call: `timeoutMs` counts only as an own entry of the options argument, never in the body, a name or a nested object, and its value must be named constants, never a number or `undefined`. It rejects `it`, an import of the runner's `test` under another name or as a namespace or default, and `test` used as a value, since each hides a declaration from it. The shard files of the interleavings and the liveness sweep run for minutes and keep a limit of their own, which the scan reads in their options. It cannot tell how long a test runs, so the limit of `longTest` is a bound the author chose.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import re
import unittest

import paths
from codex_hook import read
from ts_source import arguments, masked

TESTS = paths.ROOT / "tests"
SHARD_FILE = re.compile(r"tcr-(?:interleavings|liveness)-\d+\.test\.ts")
BARE_TEST = re.compile(r"(?<![\w$.])test\s*\(")
IT_CALL = re.compile(r"(?<![\w$.])it\s*\(")
LONG_TEST = re.compile(r"(?<![\w$.])longTest\s*\(")
OTHER_FORM = re.compile(r"(?<![\w$.])(?:test|longTest)\s*\.\s*\w+")
TEST_VALUE = re.compile(r"(?<![\w$.])(?:test|it)\b(?!\s*\(|\s*\.\s*\w)")
IMPORT = re.compile(r"^import\b(?P<what>.*?)\bfrom\s*['\"](?P<module>[^'\"]+)['\"]", re.M | re.S)
TEST_MODULES = {"claude-code/testing", "node:test", "bun:test"}
TEST_NAMES = {"test", "it"}
LIMIT_ENTRY = re.compile(r"\s*timeoutMs\s*:(?P<value>.+)", re.S)
NAMED_LIMIT = re.compile(r"\s*[A-Z][A-Z0-9_]*(?:\s*[-+*]\s*[A-Z][A-Z0-9_]*)*\s*")
SHARED_LIMIT = re.compile(r"\s*LONG_TEST_MS\s*")
OPTIONS_POSITION = 1
CALL_WITH_OPTIONS = 3
CALL_WITHOUT_OPTIONS = 2


def calls_of(source: str, pattern: re.Pattern[str]) -> list[list[str]]:
    """The masked text of each argument of each call of source that `pattern` finds."""
    code = masked(source)
    return [[code[first:last] for first, last in arguments(code, match.end() - 1)] for match in pattern.finditer(code)]


def import_faults(source: str) -> list[str]:
    """The imports of source that bring `test` or `it` of a test module in under another name, as a namespace or as a default."""
    found = []
    for match in IMPORT.finditer(source):
        if match.group("module") not in TEST_MODULES:
            continue
        what = match.group("what").strip()
        if what.startswith("*") or not what.startswith("{"):
            found.append(f"an import of {match.group('module')} that is no list of names, which hides what is called")
            continue
        for specifier in what.strip("{} \n").split(","):
            names = specifier.replace("type ", "").split()
            if names[:1] and names[0] in TEST_NAMES and (len(names) > 1 or names[0] == "it"):
                found.append(f"an import of {names[0]} that renames it or is not the test of the runner")
    return found


def limit_of(options: str) -> str | None:
    """The masked value of `timeoutMs` among the own entries of an options object, or None when there is none, as when it is nested in another entry or the options are no object."""
    code = options.strip()
    if not code.startswith("{"):
        return None
    entries = (LIMIT_ENTRY.fullmatch(code[first:last]) for first, last in arguments(code, 0))
    return next((entry.group("value") for entry in entries if entry is not None), None)


def faults(source: str, is_shard: bool = False, is_definition: bool = False) -> list[str]:
    """What is wrong with the way source declares its tests; nothing when it is right."""
    code = masked(source)
    found = import_faults(source)
    found += [f"{match.group(0)} is a form the scan does not read" for match in OTHER_FORM.finditer(code)]
    found += ["it( is a form the scan does not read" for _ in IT_CALL.finditer(code)]
    without_imports = IMPORT.sub(lambda match: " " * len(match.group(0)), code)
    found += [f"{match.group(0)} is used as a value, which the scan does not read" for match in TEST_VALUE.finditer(without_imports)]
    for each in calls_of(source, BARE_TEST):
        limit = limit_of(each[OPTIONS_POSITION]) if len(each) == CALL_WITH_OPTIONS else None
        if limit is None:
            found.append("a test without a timeoutMs in its options")
        elif NAMED_LIMIT.fullmatch(limit) is None:
            found.append("a test whose timeoutMs is not a named constant")
        elif not is_shard and not is_definition and SHARED_LIMIT.fullmatch(limit):
            found.append("a test with the limit of longTest, which declares it")
    for each in calls_of(source, LONG_TEST):
        if len(each) != CALL_WITHOUT_OPTIONS:
            found.append("a longTest with an argument besides its name and body")
    if is_shard and not calls_of(source, BARE_TEST):
        found.append("a shard file with no test")
    return found


def files_to_read() -> list:
    return sorted(TESTS.glob("*.test.ts")) + sorted((TESTS / "fixtures").glob("*.ts"))


def is_definition(path) -> bool:
    return path.parent.name == "fixtures" and "export function longTest" in read(path)


class TestTimeoutTests(unittest.TestCase):
    def test_no_test_file_keeps_the_default_limit(self) -> None:
        found = {path.name: faults(read(path), bool(SHARD_FILE.fullmatch(path.name)), is_definition(path)) for path in files_to_read()}
        self.assertEqual({name: each for name, each in found.items() if each}, {}, "declare each test with longTest, or give test a timeoutMs in its options")

    def test_the_scan_rejects_each_fault_it_names(self) -> None:
        self.assertEqual(faults("test('a', async () => {})"), ["a test without a timeoutMs in its options"])
        self.assertEqual(faults("test('a', async () => { const options = { timeoutMs: 1 } })"), ["a test without a timeoutMs in its options"])
        self.assertEqual(faults("test('timeoutMs: 1', async () => {})"), ["a test without a timeoutMs in its options"])
        self.assertEqual(faults("test.each([1])('a', async () => {})"), ["test.each is a form the scan does not read"])
        self.assertEqual(faults("test.skip('a', async () => {})"), ["test.skip is a form the scan does not read", ])
        self.assertEqual(faults("test.only('a', async () => {})"), ["test.only is a form the scan does not read"])
        self.assertEqual(faults("longTest('a', { timeoutMs: 1 }, async () => {})"), ["a longTest with an argument besides its name and body"])
        self.assertEqual(faults("test('a', { timeoutMs: LONG_TEST_MS }, async () => {})"), ["a test with the limit of longTest, which declares it"])

    def test_the_scan_rejects_each_shape_that_hid_a_test_from_it(self) -> None:
        options = "{ timeoutMs: LONG_TEST_MS_OF_ITS_OWN }"
        shapes = {
            "an alias of test": f"const run = test; run('a', {options}, async () => {{}})",
            "a renamed import": "import { test as spec } from 'claude-code/testing'\nspec('a', async () => {})",
            "a renamed import of it": "import { it } from 'node:test'\nit('a', async () => {})",
            "it": "it('a', async () => {})",
            "a cast": f"(test as any)('a', {options}, async () => {{}})",
            "an optional call": f"test?.('a', {options}, async () => {{}})",
            "an index": "test['each']([1])('a', async () => {})",
            "a namespace import": "import * as T from 'claude-code/testing'\nT.test('a', async () => {})",
            "a default import": "import test from 'node:test'\ntest('a', async () => {})",
            "a nested limit": "test('a', { other: { timeoutMs: SOME_MS } }, async () => {})",
            "a number": "test('a', { timeoutMs: 1 }, async () => {})",
            "a number with separators": "test('a', { timeoutMs: 60_000 }, async () => {})",
            "undefined": "test('a', { timeoutMs: undefined }, async () => {})",
            "an expression of numbers": "test('a', { timeoutMs: 2 * LONG_TEST_MS }, async () => {})",
        }
        self.assertEqual({name: bool(faults(source)) for name, source in shapes.items()}, {name: True for name in shapes})

    def test_the_scan_passes_what_it_must(self) -> None:
        self.assertEqual(faults("longTest('a', async () => {})"), [])
        self.assertEqual(faults("test('a', { timeoutMs: SEARCH_TEST_MS }, async () => {})"), [])
        self.assertEqual(faults("test('a', { timeoutMs: NET_TEST_MS + LONG_TEST_MS }, async () => {})"), [])
        self.assertEqual(faults("import { expect, test, type TestBody } from 'claude-code/testing'\ntest('a', { timeoutMs: SEARCH_TEST_MS }, async () => {})"), [])
        self.assertEqual(faults("test(name, { timeoutMs: LONG_TEST_MS }, body)", is_definition=True), [])
        self.assertEqual(faults("test('a', { timeoutMs: SHARD_TIMEOUT_MS }, async () => {})", is_shard=True), [])
        self.assertEqual(faults("const found = EDIT_FILE.test(name)"), [])

    def test_the_scan_reads_the_files_it_names(self) -> None:
        names = {path.name for path in files_to_read()}
        expected = {"tcr-notice.test.ts", "gating-hostile.test.ts", "lifecycle.test.ts", "reports.test.ts", "overwatch.test.ts", "settings.test.ts", "tcr-net-stops.test.ts", "tcr-interleavings-0.test.ts", "tcr-liveness-0.test.ts"}
        self.assertEqual(expected - names, set())
        self.assertTrue(any(SHARD_FILE.fullmatch(name) for name in names))


if __name__ == "__main__":
    unittest.main()
