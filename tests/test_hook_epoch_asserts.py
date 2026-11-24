"""Tests that no assert of the hooks looks at the state of the session after an await without naming the session it belongs to.

An await may outlast the session: a new session can set TCR active, or queue a message, while an old one waits. An assert that then claims the state it left for the old session fails on the new one, and its error is told to the new session and pauses it. The scan reads each function of hooks/. For each assert whose condition looks at `state.tcr`, `state.outbox`, `state.liveWatchers`, `state.head`, `state.isPromptQueued` or `state.isTurnRunning`, or at a name that a `const` makes another name for `state`, and does not name the session, it requires a guard after the last await and before the assert: an `if` that leaves when the session differs, or the statement under an `if` that names the same session (see tests/hook_epochs.py). A function that has no `epoch` of its own is read the same way, and one that is listed explains why it cannot meet a new session's state. The test of the counts pins how many such asserts the scan reads.

Its limits: it reads one function at a time, so an assert that a caller guarded is not found; an assert counts as naming the session when its condition holds the word `epoch`, `isJudging(` or a comparison of `state.tcr` with a captured `tcr`, whatever the rest of the condition says; it finds a name for `state` made by `const name = state` and not one made by a parameter or a destructuring other than the plain name `state`; a state reached through another object is not scanned.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import re
import unittest

import paths
from codex_hook import read
from hook_epochs import AWAIT, guards
from ts_source import arguments, calls, functions, masked

HOOKS = paths.ROOT / "hooks"
STATE_PARTS = r"(?:tcr|outbox|liveWatchers|head|isPromptQueued|isTurnRunning)"
ALIAS = re.compile(r"\b(?:const|let|var)\s+([\w$]+)\s*=\s*state\s*(?:;|\n)")
NAMES_THE_SESSION = re.compile(r"\bepoch\b|\bstate\.tcr\s*(?:===|!==)\s*\w*tcr\b|\bisJudging\s*\(")
EXEMPT = {
    ("judgement.ts", "judgeTcr"): "the condition compares a counter that only grows, which no session lowers",
    ("tool-calls.ts", "startEditing"): "the condition looks up a symbol that only this call made, which no session holds",
    ("tool-calls.ts", "whileEditing"): "the condition looks up a symbol that only this call made, which no session holds",
}


def inspected(source: str) -> list[tuple[str, bool, bool, bool]]:
    """Each assert of source over the session's state, as (function, names the session, follows an await, has a guard of the session between the last await and itself)."""
    code = masked(source)
    found: list[tuple[str, bool, bool, bool]] = []
    for each in functions(code):
        body, text = code[each.start:each.end], source[each.start:each.end]
        names = "|".join(["state", *ALIAS.findall(body)])
        looks_at_the_session = re.compile(rf"(?:{names})\.{STATE_PARTS}")
        for opening in calls(body, "assert"):
            span = arguments(body, opening)[0]
            condition = text[span[0]:span[1]]
            if not looks_at_the_session.search(condition):
                continue
            last_await = max((match.start() for match in AWAIT.finditer(body[:opening])), default=-1)
            is_guarded = any(first > last_await and first <= opening < last for first, last in guards(body))
            found.append((each.name, bool(NAMES_THE_SESSION.search(condition)), last_await >= 0, is_guarded))
    return found


def unchecked(file: str, source: str) -> list[tuple[str, str]]:
    """The functions of source with an assert over the session's state that follows an await with no guard of the session between them, as (file, function)."""
    return sorted({(file, name) for name, names_it, follows_await, is_guarded in inspected(source) if not names_it and follows_await and not is_guarded})


def counts() -> tuple[int, int, int]:
    """How many asserts over the session's state the hooks hold, how many of them name the session in their own condition, and how many follow an await without naming it."""
    every = [row for path in sorted(HOOKS.glob("*.ts")) for row in inspected(read(path))]
    return len(every), sum(1 for _, names_it, _, _ in every if names_it), sum(1 for _, names_it, follows_await, _ in every if not names_it and follows_await)


ASSERTS_OVER_THE_STATE, ASSERTS_NAMING_THE_SESSION, ASSERTS_AFTER_AN_AWAIT = 74, 20, 17


class EpochAssertTests(unittest.TestCase):
    def test_the_scan_reads_the_asserts_the_hooks_hold(self) -> None:
        """Each number is what the scan finds now. A change to a hook that adds or removes an assert over the state changes it: read the new assert, then set the literal to the number the failure prints."""
        self.assertEqual(counts(), (ASSERTS_OVER_THE_STATE, ASSERTS_NAMING_THE_SESSION, ASSERTS_AFTER_AN_AWAIT))

    def test_no_assert_over_the_state_of_a_session_follows_an_await_unchecked(self) -> None:
        found = [key for path in sorted(HOOKS.glob("*.ts")) for key in unchecked(path.name, read(path))]
        self.assertEqual([key for key in found if key not in EXEMPT], [], "an assert over the session's state follows an await; name the session in its condition")

    def test_every_exemption_names_a_function_that_still_holds_such_an_assert(self) -> None:
        found = {key for path in sorted(HOOKS.glob("*.ts")) for key in unchecked(path.name, read(path))}
        self.assertEqual(sorted(set(EXEMPT) - found), [], "an exemption names a function that no longer needs it")

    def test_the_scan_rejects_the_assert_that_failed_a_new_session(self) -> None:
        source = "async function f($, state) {\n  const { epoch } = state\n  try { return await g() } catch (error) {\n    await h()\n    pauseOnExpected($, state, error, epoch)\n    assert(state.tcr.status !== 'active', `x`)\n  }\n}"
        self.assertEqual(unchecked("x.ts", source), [("x.ts", "f")])
        source = "async function f($, state) {\n  const { epoch } = state\n  await g()\n  assert(state.tcr.status !== 'active', `x`)\n}"
        self.assertEqual(unchecked("x.ts", source), [("x.ts", "f")])

    def test_the_scan_rejects_an_assert_in_a_function_with_no_session_of_its_own(self) -> None:
        source = "async function f($,state){await g(); assert(state.tcr.status!=='active','x')}"
        self.assertEqual(unchecked("x.ts", source), [("x.ts", "f")])

    def test_the_scan_rejects_a_check_of_the_session_that_does_not_leave(self) -> None:
        source = "async function f($, state) {\n  const { epoch } = state\n  await g()\n  if (state.epoch !== epoch) {}\n  assert(state.tcr.status !== 'active', `x`)\n}"
        self.assertEqual(unchecked("x.ts", source), [("x.ts", "f")])

    def test_the_scan_rejects_an_assert_over_another_name_for_the_state(self) -> None:
        source = "async function f($, state) {\n  const s = state\n  await g()\n  assert(s.tcr.status !== 'active', `x`)\n}"
        self.assertEqual(unchecked("x.ts", source), [("x.ts", "f")])

    def test_the_scan_accepts_an_assert_that_names_the_session_or_follows_its_check(self) -> None:
        named = "async function f($, state) {\n  const { epoch } = state\n  await g()\n  assert(state.epoch !== epoch || state.tcr.status !== 'active', `x`)\n}"
        checked = "async function f($, state) {\n  const { epoch } = state\n  await g()\n  if (state.epoch !== epoch) return\n  assert(state.tcr.status !== 'active', `x`)\n}"
        self.assertEqual(unchecked("x.ts", named) + unchecked("x.ts", checked), [])


if __name__ == "__main__":
    unittest.main()
