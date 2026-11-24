"""The asserts of the plugin's hooks that look at text, found in the TypeScript source by the reader of tests/ts_source.py, and the functions that run after a revert has discarded the work.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import paths
from codex_hook import read
from ts_source import TEXT_NAMES, Function, arguments, calls, closing, enclosing, functions, masked

HOOKS = paths.ROOT / "hooks"
TEXT_METHODS = ("includes", "startsWith", "endsWith", "test", "match", "matchAll", "split", "trim", "trimEnd", "trimStart", "indexOf", "lastIndexOf", "localeCompare", "normalize", "replace", "replaceAll", "padStart", "padEnd", "toLowerCase", "toUpperCase", "charAt", "codePointAt", "slice")
TEXT_CONDITION = re.compile(rf"\.(?:{'|'.join(TEXT_METHODS)})\s*\(|(?<![\w$.])(?:{'|'.join(TEXT_NAMES)})\b|(?:{'|'.join(TEXT_NAMES)})\s*\.length\b|\)\s*\.length\b|[!=]==?\s*(?:'\x01*'|\"\x01*\"|`\x01*`)|(?:'\x01*'|\"\x01*\"|`\x01*`)\s*[!=]==?")
RUNS_AFTER_THE_REVERT = ("failedRevert", "inspectRestored", "toldOf", "orFailure", "forgetResults", "stillChanged", "settleRevert", "revertMessage", "unrevertedMessage", "queueTcr", "pauseTcr", "pauseUnlessPaused", "tcrMessage", "fingerprintOf", "dirtyFiles", "tellBrokenRevert", "brokenRevertMessage", "tellUnexpected", "describeError", "markTold")
RUNS_BEFORE_THE_TOOL = ("noteFilesBefore", "whileEditing", "deniedWhileFailing")
NOT_FUNCTIONS_OF_THE_HOOKS = frozenset({"assert", "constructor", "has", "get", "set", "add", "delete", "map", "filter", "some", "every", "find", "includes", "join", "split", "push", "slice", "then", "catch", "finally", "after", "cancel", "run", "start", "stop", "send", "watch", "read"})
DEFINES_ASSERT = "assert.ts"
SPACES = re.compile(r"\s+")
ARRAY_RESULT = re.compile(r"(?:\.(?:filter|map|flatMap)|Object\.(?:keys|values|entries)|Array\.from)\s*\(")
LENGTH = re.compile(r"\.length\b")
TYPE_TEST = re.compile(r"typeof\s+[\w$.]+\s*[!=]==\s*'\x01*'")


def without_array_counts(code: str) -> str:
    """code with the `.length` of a call that gives an array, a count of the plugin's own items, blanked."""
    out = code
    for match in ARRAY_RESULT.finditer(code):
        end = closing(code, match.end() - 1) + 1
        length = LENGTH.match(code, end)
        if length:
            out = out[:length.start()] + " " * (length.end() - length.start()) + out[length.end():]
    return out


@dataclass(frozen=True)
class TextAssert:
    file: str
    function: str
    condition: str

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.file, self.function, self.condition)


def sources() -> dict[str, tuple[str, str, list[Function]]]:
    found = {}
    for path in sorted(HOOKS.glob("*.ts")):
        source = read(path)
        code = masked(source)
        found[path.name] = (source, code, functions(code))
    return found


def asserts_of(file: str, source: str) -> list[tuple[TextAssert, bool]]:
    """Each assert of source with its function and its condition, and whether the condition looks at text."""
    code = masked(source)
    declared = functions(code)
    found = []
    for opening in calls(code, "assert"):
        span = arguments(code, opening)[0]
        holder = enclosing(declared, opening)
        condition = SPACES.sub(" ", source[span[0]:span[1]]).strip()
        is_text = bool(TEXT_CONDITION.search(TYPE_TEST.sub("", without_array_counts(code)[span[0]:span[1]])))
        found.append((TextAssert(file, holder.name if holder else "", condition), is_text))
    return found


def every_assert() -> list[tuple[TextAssert, bool]]:
    return [pair for path in sorted(HOOKS.glob("*.ts")) if path.name != DEFINES_ASSERT for pair in asserts_of(path.name, read(path))]


def text_asserts() -> list[TextAssert]:
    return [each for each, is_text in every_assert() if is_text]


def functions_after_the_revert() -> set[str]:
    return functions_reached_from(RUNS_AFTER_THE_REVERT)


def functions_before_the_tool() -> set[str]:
    return functions_reached_from(RUNS_BEFORE_THE_TOOL)


def functions_reached_from(entries: tuple[str, ...]) -> set[str]:
    """The functions of the hooks that the entry points named run, and the functions those call, found by name."""
    by_name = {each.name: (code, each) for _, code, declared in sources().values() for each in declared}
    reached, pending = set(), list(entries)
    while pending:
        name = pending.pop()
        if name in reached or name not in by_name:
            continue
        reached.add(name)
        code, function = by_name[name]
        pending.extend(other for other in by_name if other not in reached and other not in NOT_FUNCTIONS_OF_THE_HOOKS and calls(code[function.start:function.end], other))
    return reached


def length_asserts_where_a_raise_costs() -> list[TextAssert]:
    """Each assert that looks at a length, in a function that runs after a revert or before a tool, where an assert that raises replaces the notice of the revert or leaves the person guard off."""
    where = functions_after_the_revert() | functions_before_the_tool()
    return [each for each, has_length in length_asserts() if has_length and each.function in where]


def length_asserts() -> list[tuple[TextAssert, bool]]:
    return [pair for path in sorted(HOOKS.glob("*.ts")) if path.name != DEFINES_ASSERT for pair in length_asserts_of(path.name, read(path))]


def length_asserts_of(file: str, source: str) -> list[tuple[TextAssert, bool]]:
    """Each assert of source with its function and its condition, and whether the condition looks at a length."""
    code = masked(source)
    declared = functions(code)
    found = []
    for opening in calls(code, "assert"):
        span = arguments(code, opening)[0]
        holder = enclosing(declared, opening)
        condition = SPACES.sub(" ", source[span[0]:span[1]]).strip()
        found.append((TextAssert(file, holder.name if holder else "", condition), bool(LENGTH.search(code[span[0]:span[1]]))))
    return found
