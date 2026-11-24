"""Tests that a file the engine reads and a person or another process can write, holding bytes that are not UTF-8, is a mistake the engine tells or a cache it rebuilds, never an uncaught UnicodeDecodeError; and that each read of such a file in the engine either sets how it decodes, catches the error, or is listed here with the reason it cannot receive foreign bytes.

The registry finds these shapes: read_text or open, by any receiver but os, called without errors=; getattr(anything, "read_text" or "open"); a reference to read_text that is not called on the spot (map(Path.read_text, names)); a .decode(...) with no errors rule, whatever bytes it is given (read_bytes, a file opened with 'rb', a pipe); str(data, encoding) with no errors rule; json.load or json.loads given the bytes of read_bytes, of a file opened with 'rb', or sys.stdin, which decode them strictly; sys.stdin.read, readline and readlines, and a for loop or comprehension over sys.stdin; fileinput.input and fileinput.FileInput with no errors rule and no binary mode; os.fdopen and TextIOWrapper with no errors rule; a process run with universal_newlines=True and no errors rule. errors=None counts as no rule. The names open, read_text, sys.stdin, json.load and json.loads are followed through `from ... import ... as`, a plain assignment and a with, and the open of a zip or tar archive, whose bytes nothing decodes, and webbrowser.open are no text read, as an open that only writes or appends is none. A scope with an except clause for UnicodeDecodeError, UnicodeError or ValueError passes.
A determined evasion still passes: a name for the function (`reader = getattr(module, name)` with a name built at run time, `operator.methodcaller("read_text")`), a read through a library that decodes inside (`tomllib.load`, `csv`, `subprocess.run(text=True)`), a decode of bytes held in a helper that is called from a scope with its own rule, and an except clause for ValueError in the scope that is no catch of this read. The check is for the shapes a developer writes without meaning to; it is no proof that no read can receive foreign bytes.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import ast
import unittest
from dataclasses import dataclass, field
from pathlib import Path

import paths
import discovery
import engine
import sessions
from checkpoint_repository import put_bytes
from codex_hook import CodexHook
from foreign_byte_evasions import EVASIONS
from engine_process import run_engine_on_strict_stdin, run_triage
from records import Session, State

ENGINE = paths.ROOT / "engine"
NOT_UTF_8 = b"\xff\xfe{ not utf-8"
READ_TEXT, READ_BYTES, DECODE = "read_text", "read_bytes", "decode"
READS = frozenset({READ_TEXT, "open", "fdopen"})
STDIN_READS = frozenset({"read", "readline", "readlines"})
STDIN_CONSUMERS = frozenset({"list", "tuple", "set", "sorted", "next", "iter", "print", "copyfileobj", "enumerate"})
PROCESS_FUNCTIONS = frozenset({"run", "Popen", "check_output", "check_call", "call"})
MODE_AFTER_THE_FIRST_FOR = frozenset({"io", "os"})
ERRORS_POSITION_OF_WRAPPER = 2
JSON_LOADERS = frozenset({"load", "loads"})
ARCHIVE_CLASSES = frozenset({"ZipFile", "TarFile"})
OPENER_MODULES_OF_NO_TEXT = frozenset({"os", "tarfile", "webbrowser"})
FILE_INPUT_FUNCTIONS = frozenset({"input", "FileInput"})
IMPORTED_READS = frozenset({("io", "open"), ("builtins", "open"), ("os", "fdopen")})
NOT_A_TEXT_READ_MODES = "bwax"
ALIAS_PASSES = 2
ERRORS_POSITION_OF_DECODE, ERRORS_POSITION_OF_STR = 1, 2
CATCHING = frozenset({"UnicodeDecodeError", "ValueError", "UnicodeError"})
READS_THAT_CANNOT_RECEIVE_FOREIGN_BYTES = {
    ("discovery", "<module>"): "watchers.json is the plugin's own table, installed with the engine and never written by a person or a project",
    ("sessions", "write_log"): "the log was written by the same call from a check's output, which running.py decodes with errors='replace'",
}

READS_LEFT_AS_THEY_ARE = {
    ("engine", "read_event"): "stdin decodes strictly where the locale says so and the handler names JSONDecodeError and OSError only, so a UnicodeDecodeError ends in main's ValueError handler: a visible message with exit 0; upstream behaviour, pinned below",
}


FLAGGED_READS = {
    "a bare read_text": "def f(path):\n    return path.read_text()\n",
    "a strict read_text": "def f(path):\n    return path.read_text(encoding='utf-8')\n",
    "a bare open": "def f(path):\n    return open(path).read()\n",
    "a method open": "def f(path):\n    return path.open().read()\n",
    "an io open": "import io\ndef f(path):\n    return io.open(path).read()\n",
    "a getattr of read_text": "def f(path):\n    return getattr(path, 'read_text')()\n",
    "a getattr of open": "def f(path):\n    return getattr(path, 'open')().read()\n",
    "a getattr kept in a name": "def f(path):\n    read = getattr(path, 'read_text')\n    return read()\n",
    "a reference to read_text": "def f(paths):\n    return list(map(Path.read_text, paths))\n",
    "a decode after read_bytes": "def f(path):\n    return path.read_bytes().decode()\n",
    "a decode with an encoding only": "def f(path):\n    return path.read_bytes().decode('utf-8')\n",
    "a decode with the encoding by keyword": "def f(path):\n    return path.read_bytes().decode(encoding='utf-8')\n",
    "a decode after a binary open": "def f(path):\n    with open(path, 'rb') as handle:\n        return handle.read().decode()\n",
    "a decode of bytes kept in a name": "def f(path):\n    data = path.read_bytes()\n    return data.decode()\n",
    "a str of bytes": "def f(path):\n    return str(path.read_bytes(), 'utf-8')\n",
    "json.loads of read_bytes": "import json\ndef f(path):\n    return json.loads(path.read_bytes())\n",
    "json.load of a binary open": "import json\ndef f(path):\n    return json.load(open(path, 'rb'))\n",
    "json.load of stdin": "import json, sys\ndef f():\n    return json.load(sys.stdin)\n",
    "a read of stdin": "import sys\ndef f():\n    return sys.stdin.read()\n",
    "a readline of stdin": "import sys\ndef f():\n    return sys.stdin.readline()\n",
    "an fdopen read": "import os\ndef f(fd):\n    return os.fdopen(fd).read()\n",
    "a text wrapper over a raw stream": "import io\ndef f(raw):\n    return io.TextIOWrapper(raw).read()\n",
    "a text wrapper named without its module": "from io import TextIOWrapper\ndef f(raw):\n    return TextIOWrapper(raw, 'utf-8').read()\n",
    "a process run with universal_newlines": "import subprocess\ndef f():\n    return subprocess.run(['ls'], capture_output=True, universal_newlines=True).stdout\n",
    "a read at module level": "import json\nTABLE = json.loads(open('x').read())\n",
    "read_text with errors=None": "def f(path):\n    return path.read_text(errors=None)\n",
    "a decode with errors=None": "def f(path):\n    return path.read_bytes().decode(errors=None)\n",
    "a decode with None by position": "def f(path):\n    return path.read_bytes().decode('utf-8', None)\n",
    "a text wrapper with None by position": "import io\ndef f(raw):\n    return io.TextIOWrapper(raw, 'utf-8', None).read()\n",
    "a process with universal_newlines and errors=None": "import subprocess\ndef f():\n    return subprocess.run(['ls'], universal_newlines=True, errors=None).stdout\n",
    "an open imported under another name": "from io import open as o\ndef f(path):\n    return o(path).read()\n",
    "an open given another name": "o = open\ndef f(path):\n    return o(path).read()\n",
    "an io open given another name": "import io\no = io.open\ndef f(path):\n    return o(path).read()\n",
    "functools.partial of open": "import functools\ndef f(path):\n    return functools.partial(open, path)()\n",
    "partial of open named without its module": "from functools import partial\ndef f(path):\n    return partial(open, path)().read()\n",
    "partial of read_text": "from functools import partial\ndef f(path):\n    return partial(path.read_text)()\n",
    "input": "def f():\n    return input()\n",
    "a read of stdin imported by name": "from sys import stdin\ndef f():\n    return stdin.read()\n",
    "json.load of stdin imported by name": "import json\nfrom sys import stdin\ndef f():\n    return json.load(stdin)\n",
    "a read of stdin kept in a name": "import sys\ndef f():\n    s = sys.stdin\n    return s.read()\n",
    "a process with universal_newlines=1": "import subprocess\ndef f():\n    return subprocess.run(['ls'], capture_output=True, universal_newlines=1).stdout\n",
    "loads imported by name, given bytes": "from json import loads\ndef f(path):\n    return loads(path.read_bytes())\n",
    "loads imported under another name, given bytes": "from json import loads as parse\ndef f(path):\n    return parse(path.read_bytes())\n",
    "loads given another name, given bytes": "import json\nparse = json.loads\ndef f(path):\n    return parse(path.read_bytes())\n",
    "a str of bytes with the encoding by keyword": "def f(path):\n    return str(path.read_bytes(), encoding='utf-8')\n",
    "an open for reading": "def f(path):\n    return path.open('r').read()\n",
    "an open for reading and writing": "def f(path):\n    return open(path, 'r+').read()\n",
    "a for loop over stdin": "import sys\ndef f():\n    for line in sys.stdin:\n        print(line)\n",
    "a comprehension over stdin": "import sys\ndef f():\n    return [line for line in sys.stdin]\n",
    "a for loop over stdin kept in a name": "import sys\ndef f():\n    s = sys.stdin\n    for line in s:\n        print(line)\n",
    "a list of stdin": "import sys\ndef f():\n    return list(sys.stdin)\n",
    "a next of an iter of stdin": "import sys\ndef f():\n    return next(iter(sys.stdin))\n",
    "a print of the lines of stdin": "import sys\ndef f():\n    print(*sys.stdin)\n",
    "a copy of stdin by copyfileobj": "import shutil, sys\ndef f(out):\n    shutil.copyfileobj(sys.stdin, out)\n",
    "a sorted of stdin kept in a name": "import sys\ndef f():\n    s = sys.stdin\n    return sorted(s)\n",
    "fileinput.input": "import fileinput\ndef f():\n    return list(fileinput.input())\n",
    "fileinput.FileInput": "import fileinput\ndef f(names):\n    return fileinput.FileInput(names)\n",
    "an open of a file that is not an archive, beside an archive": "import zipfile\ndef f(path, archive):\n    with zipfile.ZipFile(archive) as z:\n        z.read('a')\n    return path.open().read()\n",
}


RULED_READS = {
    "an errors rule": "def f(path):\n    return path.read_text(errors='replace')\n",
    "a decode with errors": "def f(path):\n    return path.read_bytes().decode(errors='replace')\n",
    "a decode with errors by position": "def f(path):\n    return path.read_bytes().decode('utf-8', 'surrogateescape')\n",
    "a str with errors": "def f(path):\n    return str(path.read_bytes(), 'utf-8', 'replace')\n",
    "a binary read that is never decoded": "def f(path):\n    return open(path, 'rb').read()\n",
    "a read that catches": "def f(path):\n    try:\n        return path.read_text()\n    except UnicodeDecodeError:\n        return ''\n",
    "a decode that catches": "def f(path):\n    try:\n        return path.read_bytes().decode()\n    except ValueError:\n        return ''\n",
    "an fdopen in a binary mode": "import os\ndef f(fd):\n    return os.fdopen(fd, 'rb').read()\n",
    "an fdopen with errors": "import os\ndef f(fd):\n    return os.fdopen(fd, errors='replace').read()\n",
    "a text wrapper with errors": "import io\ndef f(raw):\n    return io.TextIOWrapper(raw, 'utf-8', 'replace').read()\n",
    "a text wrapper with errors by keyword": "import io\ndef f(raw):\n    return io.TextIOWrapper(raw, errors='replace').read()\n",
    "stdin read as bytes": "import sys\ndef f():\n    return sys.stdin.buffer.read()\n",
    "a process run with universal_newlines and errors": "import subprocess\ndef f():\n    return subprocess.run(['ls'], universal_newlines=True, errors='replace').stdout\n",
    "a process run in bytes": "import subprocess\ndef f():\n    return subprocess.run(['ls'], capture_output=True).stdout\n",
    "os.open": "import os\ndef f(path):\n    return os.open(path, os.O_RDONLY)\n",
    "json of a text read with a rule": "import json\ndef f(path):\n    return json.loads(path.read_text(errors='replace'))\n",
    "an open for writing": "def f(path):\n    return open(path, 'w')\n",
    "an open for writing by keyword": "def f(path):\n    return open(path, mode='w')\n",
    "a method open for appending": "def f(path):\n    return path.open('a')\n",
    "a method open for appending by keyword": "def f(path):\n    return path.open(mode='a')\n",
    "an open for exclusive creation": "def f(path):\n    return open(path, 'x')\n",
    "an open of a member of a zip archive": "import zipfile\ndef f(archive):\n    with zipfile.ZipFile(archive) as z:\n        return z.open('notes').read()\n",
    "an open of a member of an archive kept in a name": "from zipfile import ZipFile\ndef f(archive):\n    z = ZipFile(archive)\n    return z.open('notes').read()\n",
    "an open of a member of a tar archive": "import tarfile\ndef f(archive):\n    t = tarfile.open(archive)\n    return t.open('notes')\n",
    "an errors rule given beside None elsewhere": "def f(path):\n    return path.read_text(errors='strict')\n",
    "a text wrapper with errors given by position": "import io\ndef f(raw):\n    return io.TextIOWrapper(raw, 'utf-8', 'replace').read()\n",
    "an open under another name for writing": "from io import open as o\ndef f(path):\n    return o(path, 'w')\n",
    "a partial of open for writing": "from functools import partial\ndef f(path):\n    return partial(open, path, 'w')()\n",
    "a partial of open with errors": "from functools import partial\ndef f(path):\n    return partial(open, path, errors='replace')()\n",
    "an input read where the scope catches": "def f():\n    try:\n        return input()\n    except UnicodeDecodeError:\n        return ''\n",
    "fileinput.input with an errors rule": "import fileinput\ndef f():\n    return list(fileinput.input(errors='replace'))\n",
    "fileinput.input in a binary mode": "import fileinput\ndef f():\n    return list(fileinput.input(mode='rb'))\n",
    "webbrowser.open": "import webbrowser\ndef f(url):\n    return webbrowser.open(url)\n",
    "a for loop over a list": "def f(items):\n    for item in items:\n        print(item)\n",
    "a for loop over stdin that catches": "import sys\ndef f():\n    try:\n        for line in sys.stdin:\n            print(line)\n    except UnicodeDecodeError:\n        return ''\n",
    "a process with universal_newlines=0": "import subprocess\ndef f():\n    return subprocess.run(['ls'], universal_newlines=0).stdout\n",
}


@dataclass
class Aliases:
    """The names of a module that stand for what the registry looks for: open, read_text and fdopen; sys.stdin; json.load and json.loads; a zip or tar archive, whose open gives bytes."""
    reads: set[str] = field(default_factory=set)
    stdin: set[str] = field(default_factory=set)
    json_loaders: set[str] = field(default_factory=set)
    archives: set[str] = field(default_factory=set)


def names_in(handler: ast.ExceptHandler) -> set[str]:
    """The names of the exception types an except clause catches."""
    caught = handler.type
    nodes = caught.elts if isinstance(caught, ast.Tuple) else [caught] if caught is not None else []
    return {node.id if isinstance(node, ast.Name) else node.attr for node in nodes if isinstance(node, ast.Name | ast.Attribute)}


def called_as(call: ast.Call) -> str:
    """The name a call is made by: the attribute of a method call, the name of a plain call."""
    function = call.func
    return function.attr if isinstance(function, ast.Attribute) else function.id if isinstance(function, ast.Name) else ""


def is_none(node: ast.expr) -> bool:
    """Whether node is the constant None."""
    return isinstance(node, ast.Constant) and node.value is None


def sets_errors(call: ast.Call, position: int | None = None) -> bool:
    """Whether a call gives an errors rule, by keyword or by the positional argument at position; errors=None is no rule."""
    given = [keyword.value for keyword in call.keywords if keyword.arg == "errors"]
    if given:
        return not is_none(given[0])
    return position is not None and len(call.args) > position and not is_none(call.args[position])


def is_binary_opener(function: ast.expr) -> bool:
    """Whether function is os.open, tarfile.open or webbrowser.open, which open a file descriptor, an archive or a page and decode nothing."""
    return isinstance(function, ast.Attribute) and function.attr == "open" and isinstance(function.value, ast.Name) and function.value.id in OPENER_MODULES_OF_NO_TEXT


def is_read_reference(node: ast.expr, aliases: Aliases) -> bool:
    """Whether node names open, read_text or fdopen, or a name given one, without calling it."""
    if isinstance(node, ast.Name):
        return node.id in READS or node.id in aliases.reads
    return isinstance(node, ast.Attribute) and node.attr in READS and not is_binary_opener(node) and not (isinstance(node.value, ast.Name) and node.value.id in aliases.archives)


def is_text_read(call: ast.Call, aliases: Aliases) -> bool:
    """Whether call reads a file as text by its default: read_text, or open under its own name or one it was given, which os.open and the open of an archive do not."""
    return is_read_reference(call.func, aliases)


def is_stdin(node: ast.AST, aliases: Aliases) -> bool:
    """Whether node is sys.stdin, or a name given it, whose text decodes strictly by the locale."""
    if isinstance(node, ast.Name):
        return node.id in aliases.stdin
    return isinstance(node, ast.Attribute) and node.attr == "stdin" and isinstance(node.value, ast.Name) and node.value.id == "sys"


def is_json_loader(function: ast.expr, aliases: Aliases) -> bool:
    """Whether function is json.load or json.loads, or a name given one."""
    if isinstance(function, ast.Name):
        return function.id in aliases.json_loaders
    return isinstance(function, ast.Attribute) and function.attr in JSON_LOADERS and isinstance(function.value, ast.Name) and function.value.id == "json"


def is_archive_call(node: ast.expr) -> bool:
    """Whether node opens a zip or tar archive, whose open gives bytes."""
    return isinstance(node, ast.Call) and (called_as(node) in ARCHIVE_CLASSES or (called_as(node) == "open" and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and node.func.value.id == "tarfile"))


def imported_aliases(node: ast.ImportFrom, aliases: Aliases) -> None:
    """Records the names that from-import gives to what the registry looks for."""
    for item in node.names:
        bound = item.asname or item.name
        if (node.module, item.name) in IMPORTED_READS:
            aliases.reads.add(bound)
        if (node.module, item.name) == ("sys", "stdin"):
            aliases.stdin.add(bound)
        if node.module == "json" and item.name in JSON_LOADERS:
            aliases.json_loaders.add(bound)


def assigned_aliases(node: ast.AST, aliases: Aliases) -> None:
    """Records the names that an assignment or a with gives to what the registry looks for."""
    pairs = [(target, node.value) for target in node.targets] if isinstance(node, ast.Assign) else [(item.optional_vars, item.context_expr) for item in node.items if item.optional_vars is not None] if isinstance(node, ast.With) else []
    for target, value in pairs:
        if not isinstance(target, ast.Name):
            continue
        if is_read_reference(value, aliases):
            aliases.reads.add(target.id)
        if is_stdin(value, aliases):
            aliases.stdin.add(target.id)
        if isinstance(value, (ast.Name, ast.Attribute)) and is_json_loader(value, aliases):
            aliases.json_loaders.add(target.id)
        if is_archive_call(value):
            aliases.archives.add(target.id)


def aliases_of(tree: ast.Module) -> Aliases:
    """The names of tree that stand for what the registry looks for, found by its imports, its assignments and its withs."""
    aliases = Aliases()
    for _ in range(ALIAS_PASSES):
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                imported_aliases(node, aliases)
            assigned_aliases(node, aliases)
    assert all(name for names in (aliases.reads, aliases.stdin, aliases.json_loaders, aliases.archives) for name in names), f"{aliases} hold an empty name"
    return aliases


def is_indirect_read(call: ast.Call) -> bool:
    """Whether call is getattr(anything, "read_text" or "open"), which reaches the read by its name."""
    arguments = call.args
    return (isinstance(call.func, ast.Name) and call.func.id == "getattr" and len(arguments) >= 2
            and isinstance(arguments[1], ast.Constant) and arguments[1].value in READS)


def is_strict_decode(call: ast.Call) -> bool:
    """Whether call decodes bytes as UTF-8 and raises on a byte that is not: .decode(...) or str(data, encoding), the encoding given by position or keyword, with no errors rule."""
    function = call.func
    if isinstance(function, ast.Attribute) and function.attr == DECODE:
        return not sets_errors(call, ERRORS_POSITION_OF_DECODE)
    names_an_encoding = len(call.args) > 1 or any(keyword.arg == "encoding" for keyword in call.keywords)
    return isinstance(function, ast.Name) and function.id == "str" and names_an_encoding and not sets_errors(call, ERRORS_POSITION_OF_STR)


def mode_words(call: ast.Call) -> list[str]:
    """The mode a read is opened with, when it is a string written out, from the position after the file or by keyword."""
    receiver = call.func.value if isinstance(call.func, ast.Attribute) else None
    position = 1 if isinstance(call.func, ast.Name) or (isinstance(receiver, ast.Name) and receiver.id in MODE_AFTER_THE_FIRST_FOR) else 0
    keywords = {keyword.arg: keyword.value for keyword in call.keywords}
    return [node.value for node in [*call.args[position:position + 1], keywords.get("mode")] if isinstance(node, ast.Constant) and isinstance(node.value, str)]


def sets_decoding(call: ast.Call) -> bool:
    """Whether a read states how it decodes or reads nothing as text: an errors argument, a binary mode, or a mode that writes or appends."""
    return sets_errors(call) or any(set(mode) & set(NOT_A_TEXT_READ_MODES) for mode in mode_words(call))


def holds_binary_read(node: ast.AST, aliases: Aliases) -> bool:
    """Whether node reads bytes, by read_bytes or by a file opened in a binary mode."""
    if not isinstance(node, ast.Call):
        return False
    function = node.func
    if isinstance(function, ast.Attribute) and function.attr == READ_BYTES:
        return True
    return is_text_read(node, aliases) and any("b" in mode for mode in mode_words(node)) and not sets_errors(node)


def is_strict_json_load(call: ast.Call, aliases: Aliases) -> bool:
    """Whether call gives json.load or json.loads the bytes of a binary read, which they decode as UTF-8 and raise on a byte that is not."""
    return is_json_loader(call.func, aliases) and any(holds_binary_read(inner, aliases) or is_stdin(inner, aliases) for argument in call.args for inner in ast.walk(argument))


def is_stdin_read(call: ast.Call, aliases: Aliases) -> bool:
    """Whether call reads text from sys.stdin: .read(), readline() or readlines() of it, or input()."""
    function = call.func
    return (isinstance(function, ast.Attribute) and function.attr in STDIN_READS and is_stdin(function.value, aliases)) or (isinstance(function, ast.Name) and function.id == "input")


def is_file_input(call: ast.Call) -> bool:
    """Whether call is fileinput.input or fileinput.FileInput, which read the files named, or stdin, as text by the locale unless an errors rule or a binary mode is given."""
    function = call.func
    return (isinstance(function, ast.Attribute) and function.attr in FILE_INPUT_FUNCTIONS and isinstance(function.value, ast.Name) and function.value.id == "fileinput"
            and not sets_decoding(call))


def is_stdin_iteration(node: ast.AST, aliases: Aliases) -> bool:
    """Whether node is a for loop or a comprehension over sys.stdin, which reads its lines as text by the locale."""
    return isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)) and is_stdin(node.iter, aliases)


def is_stdin_consumer(node: ast.AST, aliases: Aliases) -> bool:
    """Whether node is a call of list, tuple, set, sorted, next, iter, print, enumerate or copyfileobj that is given sys.stdin, itself or starred, which reads its lines as text by the locale."""
    if not isinstance(node, ast.Call) or called_as(node) not in STDIN_CONSUMERS:
        return False
    given = [argument.value if isinstance(argument, ast.Starred) else argument for argument in node.args]
    assert len(given) == len(node.args), f"the arguments {node.args} lost one while the stars were taken off"
    return any(is_stdin(argument, aliases) for argument in given)


def is_text_wrapper(call: ast.Call) -> bool:
    """Whether call is TextIOWrapper(...), by any receiver, that sets no errors rule."""
    return called_as(call) == "TextIOWrapper" and not sets_errors(call, ERRORS_POSITION_OF_WRAPPER)


def is_universal_newlines_process(call: ast.Call) -> bool:
    """Whether call runs a process with universal_newlines set to a true constant, which decodes its output strictly, and sets no errors rule."""
    universal = any(keyword.arg == "universal_newlines" and isinstance(keyword.value, ast.Constant) and bool(keyword.value.value) for keyword in call.keywords)
    return called_as(call) in PROCESS_FUNCTIONS and universal and not sets_errors(call)


def is_partial_read(call: ast.Call, aliases: Aliases) -> bool:
    """Whether call is functools.partial of a read, whose later call reads with the default rule unless the partial sets one."""
    if called_as(call) != "partial" or not call.args or not is_read_reference(call.args[0], aliases):
        return False
    bound = ast.Call(func=call.args[0], args=call.args[1:], keywords=call.keywords)
    return not sets_decoding(bound)


def is_loose_reference(node: ast.AST, called: set[int]) -> bool:
    """Whether node names read_text without calling it where it stands, as in map(Path.read_text, names)."""
    return isinstance(node, ast.Attribute) and node.attr == READ_TEXT and id(node) not in called


def scopes_of(tree: ast.Module) -> list[tuple[str, list[ast.AST]]]:
    """Each function of tree with the nodes it holds, and the module with the nodes that sit in no function."""
    functions = [node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)]
    inside = {id(node) for function in functions for node in ast.walk(function)}
    scopes = [(function.name, list(ast.walk(function))) for function in functions]
    scopes.append(("<module>", [node for node in ast.walk(tree) if id(node) not in inside]))
    assert len(scopes) == len(functions) + 1, f"{len(scopes)} scopes were made for {len(functions)} functions and a module"
    return scopes


def is_unruled_call(node: ast.AST, aliases: Aliases) -> bool:
    """Whether node is a call that reads or decodes with the default rule: a text read, a getattr of one, a partial of one, a strict decode or a strict json load, a read of stdin, a text wrapper, or a process that decodes."""
    if not isinstance(node, ast.Call):
        return False
    text_read = is_text_read(node, aliases) and not sets_decoding(node)
    return (text_read or is_indirect_read(node) or is_partial_read(node, aliases) or is_strict_decode(node) or is_strict_json_load(node, aliases)
            or is_stdin_read(node, aliases) or is_file_input(node) or is_text_wrapper(node) or is_universal_newlines_process(node))


def unruled_reads(nodes: list[ast.AST], aliases: Aliases) -> list[ast.AST]:
    """The nodes of one scope that read or decode with the default rule."""
    called = {id(node.func) for node in nodes if isinstance(node, ast.Call)}
    return [node for node in nodes if is_unruled_call(node, aliases) or is_loose_reference(node, called) or is_stdin_iteration(node, aliases) or is_stdin_consumer(node, aliases)]


def reads_without_decoding_rules(source: str, module: str) -> list[tuple[str, str]]:
    """Each read of a file in source, as (module, function), that sets no errors rule and sits where no except clause names UnicodeDecodeError or ValueError."""
    hits = []
    tree = ast.parse(source)
    aliases = aliases_of(tree)
    for name, nodes in scopes_of(tree):
        catches = set().union(*[names_in(node) for node in nodes if isinstance(node, ast.ExceptHandler)])
        hits.extend((module, name) for _ in unruled_reads(nodes, aliases) if not catches & CATCHING)
    assert module, "the hits name no module"
    return list(dict.fromkeys(hits))


def reads_of_the_engine() -> list[tuple[str, str]]:
    hits = []
    for path in sorted(ENGINE.glob("*.py")):
        hits.extend(reads_without_decoding_rules(path.read_text(), path.stem))
    assert hits or ENGINE.is_dir(), f"{ENGINE} is no directory"
    return hits


class ForeignBytesTests(CodexHook):
    def session(self) -> Session:
        """A session whose files are in the test's temporary directory, none written yet."""
        folder = Path(self.temporary.name)
        return Session(folder / "session.json", folder / "session.inventory.json", folder / "session.logs")

    def test_a_settings_file_that_is_not_utf_8_is_a_configuration_error_naming_the_file(self) -> None:
        put_bytes(self.cwd / ".overwatch.json", NOT_UTF_8)
        with self.assertRaisesRegex(discovery.ConfigurationError, "could not read .*overwatch.json"):
            discovery.read_override(self.cwd)

    def test_a_settings_file_that_is_not_utf_8_is_told_to_the_user_by_the_hook_and_blocks_nothing(self) -> None:
        put_bytes(self.cwd / ".overwatch.json", NOT_UTF_8)
        output, _ = self.call("SessionStart")
        self.assertIn("could not read", str(output["systemMessage"]))
        self.assertIn(".overwatch.json", str(output["systemMessage"]))

    def test_a_saved_state_that_is_not_utf_8_is_replaced_and_the_session_starts_afresh(self) -> None:
        session = self.session()
        put_bytes(session.state, NOT_UTF_8)
        self.assertEqual(sessions.load_state(session), State(), "a state of foreign bytes was not replaced by an empty one")

    def test_a_triage_inventory_that_is_not_utf_8_is_one_the_session_replaces(self) -> None:
        session = self.session()
        put_bytes(session.inventory, NOT_UTF_8)
        self.assertIsNone(engine.inventory_checks(session), "an inventory of foreign bytes was not told as replaced")

    def test_the_triage_command_names_an_inventory_that_is_not_utf_8_without_a_traceback(self) -> None:
        inventory = Path(self.temporary.name) / "inventory.json"
        put_bytes(inventory, NOT_UTF_8)
        result = run_triage(inventory)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("could not read baseline inventory", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_every_read_of_a_file_in_the_engine_decodes_by_a_rule_or_is_listed_with_its_reason(self) -> None:
        listed = {**READS_THAT_CANNOT_RECEIVE_FOREIGN_BYTES, **READS_LEFT_AS_THEY_ARE}
        unlisted = [hit for hit in reads_of_the_engine() if hit not in listed]
        self.assertEqual(unlisted, [], "a read of a file that sets no errors rule and catches no UnicodeDecodeError; set errors=, catch it, or list why it cannot receive foreign bytes")
        self.assertEqual([hit for hit in listed if hit not in reads_of_the_engine()], [], "a listed read is gone; remove it from the list")
        self.assertEqual([hit for hit, reason in listed.items() if not reason], [], "a listed read has no reason")

    def test_a_hook_event_that_is_not_utf_8_ends_in_the_entry_points_handler_as_a_visible_message_with_exit_zero(self) -> None:
        """The limit of read_event, which the README lists: it is upstream behaviour, and pinned so that a change to it is deliberate."""
        finished = run_engine_on_strict_stdin(NOT_UTF_8)
        self.assertEqual(finished.returncode, 0, "the engine no longer ends a hook event of foreign bytes with exit 0")
        self.assertIn(b"overwatch: unexpected error", finished.stdout, "the engine does not tell a hook event of foreign bytes as the unexpected error it is today")
        self.assertNotIn(b"Traceback", finished.stderr, "the engine ends a hook event of foreign bytes with a traceback")

    def test_the_check_finds_each_read_that_leaves_decoding_to_the_default_and_leaves_ruled_reads_alone(self) -> None:
        """Each way to read or decode with the default rule is found, and a read that sets errors, reads bytes it never decodes, or catches the error is not."""
        for label, source in FLAGGED_READS.items():
            with self.subTest(label):
                self.assertEqual(len(reads_without_decoding_rules(source, "case")), 1, f"the check misses {label}")
        for label, source in RULED_READS.items():
            with self.subTest(label):
                self.assertEqual(reads_without_decoding_rules(source, "case"), [], f"the check flags {label}")

    def test_the_registry_passes_the_evasions_that_are_its_limit(self) -> None:
        """Each evasion of the registry that the README lists as its limit passes it, and the README names the limits that are new; a bare read_text is still found, so the evasions pass for a reason."""
        evasions = EVASIONS
        for label, source in evasions.items():
            with self.subTest(label):
                self.assertEqual(reads_without_decoding_rules(source, "case"), [], f"the registry now sees {label}: take it out of the README's list and out of this test")
        self.assertEqual(reads_without_decoding_rules("def f(path):\n    return path.read_text()\n", "case"), [("case", "f")], "the registry misses a bare read_text, so the evasions above pass for no reason")

    def test_the_registry_takes_an_archive_opened_through_another_name_for_a_text_read_which_is_its_limit(self) -> None:
        source = "import zipfile\nopen_archive = zipfile.ZipFile\ndef f(archive):\n    z = open_archive(archive)\n    return z.open('notes').read()\n"
        self.assertEqual(reads_without_decoding_rules(source, "case"), [("case", "f")], "the registry now follows an archive through another name: take this test out and the limit with it")


if __name__ == "__main__":
    unittest.main()
