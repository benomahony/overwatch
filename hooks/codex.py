#!/usr/bin/env python3
"""Codex lifecycle-hook adapter for Overwatch.

Codex command hooks are short lived, so this adapter runs one build whenever
the workspace changes and caches its result for the Stop hook. A configured
watch command is stopped after its first complete report.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import subprocess
import sys
import time
from typing import Any


OVERRIDE_PATH = ".overwatch.json"
REPORT_LIMIT = 8_000
COMMAND_TIMEOUT = 540
FAILURE_LIMIT = 10
# Colour codes, which some tools (deno) print even into a pipe.
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
# The decoration each tool puts around its summary, which the status line leaves out.
SUMMARY_DECORATION = re.compile(
    r"^Build Summary:\s*|^zanity:\s*|^=+\s*|\s*=+$|^Test Files\s+|^Test Suites:\s*|^DONE\s+|^(?:ok|FAILED) \| "
)

# The table every runtime reads; patterns are JavaScript regexes that Python reads the same way.
# Alternatives of one language are tried in order: the first whose marker, and tool if it needs one, are present runs.
TABLE: dict[str, Any] = json.loads((Path(__file__).resolve().parent.parent / "watchers.json").read_text())
WATCHERS: tuple[dict[str, Any], ...] = tuple(TABLE["watchers"])
CHECKERS: tuple[dict[str, Any], ...] = tuple(TABLE["checkers"])


class ConfigurationError(Exception):
    pass


def read_event() -> dict[str, Any]:
    try:
        value = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError) as error:
        raise ConfigurationError(f"could not read the Codex hook event: {error}") from error
    if not isinstance(value, dict):
        raise ConfigurationError("the Codex hook event was not a JSON object")
    return value


def read_override(cwd: Path) -> dict[str, Any]:
    path = cwd / OVERRIDE_PATH
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as error:
        raise ConfigurationError(f"could not read {path}: {error}") from error
    if not isinstance(value, dict):
        raise ConfigurationError(f"{path} must contain a JSON object")
    return value


def string_list(value: Any, field: str) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ConfigurationError(f"{OVERRIDE_PATH} field {field!r} must be an array of strings")
    return value


def apply_override(watcher: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = dict(watcher)
    result["language"] = watcher.get("language", watcher["name"])
    for field in ("name", "summary", "failed"):
        if field in override:
            value = override[field]
            if not isinstance(value, str):
                raise ConfigurationError(f"{OVERRIDE_PATH} field {field!r} must be a string")
            result[field] = value
    for field in ("argv", "baseline"):
        if field in override:
            result[field] = string_list(override[field], field)
    try:
        for field in ("summary", "result", "failure"):
            if field in result:
                re.compile(result[field], re.MULTILINE)
        if "failed" in result:
            re.compile(result["failed"])
    except re.error as error:
        raise ConfigurationError(f"invalid regular expression in {OVERRIDE_PATH}: {error}") from error
    return result


def find_watchers(cwd: Path) -> list[dict[str, Any]]:
    override = read_override(cwd)
    if override.get("enabled") is False:
        return []
    if "enabled" in override and not isinstance(override["enabled"], bool):
        raise ConfigurationError(f"{OVERRIDE_PATH} field 'enabled' must be a boolean")

    # One watcher for each language the project has; the override applies to the first.
    found: list[dict[str, Any]] = []
    for watcher in WATCHERS:
        language = watcher.get("language", watcher["name"])
        if any(each["language"] == language for each in found):
            continue
        if not (cwd / watcher["marker"]).exists():
            continue
        if "requires" in watcher and not shutil.which(watcher["requires"]):
            continue
        found.append(apply_override(watcher, override if not found else {}))
    if not found:
        argv = string_list(override.get("argv"), "argv")
        baseline = string_list(override.get("baseline"), "baseline")
        complete = isinstance(override.get("summary"), str) and isinstance(override.get("failed"), str)
        if (argv is not None or baseline) and complete:
            found.append(apply_override(
                {"name": "project", "language": "project", "marker": OVERRIDE_PATH, "summary": r"$^", "failed": r"$^"},
                override,
            ))

    for checker in CHECKERS:
        if shutil.which(checker["marker"]):
            found.append(dict(checker))
    return found


def command_for(watcher: dict[str, Any]) -> tuple[list[str], bool] | None:
    baseline = watcher.get("baseline")
    if baseline:
        return list(baseline), False
    argv = watcher.get("argv")
    if argv:
        return list(argv), True
    return None


def command_line(argv: list[str]) -> str:
    return " ".join(argv)


def terminate(process: subprocess.Popen[bytes]) -> bytes:
    process.terminate()
    try:
        tail, _ = process.communicate(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        tail, _ = process.communicate()
    return tail or b""


def read_available(selector: selectors.BaseSelector) -> bytes:
    selected = selector.select(timeout=0.1)
    if not selected:
        return b""
    key, _ = selected[0]
    return os.read(key.fd, 65_536)


def run_command(
    cwd: Path, watcher: dict[str, Any], argv: list[str], stop_after_report: bool,
) -> tuple[str, int | None]:
    """Runs argv, returning what it printed and its exit code; None when stopped after its report."""
    command = command_line(argv)
    try:
        process = subprocess.Popen(
            argv,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
        )
    except OSError as error:
        raise ConfigurationError(f"could not start {command}: {error}") from error
    assert process.stdout is not None

    if not stop_after_report:
        try:
            output, _ = process.communicate(timeout=COMMAND_TIMEOUT)
        except subprocess.TimeoutExpired:
            terminate(process)
            raise ConfigurationError(f"{command} did not finish within {COMMAND_TIMEOUT}s")
        return output.decode(errors="replace"), process.returncode

    summary = re.compile(watcher["summary"], re.MULTILINE)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    chunks: list[bytes] = []
    deadline = time.monotonic() + COMMAND_TIMEOUT
    try:
        while time.monotonic() < deadline:
            chunk = read_available(selector)
            if chunk:
                chunks.append(chunk)
                text = ANSI.sub("", b"".join(chunks).decode(errors="replace"))
                if summary.search(text):
                    chunks.append(terminate(process))
                    return b"".join(chunks).decode(errors="replace"), None
            if process.poll() is not None:
                chunks.append(process.stdout.read() or b"")
                return b"".join(chunks).decode(errors="replace"), process.returncode
    finally:
        selector.close()
    terminate(process)
    raise ConfigurationError(f"{command} gave no report within {COMMAND_TIMEOUT}s")


def failures_in(watcher: dict[str, Any], output: str) -> list[str]:
    """Each failing test or error the output names, once each, in order."""
    if "failure" not in watcher:
        return []
    names: list[str] = []
    for match in re.finditer(watcher["failure"], output, re.MULTILINE):
        name = next((group for group in match.groups() if group is not None), "").strip()
        if name and name not in names:
            names.append(name)
    return names


def read_report(watcher: dict[str, Any], output: str, code: int | None = None) -> dict[str, Any] | None:
    """Reads one build's output; a run with no summary line is read by its exit code."""
    clean = ANSI.sub("", output)
    failures = failures_in(watcher, clean)
    match = re.search(watcher["summary"], clean, re.MULTILINE) if "summary" in watcher else None
    if match is not None:
        line = match.group(0).strip()
        shown = re.search(watcher["result"], clean, re.MULTILINE) if "result" in watcher else None
        summary = shown.group(0).strip() if shown else line
        failed = "failed" in watcher and re.search(watcher["failed"], line) is not None
    elif code is None or (code == 0 and "summary" in watcher):
        return None
    else:
        failed = code != 0
        summary = (f"{len(failures)} failed" if failures else f"exited with code {code}") if failed else "passed"
    text = clean.strip()
    if len(text) > REPORT_LIMIT:
        text = f"{text[:REPORT_LIMIT]}\n… {len(text) - REPORT_LIMIT} more characters cut"
    selected = command_for(watcher)
    assert selected is not None
    return {
        "name": watcher["name"],
        "command": command_line(selected[0]),
        "summary": summary,
        "failed": failed,
        "failures": failures if failed else [],
        "text": text,
    }


def run_checks(cwd: Path, watchers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    reports: list[dict[str, Any]] = []
    for watcher in watchers:
        selected = command_for(watcher)
        if selected is None:
            continue
        argv, stop_after_report = selected
        output, code = run_command(cwd, watcher, argv, stop_after_report)
        report = read_report(watcher, output, code)
        if report is None:
            tail = output.strip()[-2_000:]
            detail = f"\n\n{tail}" if tail else ""
            raise ConfigurationError(f"{command_line(argv)} gave no matching summary{detail}")
        reports.append(report)
    return reports


def fingerprint(cwd: Path) -> str:
    digest = hashlib.blake2b(digest_size=20)
    paths: list[Path]
    try:
        result = subprocess.run(
            ["git", "ls-files", "-co", "--exclude-standard", "-z"],
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=True,
        )
        paths = [cwd / os.fsdecode(part) for part in result.stdout.split(b"\0") if part]
    except (OSError, subprocess.SubprocessError):
        ignored = {
            ".git", ".venv", "node_modules", "__pycache__", ".pytest_cache",
            ".mypy_cache", ".zig-cache", "zig-cache", "target", "dist", "build",
        }
        paths = []
        for root, directories, files in os.walk(cwd):
            directories[:] = [name for name in directories if name not in ignored]
            paths.extend(Path(root) / name for name in files)
    for path in sorted(paths):
        digest.update(os.fsencode(os.path.relpath(path, cwd)))
        try:
            stat = path.stat()
        except OSError:
            digest.update(b"\0missing")
        else:
            digest.update(f"\0{stat.st_size}:{stat.st_mtime_ns}".encode())
    return digest.hexdigest()


def state_path(event: dict[str, Any], cwd: Path) -> Path:
    data = Path(os.environ.get("PLUGIN_DATA", Path.home() / ".cache" / "overwatch"))
    identity = f"{event.get('session_id', '')}\0{cwd}"
    return data / f"{hashlib.sha256(identity.encode()).hexdigest()}.json"


def load_state(event: dict[str, Any], cwd: Path) -> dict[str, Any]:
    try:
        value = json.loads(state_path(event, cwd).read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(event: dict[str, Any], cwd: Path, value: dict[str, Any]) -> None:
    path = state_path(event, cwd)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


def failing_line(failures: list[str]) -> str:
    """Names the failing tests, the first FAILURE_LIMIT of them, for the agent."""
    if not failures:
        return ""
    named = ", ".join(f"`{name}`" for name in failures[:FAILURE_LIMIT])
    more = f", and {len(failures) - FAILURE_LIMIT} more" if len(failures) > FAILURE_LIMIT else ""
    return f"Failing: {named}{more}.\n"


def failure_message(reports: list[dict[str, Any]]) -> str:
    failures = [report for report in reports if report["failed"]]
    return "\n\n".join(
        f"overwatch: `{report['command']}` failed after the latest change.\n"
        f"{failing_line(report.get('failures', []))}"
        "Fix it before carrying on. If you are midway through a change that touches several files, finish it first.\n\n"
        f"```\n{report['text']}\n```"
        for report in failures
    )


def failing_suffix(failures: list[str]) -> str:
    if not failures:
        return ""
    more = f" +{len(failures) - 1} more" if len(failures) > 1 else ""
    return f" — {failures[0]}{more}"


def failure_status(reports: list[dict[str, Any]]) -> str:
    summaries = " · ".join(
        f"{report['name']} ✗ {SUMMARY_DECORATION.sub('', report['summary'])}{failing_suffix(report.get('failures', []))}"
        for report in reports
        if report["failed"]
    )
    return f"Overwatch: {summaries}"


def recovery_message(reports: list[dict[str, Any]]) -> str:
    summaries = " · ".join(f"overwatch {report['name']} ✓ {SUMMARY_DECORATION.sub('', report['summary'])}" for report in reports)
    return f"overwatch: green again. {summaries}"


def context_output(event_name: str, text: str) -> dict[str, Any]:
    return {
        "hookSpecificOutput": {
            "hookEventName": event_name,
            "additionalContext": text,
        }
    }


def main() -> int:
    try:
        event = read_event()
        event_name = str(event.get("hook_event_name", ""))
        cwd = Path(str(event.get("cwd") or os.getcwd())).resolve()
        old = load_state(event, cwd)
        before = fingerprint(cwd)
        should_run = not old or old.get("fingerprint") != before
        watchers = find_watchers(cwd)
        if should_run:
            reports = run_checks(cwd, watchers)
            failed = any(report["failed"] for report in reports)
            state = {"fingerprint": fingerprint(cwd), "failed": failed, "reports": reports}
            save_state(event, cwd, state)
        else:
            reports = old.get("reports", [])
            failed = bool(old.get("failed"))

        was_failing = bool(old.get("failed"))
        if failed:
            message = failure_message(reports)
            status = failure_status(reports)
            if event_name in {"Stop", "PostToolUse"}:
                output = context_output(event_name, message)
                output.update({"decision": "block", "reason": message})
            else:
                output = context_output(event_name, message)
            output["systemMessage"] = status
        elif should_run and was_failing:
            output = context_output(event_name, recovery_message(reports))
        else:
            output = {}
        print(json.dumps(output))
        return 0
    except ConfigurationError as error:
        print(json.dumps({"systemMessage": f"overwatch: {error}"}))
        return 0
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
        print(json.dumps({"systemMessage": f"overwatch: unexpected error: {error}"}))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
