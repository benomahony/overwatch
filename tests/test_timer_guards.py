"""Tests that every timer the plugin's hooks start with `$.clock.after` is accounted for: each one names the behavioural test that ends it, or is listed as a limit that no fake host steps.

A timer that fires after `stop()` and changes the state of the next session once left the gate off after a resume. The scan reads the source with the tokenizer of ts_source.py and lists each call by its file and its first argument; a call the list does not know fails, so a new timer must name its test. The scan compares how many calls each file and first argument has with the count GUARDS holds, so a second call under a key that has a test fails. It reads the declaration of each named test in tests/late-paths.test.ts and requires that its body calls the function that GUARDS names and holds an `expect(`; a test with the title and an empty body fails. What the test proves is in that test, which stops the session or ends the work and then looks at the timer, and each one fails when the line it covers is removed.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import re
import unittest
from typing import NamedTuple

import paths
from codex_hook import read
from ts_source import arguments, calls, masked

HOOKS = paths.ROOT / "hooks"
CALL = re.compile(r"\$\.clock\.after\(\s*(?P<delay>[^,]+),")
PINNING_TESTS = paths.ROOT / "tests" / "late-paths.test.ts"
NOT_STEPPED = "no fake host steps this timer"


class Guard(NamedTuple):
    test: str
    calls: int
    exercises: str


GUARDS = {
    ("delivery.ts", "QUIET_MS"): Guard("the end of a session cancels the timer that flushes its messages (stop)", 1, "stop"),
    ("quiet.ts", "QUIET_MS"): Guard("the end of a session cancels the quiet timer of each run (stop)", 1, "stop"),
    ("register.ts", "delay"): Guard("the timer that restarts a watcher does nothing once its session ended (restart)", 1, "restart"),
    ("register.ts", "0"): Guard(NOT_STEPPED, 1, ""),
    ("judgement.ts", "QUIET_MS"): Guard("the end of a session cancels the timer that starts the judgement of an edit (stop)", 1, "stop"),
    ("judgement.ts", "limit"): Guard(NOT_STEPPED, 2, ""),
    ("project.ts", "limit"): Guard("a read of the project's files cancels its limit when it ends (within)", 1, "within"),
    ("tcr.ts", "ms"): Guard("a question to the checkpoint command cancels its limit when it ends (runWithin)", 1, "fingerprintOf"),
    ("tcr.ts", "await limitOf($"): Guard("a check run for the judgement of an edit cancels its limit when it ends (runCheck)", 1, "runCheck"),
}
KEY = tuple[str, str]
ENDED_SESSION_TESTS = paths.ROOT / "tests" / "tcr-ended-session.test.ts"
FIRED_AFTER_THE_END = {
    ("judgement.ts", "limit"): Guard("a comparison of the files that outlasts its limit after its session ended pauses nothing of the next session", 1, "noteFilesBefore"),
}


def timers() -> list[tuple[KEY, int]]:
    """Each `$.clock.after` call of the hooks, with how many times its file and first argument occur."""
    found: dict[KEY, int] = {}
    for path in sorted(HOOKS.glob("*.ts")):
        for match in CALL.finditer(masked(read(path))):
            key = (path.name, match.group("delay").strip())
            found[key] = found.get(key, 0) + 1
    return sorted(found.items())


def unguarded(keys: list[KEY]) -> list[KEY]:
    """The timers among `keys` that GUARDS does not say how they end."""
    return [key for key in keys if key not in GUARDS]


def miscounted(found: list[tuple[KEY, int]]) -> list[tuple[KEY, int, int]]:
    """The timers of `found` whose number of calls is not the number GUARDS accounts for, with both numbers."""
    return [(key, count, GUARDS[key].calls) for key, count in found if key in GUARDS and count != GUARDS[key].calls]


def declared_tests(source: str) -> dict[str, str]:
    """The masked body of each `longTest` of `source`, by its title, which is read from the unmasked text."""
    code = masked(source)
    found: dict[str, str] = {}
    for opening in calls(code, "longTest"):
        title, body = arguments(code, opening)[:2]
        found[source[title[0]:title[1]].strip().strip("'\"").replace("\\'", "'")] = code[body[0]:body[1]]
    return found


def weak(body: str, exercises: str) -> list[str]:
    """What a test body lacks to prove a guard: a call of the function that it exercises, and an expectation."""
    lacks = [] if re.search(rf"(?<![\w$.]){re.escape(exercises)}\s*\(", body) else [f"a call of {exercises}"]
    return lacks + ([] if "expect(" in body else ["an expect("])


class TimerGuardTests(unittest.TestCase):
    def test_every_timer_names_its_test_or_is_a_limit(self) -> None:
        self.assertEqual(unguarded([key for key, _ in timers()]), [], "a timer of the hooks is not in GUARDS; name the test that ends it")

    def test_every_named_test_exists(self) -> None:
        source = read(PINNING_TESTS)
        held = declared_tests(source)
        missing = [(key, guard.test) for key, guard in GUARDS.items() if guard.test != NOT_STEPPED and guard.test not in held]
        self.assertEqual(missing, [], "GUARDS names a test that tests/late-paths.test.ts does not declare")
        empty = {guard.test: weak(held[guard.test], guard.exercises) for guard in GUARDS.values() if guard.test in held}
        self.assertEqual({test: lacks for test, lacks in empty.items() if lacks}, {}, "a named test does not exercise its guard or expect anything")

    def test_the_limit_of_the_comparison_is_fired_after_the_end_of_a_session_by_a_test_that_calls_it(self) -> None:
        held = declared_tests(read(ENDED_SESSION_TESTS))
        for key, guard in FIRED_AFTER_THE_END.items():
            self.assertIn(guard.test, held, f"{key} names a test that tests/tcr-ended-session.test.ts does not declare")
            self.assertEqual(weak(held[guard.test], guard.exercises), [], f"the test of {key} does not call {guard.exercises} or expect anything")
            self.assertLessEqual(guard.calls, GUARDS[key].calls, f"{key} has fewer timers than the one the test fires and the watchdog no fake host fires")

    def test_every_timer_has_as_many_calls_as_its_guard_accounts_for(self) -> None:
        self.assertEqual(miscounted(timers()), [], "a file has more or fewer `$.clock.after` calls under a key than GUARDS accounts for; name the test of each call")

    def test_every_guard_names_a_timer(self) -> None:
        unused = [known for known in GUARDS if known not in {key for key, _ in timers()}]
        self.assertEqual(unused, [], "GUARDS names a timer the hooks no longer start")

    def test_the_scan_finds_the_timer_it_must_reject(self) -> None:
        source = masked("function f($) { state.late = $.clock.after(5, () => 1) }")
        found = [(HOOKS.name, match.group("delay")) for match in CALL.finditer(source)]
        self.assertEqual(unguarded(found), [("hooks", "5")])

    def test_the_scan_rejects_a_second_call_and_a_test_with_an_empty_body(self) -> None:
        key = ("delivery.ts", "QUIET_MS")
        self.assertEqual(miscounted([(key, 2)]), [(key, 2, 1)])
        held = declared_tests("longTest('a title (stop)', async () => {})\nlongTest('b (stop)', async () => { await stop($, state); expect(1).toBe(1) })")
        self.assertEqual(weak(held["a title (stop)"], "stop"), ["a call of stop", "an expect("])
        self.assertEqual(weak(held["b (stop)"], "stop"), [])

    def test_the_scan_finds_every_timer_the_hooks_start(self) -> None:
        self.assertEqual(sum(count for _, count in timers()), sum(read(path).count("$.clock.after(") for path in HOOKS.glob("*.ts")))


if __name__ == "__main__":
    unittest.main()
