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
    assert all(isinstance(key, str) for key in value), f"event keys {list(value)} are not all strings; read the event with json.load"
    assert value == json.loads(json.dumps(value)), f"event with keys {list(value)} does not survive a JSON round trip; read it with json.load"
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
    assert path.name == OVERRIDE_PATH, f"read {path} instead of {OVERRIDE_PATH}; build the path from cwd and OVERRIDE_PATH"
    assert all(isinstance(key, str) for key in value), f"{path} gave keys {list(value)}; read it with json.loads"
    return value


def string_list(value: Any, field: str) -> list[str] | None:
    """value as a list of strings, None when it is absent, or ConfigurationError naming field when it is neither."""
    assert field in ("argv", "baseline"), f"string_list was asked for field {field}; only argv and baseline are lists of strings"
    if value is None:
        return None
    strings = [item for item in value if isinstance(item, str)] if isinstance(value, list) else None
    if strings is None or len(strings) != len(value):
        raise ConfigurationError(f"{OVERRIDE_PATH} field {field!r} must be an array of strings")
    assert strings == value, f"{field} kept {len(strings)} of {len(value)} items; reject any item that is not a string"
    return strings


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
    assert result["language"] == language_of(watcher), f"override changed {watcher['name']}'s language to {result['language']}; overrides may not set it"
    assert set(result) >= set(watcher), f"override dropped {set(watcher) - set(result)} from {watcher['name']}; copy every field of the watcher"
    return result


def language_of(watcher: dict[str, Any]) -> str:
    """The language a watcher checks: its language field, else its name."""
    language = watcher.get("language", watcher["name"])
    assert language, f"watcher {watcher['name']} has an empty language; set language or name in watchers.json"
    assert "language" in watcher or language == watcher["name"], f"watcher {watcher['name']} got language {language}; fall back to its name"
    return language


def first_present(alternatives: list[dict[str, Any]], directory: Path) -> dict[str, Any] | None:
    """The first of a language's alternatives whose marker is in directory and whose tool, if it needs one, is on PATH."""
    assert len({language_of(watcher) for watcher in alternatives}) <= 1, f"alternatives span {[watcher['name'] for watcher in alternatives]}; pass one language's"
    present = next((watcher for watcher in alternatives
                    if (directory / watcher["marker"]).exists() and ("requires" not in watcher or shutil.which(watcher["requires"]))), None)
    assert present is None or directory.is_dir(), f"found {present['name'] if present else ''} in {directory}, which is not a directory"
    return present


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
    assert len(set(found)) == len(found), f"subprojects {found} repeat a directory; visit each parent once"
    assert all(part.count("/") < SEARCH_DEPTH for part in found), f"subprojects {found} go past {SEARCH_DEPTH} levels; stop at SEARCH_DEPTH"
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
    keys = [key_of(watcher) for watcher in found]
    assert len(set(keys)) == len(keys), f"watchers {keys} repeat a check; find each language once per directory"
    assert not any(Path(watcher.get("dir", "")).is_absolute() for watcher in found), f"watchers {keys} hold an absolute dir; keep dirs relative to {cwd}"
    return found


def find_watchers(cwd: Path) -> list[dict[str, Any]]:
    """The watchers and checkers to run in cwd, after its .overwatch.json override."""
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
    assert all("name" in watcher for watcher in found), f"found {found} with an unnamed watcher; every watcher needs a name"
    assert len({key_of(watcher) for watcher in found}) == len(found), f"found {[key_of(watcher) for watcher in found]} in {cwd}; find each check once"
    return found


def command_for(watcher: dict[str, Any]) -> tuple[list[str], bool] | None:
    """The command to run for a watcher's first result, and whether to stop it after its report."""
    baseline, argv = watcher.get("baseline"), watcher.get("argv")
    selected = (list(baseline), False) if baseline else (list(argv), True) if argv else None
    assert selected is None or selected[0], f"{watcher['name']} selected an empty command; return None when it has none"
    assert selected is None or selected[1] == (not baseline), f"{watcher['name']} would stop its baseline after a report; only stop argv"
    return selected


def command_line(argv: list[str]) -> str:
    """argv as one line, for messages and logs."""
    assert argv, "command_line was given an empty command; pass the argv a watcher runs"
    line = " ".join(argv)
    assert line.startswith(argv[0]), f"command line {line} does not start with {argv[0]}; join argv in order"
    return line


def terminate(process: subprocess.Popen[bytes]) -> bytes:
    """Stops process, killing it when it ignores the request, and returns what it printed meanwhile."""
    process.terminate()
    try:
        tail, _ = process.communicate(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        tail, _ = process.communicate()
    assert process.returncode is not None, f"process {process.pid} still runs after terminate; kill it"
    assert process.stdout is None or process.stdout.closed, f"process {process.pid}'s output is still open; communicate must read it to the end"
    return tail or b""


def read_available(selector: selectors.BaseSelector) -> bytes:
    """Whatever the registered output holds within a tenth of a second, up to 64 KiB; nothing when it holds none."""
    selected = selector.select(timeout=0.1)
    if not selected:
        return b""
    key, _ = selected[0]
    assert len(selected) == 1, f"selector watched {len(selected)} outputs; register only the process's stdout"
    chunk = os.read(key.fd, 65_536)
    assert len(chunk) <= 65_536, f"read {len(chunk)} bytes; read at most 64 KiB at once"
    return chunk


def run_command(
    cwd: Path, watcher: dict[str, Any], argv: list[str], stop_after_report: bool,
) -> tuple[str, int | None]:
    """Runs argv, returning what it printed and its exit code; None when stopped after its report."""
    assert not stop_after_report or "summary" in watcher, f"{watcher['name']} is stopped after its report but has no summary; give it one in watchers.json"
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
    assert process.stdout is not None, f"{command} started without an output pipe; open it with stdout=PIPE"

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
    assert len(names) == len(seen), f"failures {names} repeat a name; add each once"
    assert all(name == name.strip() and name for name in names), f"failures {names} keep blank or padded names; strip them and skip empty ones"
    return names


def environment_in(output: str) -> str | None:
    """The first line saying the command failed for want of something in its environment, not because of the code."""
    line = next((line.strip() for line in output.splitlines() if any(pattern.search(line) for pattern in ENVIRONMENT)), None)
    assert line is None or "\n" not in line, f"environment line {line} spans lines; take one line of the output"
    assert line is None or line in output, f"environment line {line} is not in the output; return the line as printed"
    return line


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
    assert selected is not None, f"{watcher['name']} reported without a command; give it argv or baseline in watchers.json"
    report = {
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
    assert report["failed"] or not report["failures"], f"{watcher['name']} passed with failures {failures}; list failures only when it failed"
    return report


def run_check(cwd: Path, watcher: dict[str, Any]) -> dict[str, Any] | None:
    """Runs one watcher's command and reads its report, or None when it has no command."""
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
    assert report["name"] == watcher["name"], f"{watcher['name']} reported as {report['name']}; name the report after its watcher"
    assert report["command"] == command_line(argv), f"{watcher['name']} reported {report['command']} but ran {command_line(argv)}"
    return report


def run_checks(cwd: Path, watchers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Runs every watcher's check at once, so a polyglot project waits for its slowest suite, not the sum of them."""
    if not watchers:
        return []
    with ThreadPoolExecutor(max_workers=len(watchers)) as pool:
        reports = list(pool.map(lambda watcher: run_check(cwd, watcher), watchers))
    assert len(reports) == len(watchers), f"ran {len(reports)} of {len(watchers)} checks; map every watcher"
    ran = [report for report in reports if report is not None]
    assert [report["name"] for report in ran] == [watcher["name"] for watcher, report in zip(watchers, reports) if report], f"reports {[report['name'] for report in ran]} are out of watcher order"
    return ran


def fingerprint(cwd: Path) -> str:
    """A digest of the path, size and modification time of every file git would track in cwd."""
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
    assert all(path.is_relative_to(cwd) for path in paths), f"fingerprinted {[path for path in paths if not path.is_relative_to(cwd)]} outside {cwd}"
    value = digest.hexdigest()
    assert len(value) == 40, f"fingerprint {value} is not 20 bytes; keep digest_size=20"
    return value


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
    root = Path(result.stdout.strip()).resolve()
    assert root.is_absolute(), f"repository root {root} is relative; resolve it"
    assert cwd.resolve().is_relative_to(root), f"repository root {root} does not hold {cwd}; ask git from cwd"
    return root


def state_path(event: dict[str, Any], cwd: Path) -> Path:
    """Where the state of one session in one repository is kept."""
    data = Path(os.environ.get("PLUGIN_DATA", Path.home() / ".cache" / "overwatch"))
    identity = f"{event.get('session_id', '')}\0{cwd}"
    path = data / f"{hashlib.sha256(identity.encode()).hexdigest()}.json"
    assert path.parent == data, f"state path {path} is outside {data}; name it by digest alone"
    assert path.suffix == ".json", f"state path {path} is not JSON; save_state's temporary file swaps the suffix"
    return path


def load_state(event: dict[str, Any], cwd: Path) -> dict[str, Any]:
    """The session's saved state in cwd, or an empty one when none was saved or it cannot be read."""
    path = state_path(event, cwd)
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        value = {}
    state = value if isinstance(value, dict) else {}
    assert state is value or not isinstance(value, dict), f"{path} held an object that was dropped; keep it"
    assert all(isinstance(key, str) for key in state), f"{path} gave keys {list(state)}; read it with json.loads"
    return state


def save_state(event: dict[str, Any], cwd: Path, value: dict[str, Any]) -> None:
    """Saves the session's state in cwd, replacing the old state in one step."""
    path = state_path(event, cwd)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    assert temporary != path, f"state {path} would be written over itself; save through a temporary file"
    temporary.write_text(json.dumps(value))
    temporary.replace(path)
    assert not temporary.exists(), f"{temporary} was left behind; replace the state file with it"


def failing_line(failures: list[str]) -> str:
    """Names the failing tests, the first FAILURE_LIMIT of them, for the agent."""
    if not failures:
        return ""
    named = ", ".join(f"`{name}`" for name in failures[:FAILURE_LIMIT])
    more = f", and {len(failures) - FAILURE_LIMIT} more" if len(failures) > FAILURE_LIMIT else ""
    line = f"Failing: {named}{more}.\n"
    assert line.startswith(f"Failing: `{failures[0]}`"), f"line {line} does not name {failures[0]} first; quote the first {FAILURE_LIMIT} in order"
    assert (len(failures) > FAILURE_LIMIT) == line.endswith(" more.\n"), f"line {line} for {len(failures)} failures miscounts the rest"
    return line


def where(report: dict[str, Any]) -> str:
    """The sub-project a report's command ran in, for the agent."""
    text = f" in `{report['dir']}`" if report.get("dir") else ""
    assert bool(text) == bool(report.get("dir")), f"where gave {text} for dir {report.get('dir')}; name the dir only when there is one"
    assert not text or text.endswith(f"`{report['dir']}`"), f"where gave {text}; quote the dir {report.get('dir')}"
    return text


def key_of(report: dict[str, Any]) -> str:
    """What identifies a check across runs: its name and the sub-project it ran in."""
    assert "\0" not in report["name"], f"check name {report['name']} holds a NUL; key_of separates fields with one"
    key = f"{report['name']}\0{report.get('dir') or ''}"
    assert key.split("\0")[0] == report["name"], f"key {key} does not start with {report['name']}"
    return key


def known_failures(report: dict[str, Any], baseline: dict[str, Any]) -> list[str]:
    """The failures this check already had when the session started."""
    first = baseline.get(key_of(report), {})
    known = list(first.get("failures", [])) if first.get("failed") else []
    assert first.get("failed") or not known, f"{report['name']} knows failures {known} from a passing baseline"
    assert len(known) == len(first.get("failures", [])) or not first.get("failed"), f"{report['name']} kept {len(known)} known failures; keep all of them"
    return known


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
    previous, counts = failure_counts(first["summary"]), failure_counts(report["summary"])
    grew = [kind for kind, count in counts.items() if count > previous.get(kind, 0)]
    assert first.get("failed") and report["failed"], f"{report['name']} compared counts without two failing results; compare only failing ones"
    assert set(grew) <= set(counts), f"{report['name']} grew in {grew}, which its summary does not count"
    return bool(grew)


def failure_counts(summary: str) -> dict[str, int]:
    """Counts are a fallback when a runner does not identify individual issues."""
    counts: dict[str, int] = {}
    for number, label in re.findall(r"(\d+)\s+(errors?|warnings?|failures?|failed|fail)\b", summary):
        kind = "error" if label.startswith("error") else "warning" if label.startswith("warning") else "failure"
        counts[kind] = max(counts.get(kind, 0), int(number))
    assert set(counts) <= {"error", "warning", "failure"}, f"summary {summary} counted kinds {set(counts)}; fold each label into error, warning or failure"
    assert all(str(count) in summary for count in counts.values()), f"counts {counts} are not in summary {summary}; take each from it"
    return counts


def write_log(path: Path, report: dict[str, Any], prefix: str = "") -> Path:
    """Writes a report's full output beside the session's state, keeping it out of the conversation."""
    log = path.with_suffix("") / f"{prefix}{hashlib.sha256(key_of(report).encode()).hexdigest()[:16]}.log"
    assert log.parent == path.with_suffix(""), f"log {log} is outside {path.with_suffix('')}; name it by digest alone"
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text(report["text"])
    assert log.stat().st_size >= len(report["text"]), f"{log} holds {log.stat().st_size} bytes of {report['name']}'s output; write all of it"
    return log


def failure_message(reports: list[dict[str, Any]], baseline: dict[str, Any], logs: dict[str, Path]) -> str:
    """Tells the agent which checks newly fail, what fails in each and where the full output is."""
    assert all(key_of(report) in logs for report in reports), f"no log for {[report['name'] for report in reports if key_of(report) not in logs]}; write one for each report"
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
    text = "\n\n".join(messages)
    assert text.count("Full output: ") == len(reports), f"message links {text.count('Full output: ')} logs for {len(reports)} reports; link each once"
    return text


def environment_message(reports: list[dict[str, Any]]) -> str:
    """Tells the agent which checks cannot run where they are, and that no code change fixes that."""
    assert all(report.get("environment") for report in reports), f"{[report['name'] for report in reports if not report.get('environment')]} have no environment line; pass only checks that cannot run"
    lines = "\n".join(f"- `{report['command']}`{where(report)}: {report['environment']}" for report in reports)
    assert lines.count("\n- ") == max(len(reports) - 1, 0), f"environment message lists {lines.count(chr(10) + '- ') + 1} lines for {len(reports)} checks"
    return (
        "overwatch: these checks cannot run in this environment, so they are not reporting. "
        f"This is not caused by your changes and needs no code change:\n{lines}"
    )


def failing_suffix(failures: list[str]) -> str:
    """The first failure and how many more, for the status line."""
    if not failures:
        return ""
    more = f" +{len(failures) - 1} more" if len(failures) > 1 else ""
    suffix = f": {failures[0]}{more}"
    assert suffix.startswith(f": {failures[0]}"), f"suffix {suffix} does not name {failures[0]} first"
    assert (len(failures) > 1) == suffix.endswith(" more"), f"suffix {suffix} for {len(failures)} failures miscounts the rest"
    return suffix


def failure_status(reports: list[dict[str, Any]]) -> str:
    """The status line for failing checks, one part each."""
    assert reports, "failure_status was given no reports; pass the checks that newly fail"
    summaries = " · ".join(
        f"{report['name']} ✗ {SUMMARY_DECORATION.sub('', report['summary'])}{failing_suffix(report.get('failures', []))}"
        for report in reports
    )
    assert summaries.count(" ✗ ") >= len(reports), f"status {summaries} marks fewer than {len(reports)} checks; give each one part"
    return f"Overwatch: {summaries}"


def recovery_message(reports: list[dict[str, Any]]) -> str:
    """Tells the agent the checks pass again, with each one's summary."""
    summaries = " · ".join(f"overwatch {report['name']} ✓ {SUMMARY_DECORATION.sub('', report['summary'])}" for report in reports)
    assert summaries.count(" ✓ ") >= len(reports), f"recovery {summaries} marks fewer than {len(reports)} checks; give each one part"
    text = f"overwatch: green again. {summaries}"
    assert text.endswith(summaries), f"recovery {text} drops the summaries; end with them"
    return text


def context_output(event_name: str, text: str) -> dict[str, Any]:
    """The hook output that adds text to the agent's context for event_name."""
    assert text, f"context for {event_name} is empty; add context only when there is something to say"
    output = {
        "hookSpecificOutput": {
            "hookEventName": event_name,
            "additionalContext": text,
        }
    }
    assert json.loads(json.dumps(output)) == output, f"context for {event_name} is not plain JSON; pass text as a string"
    return output


def report_state(reports: list[dict[str, Any]], old: dict[str, Any]) -> dict[str, Any]:
    """The state after reports: the baseline with each new check's first result, and the regressions against it."""
    baseline = dict(old.get("baseline", {}))
    keyed = [(key_of(report), report) for report in reports]
    for key, report in keyed:
        if not report.get("environment"):
            baseline.setdefault(key, {"failed": report["failed"], "failures": report.get("failures", []),
                                      "summary": report["summary"]})
    regressions = [report for report in reports if is_regression(report, baseline)]
    signatures = regression_signatures(regressions, baseline)
    assert set(old.get("baseline", {})) <= set(baseline), f"baseline lost {set(old.get('baseline', {})) - set(baseline)}; keep each check's first result"
    assert bool(signatures) == bool(regressions), f"{len(regressions)} regressions gave signatures {signatures}; sign each one"
    return {"reports": reports, "baseline": baseline, "failed": bool(regressions),
            "told": json.dumps(signatures) if regressions else None,
            "signatures": signatures}


def regression_signatures(reports: list[dict[str, Any]], baseline: dict[str, Any]) -> list[str]:
    """What identifies each regression, the new failures or else the summary without timings, sorted."""
    signatures: list[str] = []
    for report in reports:
        known = set(known_failures(report, baseline))
        fresh = [name for name in report.get("failures", []) if name not in known]
        identities = fresh or [re.sub(r"\d+(?:\.\d+)?m?s\b", "", report["summary"])]
        signatures.extend(json.dumps([key_of(report), identity]) for identity in identities)
    assert len(signatures) >= len(reports), f"{len(reports)} regressions gave {len(signatures)} signatures; sign each at least once"
    assert all(json.loads(signature)[0] in {key_of(report) for report in reports} for signature in signatures), f"signatures {signatures} name a check that did not regress"
    return sorted(signatures)


def block_stop(event: dict[str, Any], current: dict[str, Any]) -> bool:
    """Whether a Stop event is refused because guarded checks fail."""
    if event.get("hook_event_name") != "Stop":
        return False
    guarded = gate_reports(current)
    assert all(report in current["reports"] for report in guarded), f"guarded {[report['name'] for report in guarded]} are not this run's reports"
    assert all(report["failed"] for report in guarded), f"{[report['name'] for report in guarded if not report['failed']]} pass but block Stop"
    return bool(guarded)


def gate_reports(current: dict[str, Any], checks: list[str] | None = None) -> list[dict[str, Any]]:
    """The failing reports that guard an action: those among checks, inherited ones only when the policy blocks them."""
    inherited = current.get("gate", {}).get("inherited", "allow") == "block"
    guarded = [report for report in current["reports"]
               if report["failed"] and not report.get("environment")
               and (not checks or report["name"] in checks or report.get("language") in checks)
               and (inherited or is_regression(report, current["baseline"]))]
    assert len(guarded) <= len(current["reports"]), f"guarded {len(guarded)} of {len(current['reports'])} reports; select from them"
    assert not any(report.get("environment") for report in guarded), f"{[report['name'] for report in guarded if report.get('environment')]} cannot run but guard; leave them out"
    return guarded


def protected_output(event: dict[str, Any], cwd: Path) -> dict[str, Any]:
    """The PreToolUse output: a denial when the tool call is protected and its checks fail, else nothing."""
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
    assert all(report["failed"] for report in reports), f"{[report['name'] for report in reports if not report['failed']]} pass but deny the call"
    assert all(not checks or report["name"] in checks or report.get("language") in checks for report in reports), f"{[report['name'] for report in reports]} guard a call protected only by {checks}"
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                   "permissionDecisionReason": reason}}


def gate_reason(reports: list[dict[str, Any]]) -> str:
    """Why an action is refused: the failing checks that guard it, and that repairs remain possible."""
    assert reports, "gate_reason was given no reports; give it the checks that guard the action"
    summaries = "; ".join(f"{report['name']}: {report['summary']}" for report in reports)
    assert all(f"{report['name']}: " in summaries for report in reports), f"reason {summaries} leaves out a guarding check"
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
    assert len(checks) >= len(added), f"inventory {inventory} holds {len(checks)} checks after adding {len(added)}; append every one"
    assert all("text" not in check for check in checks[-len(added):]), f"inventory {inventory} kept a report's output; link its log instead"
    count = sum(len(report.get("failures", [])) for report in added)
    detail = f"{count} named issues" if count else "individual issue names unavailable; see full logs"
    policy = ("Inherited findings guard completion and protected actions. "
              if current.get("gate", {}).get("inherited") == "block"
              else "It is not a Stop blocker; only new failures are guarded. ")
    return (f"overwatch: inherited backlog in {len(added)} checks ({detail}). "
            f"{policy}"
            f"Triage inventory: `{inventory}`. Filter or page it with hooks/triage.py; full logs are linked there.")


def new_environment(reports: list[dict[str, Any]], told: list[str]) -> list[dict[str, Any]]:
    """The reports that cannot run for a reason the agent has not been told yet."""
    fresh = [report for report in reports if report.get("environment") and report["environment"] not in told]
    assert all(report in reports for report in fresh), f"new environment reports {[report['name'] for report in fresh]} are not among the reports"
    assert not any(report["environment"] in told for report in fresh), f"{[report['environment'] for report in fresh]} repeat what the agent was told"
    return fresh


def process_event(event: dict[str, Any]) -> dict[str, Any]:
    """The hook output for one event, saving the state it leaves."""
    cwd = repository_of(Path(str(event.get("cwd") or os.getcwd())).resolve())
    if cwd is None:
        return {}
    if event.get("hook_event_name") == "PreToolUse":
        return protected_output(event, cwd)
    old, current = checked_state(event, cwd)
    output = report_output(event, old, current, state_path(event, cwd))
    assert "fingerprint" in current, f"state for {cwd} has no fingerprint; checked_state must record one"
    save_state(event, cwd, current)
    assert state_path(event, cwd).exists(), f"no state was saved for {cwd}; save_state must write it"
    return output


def checked_state(event: dict[str, Any], cwd: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    """The saved state and the state after rerunning the checks when the workspace changed since it was saved."""
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
    assert current["environment"][:len(told)] == told, f"environment {current['environment']} forgot what the agent was told; keep {told} first"
    assert should_run or current["reports"] == old.get("reports", []), f"unchanged workspace {cwd} got new reports; reuse the saved ones"
    return old, current


def report_output(event: dict[str, Any], old: dict[str, Any], current: dict[str, Any], path: Path) -> dict[str, Any]:
    """The hook output for the new state: what newly fails, recovers or cannot run, and a Stop refusal when guarded."""
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
    assert blocking == (output.get("decision") == "block"), f"output {output} disagrees with blocking={blocking}; block only a guarded Stop"
    assert bool(parts) == ("hookSpecificOutput" in output), f"output {output} drops or invents context for {len(parts)} parts"
    return output


def main() -> int:
    """Answers one hook event on stdin with JSON on stdout, reporting any problem as a system message."""
    try:
        output = json.dumps(process_event(read_event()))
        assert output.startswith("{"), f"hook output {output[:40]} is not a JSON object; return a dict from process_event"
        assert "\n" not in output, "hook output spans lines; print it as one JSON line"
        print(output)
        return 0
    except ConfigurationError as error:
        print(json.dumps({"systemMessage": f"overwatch: {error}"}))
        return 0
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
        print(json.dumps({"systemMessage": f"overwatch: unexpected error: {error}"}))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
