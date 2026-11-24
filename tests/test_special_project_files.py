"""Tests that a project file the engine reads, replaced by a pipe, a link to a pipe or a directory, is answered in bounded time with a message, and that every read of a file in the engine is made without blocking or is listed with the reason it cannot block.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import ast
import collections
import errno
import itertools
import os
import socket
import subprocess
import sys
import unittest
from collections.abc import Callable
from pathlib import Path

import paths
import discovery
from codex_hook import write
from tcr_hardening_case import HardeningCase
from test_tcr import EDITING

ENGINE = paths.ROOT / "engine"
READS = frozenset({"read_text", "read_bytes", "open", "copyfile", "file_digest"})
MODULE_READS = frozenset({("shutil", "copy"), ("shutil", "copy2"), ("shutil", "copytree"), ("fileinput", "input"), ("fileinput", "FileInput"), ("filecmp", "cmp"), ("filecmp", "cmpfiles")})
METHOD_CALLER = ("operator", "methodcaller")
NON_BLOCKING_OPENER = "open_without_blocking"
TRUSTED_OPEN = f"open(path, opener={NON_BLOCKING_OPENER})"
OVERRIDE = ".overwatch.json"
NOT_REGULAR = "is not a regular file"
READ_SECONDS = 20
PROJECT_FILES = [OVERRIDE, "pyproject.toml", "package.json", ".gitignore", "go.mod", "Cargo.toml"]
READ_OVERRIDE = "import sys; from pathlib import Path; import discovery; discovery.read_override(Path(sys.argv[1]))"
IS_COMMITTED = "import sys; from pathlib import Path; import workspace; print(workspace.is_committed(Path(sys.argv[1]), sys.argv[2], sys.argv[3]))"
SEQUENCE_NAME = "import sys; from pathlib import Path; import repository_state; print(repository_state.sequence_name(Path(sys.argv[1])))"
FINGERPRINT = "import sys; from pathlib import Path; import workspace; workspace.content_fingerprint(Path(sys.argv[1]), sys.argv[2:])"


UNFLAGGED = ("copy.copy(a)", "names.copy()", "operator.methodcaller('upper')", "from shutil import copy as duplicate\nduplicate(a, b)", "reader = path.read_text\nreader()", "getattr(path, name)()", "subprocess.run(['cat', path])", "p.copy(q)")


def make_link_to_pipe(path: Path) -> None:
    os.mkfifo(path.with_name(f"{path.name}.target"))
    os.symlink(f"{path.name}.target", path)


SPECIAL_FILES: dict[str, Callable[[Path], None]] = {"a pipe": os.mkfifo, "a link to a pipe": make_link_to_pipe, "a directory": Path.mkdir}

EXEMPT_READS: dict[tuple[str, str], tuple[int, str]] = {
    ("daemon", "serve"): (1, "opens the lock file of the data directory, which the engine creates"),
    ("discovery", "<module>"): (1, "reads watchers.json, a file of the plugin itself"),
    ("engine", "inventory_checks"): (1, "reads the inventory in the data directory, which the engine writes"),
    ("sessions", "locked"): (1, "opens the log directory in the data directory, which the engine creates"),
    ("sessions", "load_state"): (1, "reads the state file in the data directory, which the engine writes"),
    ("sessions", "write_log"): (1, "reads back the log it has just written in the data directory"),
    ("triage", "main"): (1, "reads the file named on the command line of a tool, not a project file"),
    ("unix", "open_without_blocking"): (1, "is the helper that opens with O_NONBLOCK"),
}


def name_of_read(node: ast.Call) -> str:
    """The name a call goes by, including the one getattr is given as a constant: getattr(path, "read_text")()."""
    if isinstance(node.func, ast.Call) and getattr(node.func.func, "id", "") == "getattr" and len(node.func.args) > 1 and isinstance(node.func.args[1], ast.Constant):
        return str(node.func.args[1].value)
    return node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", "")


def is_read_by_module(node: ast.Call) -> bool:
    """Whether the call is shutil.copy, copy2 or copytree, fileinput.input or FileInput, filecmp.cmp or cmpfiles, or operator.methodcaller given the name of a read as a constant."""
    function = node.func
    if not (isinstance(function, ast.Attribute) and isinstance(function.value, ast.Name)):
        return False
    pair = (function.value.id, function.attr)
    named_read = bool(node.args) and isinstance(node.args[0], ast.Constant) and node.args[0].value in READS
    return pair in MODULE_READS or (pair == METHOD_CALLER and named_read)


def opens_without_blocking(node: ast.Call) -> bool:
    """Whether the call passes the opener that opens with O_NONBLOCK; any other opener is not trusted."""
    return any(keyword.arg == "opener" and getattr(keyword.value, "id", "") == NON_BLOCKING_OPENER for keyword in node.keywords)


class ReadsOf(ast.NodeVisitor):
    """The calls to read_text, read_bytes, open, copyfile or file_digest without the non-blocking opener in one module, counted by the innermost function that makes them."""

    def __init__(self, module: str) -> None:
        self.module = module
        self.scopes = ["<module>"]
        self.found: collections.Counter[tuple[str, str]] = collections.Counter()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.scopes.append(node.name)
        self.generic_visit(node)
        self.scopes.pop()

    def visit_Call(self, node: ast.Call) -> None:
        if (name_of_read(node) in READS and not opens_without_blocking(node)) or is_read_by_module(node):
            self.found[(self.module, self.scopes[-1])] += 1
        self.generic_visit(node)


def blocking_reads() -> collections.Counter[tuple[str, str]]:
    """How many calls to read_text, read_bytes, open, copyfile or file_digest that do not pass open_without_blocking as the opener each (module, function) of engine/*.py makes."""
    found: collections.Counter[tuple[str, str]] = collections.Counter()
    for module in sorted(ENGINE.glob("*.py")):
        visitor = ReadsOf(module.stem)
        visitor.visit(ast.parse(module.read_text()))
        found += visitor.found
    return found


def reads_in(source: str) -> int:
    visitor = ReadsOf("module")
    visitor.visit(ast.parse(source))
    return sum(visitor.found.values())


def run_in_engine(program: str, root: Path, names: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, "-c", program, str(root), *names], capture_output=True, text=True, env={**os.environ, "PYTHONPATH": str(ENGINE)}, timeout=READ_SECONDS, check=False)


class SpecialProjectFileTests(HardeningCase):
    def replace_override_with(self, make: Callable[[Path], None]) -> None:
        (self.cwd / OVERRIDE).unlink()
        make(self.cwd / OVERRIDE)
        assert not (self.cwd / OVERRIDE).is_file(), f"{OVERRIDE} is still a regular file"

    def test_a_special_file_as_the_override_is_answered_in_bounded_time_at_the_start_and_in_the_middle_of_a_session(self) -> None:
        for (kind, make), event in itertools.product(SPECIAL_FILES.items(), ("SessionStart", "PostToolUse")):
            with self.subTest(kind=kind, event=event):
                self.setUp()
                self.start_a_python_project()
                self.replace_override_with(make)
                output = self.call_that_fails_on_a_hang(event, **EDITING)
                self.assertIn(NOT_REGULAR, str(output), f"{kind} at {event}: the hook did not say the override is no regular file: {output}")
            if self.hung:
                break

    def test_every_reader_of_a_project_file_answers_in_bounded_time_whatever_special_file_is_at_its_path(self) -> None:
        for kind, make in SPECIAL_FILES.items():
            for name in PROJECT_FILES:
                with self.subTest(kind=kind, file=name):
                    self.setUp()
                    make(self.cwd / name)
                    fingerprinted = self.fail_on_hang(lambda: run_in_engine(FINGERPRINT, self.cwd, [name]))
                    self.assertEqual(fingerprinted.returncode, 0, f"the fingerprint of {kind} named {name} failed: {fingerprinted.stderr[-300:]}")
                if self.hung:
                    break
            if self.hung:
                break
            with self.subTest(kind=kind, reader="read_override"):
                self.setUp()
                make(self.cwd / OVERRIDE)
                read = self.fail_on_hang(lambda: run_in_engine(READ_OVERRIDE, self.cwd, []))
                self.assertIn(NOT_REGULAR, read.stderr, f"reading {kind} as the override did not raise ConfigurationError: {read.stderr[-300:]}")
            if self.hung:
                break

    def override_error_with(self, prepare: Callable[[Path], None]) -> str:
        (self.cwd / OVERRIDE).unlink(missing_ok=True)
        prepare(self.cwd / OVERRIDE)
        with self.assertRaises(discovery.ConfigurationError) as raised:
            discovery.read_override(self.cwd)
        return str(raised.exception)

    def test_an_override_that_the_user_may_not_read_is_told_as_a_permission_error(self) -> None:
        def unreadable(path: Path) -> None:
            write(path, "{}")
            path.chmod(0)
        message = self.override_error_with(unreadable)
        self.assertEqual(message, f"could not read {self.cwd / OVERRIDE}: permission denied", "a file that cannot be read was told as invalid JSON")

    def test_an_override_that_is_a_socket_is_told_as_no_regular_file(self) -> None:
        def make_socket(path: Path) -> None:
            listener = socket.socket(socket.AF_UNIX)
            self.addCleanup(listener.close)
            listener.bind(str(path))
        self.assertIn(NOT_REGULAR, self.override_error_with(make_socket), "a socket was not told as no regular file")

    def test_an_override_that_is_a_link_that_loops_names_its_path_once(self) -> None:
        message = self.override_error_with(lambda path: os.symlink(path.name, path))
        self.assertEqual(message, f"could not read {self.cwd / OVERRIDE}: {os.strerror(errno.ELOOP)}", "a link that loops was told with its path twice, or without its cause")

    def test_an_override_with_invalid_json_keeps_its_message(self) -> None:
        message = self.override_error_with(lambda path: write(path, "{"))
        self.assertEqual(message, f"could not read {self.cwd / OVERRIDE}: Expecting property name enclosed in double quotes: line 1 column 2 (char 1); fix the JSON in it, which must be UTF-8 text")

    def replace_with_pipe_inside_git(self, relative: str) -> None:
        pipe = self.cwd / ".git" / relative
        pipe.parent.mkdir(parents=True, exist_ok=True)
        pipe.unlink(missing_ok=True)
        os.mkfifo(pipe)

    def test_a_pipe_in_place_of_the_reflog_is_answered_in_bounded_time_as_not_committed(self) -> None:
        write(self.cwd / "a.txt", "1\n")
        before = self.commit("one")
        write(self.cwd / "b.txt", "2\n")
        after = self.commit("two")
        self.replace_with_pipe_inside_git("logs/HEAD")
        answered = run_in_engine(IS_COMMITTED, self.cwd, [before, after])
        self.assertEqual(answered.stdout.strip(), "False", f"a pipe as the reflog was not answered as not committed: {answered.stderr[-300:]}")

    def test_a_pipe_in_place_of_the_sequence_todo_is_answered_in_bounded_time_as_an_unknown_sequence(self) -> None:
        self.replace_with_pipe_inside_git("sequencer/todo")
        answered = run_in_engine(SEQUENCE_NAME, self.cwd, [])
        self.assertEqual(answered.stdout.strip(), "cherry-pick or revert", f"a pipe as the todo was not answered as an unknown sequence: {answered.stderr[-300:]}")


class ReadScanTests(unittest.TestCase):
    def test_every_read_of_a_file_in_the_engine_that_may_block_is_listed_with_its_count_and_reason(self) -> None:
        listed = collections.Counter({read: count for read, (count, _) in EXEMPT_READS.items()})
        self.assertEqual(blocking_reads(), listed, "the reads that may block on a pipe are not the listed ones: open a new one without blocking, as read_regular_text does, and remove a listed one that is gone")
        self.assertEqual([read for read, (_, reason) in EXEMPT_READS.items() if not reason], [], "a listed read has no reason")

    def test_the_scan_flags_the_reads_it_must_and_trusts_only_the_non_blocking_opener(self) -> None:
        flagged = ("path.read_text()", "open(path)", "shutil.copyfile(a, b)", "hashlib.file_digest(handle, 'sha1')", "getattr(path, 'read_text')()", "open(path, opener=os.open)", "open(path, opener=any_callable)", "shutil.copy(a, b)", "shutil.copy2(a, b)", "shutil.copytree(a, b)", "fileinput.input(names)", "fileinput.FileInput(names)", "filecmp.cmp(a, b)", "filecmp.cmpfiles(a, b, names)", "operator.methodcaller('read_text')", "operator.methodcaller('open', 'rb')")
        for source in flagged:
            self.assertEqual(reads_in(source), 1, f"the scan does not flag {source}")
        self.assertEqual(reads_in(TRUSTED_OPEN), 0, f"the scan flags {TRUSTED_OPEN}")
        for source in UNFLAGGED:
            self.assertEqual(reads_in(source), 0, f"the scan flags {source}, which the README says it does not")
        self.assertEqual(reads_in("open(a)\nopen(b)"), 2, "the scan counts two reads of a function as one")


if __name__ == "__main__":
    unittest.main()
