"""A reader of the plugin's TypeScript source for the tests that scan it: the source with its comments and the insides of its strings, templates and regular expressions blanked, so that a bracket or a keyword found in it is code; the functions it declares, and the calls it makes.

The plugin's tests may import nothing but their kit, so these scans read the source here, with a tokenizer and not a syntax tree.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import re
from dataclasses import dataclass

BLANK = "\x01"
REGEX_PRECEDERS = frozenset("(,=:[!&|?{};+-*%<>~^")
REGEX_KEYWORDS = ("return", "typeof", "case", "void", "throw", "yield", "await")
OPENERS = {"(": ")", "[": "]", "{": "}"}
CLOSERS = frozenset(OPENERS.values())
NOT_METHODS = frozenset({"async", "if", "for", "while", "switch", "catch", "function", "return", "with", "await", "typeof", "super", "import", "else", "do", "try", "new", "delete", "void", "throw", "yield", "assert"})
STRING = r"(?:'\x01*'|\"\x01*\"|`\x01*`)"
TEXT_NAMES = ("message", "text", "summary", "summaries", "notice", "reason", "line", "told")
TEXT_VARIABLES = rf"(?:{'|'.join(TEXT_NAMES)})"
TEXT_MARKS = re.compile(
    rf"\$\{{|\.(?:join|concat|replace|replaceAll|padStart|padEnd|repeat|toString)\s*\(|JSON\.stringify\s*\(|(?<![\w$.])String\s*\("
    rf"|[\w$\]\)]\s*\+=(?!\s*\d)|\+=\s*{STRING}|{STRING}\s*\+(?!=)|(?<![+])\+(?![+=])\s*{STRING}"
    rf"|(?<![\w$.]){TEXT_VARIABLES}\b\s*\+(?![+=])|(?<![+])\+(?![+=])\s*{TEXT_VARIABLES}\b"
    r"|\.reduce\s*\(\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*=>\s*\1\s*\+\s*\2\s*\)"
)
NOT_NOTICE_TEXT = ("assert", "new CommandError", "new Error")
CONTINUING_START = re.compile(r"[?:.+\-*&|)\]},=<>%^]|/(?![/*])")
CONTINUING_END = re.compile(r"[=>+\-*/&|?:,(\[<%^]$")


def masked(source: str) -> str:
    """source with the same length and line breaks, and its comments and the insides of its strings, template texts and regular expressions blanked."""
    return Masker(source).run()[0]


def scanned(source: str) -> tuple[str, list[tuple[int, int]]]:
    """The masked source, and the span of the text of each string and of each piece of a template."""
    return Masker(source).run()


class Masker:
    def __init__(self, source: str) -> None:
        self.source = source
        self.size = len(source)
        self.out = list(source)
        self.spans: list[tuple[int, int]] = []
        self.substitutions: list[int] = []
        self.depth = 0
        self.previous = ""
        self.at = 0

    def blank(self, first: int, last: int, is_text: bool = False) -> None:
        if is_text:
            self.spans.append((first, last))
        for index in range(first, last):
            if self.out[index] != "\n":
                self.out[index] = BLANK

    def static(self, start: int) -> int:
        index = start
        while index < self.size:
            if self.source[index] == "\\":
                index += 2
            elif self.source[index] == "`":
                self.blank(start, index, True)
                return index + 1
            elif self.source.startswith("${", index):
                self.blank(start, index, True)
                self.substitutions.append(self.depth)
                return index + 2
            else:
                index += 1
        self.blank(start, self.size, True)
        return self.size

    def comment(self) -> bool:
        opener = self.source[self.at:self.at + 2]
        if opener not in ("//", "/*"):
            return False
        closer = "\n" if opener == "//" else "*/"
        end = self.source.find(closer, self.at + 2)
        end = self.size if end < 0 else end + (0 if opener == "//" else 2)
        self.blank(self.at, end)
        self.at = end
        return True

    def quoted(self) -> None:
        quote = self.source[self.at]
        end = self.at + 1
        while end < self.size and self.source[end] != quote:
            end += 2 if self.source[end] == "\\" else 1
        self.blank(self.at + 1, end, True)
        self.at, self.previous = end + 1, quote

    def regular_expression(self) -> None:
        end, inside = self.at + 1, False
        while end < self.size and (inside or self.source[end] != "/") and self.source[end] != "\n":
            if self.source[end] in "[]":
                inside = self.source[end] == "["
            end += 2 if self.source[end] == "\\" else 1
        self.blank(self.at + 1, end)
        self.at, self.previous = end + 1, ")"

    def is_regular_expression(self) -> bool:
        return self.source[self.at] == "/" and (self.previous == "" or self.previous in REGEX_PRECEDERS or self.previous.endswith(REGEX_KEYWORDS))

    def code(self) -> None:
        character = self.source[self.at]
        self.depth += {"{": 1, "}": -1}.get(character, 0)
        if not character.isspace():
            self.previous = (self.previous + character)[-12:] if character.isalpha() else character
        self.at += 1

    def step(self) -> None:
        character = self.source[self.at]
        if self.comment():
            return
        if character in "'\"":
            self.quoted()
        elif character == "`":
            self.at, self.previous = self.static(self.at + 1), "`"
        elif character == "}" and self.substitutions and self.substitutions[-1] == self.depth:
            self.substitutions.pop()
            self.at, self.previous = self.static(self.at + 1), "`"
        elif self.is_regular_expression():
            self.regular_expression()
        else:
            self.code()

    def run(self) -> tuple[str, list[tuple[int, int]]]:
        while self.at < self.size:
            self.step()
        return "".join(self.out), self.spans


def closing(code: str, opening: int) -> int:
    """The index of the bracket that closes the one at opening, in masked code."""
    depth = 0
    for index in range(opening, len(code)):
        if code[index] in OPENERS:
            depth += 1
        elif code[index] in CLOSERS:
            depth -= 1
            if depth == 0:
                return index
    raise AssertionError(f"the bracket at {opening} never closes")


def arguments(code: str, opening: int) -> list[tuple[int, int]]:
    """The span of each argument of the call whose parenthesis is at opening, split at the commas outside any bracket."""
    end = closing(code, opening)
    spans, first, depth = [], opening + 1, 0
    for index in range(opening + 1, end):
        if code[index] in OPENERS:
            depth += 1
        elif code[index] in CLOSERS:
            depth -= 1
        elif code[index] == "," and depth == 0:
            spans.append((first, index))
            first = index + 1
    if code[first:end].strip():
        spans.append((first, end))
    return spans


def calls(code: str, name: str) -> list[int]:
    """The index of the parenthesis of each call of name, a function or a method, in masked code."""
    return [match.end() - 1 for match in re.finditer(rf"(?<![\w$]){re.escape(name)}\s*\(", code)]


@dataclass(frozen=True)
class Function:
    name: str
    start: int
    body_start: int
    end: int


HEADERS = (
    re.compile(r"\bfunction\s*\*?\s*(?P<name>[\w$]+)\s*(?:<[^()]*>)?\s*(?=\()"),
    re.compile(r"\b(?:const|let|var)\s+(?P<name>[\w$]+)\s*(?::[^=;]+?)?=\s*(?:async\s+)?(?:function\s*\*?\s*(?:[\w$]+\s*)?)?(?:<[^()]*>\s*)?(?=\()"),
    re.compile(r"(?<![\w$.])(?P<name>[\w$]+)\s*\??:\s*(?:async\s+)?(?:<[^()]*>\s*)?(?=\()"),
    re.compile(r"^[ \t]*(?:(?:public|private|protected|static|async|readonly|get|set)\s+)*(?P<name>[\w$]+)\s*(?:<[^()]*>)?\s*(?=\()", re.M),
    re.compile(r"[{,]\s*(?:async\s+)?(?P<name>[\w$]+)\s*(?:<[^()]*>)?\s*(?=\()"),
)


def type_end(code: str, colon: int) -> int:
    """The index of the arrow or the opening brace of the body that follows the return type that begins at colon, skipping the brackets inside the type."""
    depth = 0
    for index in range(colon + 1, len(code)):
        character = code[index]
        if character in "<([{" and not (character == "{" and depth == 0 and code[colon + 1:index].strip()):
            depth += 1
        elif character in ">)]}" and not (character == ">" and code[index - 1] == "="):
            depth -= 1
        elif depth == 0 and (code.startswith("=>", index) or character == "{"):
            return index
        elif character == ";" and depth == 0:
            return -1
    return -1


def after_signature(code: str, close: int) -> tuple[int, int] | None:
    """Where the body of a function whose parameters close at close begins and ends, or None when what follows is no function body."""
    index = close + 1
    while index < len(code) and code[index].isspace():
        index += 1
    if code.startswith(":", index):
        index = type_end(code, index)
        if index < 0:
            return None
    if code.startswith("=>", index):
        start = index + 2
        while code[start].isspace():
            start += 1
        return (start, closing(code, start)) if code.startswith("{", start) else (start, expression_end(code, start))
    if code.startswith("{", index):
        return index, closing(code, index)
    return None


def expression_end(code: str, start: int) -> int:
    """The index after the expression that begins at start and has no braces of its own around it."""
    depth, index = 0, start
    while index < len(code):
        character = code[index]
        if character in OPENERS:
            depth += 1
        elif character in CLOSERS:
            depth -= 1
            if depth < 0:
                return index
        elif depth == 0 and character in ";,":
            return index
        elif depth == 0 and character == "\n":
            following = code[index:].lstrip()
            if not CONTINUING_START.match(following) and not CONTINUING_END.search(code[start:index].rstrip()):
                return index
        index += 1
    return len(code)


def functions(code: str) -> list[Function]:
    """Every function, arrow and method whose name the source gives, in masked code, with its span from its name to the end of its body."""
    found: dict[tuple[str, int], Function] = {}
    for header in HEADERS:
        for match in header.finditer(code):
            name = match.group("name")
            if name in NOT_METHODS:
                continue
            opening = match.end()
            if code[opening] != "(":
                continue
            close = closing(code, opening)
            body = after_signature(code, close)
            if body is None:
                continue
            found.setdefault((name, match.start("name")), Function(name, match.start("name"), body[0], body[1] + 1))
    return sorted(found.values(), key=lambda each: each.start)


def enclosing(all_functions: list[Function], at: int) -> Function | None:
    """The innermost named function whose span holds the index at."""
    holding = [each for each in all_functions if each.start <= at < each.end]
    return max(holding, key=lambda each: each.start, default=None)


def blanked(code: str, spans: list[tuple[int, int]]) -> str:
    """code with each span turned to spaces, its line breaks kept."""
    out = list(code)
    for first, last in spans:
        for index in range(first, last):
            if out[index] != "\n":
                out[index] = " "
    return "".join(out)


def writes_text(code: str, function: Function, declared: list[Function]) -> bool:
    """Whether a function writes a text: a template that substitutes, a join, a replace, a concat, or a concatenation with a string, a reduce that starts from a string, outside its asserts, the errors it raises and the functions declared inside it."""
    inside = [(each.start, each.end) for each in declared if each is not function and function.start <= each.start and each.end <= function.end]
    region = blanked(code, inside)[function.start:function.end]
    raised = [(opening, closing(region, opening) + 1) for name in NOT_NOTICE_TEXT for opening in calls(region, name)]
    scrubbed = blanked(region, raised)
    return bool(TEXT_MARKS.search(scrubbed)) or starts_from_a_string(scrubbed)


def starts_from_a_string(code: str) -> bool:
    """Whether code holds a reduce whose initial value is a string, which concatenates what it folds."""
    return any(len(spans) == 2 and re.fullmatch(rf"\s*{STRING}\s*", code[spans[1][0]:spans[1][1]]) for spans in (arguments(code, opening) for opening in calls(code, "reduce")))
