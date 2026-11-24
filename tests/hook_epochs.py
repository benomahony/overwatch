"""Where the hooks name the session that an awaited result belongs to, read from the TypeScript source by the reader of tests/ts_source.py.

A call that queues a message or pauses TCR changes the session that is current when it runs. After an await the current session may be a newer one than the session the call was made for, so such a call needs a guard after the last await that compares the current session with the one it began in. The limits of this reading are listed in tests/test_hook_queue_epochs.py.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import re

from ts_source import Function, arguments, calls, closing, functions, masked

AWAIT = re.compile(r"\bawait\b")
COMPARISON = re.compile(r"([\w$.]+)\s*(===|!==)\s*([\w$.]+)")
CURRENT = re.compile(r"(?:^|\.)state\.(?:epoch|tcr)$")
CAPTURED = re.compile(r"(?:^|\.)(?:epoch|tcr)$")
JUDGING = re.compile(r"(?<!!)\bisJudging\s*\(")
NOT_JUDGING = re.compile(r"!\s*isJudging\s*\(")
EXITS = re.compile(r"(?:return|continue|throw|break)\b")
IF = re.compile(r"\bif\s*\(")
NEGATION = re.compile(r"!\s*\(")
CATCH = re.compile(r"\bcatch\s*(?:\([^)]*\))?\s*\{")


def statement_end(code: str, start: int) -> int:
    """The index after the statement that begins at start: its block when it opens one, else its line."""
    at = start
    while at < len(code) and code[at].isspace():
        at += 1
    if at < len(code) and code[at] == "{":
        return closing(code, at) + 1
    end = code.find("\n", at)
    return len(code) if end < 0 else end


def without_groups(condition: str) -> str:
    """The condition without what it holds in parentheses, so that only what joins its top-level parts is left."""
    depth, kept = 0, []
    for character in condition:
        if character == "(":
            depth += 1
        elif character == ")":
            depth -= 1
        elif depth == 0:
            kept.append(character)
    return "".join(kept)


def stands_alone(condition: str, joins: str) -> bool:
    """Whether condition is neither negated as a group, as in `!(...)`, which turns what it names the other way, nor joins another test to its top level by joins: a condition that holds `&&` where it leaves, or `||` where it acts, may leave or act for another reason."""
    return NEGATION.search(condition) is None and joins not in without_groups(condition.strip()[1:-1])


def compares_session(condition: str, operator: str) -> bool:
    """Whether condition compares the session's current epoch or TCR state, `state.epoch` or `state.tcr`, with one captured earlier, by operator, and stands alone as `stands_alone` says."""
    if not stands_alone(condition, "&&" if operator == "!==" else "||"):
        return False
    for left, found, right in COMPARISON.findall(condition):
        if found != operator:
            continue
        current, captured = (left, right) if CURRENT.search(left) else (right, left)
        if CURRENT.search(current) and CAPTURED.search(captured) and not CURRENT.search(captured):
            return True
    return False


def enclosing_block_end(code: str, at: int) -> int:
    """The index of the closing brace of the innermost block that holds the index at, or the end of code when none does."""
    depth = 0
    for index in range(at - 1, -1, -1):
        if code[index] == "}":
            depth += 1
        elif code[index] == "{":
            if depth == 0:
                return closing(code, index)
            depth -= 1
    return len(code)


def guards(code: str) -> list[tuple[int, int]]:
    """The span of each guard in code: the rest of the block that holds an `if` that leaves when the session differs, and the statement under an `if` that names the same session."""
    spans: list[tuple[int, int]] = []
    for match in IF.finditer(code):
        opening = match.end() - 1
        after = closing(code, opening) + 1
        condition = code[opening:after]
        end = statement_end(code, after)
        consequence = code[after:end].lstrip().lstrip("{").lstrip()
        leaves = compares_session(condition, "!==") or (NOT_JUDGING.search(condition) is not None and stands_alone(condition, "&&"))
        acts = compares_session(condition, "===") or (JUDGING.search(condition) is not None and stands_alone(condition, "||"))
        if leaves and EXITS.match(consequence):
            spans.append((end, enclosing_block_end(code, match.start())))
        if acts:
            spans.append((after, end))
    return spans


def last_wait(code: str, call: int) -> int:
    """The index after which the session may have changed before the call at call: the last await before the end of its arguments, and the start of the catch block that holds it when the function awaited before that block, since a throw may come from any of its awaits; -1 when none."""
    last_await = max((found.start() for found in AWAIT.finditer(code[:closing(code, call)])), default=-1)
    for found in CATCH.finditer(code):
        block_end = closing(code, found.end() - 1)
        if found.end() <= call <= block_end and any(wait.start() < found.start() for wait in AWAIT.finditer(code)):
            last_await = max(last_await, found.end())
    return last_await


def is_told_with_its_epoch(code: str, call: int) -> bool:
    """Whether the call at call is `tellUnexpected` and its last argument is the plain name `epoch`, which the entry captured when it began; the state's own `epoch` is the current session and says nothing."""
    spans = arguments(code, call)
    return code[call - len("tellUnexpected"):call] == "tellUnexpected" and len(spans) == 4 and code[spans[3][0]:spans[3][1]].strip() == "epoch"


def is_guarded(code: str, call: int) -> bool:
    """Whether the call at call, a parenthesis in code, runs in the session the function began in: nothing awaited before it, or it is a `tellUnexpected` given the captured `epoch`, or a guard after the last wait names the session."""
    wait = last_wait(code, call)
    if wait < 0:
        return True
    if is_told_with_its_epoch(code, call):
        return True
    return any(first > wait and first <= call < last for first, last in guards(code))


def without_guard(file: str, source: str, names: tuple[str, ...]) -> list[tuple[str, str, str]]:
    """The calls of `names` in source that follow an await in their function with no guard that names the session, as (file, function, call)."""
    code = masked(source)
    found: set[tuple[str, str, str]] = set()
    for each in functions(code):
        body = code[each.start:each.end]
        for name in names:
            for opening in calls(body, name):
                if body[opening - len(name) - 1:opening - len(name)] == ".":
                    continue
                if not is_guarded(body, opening):
                    found.add((file, each.name, name))
    return sorted(found)
