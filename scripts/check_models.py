#!/usr/bin/env python3
"""Run TLC on the configurations that CI can afford and check what each must say.

A configuration passes or it does not. A refinement check shows that Overwatch with TcrMode off
and the system model as it was before TCR describe the same behaviors. A probe asks TLC for a
trace of something that must be possible, or for none of something that must be impossible, so
a property of TCR cannot hold only because its scenario is unreachable.

Set TLA2TOOLS_JAR or pass --jar. IntegrationContract.cfg takes about ten minutes and a large
heap, and OverwatchTcrNotices.cfg explores 478 million states, so they run only with --full.
OverwatchTcrReverts.cfg explores 153 million states and runs with --reverts, which CI gives a
job of its own, and the 66 runs that leave out one action's fairness run with --fairness. No
single run may take longer than TLC_TIMEOUT, which is under the time limit of a CI job.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "spec"
PROBE_BOUNDS = "    Names = {\"a\"}\n    Timeout = 1\n    TcrMode = TRUE\n    SaveReverted = TRUE\n    StartQueued = FALSE\n"
TLC_HEAP = "-Xmx4g"
TLC_TIMEOUT = 2400


@dataclass(frozen=True)
class Run:
    name: str
    module: str
    config: str
    expected: str
    heavy: bool = False
    edit: tuple[str, str] | None = None
    group: str = ""


def probe(name: str, edits: int, expected: str) -> Run:
    assert edits >= 2, f"a probe with {edits} workspace edits cannot reach a revert"
    assert expected in ("pass", "violation"), f"probe {name} expects {expected}, which TLC never says"
    config = f"SPECIFICATION Spec\nCONSTANTS\n{PROBE_BOUNDS}    MaxEdits = {edits}\nPROPERTIES\n    {name}\n"
    return Run(f"probe {name} with {edits} edits", "Probes", config, expected)


def checked(config: str, module: str, heavy: bool = False, group: str = "") -> Run:
    assert (SPEC / f"{config}.cfg").is_file(), f"spec/{config}.cfg does not exist"
    assert (SPEC / f"{module}.tla").is_file(), f"spec/{module}.tla does not exist"
    return Run(f"configuration {config}", module, (SPEC / f"{config}.cfg").read_text(), "pass", heavy, group=group)


def mutant(name: str, module: str, old: str, new: str) -> Run:
    """A refinement check of a copy of Overwatch.tla in which old is replaced by new; TLC must find the break."""
    assert old in (SPEC / "Overwatch.tla").read_text(), f"mutant {name} replaces {old!r}, which Overwatch.tla does not hold"
    assert old != new, f"mutant {name} replaces {old!r} with itself"
    base = refinement(module)
    return Run(f"mutant {name} of refinement {module}", module, base.config, "violation", edit=(old, new))


def property_mutant(name: str, edit: tuple[str, str], claim: str, names: str = '{"a"}') -> Run:
    """A check of one TCR property against a copy of Overwatch.tla in which old is replaced by new; TLC must find the break."""
    old, new = edit
    assert old in (SPEC / "Overwatch.tla").read_text(), f"mutant {name} replaces {old!r}, which Overwatch.tla does not hold"
    assert old != new, f"mutant {name} replaces {old!r} with itself"
    bounds = PROBE_BOUNDS.replace('Names = {"a"}', f"Names = {names}")
    assert names in bounds, f"the bounds {bounds!r} do not hold the names {names}"
    config = f"SPECIFICATION Spec\nCONSTANTS\n{bounds}    MaxEdits = 2\nPROPERTIES\n    {claim}\n"
    return Run(f"mutant {name} of property {claim}", "Overwatch", config, "violation", edit=(old, new))


def refinement(module: str) -> Run:
    assert (SPEC / "refinement" / f"{module}.cfg").is_file(), f"spec/refinement/{module}.cfg does not exist"
    assert (SPEC / "refinement" / f"{module}.tla").is_file(), f"spec/refinement/{module}.tla does not exist"
    return Run(f"refinement {module}", module, (SPEC / "refinement" / f"{module}.cfg").read_text(), "pass")


CHECKPOINT = ("    /\\ ck' = head /\\ settleDue' = FALSE /\\ person' = \"none\" /\\ held' = FALSE /\\ heldAt' = NoHold\n"
              "    /\\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,\n")
CHECKPOINT_RESTARTS_THE_QUIET_TIMER = (
    "    /\\ ck' = head /\\ settleDue' = FALSE /\\ person' = \"none\" /\\ held' = FALSE /\\ heldAt' = NoHold /\\ quiet' = TRUE\n"
    "    /\\ UNCHANGED <<truth, head, based, busy, from, installed, produced, consumed,\n")
REFINEMENT_MUTANTS = (("checkpoint-restarts-the-quiet-timer", CHECKPOINT, CHECKPOINT_RESTARTS_THE_QUIET_TIMER),)
FAILED_COMMIT = ("    /\\ tcr' = \"unavailable\" /\\ held' = FALSE /\\ heldAt' = NoHold\n"
                 "    /\\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,\n"
                 "                   pending, report, baseline, wasFailing, outbox, told, flush, turn,\n"
                 "                   toldThisTurn, promptQueued, knows, elapsed, edited, ck, person,\n")
HALF_A_FAILED_COMMIT = ("    /\\ tcr' = \"unavailable\" /\\ held' = FALSE /\\ heldAt' = NoHold /\\ ck' = head\n"
                        "    /\\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,\n"
                        "                   pending, report, baseline, wasFailing, outbox, told, flush, turn,\n"
                        "                   toldThisTurn, promptQueued, knows, elapsed, edited, person,\n")
REVERT_ABORT = ("    /\\ tcr' = \"unavailable\"\n"
                "    /\\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,\n"
                "                   pending, report, baseline, wasFailing, outbox, told, flush, turn,\n"
                "                   toldThisTurn, promptQueued, knows, elapsed, edited, ck, person, settleDue,\n")
HALF_A_REVERT_ABORT = ("    /\\ tcr' = \"unavailable\" /\\ ck' = head\n"
                       "    /\\ UNCHANGED <<truth, head, based, busy, from, quiet, installed, produced, consumed,\n"
                       "                   pending, report, baseline, wasFailing, outbox, told, flush, turn,\n"
                       "                   toldThisTurn, promptQueued, knows, elapsed, edited, person, settleDue,\n")
FRESH_FAILURES = "FreshFailures == report.failures \\ baseline.failures"
EVERY_FAILURE_IS_FRESH = "FreshFailures == report.failures"
NAMED_FAILURE_MUTANT = ("a-revert-notice-names-the-inherited-failures-too", (FRESH_FAILURES, EVERY_FAILURE_IS_FRESH), "RevertNoticeNamesNewFailures", '{"a", "b"}')
UNPROVEN = "Unproven == report.failures # {} /\\ (firstResult \\/ held \\/ TimedOut \\in report.failures)"
TIMEOUT_IS_PROVEN = "Unproven == report.failures # {} /\\ (firstResult \\/ held)"
PULL_KEEPS_THE_HOLD = ("    /\\ held' = FALSE /\\ heldAt' = NoHold\n    /\\ quiet' = TRUE /\\ pending' = <<>>\n    /\\ from' = IF busy",
                       "    /\\ held' = held /\\ heldAt' = heldAt\n    /\\ quiet' = TRUE /\\ pending' = <<>>\n    /\\ from' = IF busy")
TIMEOUT_MUTANT = ("a-timed-out-check-is-judged-like-any-other", (UNPROVEN, TIMEOUT_IS_PROVEN), "ATimedOutCheckOnlyHolds")
PULL_MUTANT = ("a-pull-keeps-the-hold", PULL_KEEPS_THE_HOLD, "APullClearsTheHold")
PROPERTY_MUTANTS = (NAMED_FAILURE_MUTANT, TIMEOUT_MUTANT, PULL_MUTANT,("a-failed-commit-moves-the-restore-point", (FAILED_COMMIT, HALF_A_FAILED_COMMIT), "CheckpointIsAllOrNothing"),
                    ("an-aborted-revert-moves-the-restore-point", (REVERT_ABORT, HALF_A_REVERT_ABORT), "RevertIsAllOrNothing"))
REACHABLE = ("NeverReverts", "NeverCheckpoints", "NeverCheckpointFails", "NeverRevertAborts", "NeverAbortsACommitWithWorkPending", "NeverHolds", "NeverObserves", "NeverPersonCommits",
             "NeverTellsRevert", "NeverTellsHold", "NeverPulls", "NeverHoldsATimeout", "NeverPullsWhileHeld", "NeverUnavailable", "NeverResumes", "NeverDirtyStart")
PROBE_NAMES = (*REACHABLE, "NoRevertOfUnseenWork", "NeverCheckpointsAfterARevert")
FAIRNESS_CLAIMS = ("RunsEnd", "EveryEditIsChecked", "RegressionsReachAgent", "RevertNoticeReachesAgent", "HoldNoticeReachesAgent", "EditsAreSettled")
FAIRNESS_NEEDED_BY = {
    "Nothing": (),
    "QuietElapses": ("EveryEditIsChecked", "RegressionsReachAgent", "EditsAreSettled"),
    "Tick": ("RunsEnd", "EveryEditIsChecked", "RegressionsReachAgent", "EditsAreSettled"),
    "TimesOut": ("RunsEnd", "EveryEditIsChecked", "RegressionsReachAgent", "EditsAreSettled"),
    "ReadResults": ("EveryEditIsChecked", "RegressionsReachAgent", "EditsAreSettled"),
    "Flush": ("RegressionsReachAgent",),
    "WokenTurnStarts": (),
    "TurnCompletes": ("RegressionsReachAgent",),
    "TellRevert": ("RevertNoticeReachesAgent",),
    "TellHold": ("HoldNoticeReachesAgent",),
    "Settle": ("EditsAreSettled",),
}


def run_at_bounds(edits: int, names: str, timeout: int, agent_only: bool) -> Run:
    """Every property of OverwatchTcr.cfg, liveness included, at other bounds than its own; agent_only keeps the person's
    work and more than four builds out, as OverwatchTcrNotices.cfg does, so that three edits fit."""
    assert edits >= 1, f"{edits} workspace edits leave nothing to check"
    assert names.startswith("{") and names.endswith("}"), f"the names {names} are no set"
    text = (SPEC / "OverwatchTcr.cfg").read_text()
    for old in ('Names = {"a"}', "MaxEdits = 2", "Timeout = 1"):
        assert old in text, f"OverwatchTcr.cfg no longer holds {old}, which the bounds runs replace"
    text = text.replace('Names = {"a"}', f"Names = {names}").replace("MaxEdits = 2", f"MaxEdits = {edits}").replace("Timeout = 1", f"Timeout = {timeout}")
    if agent_only:
        text = text.replace("SPECIFICATION Spec\n", "SPECIFICATION Spec\nCONSTRAINT AgentWorkOnly\nCONSTRAINT FewBuilds\n")
    label = f"{edits} edits, names {names}, timeout {timeout}{', agent only' if agent_only else ''}"
    return Run(f"bounds {label}", "Overwatch", text, "pass", edits > 1, group="bounds" if edits > 1 else "")


def fairness(left: str, claim: str) -> Run:
    """Overwatch without the weak fairness of one action; the claim fails exactly when it needs that action."""
    assert left in FAIRNESS_NEEDED_BY, f"fairness of {left} is not one of {sorted(FAIRNESS_NEEDED_BY)}"
    assert claim in FAIRNESS_CLAIMS, f"{claim} is not one of the progress claims {FAIRNESS_CLAIMS}"
    config = f"SPECIFICATION SpecWithout{left}\nCONSTANTS\n{PROBE_BOUNDS}    MaxEdits = 2\nPROPERTIES\n    {claim}\n"
    return Run(f"fairness without {left} for {claim}", "Fairness", config, "violation" if claim in FAIRNESS_NEEDED_BY[left] else "pass", True, group="fairness")


def runs() -> list[Run]:
    """Every run, cheapest first, with what TLC must report."""
    found = [checked("Overwatch", "Overwatch"), checked("OverwatchTcr", "Overwatch"), checked("OverwatchTcrReverts", "Overwatch", group="reverts"), checked("OverwatchTcrQueues", "Overwatch"), checked("OverwatchTcrNames", "Overwatch"),
             checked("OverwatchTcrNotices", "Overwatch", heavy=True), checked("IntegrationLifecycle", "IntegrationLifecycle"),
             checked("IntegrationNotices", "IntegrationContract"), checked("IntegrationContract", "IntegrationContract", heavy=True),
             refinement("NewImplementsOld"), refinement("OldImplementsNew"), refinement("TcrImplementsBase")]
    found += [mutant(name, "TcrImplementsBase", old, new) for name, old, new in REFINEMENT_MUTANTS]
    found += [property_mutant(*mutation) for mutation in PROPERTY_MUTANTS]
    found += [probe(name, 2, "violation") for name in REACHABLE]
    found += [probe("NoRevertOfUnseenWork", 2, "pass"), probe("NoRevertOfUnseenWork", 3, "violation")]
    found += [probe("NeverCheckpointsAfterARevert", 2, "pass"), probe("NeverCheckpointsAfterARevert", 3, "violation")]
    found += [run_at_bounds(1, '{"a"}', 1, False), run_at_bounds(2, '{"a", "b"}', 1, False), run_at_bounds(3, '{"a"}', 0, True), run_at_bounds(3, '{"a"}', 1, True)]
    found += [fairness(left, claim) for left in FAIRNESS_NEEDED_BY for claim in FAIRNESS_CLAIMS]
    assert len({run.name for run in found}) == len(found), f"two of the {len(found)} runs share a name: {[run.name for run in found]}"
    assert all(run.expected in ("pass", "violation") for run in found), f"a run of {[run.name for run in found]} expects something other than pass or violation"
    return found


def verdict(output: str) -> str:
    """pass, violation, or error when TLC could not decide, as its output says."""
    assert output, f"TLC printed {len(output)} characters; it did not run"
    found = "pass" if "No error has been found" in output else (
        "violation" if re.search(r"Error: .*(violated|is not satisfied)|Temporal properties were violated", output) else "error")
    assert found in ("pass", "violation", "error"), f"verdict {found} is none of pass, violation, error"
    return found


def execute(run: Run, jar: Path, java: str) -> tuple[str, str]:
    """TLC's verdict on run and its state counts, computed in a copy of the modules so no state files reach the repository."""
    assert jar.is_file(), f"the TLA tools jar {jar} does not exist"
    assert run.config.strip(), f"run {run.name} has no configuration"
    with tempfile.TemporaryDirectory(prefix="overwatch-tlc-") as directory:
        work = Path(directory)
        for source in (*SPEC.glob("*.tla"), *(SPEC / "refinement").glob("*.tla"), *(SPEC / "probes").glob("*.tla")):
            shutil.copyfile(source, work / source.name)
        if run.edit:
            target = work / "Overwatch.tla"
            assert run.edit[0] in target.read_text(), f"run {run.name} edits text that Overwatch.tla does not hold"
            target.write_text(target.read_text().replace(*run.edit, 1))
        (work / "Run.cfg").write_text(run.config)
        result = subprocess.run([java, "-XX:+UseParallelGC", TLC_HEAP, "-cp", str(jar), "tlc2.TLC", "-config", "Run.cfg", "-workers", "auto",
                                 "-metadir", str(work / "states"), f"{run.module}.tla"], cwd=work, capture_output=True, text=True, timeout=TLC_TIMEOUT)
    output = result.stdout + result.stderr
    counts = re.findall(r"(\d+) states generated, (\d+) distinct", output)
    return verdict(output), (f"{counts[-1][0]} generated, {counts[-1][1]} distinct" if counts else "no state counts")


def wanted(run: Run, args: argparse.Namespace) -> bool:
    """Whether the command line asks for run: the fairness runs and the reverts configuration each have a flag of their own, and --full adds the heavy ones."""
    assert run.group in ("", "fairness", "reverts", "bounds"), f"run {run.name} is in the group {run.group!r}, which no flag selects"
    assert hasattr(args, "full"), f"the arguments {args} do not say whether the heavy runs are wanted"
    if run.group == "bounds":
        return args.bounds
    if run.group == "fairness":
        return args.fairness
    if run.group == "reverts":
        return args.reverts or args.full
    return args.full or not run.heavy


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--jar", type=Path, default=os.environ.get("TLA2TOOLS_JAR", ""))
    parser.add_argument("--java", default="java")
    parser.add_argument("--only", default="", help="run only the runs whose name contains this text")
    parser.add_argument("--full", action="store_true", help="include IntegrationContract.cfg")
    parser.add_argument("--bounds", action="store_true", help="run every property of OverwatchTcr.cfg at three edits and at two failure names, about an hour")
    parser.add_argument("--reverts", action="store_true", help="add OverwatchTcrReverts.cfg, 153 million states, which CI runs in a job of its own")
    parser.add_argument("--fairness", action="store_true", help="run the 66 runs that leave out one action's fairness, about an hour")
    args = parser.parse_args()
    if not str(args.jar) or not args.jar.is_file():
        sys.exit(f"TLA tools jar missing: pass --jar or set TLA2TOOLS_JAR (got {args.jar!r})")
    if shutil.which(args.java) is None:
        sys.exit(f"Java not found: put {args.java!r} on PATH or pass --java with the path of a java executable")
    selected = [run for run in runs() if args.only in run.name and wanted(run, args)]
    assert selected, f"no run contains {args.only!r}; see runs() for the names"
    assert all(run.expected in ("pass", "violation") for run in selected), f"a selected run expects something TLC never says: {selected}"
    failures = []
    for run in selected:
        got, counts = execute(run, args.jar.resolve(), args.java)
        print(f"{'ok  ' if got == run.expected else 'FAIL'} {run.name}: expected {run.expected}, TLC said {got} ({counts})", flush=True)
        if got != run.expected:
            failures.append(run.name)
    if failures:
        sys.exit(f"{len(failures)} of {len(selected)} runs did not say what they must: {failures}")
    print(f"{len(selected)} TLC runs said what they must")


if __name__ == "__main__":
    main()
