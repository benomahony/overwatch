#!/usr/bin/env python3
"""Filter and page an Overwatch baseline inventory without rerunning checks."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def triage(inventory: dict[str, Any], check: str = "", match: str = "") -> dict[str, Any]:
    groups = []
    issues = []
    for report in inventory["checks"]:
        label = f"{report['name']} {report.get('dir') or ''} {report['command']}"
        if check.casefold() not in label.casefold():
            continue
        names = report.get("failures") or [report["summary"]]
        selected = [name for name in names if match.casefold() in name.casefold()]
        if not selected:
            continue
        groups.append({"name": report["name"], "dir": report.get("dir"), "count": len(selected), "log": report["log"]})
        issues.extend({"check": report["name"], "dir": report.get("dir"), "issue": name, "log": report["log"]} for name in selected)
    return {"checks": groups, "issues": issues, "total": len(issues)}


def triage_page(result: dict[str, Any], offset: int, limit: int) -> dict[str, Any]:
    return {**result, "checks": result["checks"][:limit],
            "issues": result["issues"][offset:offset + limit], "offset": offset, "limit": limit}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inventory", type=Path)
    parser.add_argument("--check", default="", help="Match a check, command, or subproject (case insensitive)")
    parser.add_argument("--match", default="", help="Match an issue name (case insensitive)")
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if args.offset < 0 or not 1 <= args.limit <= 100:
        parser.error("offset must be nonnegative and limit must be between 1 and 100")
    try:
        result = triage_page(triage(json.loads(args.inventory.read_text()), args.check, args.match), args.offset, args.limit)
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.error(f"could not read baseline inventory: {error}")
    if args.json:
        print(json.dumps(result, indent=2))
        return
    print(f"Inherited backlog: {result['total']} matching issues. These are not Stop blockers.")
    for group in result["checks"]:
        print(f"  {group['name']} ({group.get('dir') or '.'}): {group['count']}")
    print(f"Showing up to {args.limit} issues from offset {args.offset}:")
    for issue in result["issues"]:
        print(f"- {issue['check']}: {issue['issue']}\n  Full output: {issue['log']}")
    if args.offset + args.limit < result["total"]:
        print(f"Next page: --offset {args.offset + args.limit} --limit {args.limit}")


if __name__ == "__main__":
    main()
