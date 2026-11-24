"""Tests that the plugin names the categories the engine names, and that the characters of those categories are the same in Node and in Python on this machine.

The plugin matches a category with a Unicode property escape of Node; the engine asks `unicodedata.category` of Python. The test reads the categories of each rule from hooks/safe-text.ts and from engine/safe_text.py and fails when a rule names another set in the plugin than in the engine. It then compares the tables. A character that one version of Unicode has assigned to a hiding category and the other has not would be raw in one notice and escaped in the other. This test lists the code points of each category in both. A code point that only one of the two Unicode versions has assigned is not compared, since the other cannot say which category it will have; the test names that rule and prints how many code points it left out. Any other difference fails. It cannot say what other versions of Node and Python hold, as those of the CI; the README lists that.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import importlib
import json
import re
import shutil
import sys
import subprocess
import unicodedata
import unittest

import paths
from codex_hook import read

sys.path.insert(0, str(paths.ROOT / "engine"))
safe_text = importlib.import_module("safe_text")

SAFE_TEXT = paths.ROOT / "hooks" / "safe-text.ts"
FIRST_SURROGATE = 0xD800
LAST_SURROGATE = 0xDFFF
LAST_CODE_POINT = 0x10FFFF
FIRST_TWO_BYTE_CODE = 0x100
FIRST_ASTRAL_CODE = 0x10000
NODE = shutil.which("node")
LISTING = (
    "const found = []\n"
    "const rule = new RegExp(process.argv[1], 'u')\n"
    f"for (let code = 0; code <= {LAST_CODE_POINT}; code++) {{ if (code >= {FIRST_SURROGATE} && code <= {LAST_SURROGATE}) continue; if (rule.test(String.fromCodePoint(code))) found.push(code) }}\n"
    "console.log(JSON.stringify(found))"
)


def rules_of_the_plugin(source: str | None = None) -> dict[str, set[str]]:
    """The categories of each character class of hooks/safe-text.ts that names Unicode categories, by the name of the constant that holds it."""
    found = {}
    for line in (read(SAFE_TEXT) if source is None else source).splitlines():
        match = re.search(r"/\[((?:\\p\{\w\w\})+)\]/u", line)
        name = re.search(r"const (\w+)", line)
        if match and name:
            found[name.group(1)] = set(re.findall(r"\\p\{(\w\w)\}", match.group(1)))
    return found


def rules_of_the_engine() -> dict[str, set[str]]:
    """The categories the engine's rules write as an escape, by the name the plugin's constant for the same rule has."""
    return {"HIDING_CHARACTER": set(safe_text.HIDING_CATEGORIES), "LINE_BREAKS": set(safe_text.LINE_BREAKS.categories)}


def categories_in_node(categories: set[str]) -> set[int]:
    pattern = "[" + "".join(f"\\p{{{each}}}" for each in sorted(categories)) + "]"
    done = subprocess.run([NODE or "node", "-e", LISTING, pattern], capture_output=True, text=True, check=True)
    return set(json.loads(done.stdout))


def unassigned_in_node() -> set[int]:
    return categories_in_node({"Cn"})


def unassigned_in_python() -> set[int]:
    return categories_in_python({"Cn"})


def disagreements(node: set[int], python: set[int], unassigned: tuple[set[int], set[int]]) -> tuple[list[int], list[int]]:
    """The code points on which the two sets differ although both versions of Unicode assigned them, and those left out because one version did not."""
    node_free, python_free = unassigned
    differing = node ^ python
    left_out = sorted(differing & (node_free | python_free))
    return sorted(differing - set(left_out)), left_out


def categories_in_python(categories: set[str]) -> set[int]:
    return {code for code in range(LAST_CODE_POINT + 1) if not FIRST_SURROGATE <= code <= LAST_SURROGATE and unicodedata.category(chr(code)) in categories}


@unittest.skipIf(NODE is None, "node is not installed, so there is no table of Node to compare")
class UnicodeTableTests(unittest.TestCase):
    def test_node_and_python_hold_the_same_characters_in_each_category_the_plugin_escapes(self) -> None:
        rules = rules_of_the_plugin()
        self.assertEqual(sorted(rules), ["HIDING_CHARACTER", "LINE_BREAKS"], "the scan found other classes than the two of hooks/safe-text.ts")
        unassigned = (unassigned_in_node(), unassigned_in_python())
        for name, categories in rules.items():
            with self.subTest(name):
                self.assertGreaterEqual(len(categories), 3, f"{name} names {categories}, which is too few to be a rule of hiding characters")
                differing, left_out = disagreements(categories_in_node(categories), categories_in_python(categories), unassigned)
                if left_out:
                    print(f"{name}: {len(left_out)} code points are assigned in one Unicode version only and are not compared: {[hex(code) for code in left_out]}")
                self.assertEqual(differing, [], f"Node and Python disagree about the characters of {sorted(categories)} that both versions of Unicode assigned")

    def test_the_plugin_names_the_categories_the_engine_names(self) -> None:
        self.assertEqual(rules_of_the_plugin(), rules_of_the_engine(), "a rule of hooks/safe-text.ts names other categories than the same rule of engine/safe_text.py")

    def test_the_comparison_fails_for_a_plugin_that_drops_a_category(self) -> None:
        without_format = read(SAFE_TEXT).replace("\\p{Cf}", "", 1)
        self.assertNotEqual(rules_of_the_plugin(without_format), rules_of_the_engine())
        self.assertEqual(rules_of_the_engine()["HIDING_CHARACTER"], {"Cc", "Cf", "Zl", "Zp", "Zs"})
        self.assertEqual(rules_of_the_engine()["LINE_BREAKS"], {"Cc", "Zl", "Zp"})

    def test_no_character_at_the_first_code_of_a_wider_escape_is_escaped(self) -> None:
        hiding = categories_in_python({"Cc", "Cf", "Zl", "Zp", "Zs"})
        self.assertEqual({FIRST_TWO_BYTE_CODE, FIRST_ASTRAL_CODE} & hiding, set(), "a character at the first code of a four or eight digit escape is escaped, so a changed limit of the escape widths is no equivalent change")

    def test_the_comparison_fails_for_a_set_that_differs(self) -> None:
        self.assertNotEqual(categories_in_node({"Cc"}), categories_in_python({"Cc", "Cf"}))

    def test_a_difference_on_a_code_point_that_one_version_left_unassigned_is_left_out_and_any_other_fails(self) -> None:
        self.assertEqual(disagreements({1, 2, 3}, {1, 2}, (set(), {3})), ([], [3]))
        self.assertEqual(disagreements({1, 2, 3}, {1, 2}, (set(), set())), ([3], []))
        self.assertEqual(disagreements({1, 2, 3}, {1}, (set(), {3})), ([2], [3]))
        self.assertEqual(disagreements({1}, {1}, (set(), set())), ([], []))

    def test_the_code_points_of_the_reported_difference_are_left_out_only_when_unassigned_on_one_side(self) -> None:
        first_format_character, last_format_character = 0x13439, 0x1343F
        codes = set(range(first_format_character, last_format_character + 1))
        self.assertEqual(disagreements(codes, set(), (set(), codes)), ([], sorted(codes)))
        self.assertEqual(disagreements(codes, set(), (set(), set())), (sorted(codes), []))


if __name__ == "__main__":
    unittest.main()
