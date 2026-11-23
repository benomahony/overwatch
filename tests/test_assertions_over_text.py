"""A test that no assert in the engine modules this change adds inspects text, which holds what the engine does not control (a repository path, a file or check name, git's output): such an assert raises on a correct run, after a side effect such as a revert, and replaces the answer.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

from paths import ROOT

ENGINE = ROOT / "engine"
MODULES_OF_THIS_CHANGE = ("bugs", "checkpoint", "checkpoint_git", "repository_state", "safe_text", "saved_revert", "secrets_guard", "tcr", "tcr_settings", "tcr_texts")
TEXT_METHODS = frozenset({"startswith", "endswith", "split", "rsplit", "splitlines", "count", "find", "rfind", "index", "rindex", "partition", "rpartition",
                          "strip", "lstrip", "rstrip", "removeprefix", "removesuffix", "lower", "upper", "casefold", "title", "swapcase", "replace", "translate",
                          "ljust", "rjust", "center", "zfill", "expandtabs", "format_map", "isalpha", "isdigit", "isalnum", "isspace"})
REGEX_FUNCTIONS = frozenset({"search", "match", "fullmatch", "findall", "finditer", "sub", "subn", "split"})
OPERATOR_FUNCTIONS = frozenset({"contains", "eq", "ne", "getitem", "countOf", "indexOf"})
EXTERNAL_TEXT_ATTRIBUTES = frozenset({"stdout", "stderr", "notices", "summary", "message", "reason"})
TEXT_PARAMETER_NAMES = frozenset({"reason", "text", "message", "notice", "summary", "line", "told"})
TEXT_ONLY_METHODS = frozenset({"startswith", "endswith", "splitlines", "strip", "lstrip", "rstrip", "removeprefix", "removesuffix", "lower", "upper", "casefold", "partition", "rpartition", "swapcase"})
NOT_TEXT_CALLS = frozenset({"len", "int", "float", "bool", "sum", "min", "max", "sorted", "list", "set", "tuple", "dict", "any", "all", "range", "enumerate", "zip", "isinstance", "round", "abs", "frozenset"})
EXTERNAL_TEXT_CALLS = frozenset({"str", "repr"})
EXTERNAL_TEXT_METHODS = frozenset({"read_text", "decode", "getvalue", "readline"})
TEXT_ANNOTATIONS = frozenset({"str", "str | None"})
BUILDING_METHODS = frozenset({"join", "format"})
TEXT_OPERATORS = (ast.Add, ast.Mod)
UPSTREAM_MODULES_NOT_SCANNED = ("daemon", "discovery", "engine", "gating", "messages", "reading", "records", "running", "sessions", "triage", "unix", "watching", "workspace")
TEMPLATE_REASON = "the sentence is a constant template of tcr_texts, written with the code, and not text the engine does not control; the assert runs before the template is formatted and fails at once when a template has no place for the names"
ALLOWED: dict[tuple[str, str, str], str] = {
    ("tcr_texts", "named_in", "'{names}' in sentence"): TEMPLATE_REASON,
}
PASSES_OVER_ASSIGNMENTS = 3
DUNDER = "__"


def classify_call(node: ast.Call) -> tuple[bool, list[ast.expr]]:
    """Whether a call makes text outright, and the parts whose textness decides it when it does not."""
    function = node.func
    if isinstance(function, ast.Name):
        return function.id in EXTERNAL_TEXT_CALLS, []
    if isinstance(function, ast.Attribute) and (function.attr in BUILDING_METHODS or function.attr in EXTERNAL_TEXT_METHODS):
        return True, []
    return False, [function.value] if isinstance(function, ast.Attribute) and function.attr in TEXT_METHODS else []


def classify_sum(node: ast.BinOp) -> tuple[bool, list[ast.expr]]:
    """Whether a + or % joins a string constant, which makes text, and the sides whose textness decides it otherwise."""
    if not isinstance(node.op, TEXT_OPERATORS):
        return False, []
    return any(isinstance(side, ast.Constant) and isinstance(side.value, str) for side in (node.left, node.right)), [node.left, node.right]


def classify(node: ast.expr, texts: set[str]) -> tuple[bool, list[ast.expr]]:
    """Whether node is text outright (an f-string, a name of a text, a text built by a call or a sum), and the parts whose textness decides it otherwise."""
    if isinstance(node, ast.JoinedStr):
        return True, []
    if isinstance(node, ast.Name):
        return node.id in texts, []
    if isinstance(node, ast.Call):
        return classify_call(node)
    if isinstance(node, ast.BinOp):
        return classify_sum(node)
    if isinstance(node, ast.Attribute):
        return node.attr in EXTERNAL_TEXT_ATTRIBUTES, []
    if isinstance(node, ast.Subscript):
        return False, [node.value]
    if isinstance(node, ast.NamedExpr):
        return False, [node.value]
    return (False, [node.body, node.orelse]) if isinstance(node, ast.IfExp) else (False, [])


def is_text(node: ast.expr, texts: set[str]) -> bool:
    """Whether node is text: a string put together at run time, a name holding one, or a string method's answer."""
    pending = [node]
    for current in pending:
        verdict, parts = classify(current, texts)
        if verdict:
            return True
        pending.extend(parts)
    return False


def target_names(target: ast.expr) -> list[str]:
    """The names a target binds, through a tuple or a list, and none that it only reads, as the x of x[0]."""
    return [node.id for node in ast.walk(target) if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store)]


def names_bound_from_text(node: ast.AST, texts: set[str]) -> list[str]:
    """The names that node binds to a text: by an assignment, a walrus, or a loop or comprehension over a text's pieces."""
    if isinstance(node, ast.Assign | ast.AugAssign | ast.AnnAssign) and node.value is not None and is_text(node.value, texts):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        return [name for target in targets for name in target_names(target)]
    if isinstance(node, ast.NamedExpr) and is_text(node.value, texts):
        return target_names(node.target)
    if isinstance(node, ast.For | ast.comprehension) and is_text(node.iter, texts):
        return target_names(node.target)
    return []


def texts_of(function: ast.FunctionDef) -> set[str]:
    """The names in function that hold text: parameters annotated as text or, without an annotation, named as a text is, and what is bound from text, by an assignment, a walrus, a loop or a comprehension over a text's pieces, or an unpacking."""
    arguments = [*function.args.args, *function.args.kwonlyargs]
    texts = {argument.arg for argument in arguments if (argument.annotation is not None and ast.unparse(argument.annotation) in TEXT_ANNOTATIONS) or (argument.annotation is None and argument.arg in TEXT_PARAMETER_NAMES)}
    for _ in range(PASSES_OVER_ASSIGNMENTS):
        for node in ast.walk(function):
            texts.update(names_bound_from_text(node, texts))
    assert all(texts), f"the names {texts} of texts include an empty one"
    return texts


def maybe_texts_of(function: ast.FunctionDef, texts: set[str]) -> set[str]:
    """The names in function bound from a call, an index or an attribute of an object, which may hold text though nothing says so: a method that only a text has, or a string looked for in one, flags an assert over them."""
    maybe: set[str] = set()
    for node in ast.walk(function):
        if isinstance(node, ast.Assign) and not is_text(node.value, texts):
            value = node.value
            from_a_call = isinstance(value, ast.Call) and called_function(value) not in NOT_TEXT_CALLS
            if from_a_call or isinstance(value, ast.Subscript | ast.Attribute):
                maybe.update(name for target in node.targets for name in target_names(target))
    return maybe - texts


def called_function(call: ast.Call) -> str:
    return call.func.id if isinstance(call.func, ast.Name) else call.func.attr if isinstance(call.func, ast.Attribute) else ""


def maybe_inspections(node: ast.AST, maybe: set[str]) -> list[str]:
    """What an assert does to a name that may hold text: calls a method only a text has on it, or looks for a string constant in it."""
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in TEXT_ONLY_METHODS and isinstance(node.func.value, ast.Name) and node.func.value.id in maybe:
        return [f".{node.func.attr}() of a name that may hold text"]
    if isinstance(node, ast.Compare) and isinstance(node.left, ast.Constant) and isinstance(node.left.value, str) and any(
            isinstance(operator, ast.In | ast.NotIn) and isinstance(side, ast.Name) and side.id in maybe for operator, side in zip(node.ops, node.comparators)):
        return ["a string looked for in a name that may hold text"]
    return []


def is_dunder(name: str) -> bool:
    return len(name) > len(DUNDER) * 2 and name.startswith(DUNDER) and name.endswith(DUNDER)


def method_inspections(node: ast.AST, texts: set[str]) -> list[str]:
    """What a call does to a text, as a name: a string method or a dunder method called on it or with it, a regular expression or an operator function applied to it; none for another node."""
    if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
        return []
    attribute, operand = node.func.attr, node.func.value
    arguments_are_text = any(is_text(argument, texts) for argument in node.args)
    if attribute in TEXT_METHODS and is_text(operand, texts):
        return [f".{attribute}()"]
    if is_dunder(attribute) and (is_text(operand, texts) or arguments_are_text):
        return [f".{attribute}()"]
    if attribute in REGEX_FUNCTIONS | OPERATOR_FUNCTIONS and arguments_are_text and not is_text(operand, texts):
        return [f".{attribute}(text)"]
    return []


def subscript_inspections(node: ast.AST, texts: set[str]) -> list[str]:
    """An index or a slice of a text."""
    return ["[]"] if isinstance(node, ast.Subscript) and is_text(node.value, texts) else []


def comparison_inspections(node: ast.AST, texts: set[str], built: set[str]) -> list[str]:
    """What a comparison does to text: looks for something in it, or compares a text built at run time with something but the empty text."""
    if not isinstance(node, ast.Compare):
        return []
    sides = [node.left, *node.comparators]
    looks_inside = any(isinstance(operator, ast.In | ast.NotIn) for operator in node.ops) and any(is_text(side, texts) for side in node.comparators)
    is_emptiness_check = any(isinstance(side, ast.Constant) and side.value == "" for side in sides)
    compares = any(isinstance(operator, ast.Eq | ast.NotEq) for operator in node.ops) and not is_emptiness_check and any(
        isinstance(side, ast.JoinedStr) or (isinstance(side, ast.Name) and side.id in built) for side in sides)
    return (["in"] if looks_inside else []) + (["=="] if compares else [])


def inspections(test: ast.expr, texts: set[str], built: set[str], maybe: set[str] | None = None) -> list[str]:
    """What an assert condition does to text: calls a string method on it, looks for something in it, or compares a text built at run time."""
    found = [name for node in ast.walk(test) for name in [*method_inspections(node, texts), *subscript_inspections(node, texts), *comparison_inspections(node, texts, built), *maybe_inspections(node, maybe or set())]]
    assert all(found), f"the inspections {found} include one with no name"
    return found


def asserts_over_text(source: str, module: str) -> list[tuple[str, str, str]]:
    """Each assert of source that inspects text, as (module, function, the condition)."""
    hits = []
    for function in ast.walk(ast.parse(source)):
        if isinstance(function, ast.FunctionDef):
            texts = texts_of(function)
            maybe = maybe_texts_of(function, texts)
            built = texts - {argument.arg for argument in [*function.args.args, *function.args.kwonlyargs]}
            hits.extend((module, function.name, ast.unparse(node.test)) for node in ast.walk(function) if isinstance(node, ast.Assert) and inspections(node.test, texts, built, maybe))
    assert module, "the hits name no module"
    return list(dict.fromkeys(hits))


def asserts_of_the_engine() -> list[tuple[str, str, str]]:
    hits = []
    for module in MODULES_OF_THIS_CHANGE:
        hits.extend(asserts_over_text((ENGINE / f"{module}.py").read_text(), module))
    assert Path(ENGINE / "tcr.py").is_file(), f"{ENGINE} holds no tcr.py"
    return hits


class AssertionsOverTextTests(unittest.TestCase):
    def test_no_assert_of_this_changes_modules_inspects_text_except_the_ones_listed_with_their_reason(self) -> None:
        unlisted = [hit for hit in asserts_of_the_engine() if hit not in ALLOWED]
        self.assertEqual(unlisted, [], f"{len(unlisted)} asserts inspect text; assert on the values the text is built from, never on the text")

    def test_the_modules_scanned_are_the_ones_of_this_change_and_each_other_module_is_listed_as_not_scanned(self) -> None:
        """Widening the scan is a deliberate act: a module added to the engine, or moved into the scan, changes one of the two lists."""
        modules = sorted(path.stem for path in ENGINE.glob("*.py"))
        self.assertEqual(sorted((*MODULES_OF_THIS_CHANGE, *UPSTREAM_MODULES_NOT_SCANNED)), modules, "the engine holds a module that is neither scanned nor listed as upstream code left alone")
        self.assertEqual(sorted(MODULES_OF_THIS_CHANGE), ["bugs", "checkpoint", "checkpoint_git", "repository_state", "safe_text", "saved_revert", "secrets_guard", "tcr", "tcr_settings", "tcr_texts"], "the modules scanned changed")

    def test_every_allowed_assert_still_exists_and_has_a_reason(self) -> None:
        self.assertEqual([hit for hit in ALLOWED if hit not in set(asserts_of_the_engine())], [], "an allowed assert is gone; remove it from the list")
        self.assertEqual([hit for hit, reason in ALLOWED.items() if not reason], [], "an allowed assert has no reason")

    def test_the_check_finds_each_way_to_inspect_text_and_leaves_asserts_over_values_alone(self) -> None:
        """Each shape that inspects a text, whatever makes the text, is found, and an assert over numbers, lists and paths is not."""
        flagged = {
            "in a built text": "def f(name):\n    notice = f'is {name}'\n    assert 'is on' in notice\n",
            "a method of a parameter": "def f(reason: str):\n    assert reason == reason.rstrip('.')\n",
            "a method of a joined text": "def f(names):\n    text = ', '.join(names)\n    assert text.count(',') == 1\n",
            "a text compared with an f-string": "def f(x):\n    assert f'{x}' == str(x)\n",
            "a text made by +": "def f(a):\n    text = 'x' + a\n    assert text.startswith('x')\n",
            "a slice of a text": "def f(reason: str):\n    head = reason[:3]\n    assert head.endswith('a')\n",
            "a dunder method": "def f(name):\n    notice = f'is {name}'\n    assert notice.__contains__('is')\n",
            "a dunder method called on the type": "def f(name):\n    notice = f'is {name}'\n    assert str.__contains__(notice, 'is')\n",
            "a slice compared with a constant": "def f(name):\n    notice = f'is {name}'\n    assert notice[:2] == 'is'\n",
            "an index of a text": "def f(name):\n    notice = 'is %s' % name\n    assert notice[0] == 'i'\n",
            "an index of a text from format": "def f(name):\n    notice = 'is {}'.format(name)\n    assert notice[-1]\n",
            "a regular expression search": "import re\ndef f(name):\n    notice = f'is {name}'\n    assert re.search('is', notice)\n",
            "a regular expression match": "import re\ndef f(name):\n    notice = 'is ' + name\n    assert re.match('is', notice)\n",
            "a regular expression full match": "import re\ndef f(name):\n    notice = f'is {name}'\n    assert re.fullmatch('is.*', notice)\n",
            "a compiled regular expression": "import re\nPATTERN = re.compile('is')\ndef f(name):\n    notice = f'is {name}'\n    assert PATTERN.search(notice)\n",
            "an operator function": "import operator\ndef f(name):\n    notice = f'is {name}'\n    assert operator.contains(notice, 'is')\n",
            "text from a file": "def f(path):\n    text = path.read_text()\n    assert text.find('x') >= 0\n",
            "text from a process": "def f(result):\n    text = result.stdout\n    assert text.index('x') >= 0\n",
            "text from str": "def f(error):\n    text = str(error)\n    assert text[0]\n",
            "text bound by a walrus": "def f(name):\n    assert (notice := f'is {name}').lower()\n",
            "a line of a text": "def f(name):\n    for line in f'is {name}'.splitlines():\n        assert line.upper()\n",
            "a string looked for in the first notice of a step": "def f(step):\n    assert 'nothing to revert' in step.notices[0]\n",
            "a method of a parameter named as a text, without an annotation": "def f(reason):\n    assert reason.startswith('x')\n",
            "a string looked for in the answer of a call": "def f(error):\n    told = describe(error)\n    assert 'X' in told\n",
            "a method of the summary of a report": "def f(report):\n    assert report.summary.endswith('.')\n",
            "a method of a piece of a list": "def f(parts):\n    notice = parts[0]\n    assert notice.startswith('x')\n",
            "a method of the answer of a call": "def f(root):\n    branch = run_git(root).strip()\n    assert branch.startswith('refs/heads/')\n",
            "a piece of a partition": "def f(name):\n    head, _, tail = f'is {name}'.partition(' ')\n    assert tail.casefold()\n",
        }
        for method in sorted(TEXT_METHODS):
            flagged[f"the method {method}"] = f"def f(name):\n    notice = f'is {{name}}'\n    assert notice.{method}()\n"
        for label, source in flagged.items():
            with self.subTest(label):
                self.assertEqual(len(asserts_over_text(source, "case")), 1, f"the check misses {label}")
        values = ("def f(x, files: list[str], saved: str | None, path):\n    assert x == 1\n    assert x in (1, 2)\n    assert len(files) > 1\n    assert saved is None or saved != ''\n"
                  "    assert all(files)\n    assert files[0]\n    assert path.is_absolute()\n    assert x.__class__ is int\n    assert files.index(x) >= 0\n"
                  "    names = sorted(files)\n    assert x in names\n    count = len(files)\n    assert count > 1\n    assert len(path.parts) > 1\n")
        self.assertEqual(asserts_over_text(values, "case"), [], "the check flags an assert over values")


if __name__ == "__main__":
    unittest.main()
