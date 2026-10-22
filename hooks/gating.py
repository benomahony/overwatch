"""Project policy for completion and explicitly protected tool actions."""
from __future__ import annotations

import re
from typing import Any


def read_policy(override: dict[str, Any]) -> dict[str, Any]:
    policy = override.get("gate", {})
    if not isinstance(policy, dict) or policy.get("inherited", "allow") not in ("allow", "block"):
        raise ValueError("gate must be an object with inherited set to 'allow' or 'block'")
    actions = policy.get("protected_actions", [])
    if not isinstance(actions, list):
        raise ValueError("gate.protected_actions must be an array")
    for action in actions:
        validate_action(action)
    return policy


def validate_action(action: Any) -> None:
    if not isinstance(action, dict) or not isinstance(action.get("tool"), str) or not action["tool"]:
        raise ValueError("a protected action must name a tool")
    checks = action.get("checks", [])
    if not isinstance(checks, list) or any(not isinstance(name, str) for name in checks):
        raise ValueError("a protected action's checks must be an array of check names")
    pattern = action.get("command")
    if pattern is not None:
        if not isinstance(pattern, str):
            raise ValueError("a protected action's command must be a regular expression string")
        re.compile(pattern)


def protected_checks(event: dict[str, Any], policy: dict[str, Any]) -> list[str] | None:
    """None means an ordinary tool; an empty list means all configured checks."""
    selected: set[str] = set()
    matched = False
    arguments = event.get("tool_input") or {}
    command = arguments.get("command", arguments.get("cmd", "")) if isinstance(arguments, dict) else ""
    for action in policy.get("protected_actions", []):
        if action["tool"].casefold() != str(event.get("tool_name", "")).casefold():
            continue
        if "command" in action and re.search(action["command"], str(command)) is None:
            continue
        matched = True
        names = action.get("checks", [])
        if not names:
            return []
        selected.update(names)
    return sorted(selected) if matched else None


def relevant(report: dict[str, Any], checks: list[str]) -> bool:
    return not checks or report["name"] in checks or report.get("language") in checks
