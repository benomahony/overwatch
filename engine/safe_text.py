"""Writing text the engine does not control, as a file, check or directory name, a command, a summary, a path or git's own words, into a notice, so that none of it can start a line the agent reads as overwatch's own, imitate its marks or end the quotes around it.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import sys
import unicodedata
from dataclasses import dataclass

BACKTICK = "`"
SPACE = " "
TAB = "\t"
BYTE_LIMIT = 0x100
BASIC_PLANE_LIMIT = 0x10000
BYTE_DIGITS, BASIC_PLANE_DIGITS, ASTRAL_DIGITS = 2, 4, 8
NAME_LIMIT = 200
CUT = "..."


@dataclass(frozen=True)
class Rule:
    """Which characters a notice writes as an escape: those of the categories, but the characters kept raw."""
    categories: frozenset[str]
    kept: str


HIDING_CATEGORIES = frozenset({"Cc", "Cf", "Zl", "Zp", "Zs"})
LINE_BREAKS = Rule(frozenset({"Cc", "Zl", "Zp"}), SPACE + TAB)
HIDING = Rule(HIDING_CATEGORIES, SPACE)
HIDING_BUT_TABS = Rule(HIDING_CATEGORIES, SPACE + TAB)


def is_unsafe(character: str, rule: Rule, quoted: bool) -> bool:
    """Whether a notice writes the character as an escape: one of the rule's categories that it does not keep, and with quoted, the backtick that ends quotes."""
    assert len(character) == 1, f"{character!r} is not one character"
    assert rule.categories, "a rule with no category writes no escape"
    return (unicodedata.category(character) in rule.categories and character not in rule.kept) or (quoted and character == BACKTICK)


def escape(character: str) -> str:
    """The escape for one character that a notice does not carry raw: \\xNN below BYTE_LIMIT, \\uNNNN in the basic plane, \\UNNNNNNNN above it."""
    assert len(character) == 1, f"{character!r} is not one character"
    code = ord(character)
    assert code <= sys.maxunicode, f"the code point {code} is outside Unicode"
    return f"\\x{code:0{BYTE_DIGITS}x}" if code < BYTE_LIMIT else f"\\u{code:0{BASIC_PLANE_DIGITS}x}" if code < BASIC_PLANE_LIMIT else f"\\U{code:0{ASTRAL_DIGITS}x}"


def written(text: str, rule: Rule, quoted: bool, limit: int | None) -> str:
    """text with each unsafe character as its escape; when that passes limit characters, its first characters that fit, then CUT."""
    assert limit is None or limit > len(CUT), f"the limit {limit} leaves no room for text before {CUT!r}"
    assert rule.categories <= HIDING_CATEGORIES, f"the rule names {rule.categories - HIDING_CATEGORIES}, which no notice escapes"
    pieces = [escape(character) if is_unsafe(character, rule, quoted) else character for character in text]
    if limit is None or sum(map(len, pieces)) <= limit:
        return "".join(pieces)
    kept: list[str] = []
    for piece in pieces:
        if sum(map(len, kept)) + len(piece) > limit - len(CUT):
            break
        kept.append(piece)
    return "".join(kept) + CUT


def safe_name(name: str) -> str:
    """name with each hiding character and backtick written as an escape, and cut to NAME_LIMIT characters with CUT; for a file name or a saved ref in a notice of TCR, which puts it in quotes."""
    assert NAME_LIMIT > len(CUT), f"the limit {NAME_LIMIT} of a name leaves no room for text before {CUT!r}"
    assert BACKTICK not in HIDING.kept, "a name keeps the backtick that ends its quotes"
    return written(name, HIDING, True, NAME_LIMIT)


def safe_path(text: str) -> str:
    """text with each line break and control character but the tab written as an escape, and nothing else changed or cut, so that a command, a name, a directory or a path of a message stays as it is to copy and cannot start a line."""
    assert "\n" not in LINE_BREAKS.kept, "a command keeps a line break"
    assert TAB in LINE_BREAKS.kept, "a command is written with its tabs as escapes, so it cannot be copied"
    return written(text, LINE_BREAKS, False, None)


def safe_line(text: str) -> str:
    """text with each hiding character but the tab written as an escape, backticks kept and no cut, so that it cannot start a line of a notice or hide words in it; for a summary or git's own message, which holds the quotes of the notice's own words and, as a Go summary does, tabs."""
    assert "\n" not in HIDING_BUT_TABS.kept, "a summary keeps a line break"
    assert TAB in HIDING_BUT_TABS.kept, "a summary is written with its tabs as escapes"
    return written(text, HIDING_BUT_TABS, False, None)
