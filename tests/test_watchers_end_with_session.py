"""Tests that a plugin test which starts a session and gives the session a watcher that never stops on its own ends the session.

A watcher that is still running when its test ends calls the host after the test's environment is gone, and the runner counts that refused call as an extra failure of the file, now and then. Ending the session stops the watcher first. The scan reads each test of tests/*.test.ts with the tokenizer of ts_source.py. A test keeps a watcher running when its own `process.spawn` hook loops over `clock.sleep` or waits on a promise. A watcher that a fixture gives, as `tcrProject` or `gatingProject` do, is not read.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import re
import unittest

import paths
from codex_hook import read
from ts_source import arguments, calls, masked

TESTS = paths.ROOT / "tests"
TEST_FUNCTIONS = ("test", "longTest")
STARTS_SESSION = re.compile(r"\bsession\.start\(")
ENDS_SESSION = re.compile(r"\bsession\.end\(")
LOOPS = re.compile(r"\b(?:for|while)\s*\(")
SLEEPS = re.compile(r"\bclock\.sleep\(")
WAITS = re.compile(r"\bnew Promise\(")
SPAWN_HOOK = "'process.spawn'"
LEAST_FILES = 100
LEAST_TESTS = 500


def bodies_of_the_tests(source: str) -> list[tuple[str, str, str]]:
    """The title, the source and the masked source of the body of each `test` or `longTest` call of a file."""
    code = masked(source)
    found = []
    for name in TEST_FUNCTIONS:
        for opening in calls(code, name):
            spans = arguments(code, opening)
            if len(spans) >= 2:
                first, last = spans[0], spans[-1]
                found.append((source[first[0]:first[1]].strip()[:80], source[last[0]:last[1]], code[last[0]:last[1]]))
    return found


def keeps_a_watcher_running(body: str, code: str) -> bool:
    """Whether a `process.spawn` hook written in the test loops over `clock.sleep` or waits on a promise."""
    for opening in calls(code, "on"):
        spans = arguments(code, opening)
        if len(spans) >= 2 and body[spans[0][0]:spans[0][1]].strip() == SPAWN_HOOK:
            handler = code[spans[-1][0]:spans[-1][1]]
            if (LOOPS.search(handler) and SLEEPS.search(handler)) or WAITS.search(handler):
                return True
    return False


def unended(source: str) -> list[str]:
    """The titles of the tests of a file that start a session, keep a watcher running and never end the session."""
    return [title for title, body, code in bodies_of_the_tests(source) if STARTS_SESSION.search(code) and keeps_a_watcher_running(body, code) and not ENDS_SESSION.search(code)]


KEEPS_RUNNING_UNENDED = """
longTest('a watcher that runs for ever', async ($, on) => {
  on('process.spawn', async function* () {
    for (let second = 0; second < 3600; second++) {
      await clock.sleep(1000)
      yield { stream: 'stderr', text: '\\n' }
    }
    return { value: { code: 0, signal: null } }
  })
  await $.session.start(start)
})
"""
KEEPS_RUNNING_ENDED = KEEPS_RUNNING_UNENDED.replace("await $.session.start(start)", "await $.session.start(start)\n  await $.session.end(ending)")
WAITS_FOR_A_PROMISE_UNENDED = "test('a watcher that waits', async ($, on) => {\n  on('process.spawn', async function* () {\n    await new Promise(() => undefined)\n  })\n  await $.session.start(start)\n})\n"
EXITS_AT_ONCE = "test('a watcher that exits', async ($, on) => {\n  on('process.spawn', async function* () {\n    yield { stream: 'stderr', text: 'x' }\n    return { value: { code: 0, signal: null } }\n  })\n  await $.session.start(start)\n})\n"
STARTS_NO_SESSION = KEEPS_RUNNING_UNENDED.replace("  await $.session.start(start)\n", "")
IN_A_COMMENT = "test('a comment', async ($, on) => {\n  // on('process.spawn', loops over clock.sleep(1) for (;;)\n  await $.session.start(start)\n})\n"


class WatchersEndWithSessionTests(unittest.TestCase):
    def test_no_test_that_keeps_a_watcher_running_leaves_its_session_open(self) -> None:
        files = sorted(TESTS.glob("*.test.ts"))
        self.assertGreaterEqual(len(files), LEAST_FILES, f"only {len(files)} plugin test files were found")
        self.assertGreaterEqual(sum(len(bodies_of_the_tests(read(path))) for path in files), LEAST_TESTS, "the scan found too few tests to be reading each file")
        open_sessions = {path.name: unended(read(path)) for path in files}
        self.assertEqual({name: titles for name, titles in open_sessions.items() if titles}, {}, "a test starts a session, keeps a watcher running and does not end the session")

    def test_the_scan_finds_a_test_that_keeps_a_watcher_running_and_never_ends_the_session(self) -> None:
        self.assertEqual(len(unended(KEEPS_RUNNING_UNENDED)), 1, "a loop over clock.sleep with no end of the session was not found")
        self.assertEqual(len(unended(WAITS_FOR_A_PROMISE_UNENDED)), 1, "a promise that nothing resolves with no end of the session was not found")

    def test_the_scan_passes_a_test_that_ends_its_session_or_whose_watcher_stops_or_that_starts_none(self) -> None:
        for name, source in {"ends the session": KEEPS_RUNNING_ENDED, "exits at once": EXITS_AT_ONCE, "starts no session": STARTS_NO_SESSION, "holds only a comment": IN_A_COMMENT}.items():
            with self.subTest(name):
                self.assertEqual(unended(source), [], f"the scan flags a test that {name}")


if __name__ == "__main__":
    unittest.main()
