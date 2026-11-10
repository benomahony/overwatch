#!/usr/bin/env python3
"""Validates traces of the real engine against spec/Overwatch.tla.

Runs the engine as Codex runs it, under seeded random environments: the agent's edits during its turns, another
process's edits, commit moves, and checks that pass, fail, hang past their deadline, or see an edit while they run.
It logs each thing the environment did and what the engine reported after each hook, then asks TLC whether some
behaviour of the model has that log, letting the model take its own steps (starting, ticking, ending and reading a
check, flushing a message) wherever it needs them. A log that no behaviour has is a conformance bug; the report
names the first entry no behaviour could reach.

Usage: python3 tests/trace_validation.py --jar /path/to/tla2tools.jar [--traces N] [--seed S]

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys
import tempfile
from unittest.mock import patch

# Run as a script, this file's directory holds paths, which puts engine/ on the import path for the imports after it.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import paths
import engine
from test_model_paths import build_output

assert str(paths.ROOT / "engine") in sys.path, f"{paths.ROOT / 'engine'} is not on sys.path {sys.path}; paths puts engine/ there"
ROOT = paths.ROOT

# How long a check may run before the engine must give up on it; short, so a hanging check costs the run little.
TIMEOUT_SECONDS = 1.5
# How many versions of the workspace a trace may make, the model's MaxEdits.
MAX_VERSIONS = 4
EVENTS_PER_TRACE = 10
NAMES = ("a", "b")
GIT = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}

# The project's one check: reads the workspace's version, follows the plan for it, and prints its result.
CHECK = '''
import json, sys, time
from pathlib import Path
version = int(Path("build.zig").read_text().split()[1])
plan = json.loads(Path(sys.argv[1]).read_text())[str(version)]
if plan["overlap"]:
    # Another process edits the workspace while this check runs, which still reports the version it read.
    Path("build.zig").write_text(f"version {version + 1}")
    with open(sys.argv[2], "a") as overlaps:
        overlaps.write(f"{version + 1}\\n")
if plan["hang"]:
    time.sleep(3600)
print(plan["output"], end="", flush=True)
'''


class EngineTrace:
    """One project, session and environment, and the log of what happened to them."""

    def __init__(self, root: Path, rng: random.Random) -> None:
        self.rng = rng
        self.root = root
        self.project = root / "project"
        self.data = root / "data"
        self.plan_path = root / "plan.json"
        self.overlaps = root / "overlaps"
        self.project.mkdir()
        self.data.mkdir()
        self.version = 0
        self.turn = False
        self.log: list[dict[str, object]] = []
        # Each version's failures, and whether a check of it hangs or sees another process's edit.
        failures = [sorted(rng.sample(NAMES, rng.randint(0, 2))) for _ in range(MAX_VERSIONS + 1)]
        self.plan = {str(version): {"failures": names, "output": build_output(names), "hang": rng.random() < 0.1, "overlap": False}
                     for version, names in enumerate(failures)}
        (root / "check.py").write_text(CHECK)
        # The project's zig watcher runs the fixture check in place of its own command and reads it with its own patterns.
        override = {"baseline": [sys.executable, str(root / "check.py"), str(self.plan_path), str(self.overlaps)], "timeout": TIMEOUT_SECONDS,
                    "gate": {"protected_actions": [{"tool": "Publish", "checks": []}]},
                    "watchers": {"zanity": {"enabled": False}, "git": {"enabled": False}}}
        (self.project / ".overwatch.json").write_text(json.dumps(override))
        (self.project / "build.zig").write_text("version 0")
        self.git(["init", "-q"])
        self.git(["add", "-A"])
        self.git(["commit", "-q", "-m", "start"])
        self.save_plan()
        assert self.version == 0 and not self.log, "a trace starts at version 0 with nothing logged"

    def git(self, args: list[str]) -> str:
        assert args, "git was given no arguments; pass the subcommand and its arguments"
        return subprocess.run(["git", *args], cwd=self.project, check=True, capture_output=True, text=True,
                              env={**os.environ, **GIT}).stdout.strip()

    def save_plan(self) -> None:
        self.plan_path.write_text(json.dumps(self.plan))

    def hook(self, name: str, tool: str = "") -> dict[str, object]:
        """Sends one hook event to the engine, as Codex does, with the short deadline, and logs any overlap."""
        event = engine.Event(name, "trace", str(self.project), tool, {})
        with patch.dict("os.environ", {"PATH": "/usr/bin:/bin"}):
            try:
                output = engine.process_event(event, self.data)
            except engine.ConfigurationError as error:
                output = {"error": str(error)}
        self.note_overlaps()
        return output

    def note_overlaps(self) -> None:
        """Logs each edit a check made while it ran, as the other process's edit it stands for."""
        if not self.overlaps.exists():
            return
        for line in self.overlaps.read_text().split():
            self.version = int(line)
            self.log.append({"kind": "Outside"})
        self.overlaps.unlink()

    def observe(self) -> None:
        """Logs what the engine reports now: the check's failures and whether a protected action is held."""
        output = self.hook("PreToolUse", "Publish")
        guarded = output.get("hookSpecificOutput", {}).get("permissionDecision") == "deny"
        event = engine.Event("", "trace", "", "", {})
        with engine.locked(engine.state_path(event, self.project, self.data), self.data) as session:
            reports = engine.load_state(session).reports
        failures = ["error"] if "error" in output else sorted(reports[0].failures) if reports and reports[0].failed else []
        self.log.append({"kind": "Observe", "known": bool(reports) or "error" in output, "failures": failures, "guarded": guarded})

    def bump(self) -> None:
        """Writes the workspace's next version, letting its check see an edit once, when versions remain for it."""
        self.version += 1
        if self.version + 1 < MAX_VERSIONS and self.rng.random() < 0.15:
            self.plan[str(self.version)]["overlap"] = True
            self.save_plan()
        (self.project / "build.zig").write_text(f"version {self.version}")

    def step(self) -> None:
        """One thing the environment does, chosen among those it may do now, then what the engine reports."""
        room = self.version + 2 < MAX_VERSIONS
        choices = ["Complete"] if self.turn else ["Start"]
        if room:
            choices += ["Outside", "Move"] + (["Edit", "Edit"] if self.turn else [])
        kind = self.rng.choice(choices)
        if kind == "Start":
            self.log.append({"kind": "Start"})
            self.turn = True
            self.hook("UserPromptSubmit")
        elif kind == "Complete":
            self.log.append({"kind": "Complete"})
            self.turn = self.hook("Stop").get("decision") == "block"
        elif kind == "Edit":
            # Codex runs an editing tool's PreToolUse before the tool itself, as the agent starts its edit.
            self.hook("PreToolUse", "Edit")
            self.bump()
            self.log.append({"kind": "Edit"})
            self.hook("PostToolUse", "Edit")
        elif kind == "Outside":
            self.bump()
            self.log.append({"kind": "Outside"})
        else:
            self.bump()
            self.git(["add", "-A"])
            commit = self.git(["commit-tree", self.git(["write-tree"]), "-p", "HEAD", "-m", f"version {self.version}"])
            self.git(["reset", "-q", "--hard", commit])
            self.log.append({"kind": "Move"})
        self.observe()

    def run(self) -> list[dict[str, object]]:
        self.hook("SessionStart")
        self.observe()
        for _ in range(EVENTS_PER_TRACE):
            self.step()
        assert self.version <= MAX_VERSIONS, f"the trace made {self.version} versions, past {MAX_VERSIONS}"
        return self.log


VALIDATOR = r'''------------------------- MODULE Validate -------------------------
EXTENDS Overwatch, TLC
Logs == LOGS
Truths == TRUTHS
\* The versions whose check the harness makes hang: only a run of one may time out, as a timeout is the environment's.
Hangs == HANGS
VARIABLES scenario, i
ValInit == Init /\ scenario \in 1..Len(Logs) /\ truth = Truths[scenario] /\ i = 1
Entry == Logs[scenario][i]
Env == CASE Entry.kind = "Edit" -> Edit
         [] Entry.kind = "Outside" -> OutsideEdit
         [] Entry.kind = "Move" -> HeadMoves
         [] Entry.kind = "Start" -> TurnStarts
         [] Entry.kind = "Complete" -> TurnCompletes
         [] OTHER -> FALSE
Seen == report.known = Entry.known /\ report.failures = Entry.failures /\ Guard = Entry.guarded
Internal == QuietElapses \/ Tick \/ RunEnds \/ (TimesOut /\ from \in Hangs[scenario]) \/ ReadResults \/ Flush
ValNext == \/ i <= Len(Logs[scenario]) /\ Entry.kind # "Observe" /\ Env /\ i' = i + 1 /\ UNCHANGED scenario
           \/ i <= Len(Logs[scenario]) /\ Entry.kind = "Observe" /\ Seen /\ i' = i + 1 /\ UNCHANGED <<vars, scenario>>
           \/ Internal /\ UNCHANGED <<scenario, i>>
Reached == PrintT("TRACE_REACHED " \o ToString(scenario) \o " " \o ToString(i))
=============================================================================
'''


def report_set(names: list[str]) -> str:
    """An observed set of outcomes as TLA+: failure names, and the timeout or error a check ended with."""
    return "{" + ", ".join(json.dumps(name) for name in names) + "}"


def tla_entry(entry: dict[str, object]) -> str:
    known, failures, guarded = entry.get("known", False), entry.get("failures", []), entry.get("guarded", False)
    return f'[kind |-> "{entry["kind"]}", known |-> {"TRUE" if known else "FALSE"}, failures |-> {report_set(failures)}, guarded |-> {"TRUE" if guarded else "FALSE"}]'


def validate(jar: Path, traces: list[tuple[dict[str, dict], list[dict[str, object]]]]) -> dict[int, int]:
    """For each trace, the furthest entry some behaviour of the model reached: past its end when one has it all."""
    logs = "<<" + ", ".join("<<" + ", ".join(tla_entry(entry) for entry in log) + ">>" for _, log in traces) + ">>"
    truths = "<<" + ", ".join("[v \\in Versions |-> CASE " + " [] ".join(
        f'v = {version} -> {report_set(plan[str(version)]["failures"])}' for version in range(MAX_VERSIONS + 1)) + " [] OTHER -> {}]"
        for plan, _ in traces) + ">>"
    with tempfile.TemporaryDirectory(prefix="overwatch-validate-") as directory:
        work = Path(directory)
        for name in ("Overwatch.tla", "FailurePolicy.tla"):
            shutil.copyfile(ROOT / "spec" / name, work / name)
        hangs = "<<" + ", ".join("{" + ", ".join(version for version in plan if plan[version]["hang"]) + "}" for plan, _ in traces) + ">>"
        (work / "Validate.tla").write_text(VALIDATOR.replace("LOGS", logs).replace("TRUTHS", truths).replace("HANGS", hangs))
        (work / "Validate.cfg").write_text(f'''INIT ValInit
NEXT ValNext
CONSTANTS
    Names = {{"a", "b"}}
    MaxEdits = {MAX_VERSIONS}
    Timeout = 2
INVARIANTS
    Reached
''')
        result = subprocess.run(["java", "-XX:+UseParallelGC", "-Xmx2g", "-cp", str(jar), "tlc2.TLC", "-workers", "auto", "-deadlock",
                                 "-metadir", str(work / "states"), str(work / "Validate.tla")], text=True, capture_output=True, timeout=1800)
        if result.returncode:
            raise RuntimeError(f"TLC could not validate the traces:\n{result.stdout[-4000:]}\n{result.stderr[-2000:]}")
    reached: dict[int, int] = {}
    for line in result.stdout.splitlines():
        if line.startswith('"TRACE_REACHED '):
            scenario, index = map(int, json.loads(line).split()[1:])
            reached[scenario] = max(reached.get(scenario, 0), index)
    return reached


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--jar", type=Path, default=os.environ.get("TLA2TOOLS_JAR", str(Path.home() / ".cache/tlalings/tla2tools.jar")))
    parser.add_argument("--traces", type=int, default=40)
    parser.add_argument("--seed", type=int, default=20261110)
    args = parser.parse_args()
    if not args.jar.is_file():
        parser.error("Set TLA2TOOLS_JAR or pass --jar pointing to tla2tools.jar")
    traces = []
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="owv") as directory:
        for index in range(args.traces):
            root = Path(directory).resolve() / str(index)
            root.mkdir()
            trace = EngineTrace(root, random.Random(args.seed + index))
            traces.append((trace.plan, trace.run()))
    reached = validate(args.jar.resolve(), traces)
    rejected = [(scenario, reached.get(scenario, 0)) for scenario in range(1, len(traces) + 1)
                if reached.get(scenario, 0) <= len(traces[scenario - 1][1])]
    for scenario, index in rejected:
        plan, log = traces[scenario - 1]
        print(f"trace {scenario - 1} (seed {args.seed + scenario - 1}) leaves the model at entry {index}: {json.dumps(log[index - 1])}")
        print("  truth " + json.dumps({version: plan[version]["failures"] for version in plan}) +
              " hangs " + json.dumps([version for version in plan if plan[version]["hang"]]))
        for position, entry in enumerate(log[:index], 1):
            print(f"  {position:2} {json.dumps(entry)}")
    print(f"{len(traces) - len(rejected)} of {len(traces)} engine traces are behaviours of the model")
    if rejected:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
