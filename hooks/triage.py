#!/usr/bin/env python3
"""Filter and page an Overwatch baseline inventory without rerunning checks."""
from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path

MAX_LIMIT = 100
DEFAULT_LIMIT = 20
CONTROL_TEXT = "".join(chr(code) for code in range(32)) + "\x7f"
CONTROL = set(CONTROL_TEXT)


class InventoryError(ValueError):
    """A baseline inventory is not in the shape overwatch writes; the message names the entry and what to do."""


@dataclass(frozen=True)
class Check:
    """One check in a baseline inventory: its name, sub-project and command, the issues it named, or its summary when
    it named none, and the path of its full log."""
    name: str
    dir: str | None
    command: str
    issues: tuple[str, ...]
    log: str


@dataclass(frozen=True)
class Issue:
    """One inherited issue that matched the filter, with the check that reported it and that check's log."""
    check: str
    dir: str | None
    issue: str
    log: str


@dataclass(frozen=True)
class Group:
    """A check with at least one matching issue, and how many matched."""
    name: str
    dir: str | None
    count: int
    log: str


@dataclass(frozen=True)
class Page:
    """One page of a triage: the first limit groups, limit issues from offset, and how many issues matched in all."""
    checks: tuple[Group, ...]
    issues: tuple[Issue, ...]
    total: int
    offset: int
    limit: int


@dataclass(frozen=True)
class Triage:
    """The groups and issues of an inventory that match a filter, both in inventory order."""
    checks: tuple[Group, ...]
    issues: tuple[Issue, ...]


def text_value(value: object, name: object, field: str) -> str:
    """value as a non-empty, single-line string, or InventoryError naming the entry and field when it is not one."""
    if not isinstance(value, str) or not value or any(character in value for character in CONTROL):
        raise InventoryError(f"inventory entry {name!r} has {field} {value!r}, not one line of text; rerun overwatch to rewrite the inventory")
    assert value.strip(CONTROL_TEXT) == value, f"{field} {value!r} kept a control character; check CONTROL"
    assert value.splitlines() == [value], f"{field} {value!r} spans lines; check CONTROL covers line breaks"
    return value


def parse_check(entry: object) -> Check:
    """Parses one inventory entry, raising InventoryError that names it and the field that is wrong."""
    if not isinstance(entry, dict):
        raise InventoryError(f"inventory entry {entry} is not an object; rerun overwatch to rewrite the inventory")
    name = text_value(entry.get("name"), entry.get("name"), "name")
    failures, directory, summary = entry.get("failures") or [], entry.get("dir"), entry.get("summary")
    if not isinstance(failures, list):
        raise InventoryError(f"inventory entry {name!r} has failures {failures!r}, not a list of names; rerun overwatch to rewrite the inventory")
    issues = tuple(text_value(failure, name, "a failure") for failure in failures) or (text_value(summary, name, "summary"),)
    check = Check(name, None if directory is None else text_value(directory, name, "dir"), text_value(entry.get("command"), name, "command"),
                  issues, text_value(entry.get("log"), name, "log"))
    assert check.issues, f"{check.name} parsed with no issues; parse_check must fall back to the summary"
    assert len(check.issues) == max(len(failures), 1), f"{check.name} parsed {len(check.issues)} issues from {len(failures)} failures; keep each one"
    return check


def parse_inventory(data: object) -> tuple[Check, ...]:
    """Parses a baseline inventory's JSON, raising InventoryError that names the entry or field that is wrong."""
    if not isinstance(data, dict) or not isinstance(data.get("checks"), list):
        raise InventoryError("a baseline inventory is an object with a checks array; pass the path from overwatch's notice")
    checks = tuple(parse_check(entry) for entry in data["checks"])
    assert len(checks) == len(data["checks"]), f"parsed {len(checks)} of {len(data['checks'])} checks; parse_check must return one per entry"
    assert all(type(check) is Check for check in checks), f"parse_check returned {checks}; it must return Check values"
    return checks


def triage(checks: tuple[Check, ...], check: str = "", match: str = "") -> Triage:
    """The checks whose name, sub-project or command contain check, and their issues that contain match, both
    ignoring case and in inventory order."""
    groups, issues = [], []
    for entry in checks:
        if check.casefold() not in f"{entry.name} {entry.dir or ''} {entry.command}".casefold():
            continue
        selected = [name for name in entry.issues if match.casefold() in name.casefold()]
        if selected:
            groups.append(Group(entry.name, entry.dir, len(selected), entry.log))
            issues.extend(Issue(entry.name, entry.dir, name, entry.log) for name in selected)
    result = Triage(tuple(groups), tuple(issues))
    assert sum(group.count for group in result.checks) == len(result.issues), f"groups count {sum(group.count for group in result.checks)} issues of {len(result.issues)}; count each once"
    assert all(match.casefold() in issue.issue.casefold() for issue in result.issues), f"issues {result.issues} include one not matching {match}"
    return result


def triage_page(result: Triage, offset: int, limit: int) -> Page:
    """One page of a triage: the first limit groups, limit issues from offset, and the total that matched."""
    if offset < 0 or not 1 <= limit <= MAX_LIMIT:
        raise InventoryError(f"offset {offset} must be at least 0 and limit {limit} between 1 and {MAX_LIMIT}; pass --offset and --limit in range")
    page = Page(result.checks[:limit], result.issues[offset:offset + limit], len(result.issues), offset, limit)
    assert len(page.issues) <= page.limit, f"page holds {len(page.issues)} issues over the limit {page.limit}; slice by limit"
    assert page.offset >= page.total or page.issues[0] is result.issues[page.offset], f"page starts at the wrong issue for offset {page.offset}"
    return page


def page_text(page: Page) -> str:
    """A triage page as the lines shown in a terminal, ending with how to fetch the next page when there is one."""
    lines = [f"Inherited backlog: {page.total} matching issues. Completion follows the project's inherited-finding policy."]
    lines.extend(f"  {group.name} ({group.dir or '.'}): {group.count}" for group in page.checks)
    lines.append(f"Showing up to {page.limit} issues from offset {page.offset}:")
    lines.extend(f"- {issue.check}: {issue.issue}\n  Full output: {issue.log}" for issue in page.issues)
    if page.offset + page.limit < page.total:
        lines.append(f"Next page: --offset {page.offset + page.limit} --limit {page.limit}")
    text = "\n".join(lines)
    assert text.startswith(f"Inherited backlog: {page.total} "), f"page text opens with {text[:40]!r}; keep the total first"
    assert text.count("Full output: ") == len(page.issues), f"{text.count('Full output: ')} log links for {len(page.issues)} issues; give each issue one"
    return text


def main() -> None:
    """Parses the arguments and inventory, then prints one page of matching issues as text or JSON."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inventory", type=Path)
    parser.add_argument("--check", default="", help="Match a check, command, or subproject (case insensitive)")
    parser.add_argument("--match", default="", help="Match an issue name (case insensitive)")
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        page = triage_page(triage(parse_inventory(json.loads(args.inventory.read_text())), args.check, args.match), args.offset, args.limit)
    except (OSError, ValueError) as error:
        parser.error(f"could not read baseline inventory: {error}; pass the inventory path from overwatch's notice")
    output = json.dumps(asdict(page), indent=2) if args.json else page_text(page)
    assert output, f"nothing to print for page {page}; page_text and json.dumps always produce text"
    assert args.json or output.count("\n- ") == len(page.issues), f"text output lists {output.count(chr(10) + '- ')} of {len(page.issues)} issues"
    print(output)


if __name__ == "__main__":
    main()
