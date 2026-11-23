"""Thirty realistic checks and the texts the upstream message builders write for them, as main wrote them, so that a change to the builders shows where it changes text a real check holds.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

from pathlib import Path

import messages
from records import First, Report

LONG_TEST_ID = "tests/test_matrix.py::test_cell[" + "-".join(f"parameter{number}" for number in range(30)) + "]"
CHECKS = (
    ("pytest", "python", "pytest -q --testmon", None, "=== 2 failed, 10 passed in 0.52s ===", ("tests/test_a.py::test_x", "tests/test_b.py::test_y[a-b]")),
    ("pytest", "python", "python3 -m pytest tests", "services/api", "=== 1 failed in 0.01s ===", ("tests/test_a.py::test_x",)),
    ("go", "go", "go test ./...", None, "FAIL\texample.com/pkg\t0.004s", ("TestAdd", "TestSub/negative")),
    ("jest", "javascript", "npx jest --ci", "web", "Tests:       1 failed, 4 passed, 5 total", ("renders the title", "adds 2 + 2")),
    ("cargo", "rust", "cargo test --workspace", None, "test result: FAILED. 3 passed; 1 failed; 0 ignored", ("tests::adds",)),
    ("echo", "shell", "echo `date`", None, "1 failed", ()),
    ("tab", "shell", "printf 'a\tb' | sh", None, "1 failed", ("a\tb",)),
    ("unicode", "python", "pytest tests/test_ünï.py", "módulo/ü", "=== 1 failed in 0.1s ===", ("tests/test_ünï.py::test_日本語",)),
    ("long", "python", "pytest", None, "=== 1 failed in 0.1s ===", (LONG_TEST_ID,)),
    ("quotes", "shell", "sh -c \"test -f 'a b'\"", None, "exit 1", ()),
    ("backticks", "python", "pytest -k `echo x`", None, "=== 1 failed ===", ("test_`x`",)),
    ("many", "python", "pytest", None, "=== 14 failed in 3s ===", tuple(f"tests/test_m.py::test_{number}" for number in range(14))),
    ("zanity", "python", "zanity check .", None, "zanity: 3 errors, 1 warning", ("rule-a", "rule-b")),
    ("dotnet", "csharp", "dotnet test --no-build", "src/App.Tests", "Failed!  - Failed: 1, Passed: 9, Skipped: 0, Total: 10", ("App.Tests.CalcTests.Adds",)),
    ("maven", "java", "mvn -q test", None, "Tests run: 5, Failures: 1, Errors: 0, Skipped: 0", ("CalcTest.adds",)),
    ("make", "c", "make -j4 check", None, "make: *** [check] Error 2", ()),
    ("dir with space", "python", "pytest", "my project/api", "=== 1 failed ===", ("t",)),
    ("percent", "shell", "printf '%s\\n' 100%", None, "100% failed", ("100%",)),
    ("braces", "shell", "echo {a,b}", None, "{1} failed", ("{x}",)),
    ("colon", "python", "pytest -x", None, "FAILED tests/a.py::t - assert 1 == 2", ("tests/a.py::t",)),
    ("ruff", "python", "ruff check .", None, "Found 3 errors.", ()),
    ("mypy", "python", "mypy --strict src", None, "Found 2 errors in 1 file (checked 4 source files)", ()),
    ("tsc", "typescript", "npx tsc --noEmit", None, "Found 1 error.", ()),
    ("elixir", "elixir", "mix test", None, "1 test, 1 failure", ("test adds (CalcTest)",)),
    ("php", "php", "vendor/bin/phpunit", None, "FAILURES! Tests: 5, Assertions: 5, Failures: 1.", ("CalcTest::testAdds",)),
    ("swift", "swift", "swift test", None, "Executed 5 tests, with 1 failure (0 unexpected)", ("CalcTests.testAdds",)),
    ("ruby", "ruby", "bundle exec rspec", None, "5 examples, 1 failure", ("Calc adds",)),
    ("lua", "lua", "busted", "lua", "1 failure / 0 errors", ("calc adds",)),
    ("zig", "zig", "zig build test", None, "1 failed; 3 passed", ("test.adds",)),
    ("dash", "python", "pytest --maxfail=1 -p no:cacheprovider", None, "Build Summary: 1 failed", ("t-1",)),
)
LOG = Path("/data/logs/check.log")


def key_of(index: int, case: tuple[str, str, str, str | None, str, tuple[str, ...]]) -> str:
    """The key of a case in the goldens: its place and its name, since two checks may share a name."""
    return f"{index:02d} {case[0]}"


def report_of(case: tuple[str, str, str, str | None, str, tuple[str, ...]], *, environment: str | None = None, text: str = "took 87ms (limit: 50ms)") -> Report:
    name, language, command, directory, summary, failures = case
    return Report(name, language, command, directory, summary, True, failures, environment, text)


def messages_of(case: tuple[str, str, str, str | None, str, tuple[str, ...]]) -> dict[str, str]:
    """Each text of the nine upstream builders for the check: the names it fails, its directory, its failure as told after an edit and after a change made outside, its environment, a timing hint, the status line, the recovery and the reason that guards an action."""
    report = report_of(case)
    stuck = report_of(case, environment="the check cannot find its runner")
    logs = {messages.report_key(report): LOG}
    baseline = {messages.report_key(report): First(True, case[5][:1], "=== 1 failed ===")}
    return {
        "failing_line": messages.failing_line(list(report.failures)),
        "where": messages.where(report),
        "failure_message": messages.failure_message([report], baseline, logs),
        "failure_message outside": messages.failure_message([report], {}, logs, outside=True),
        "environment_message": messages.environment_message([stuck]),
        "timing_hint": messages.timing_hint(report),
        "failing_suffix": messages.failing_suffix(report.failures),
        "failure_status": messages.failure_status([report]),
        "recovery_message": messages.recovery_message((report,)),
        "gate_reason": messages.gate_reason([report]),
    }
