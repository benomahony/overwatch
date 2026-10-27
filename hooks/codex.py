#!/usr/bin/env python3
"""One-shot check runner for Overwatch's coding-agent adapters.

Command hooks and in-process plugins call this runner with a Claude-style hook
event. It checks the git repository holding the event's directory, and nothing
outside one. It runs one build whenever the workspace changes and caches its
result for later hooks. A configured watch command is stopped after its first
complete report. The first result of each check is its baseline: only failures
it did not have are reported, each once, with the full output in a log file.
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
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from gating import protected_checks, read_gate, tool_command


OVERRIDE_PATH = ".overwatch.json"
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
# A language the project's root lacks is looked for in the directories this many levels down, leaving out hidden ones
# and these.
SEARCH_DEPTH: int = TABLE["search"]["depth"]
SEARCH_SKIP: frozenset[str] = frozenset(TABLE["search"]["skip"])
# Lines that mean a command could not run where it is, which no change to the code fixes.
ENVIRONMENT: tuple[re.Pattern[str], ...] = tuple(re.compile(pattern) for pattern in TABLE["environment"])


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


def language_of(watcher: dict[str, Any]) -> str:
    return watcher.get("language", watcher["name"])


def first_present(alternatives: list[dict[str, Any]], directory: Path) -> dict[str, Any] | None:
    """The first of a language's alternatives whose marker is in directory and whose tool, if it needs one, is on PATH."""
    for watcher in alternatives:
        if (directory / watcher["marker"]).exists() and ("requires" not in watcher or shutil.which(watcher["requires"])):
            return watcher
    return None


def find_subprojects(cwd: Path) -> list[str]:
    """The directories SEARCH_DEPTH levels down, relative to cwd, nearest and then alphabetically first."""
    found: list[str] = []
    parents = [""]
    for _ in range(SEARCH_DEPTH):
        level: list[str] = []
        for parent in parents:
            try:
                entries = list(os.scandir(cwd / parent))
            except OSError:
                continue
            for entry in entries:
                if entry.is_dir(follow_symlinks=False) and not entry.name.startswith(".") and entry.name not in SEARCH_SKIP:
                    level.append(f"{parent}/{entry.name}" if parent else entry.name)
        level.sort()
        found.extend(level)
        parents = level
    return found


def find_project_watchers(cwd: Path, override: dict[str, Any]) -> list[dict[str, Any]]:
    # One watcher for each language the project has, or else for each sub-project that has it, one not inside
    # another that does; the override applies to the first.
    found: list[dict[str, Any]] = []
    subprojects: list[str] | None = None
    for language in dict.fromkeys(language_of(watcher) for watcher in WATCHERS):
        alternatives = [watcher for watcher in WATCHERS if language_of(watcher) == language]
        at_root = first_present(alternatives, cwd)
        if at_root is not None:
            found.append(apply_override(at_root, override if not found else {}))
            continue
        if subprojects is None:
            subprojects = find_subprojects(cwd)
        claimed: list[str] = []
        for directory in subprojects:
            if any(directory.startswith(f"{parent}/") for parent in claimed):
                continue
            watcher = first_present(alternatives, cwd / directory)
            if watcher is None:
                continue
            claimed.append(directory)
            labelled = {**watcher, "language": language, "name": f"{watcher['name']} {directory}", "dir": directory}
            found.append(apply_override(labelled, override if not found else {}))
    return found


def find_watchers(cwd: Path) -> list[dict[str, Any]]:
    override = read_override(cwd)
    if override.get("enabled") is False:
        return []
    if "enabled" in override and not isinstance(override["enabled"], bool):
        raise ConfigurationError(f"{OVERRIDE_PATH} field 'enabled' must be a boolean")

    found = find_project_watchers(cwd, override)
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
    seen: set[str] = set()
    for match in re.finditer(watcher["failure"], output, re.MULTILINE):
        name = next((group for group in match.groups() if group is not None), "").strip()
        if name and name not in seen:
            seen.add(name)
            names.append(name)
    return names


def environment_in(output: str) -> str | None:
    """The first line saying the command failed for want of something in its environment, not because of the code."""
    for line in output.splitlines():
        if any(pattern.search(line) for pattern in ENVIRONMENT):
            return line.strip()
    return None


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
    selected = command_for(watcher)
    assert selected is not None
    return {
        "name": watcher["name"],
        "language": language_of(watcher),
        "command": command_line(selected[0]),
        "dir": watcher.get("dir"),
        "summary": summary,
        "failed": failed,
        "failures": failures if failed else [],
        "environment": environment_in(clean) if failed else None,
        "text": clean.strip(),
    }


def run_check(cwd: Path, watcher: dict[str, Any]) -> dict[str, Any] | None:
    selected = command_for(watcher)
    if selected is None:
        return None
    argv, stop_after_report = selected
    output, code = run_command(cwd / watcher.get("dir", ""), watcher, argv, stop_after_report)
    report = read_report(watcher, output, code)
    if report is None:
        tail = output.strip()[-2_000:]
        detail = f"\n\n{tail}" if tail else ""
        raise ConfigurationError(f"{command_line(argv)} gave no matching summary{detail}")
    return report


def run_checks(cwd: Path, watchers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Runs every watcher's check at once, so a polyglot project waits for its slowest suite, not the sum of them."""
    if not watchers:
        return []
    with ThreadPoolExecutor(max_workers=len(watchers)) as pool:
        reports = list(pool.map(lambda watcher: run_check(cwd, watcher), watchers))
    return [report for report in reports if report is not None]


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


def repository_of(cwd: Path) -> Path | None:
    """The root of the git repository holding cwd; None outside one."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return Path(result.stdout.strip()).resolve()


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


def where(report: dict[str, Any]) -> str:
    """The sub-project a report's command ran in, for the agent."""
    return f" in `{report['dir']}`" if report.get("dir") else ""


def key_of(report: dict[str, Any]) -> str:
    return f"{report['name']}\0{report.get('dir') or ''}"


def known_failures(report: dict[str, Any], baseline: dict[str, Any]) -> list[str]:
    """The failures this check already had when the session started."""
    first = baseline.get(key_of(report), {})
    return list(first.get("failures", [])) if first.get("failed") else []


def is_regression(report: dict[str, Any], baseline: dict[str, Any]) -> bool:
    """Whether a report fails in a way its baseline, the session's first result, did not."""
    if not report["failed"] or report.get("environment"):
        return False
    first = baseline.get(key_of(report), {})
    known = set(known_failures(report, baseline))
    if not first.get("failed") or any(name not in known for name in report.get("failures", [])):
        return True
    if "summary" not in first:
        return False
    previous = failure_counts(first["summary"])
    return any(count > previous.get(kind, 0) for kind, count in failure_counts(report["summary"]).items())


def failure_counts(summary: str) -> dict[str, int]:
    """Counts are a fallback when a runner does not identify individual issues."""
    counts: dict[str, int] = {}
    for number, label in re.findall(r"(\d+)\s+(errors?|warnings?|failures?|failed|fail)\b", summary):
        kind = "error" if label.startswith("error") else "warning" if label.startswith("warning") else "failure"
        counts[kind] = max(counts.get(kind, 0), int(number))
    return counts


def write_log(path: Path, report: dict[str, Any], prefix: str = "") -> Path:
    """Writes a report's full output beside the session's state, keeping it out of the conversation."""
    log = path.with_suffix("") / f"{prefix}{hashlib.sha256(key_of(report).encode()).hexdigest()[:16]}.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text(report["text"])
    return log


def failure_message(reports: list[dict[str, Any]], baseline: dict[str, Any], logs: dict[str, Path]) -> str:
    messages: list[str] = []
    for report in reports:
        known = set(known_failures(report, baseline))
        fresh = [name for name in report.get("failures", []) if name not in known]
        old = len(report.get("failures", [])) - len(fresh)
        messages.append(
            f"overwatch: `{report['command']}`{where(report)} failed after the latest change: {report['summary']}\n"
            f"{failing_line(fresh)}"
            f"{f'{old} more were already failing when the session started.' + chr(10) if old else ''}"
            "Fix these new failures before finishing. Tools remain available while you investigate.\n"
            f"Full output: `{logs[key_of(report)]}`"
        )
    return "\n\n".join(messages)


def environment_message(reports: list[dict[str, Any]]) -> str:
    lines = "\n".join(f"- `{report['command']}`{where(report)}: {report['environment']}" for report in reports)
    return (
        "overwatch: these checks cannot run in this environment, so they are not reporting. "
        f"This is not caused by your changes and needs no code change:\n{lines}"
    )


def failing_suffix(failures: list[str]) -> str:
    if not failures:
        return ""
    more = f" +{len(failures) - 1} more" if len(failures) > 1 else ""
    return f": {failures[0]}{more}"


def failure_status(reports: list[dict[str, Any]]) -> str:
    summaries = " · ".join(
        f"{report['name']} ✗ {SUMMARY_DECORATION.sub('', report['summary'])}{failing_suffix(report.get('failures', []))}"
        for report in reports
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


def report_state(reports: list[dict[str, Any]], old: dict[str, Any]) -> dict[str, Any]:
    baseline = dict(old.get("baseline", {}))
    keyed = [(key_of(report), report) for report in reports]
    for key, report in keyed:
        if not report.get("environment"):
            baseline.setdefault(key, {"failed": report["failed"], "failures": report.get("failures", []),
                                      "summary": report["summary"]})
    regressions = [report for report in reports if is_regression(report, baseline)]
    signatures = regression_signatures(regressions, baseline)
    return {"reports": reports, "baseline": baseline, "failed": bool(regressions),
            "told": json.dumps(signatures) if regressions else None,
            "signatures": signatures}


def regression_signatures(reports: list[dict[str, Any]], baseline: dict[str, Any]) -> list[str]:
    signatures: list[str] = []
    for report in reports:
        known = set(known_failures(report, baseline))
        fresh = [name for name in report.get("failures", []) if name not in known]
        identities = fresh or [re.sub(r"\d+(?:\.\d+)?m?s\b", "", report["summary"])]
        signatures.extend(json.dumps([key_of(report), identity]) for identity in identities)
    return sorted(signatures)


def block_stop(event: dict[str, Any], current: dict[str, Any]) -> bool:
    if event.get("hook_event_name") != "Stop":
        return False
    return bool(gate_reports(current))


def gate_reports(current: dict[str, Any], checks: list[str] | None = None) -> list[dict[str, Any]]:
    inherited = current.get("gate", {}).get("inherited", "allow") == "block"
    return [report for report in current["reports"]
            if report["failed"] and not report.get("environment")
            and (not checks or report["name"] in checks or report.get("language") in checks)
            and (inherited or is_regression(report, current["baseline"]))]


def protected_output(event: dict[str, Any], cwd: Path) -> dict[str, Any]:
    tool = event.get("tool_name")
    checks = protected_checks(tool if isinstance(tool, str) else "", tool_command(event.get("tool_input")), read_gate(read_override(cwd)))
    if checks is None:
        return {}
    old, current = checked_state(event, cwd)
    current["told"] = old.get("told")
    save_state(event, cwd, current)
    reports = gate_reports(current, checks)
    if not reports:
        return {}
    reason = gate_reason(reports)
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                   "permissionDecisionReason": reason}}


def gate_reason(reports: list[dict[str, Any]]) -> str:
    summaries = "; ".join(f"{report['name']}: {report['summary']}" for report in reports)
    return (f"overwatch: this action is guarded while relevant checks fail. {summaries}. "
            "Inspection, edits, and check commands remain available. Rerun the checks after repairing the failure.")


def baseline_inventory(old: dict[str, Any], current: dict[str, Any], path: Path) -> str:
    """Keep the inherited backlog inspectable without putting it in model context."""
    added = [report for report in current["reports"]
             if key_of(report) not in old.get("baseline", {}) and report["failed"] and not report.get("environment")]
    if not added:
        return ""
    inventory = path.with_suffix(".baseline.json")
    try:
        checks = json.loads(inventory.read_text())["checks"]
    except (OSError, ValueError, KeyError):
        checks = []
    for report in added:
        log = write_log(path, report, "baseline-")
        checks.append({**{key: value for key, value in report.items() if key != "text"}, "log": str(log)})
    inventory.write_text(json.dumps({"checks": checks}, indent=2))
    count = sum(len(report.get("failures", [])) for report in added)
    detail = f"{count} named issues" if count else "individual issue names unavailable; see full logs"
    policy = ("Inherited findings guard completion and protected actions. "
              if current.get("gate", {}).get("inherited") == "block"
              else "It is not a Stop blocker; only new failures are guarded. ")
    return (f"overwatch: inherited backlog in {len(added)} checks ({detail}). "
            f"{policy}"
            f"Triage inventory: `{inventory}`. Filter or page it with hooks/triage.py; full logs are linked there.")


def new_environment(reports: list[dict[str, Any]], told: list[str]) -> list[dict[str, Any]]:
    return [report for report in reports if report.get("environment") and report["environment"] not in told]


def process_event(event: dict[str, Any]) -> dict[str, Any]:
    cwd = repository_of(Path(str(event.get("cwd") or os.getcwd())).resolve())
    if cwd is None:
        return {}
    if event.get("hook_event_name") == "PreToolUse":
        return protected_output(event, cwd)
    old, current = checked_state(event, cwd)
    output = report_output(event, old, current, state_path(event, cwd))
    save_state(event, cwd, current)
    return output


def checked_state(event: dict[str, Any], cwd: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    old = load_state(event, cwd)
    before = fingerprint(cwd)
    should_run = not old or old.get("fingerprint") != before
    watchers = find_watchers(cwd)
    reports = run_checks(cwd, watchers) if should_run else old.get("reports", [])
    current = report_state(reports, old)
    told = list(old.get("environment", []))
    environment = new_environment(reports, told)
    current.update({
        "gate": {"inherited": read_gate(read_override(cwd)).inherited},
        "fingerprint": fingerprint(cwd) if should_run else before,
        "environment": [*told, *(report["environment"] for report in environment)],
    })
    return old, current


def report_output(event: dict[str, Any], old: dict[str, Any], current: dict[str, Any], path: Path) -> dict[str, Any]:
    reports = current["reports"]
    environment = new_environment(reports, list(old.get("environment", [])))
    baseline_notice = baseline_inventory(old, current, path)
    parts: list[str] = [baseline_notice] if baseline_notice else []
    output: dict[str, Any] = {}
    blocking = block_stop(event, current)
    if current["failed"] and current["told"] != old.get("told"):
        regressions = [report for report in reports if is_regression(report, current["baseline"])]
        logs = {key_of(report): write_log(path, report) for report in regressions}
        message = failure_message(regressions, current["baseline"], logs)
        parts.append(message)
        output["systemMessage"] = failure_status(regressions)
    elif not current["failed"] and old.get("failed"):
        parts.append(recovery_message(reports))
    if environment:
        parts.append(environment_message(environment))
        output.setdefault("systemMessage", "Overwatch: some checks cannot run in this environment")
    if blocking:
        output.update({"decision": "block", "reason": gate_reason(gate_reports(current))})
    if parts:
        output.update(context_output(str(event.get("hook_event_name", "")), "\n\n".join(parts)))
    return output


def main() -> int:
    try:
        print(json.dumps(process_event(read_event())))
        return 0
    except ConfigurationError as error:
        print(json.dumps({"systemMessage": f"overwatch: {error}"}))
        return 0
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
        print(json.dumps({"systemMessage": f"overwatch: unexpected error: {error}"}))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
