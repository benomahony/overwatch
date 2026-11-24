"""Tests that every function of the plugin's hooks that builds a text a notice carries is in the matrix of tests/forged-lines.test.ts, which puts hostile text in each of its inputs, or says why it need not be, and that each reason holds: the function it names exists and holds no assert over a text a file, a check or a summary gave beyond those the list of tests/test_hook_text_asserts.py gives a safe reason.

The scan reads the TypeScript source with the tokenizer of ts_source.py, not its syntax tree, because the plugin's tests may import nothing but their kit. It reads a function declared with `function`, as a `const` arrow, as a method of a class or an object, and as an object property that holds an arrow, with a body in braces or an expression, and a text it builds in a template, with a join, a replace, a concat, a concatenation with a string or `+=` of a string.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
 It also holds the fixed sentences of those builders in tests/fixtures/notice-sentences.ts, which the tests through the fake host put in file names, check names and summaries, so that a notice that compares its own text with what a file name holds fails there; run it with --write to write that fixture."""
from __future__ import annotations

import ast
import json
import re
import sys
import unittest

import paths
from codex_hook import read
from hook_assertions import HOOKS, text_asserts
from test_hook_text_asserts import ALLOWED, BY_CONSTRUCTION, FIXED, OBJECT, OWN, PATH, TYPE
from ts_source import arguments, calls, functions, masked, scanned, writes_text

REGISTRY = paths.ROOT / "tests" / "fixtures" / "hook-text-builders.ts"
NAME_CASES = paths.ROOT / "tests" / "tcr-names-in-notices.test.ts"
ENGINE = paths.ROOT / "engine"
NO_TS_NOTICE = "no TS notice: "
NAME_WRITERS = frozenset({"named", "safe_name"})
SAFE_REASONS = frozenset({BY_CONSTRUCTION, FIXED, OBJECT, OWN, PATH, TYPE})
BUILDING_SHAPES = {
    "an array joined": "function f(a: string[]) { return a.join(', ') }",
    "a replace": "function f(a: string) { return a.replace('x', 'y') }",
    "a concat": "function f(a: string) { return a.concat('y') }",
    "a += to a variable of text": "function f(a: string) { let text = ''; text += a; return text }",
    "a += of a string": "function f(a: string) { let n = ''; n += 'x'; return n }",
    "a += of a value that is no literal onto a variable of any name": "function f(a: string) { let out2 = ''; out2 += a; return out2 }",
    "a + of a variable named for text and another": "function f(a: string, b: string) { const text = a; return text + b }",
    "a reduce that adds without an initial value": "function f(a: string[]) { return a.reduce((s, x) => s + x) }",
    "a reduce that starts from a string": "function f(a: { name: string }[]) { return a.map(x => x.name).reduce((s, x) => s + x, '') }",
    "a padStart": "function f(a: string) { return a.padStart(3) }",
    "a repeat": "function f(a: string) { return a.repeat(3) }",
    "a JSON.stringify": "function f(a: string) { return JSON.stringify(a) }",
    "a String of a value": "function f(a: unknown) { return String(a) }",
    "a toString": "function f(a: number) { return a.toString() }",
    "a function expression held by a const": "const f = function (a: string) { return `x ${a}` }",
    "a getter": "class C {\n  get f() { return 1 }\n  get name() {\n    return `x ${this.a}`\n  }\n}",
    "a static method": "class C {\n  static f(a: string) {\n    return `x ${a}`\n  }\n}",
    "an object method": "const o = { f(a: string) { return `x ${a}` } }",
    "a class method": "class C {\n  f(a: string) {\n    return `x ${a}`\n  }\n}",
    "an expression-bodied arrow": "const f = (a: string) => `x ${a}`",
    "a default parameter that is a template": "function f(a: string, b = `x ${a}`) { return b }",
    "an arrow with a typed result": "const f = (a: string): string => { return `x ${a}` }",
    "an arrow with generics": "const f = <T,>(a: T) => `x ${a}`",
    "an arrow with an object type for its result": "const f = (a: string): { text: string } => ({ text: `x ${a}` })",
    "an object property that holds an arrow": "const o = { f: (a: string) => `x ${a}` }",
    "a template that holds two slashes": "function f(a: string) { return `${a}//${a}` }",
    "a function with a regular expression with a quote": "function f(a: string) { const r = /['\"]/; return `x ${a}` }",
    "a const with a typed annotation": "const f: (a: string) => string = (a: string) => `x ${a}`",
}
QUIET_SHAPES = {
    "a counter": "function f() { let n = 0; n += 1; return n }",
    "a counter that adds a number held by a name": "function f(size: number) { let n = 0; n += 1; n = n + size; return n }",
    "a reduce that starts from a number": "function f(a: number[]) { return a.reduce((s, x) => s + x, 0) }",
    "a comment": "function f(a: string) {\n  // x ${a} + 'y'\n  return a\n}",
    "a string that holds a template": "function f() { return '${a} + .join(' }",
}
LIMITS = {
    "an arrow with one parameter and no parentheses": ("const f = a => `x ${a}`", set()),
    "a text built by another function it calls": ("function f(a: string) { return g(a) }\nfunction g(a: string) { return a }", set()),
    "an immediately invoked arrow outside any function": ("(() => `x ${a}`)()", set()),
    "a plus of two variables whose names do not say text": ("function f(first,second){return first+second}", set()),
    "a slice, which an array has too": ("function f(a: string) { return a.slice(1) }", set()),
    "two methods of one name in one file": ("class A {\n  f(a: string) { return a }\n}\nclass B {\n  f(a: string) { return `x ${a}` }\n}", {"x.ts:f"}),
}


def builders_in(file: str, source: str) -> set[str]:
    code = masked(source)
    declared = functions(code)
    return {f"{file}:{each.name}" for each in declared if writes_text(code, each, declared)}


def text_builders_of_the_hooks() -> set[str]:
    return {name for path in sorted(HOOKS.glob("*.ts")) for name in builders_in(path.name, read(path))}


def registry() -> dict[str, dict[str, str]]:
    return json.loads(read(REGISTRY).split(" = ", 1)[1])


def functions_of_the_engine_that_write_names() -> set[str]:
    found = set()
    for path in sorted(ENGINE.glob("*.py")):
        for function in ast.walk(ast.parse(read(path))):
            if not isinstance(function, ast.FunctionDef | ast.AsyncFunctionDef):
                continue
            for call in ast.walk(function):
                name = call.func.id if isinstance(call, ast.Call) and isinstance(call.func, ast.Name) else call.func.attr if isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) else None
                if name in NAME_WRITERS:
                    found.add(f"{path.name}:{function.name}")
    return found


def name_cases_of_the_matrix() -> set[str]:
    return {quoted or bare for quoted, bare in re.findall(r"^  (?:'([^']+)'|(\w+)): name =>", read(NAME_CASES), re.MULTILINE)}


FIXTURE = paths.ROOT / "tests" / "fixtures" / "notice-sentences.ts"
NOT_NOTICE_TEXT = ("assert", "new CommandError", "new Error")
LEAST_WORDS = 2
LEAST_CHARACTERS = 10
ESCAPES = {"n": "\n", "t": "\t"}
COMPARED_WITH_TEXT = ("includes", "startsWith", "endsWith")
SAID_ABOUT_NOTICES = ("The files are unchanged", "refs/x^2")


def unescaped(piece: str) -> str:
    return re.sub(r"\\(.)", lambda match: ESCAPES.get(match.group(1), match.group(1)), piece)


def inside_calls(code: str, names: tuple[str, ...]) -> list[tuple[int, int]]:
    spans = []
    for name in names:
        for opening in calls(code, name):
            spans.append((opening, arguments_end(code, opening)))
    return spans


def arguments_end(code: str, opening: int) -> int:
    spans = arguments(code, opening)
    return spans[-1][1] + 1 if spans else opening + 1


def pieces_of_the_file(file: str, names: set[str]) -> set[str]:
    source = read(HOOKS / file)
    code, spans = scanned(source)
    every = functions(code)
    builders = [each for each in every if each.name in names]
    skipped = inside_calls(code, NOT_NOTICE_TEXT)
    found = set()
    for first, last in spans:
        is_wanted = any(each.start <= first < each.end for each in builders) or not any(each.start <= first < each.end for each in every)
        piece = unescaped(source[first:last]).strip()
        if is_wanted and not any(a <= first < b for a, b in skipped) and len(piece) >= LEAST_CHARACTERS and len(piece.split()) >= LEAST_WORDS:
            found.add(piece)
    return found


def sentences_of_the_builders() -> list[str]:
    covered = json.loads(read(REGISTRY).split(" = ", 1)[1])["covered"]
    found = set(SAID_ABOUT_NOTICES)
    for file in sorted({key.split(":")[0] for key in covered}):
        found |= pieces_of_the_file(file, {key.split(":")[1] for key in covered if key.startswith(f"{file}:")})
    return sorted(found)

class HookTextBuilderTests(unittest.TestCase):
    def test_every_notice_the_engine_writes_names_in_is_a_case_of_the_name_matrix_or_names_why_it_has_none(self) -> None:
        held = registry()["namedByPython"]
        found = functions_of_the_engine_that_write_names()
        self.assertEqual(found - set(held), set(), "a function of the engine writes names with safe_name and the registry does not know it")
        self.assertEqual(set(held) - found, set(), "the registry names a function of the engine that writes no names now")
        cases = name_cases_of_the_matrix()
        self.assertGreater(len(cases), 0, "the name matrix has no case")
        for function, builder in held.items():
            with self.subTest(function):
                self.assertTrue(builder in cases or (builder.startswith(NO_TS_NOTICE) and len(builder) > len(NO_TS_NOTICE) + 10), f"{function} is covered by {builder!r}, which is no case of tests/tcr-names-in-notices.test.ts")

    def test_a_reason_of_the_registry_names_only_helpers_and_files_that_exist(self) -> None:
        held = registry()
        helpers = set(re.findall(r"export function (\w+)", read(HOOKS / "safe-text.ts")))
        for kind in ("notBuiltFromAText", "namedByPython"):
            for function, reason in held[kind].items():
                with self.subTest(function):
                    for helper in re.findall(r"\bsafe[A-Z]\w*", reason):
                        self.assertIn(helper, helpers, f"{function} names the helper {helper}, which safe-text.ts does not export")
                    for file in re.findall(r"[\w-]+\.(?:json|ts)\b", reason):
                        self.assertTrue(any(found.name == file for found in paths.ROOT.glob(f"**/{file}")), f"{function} names the file {file}, which does not exist")

    def test_every_function_of_the_hooks_that_builds_a_text_is_in_the_matrix_or_names_why_it_need_not_be(self) -> None:
        held = registry()
        covered, exempt = set(held["covered"]), set(held["notBuiltFromAText"])
        found = text_builders_of_the_hooks()
        self.assertEqual(found - covered - exempt, set(), "a function builds a text and is in neither the matrix nor the list of those with no text to write")
        self.assertEqual((covered | exempt) - found, set(), "the registry names a function that builds no text now")
        self.assertEqual(covered & exempt, set(), "a function is both covered and exempt")
        self.assertEqual([name for name, reason in held["notBuiltFromAText"].items() if not reason], [], "an exemption has no reason")
        self.assertGreater(len(found), len(covered), "every function the scan found is covered, so none is exempt, which it never is")

    def test_a_function_an_exemption_names_holds_no_assert_over_text_but_those_that_cannot_fail_on_it(self) -> None:
        exempt = set(registry()["notBuiltFromAText"])
        unsafe = [each for each in text_asserts() if f"{each.file}:{each.function}" in exempt and ALLOWED.get(each.key) not in SAFE_REASONS]
        self.assertEqual(unsafe, [], "a function that is exempt because it writes no text holds an assert over text that can fail on it")

    def test_the_scan_finds_a_function_that_builds_a_text_and_passes_over_one_that_builds_none(self) -> None:
        found = text_builders_of_the_hooks()
        self.assertIn("watchers.ts:failureMessage", found)
        self.assertNotIn("gating.ts:commandWords", found)
        self.assertNotIn("assert.ts:assert", found)

    def test_the_scan_does_not_count_a_text_that_only_an_assert_or_an_error_builds(self) -> None:
        source = "function f(a: string) {\n  assert(a !== '', `a is ${a}`)\n  throw new CommandError(`bad ${a}`)\n  return a\n}\n"
        self.assertEqual(builders_in("x.ts", source), set())
        self.assertEqual(builders_in("x.ts", source.replace("return a", "return `x ${a}`")), {"x.ts:f"})
        self.assertEqual(builders_in("x.ts", source.replace("return a", "return 'x' + a")), {"x.ts:f"})

    def test_the_scan_reads_each_shape_of_function_and_each_way_to_build_a_text(self) -> None:
        for name, source in BUILDING_SHAPES.items():
            with self.subTest(name):
                self.assertEqual(len(builders_in("x.ts", source)), 1, f"the scan misses {name}")

    def test_the_scan_passes_over_a_function_that_counts_and_a_comment_or_string_that_looks_like_a_template(self) -> None:
        for name, source in QUIET_SHAPES.items():
            with self.subTest(name):
                self.assertEqual(builders_in("x.ts", source), set(), f"the scan finds text in {name}")

    def test_the_limits_of_the_scan_are_misses_of_it_today(self) -> None:
        for name, (source, found) in LIMITS.items():
            with self.subTest(name):
                self.assertEqual(builders_in("x.ts", source), found, f"the limit {name} no longer holds; update the limits")


class NoticeSentenceTests(unittest.TestCase):
    def test_the_fixture_holds_each_fixed_sentence_of_the_notice_builders_and_the_sentences_the_review_named(self) -> None:
        held = json.loads(read(FIXTURE).split(" = ", 1)[1])
        self.assertEqual(held, sentences_of_the_builders(), "the fixture is not what the scan finds in the builders; run python3 tests/test_hook_text_builders.py --write")

    def test_the_scan_finds_a_sentence_of_each_notice_the_review_named_and_none_of_an_assert(self) -> None:
        found = sentences_of_the_builders()
        self.assertIn("TCR reverted part of the latest change", found)
        self.assertIn("The discarded work is gone: `tcr.saveReverted` is false in", found)
        self.assertFalse([each for each in found if "does not say it is about" in each], "a sentence of an assert message is in the fixture")


if __name__ == "__main__":
    if "--write" in sys.argv:
        FIXTURE.write_text(f"export const SENTENCES = {json.dumps(sentences_of_the_builders(), indent=2)}\n", encoding="utf-8")
    else:
        unittest.main()
