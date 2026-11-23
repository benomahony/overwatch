"""Tests of what the engine's entry point does with an error the engine does not expect: the types it has always caught are told in a system message and exit 0, and every other bug fails with its traceback and a non-zero exit.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import builtins
import contextlib
import io
import json
import subprocess
import unittest
import unittest.mock

import paths
import engine
from engine_process import run_engine_that_fails_with

BUGS = (AssertionError("bug"), IndexError("empty"), RuntimeError("broken"), AttributeError("missing"), ZeroDivisionError("zero"),
        NameError("undefined"), LookupError("lookup"))
CAUGHT = (OSError("disk"), ValueError("value"), TypeError("type"), KeyError("key"))
CAUGHT_TYPES = (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError)
EVENT = json.dumps({"hook_event_name": "PostToolUse", "session_id": "s", "cwd": str(paths.ROOT)})


def builtin_error_types() -> list[type[Exception]]:
    """Every exception type of the builtins that a plain message builds, which the entry point can meet."""
    found = [value for value in vars(builtins).values() if isinstance(value, type) and issubclass(value, Exception)]
    plain = [kind for kind in found if not issubclass(kind, (UnicodeError, SyntaxError, StopIteration, ExceptionGroup))]
    assert plain, "no builtin exception type was found to try"
    assert all(issubclass(kind, Exception) for kind in plain), f"{plain} holds a type that is no Exception"
    return plain


class EntryPointTests(unittest.TestCase):
    def answer(self, error: Exception) -> tuple[dict[str, str], str]:
        stdout, stderr = io.StringIO(), io.StringIO()
        with (unittest.mock.patch("sys.stdin", io.StringIO(EVENT)), unittest.mock.patch.object(engine, "process_event", side_effect=error),
              contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr)):
            engine.main()
        return json.loads(stdout.getvalue()), stderr.getvalue()

    def test_a_bug_in_the_engine_exits_non_zero_and_writes_its_traceback_to_stderr_in_a_real_process(self) -> None:
        for bug in BUGS:
            with self.subTest(bug=type(bug).__name__):
                result = run_engine_that_fails_with(bug, EVENT)
                self.assertNotEqual(result.returncode, 0, f"a {type(bug).__name__} exited 0, which hosts do not show; let it propagate")
                self.assertIn("Traceback", result.stderr)
                self.assertIn(type(bug).__name__, result.stderr)
                self.assertEqual(result.stdout, "", "a bug printed a hook answer; print nothing and fail")

    def test_the_types_the_entry_point_has_always_caught_exit_zero_with_a_system_message_in_a_real_process(self) -> None:
        for error in CAUGHT:
            with self.subTest(error=type(error).__name__):
                result = run_engine_that_fails_with(error, EVENT)
                self.assertEqual(result.returncode, 0, f"a {type(error).__name__} no longer exits 0: {result.stderr[-200:]}")
                self.assertIn("overwatch: unexpected error", json.loads(result.stdout)["systemMessage"])
                self.assertIn(f"unexpected {type(error).__name__}", result.stderr)

    def test_an_error_the_engine_expects_is_still_told_the_same_way(self) -> None:
        for error in (OSError("disk"), subprocess.SubprocessError("git")):
            with self.subTest(error=type(error).__name__):
                output, stderr = self.answer(error)
                self.assertIn(f"overwatch: unexpected error: {error}", output["systemMessage"])
                self.assertIn(f"unexpected {type(error).__name__}: {error}", stderr)

    def test_every_builtin_error_type_is_either_told_and_exits_zero_or_propagates_by_the_caught_types_alone(self) -> None:
        for kind in builtin_error_types():
            with self.subTest(error=kind.__name__):
                if issubclass(kind, CAUGHT_TYPES):
                    output, _ = self.answer(kind("text"))
                    self.assertIn("systemMessage", output)
                else:
                    with self.assertRaises(kind, msg=f"a {kind.__name__} was caught, but it is no type the entry point catches"):
                        self.answer(kind("text"))


if __name__ == "__main__":
    unittest.main()
