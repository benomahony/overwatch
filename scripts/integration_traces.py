#!/usr/bin/env python3
"""Generate host contract expectations with TLC. Cases contain inputs, never an implementation oracle."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
HOSTS = ('claude', 'codex', 'opencode1', 'opencode2', 'pi', 'neovim')
CHECKS = ('primary', 'secondary')
EMPTY = {check: [] for check in CHECKS}
FAILED = {'primary': ['a'], 'secondary': []}
BOTH = {'primary': ['a'], 'secondary': ['a']}


def cases() -> list[dict]:
    """Input programs cover every host, both inherited policies, relevant and irrelevant checks, and held checks."""
    programs = [
        ('inspect during check', 'RequestInspect Respond', True, FAILED, EMPTY, 'allow', [], FAILED),
        ('repair during check', 'RequestRepair Respond', True, FAILED, EMPTY, 'allow', [], FAILED),
        ('latest result decides protected action', 'RequestPublish Poll Finish Respond', True, EMPTY, EMPTY, 'allow', [], FAILED),
        ('recovery decides protected action', 'RequestPublish Poll Finish Respond', True, FAILED, EMPTY, 'allow', [], EMPTY),
        ('completion does not queue duplicates', 'RequestComplete Respond Ack RequestComplete Respond', False, FAILED, EMPTY, 'allow', [], FAILED),
        ('work in the correction turn keeps one correction', 'RequestComplete Respond Ack CorrectionTurn Work RequestComplete Respond', False, FAILED, EMPTY, 'allow', [], FAILED),
        ('work in a later turn permits a fresh correction', 'RequestComplete Respond Ack CorrectionTurn RequestComplete Respond Ack Turn Work RequestComplete Respond', False, FAILED, EMPTY, 'allow', [], FAILED),
        ('idle result delivery', 'Report Deliver', False, FAILED, EMPTY, 'allow', [], FAILED),
        ('outside change keeps one correction', 'RequestComplete Respond Ack CorrectionTurn OutsideBegin OutsideFinish Report RequestComplete Respond', False, FAILED, EMPTY, 'allow', [], BOTH),
        ('outside failure is not told as the session\'s', 'OutsideBegin OutsideFinish Report Deliver', False, EMPTY, EMPTY, 'allow', [], FAILED),
        ('session change after a correction permits a fresh one', 'RequestComplete Respond Ack CorrectionTurn Begin Finish Report RequestComplete Respond', False, FAILED, EMPTY, 'allow', [], BOTH),
        ('delivery survives deduplication', 'Report Deliver Report Deliver', False, FAILED, EMPTY, 'allow', [], FAILED),
        ('pending recovery cancels stale delivery', 'Report Begin Finish Report Deliver', False, FAILED, EMPTY, 'allow', [], EMPTY),
        ('shutdown discards pending delivery', 'Report Stop Deliver', False, FAILED, EMPTY, 'allow', [], FAILED),
        ('restart clears previous session', 'Report Stop Restart Report Deliver', False, FAILED, EMPTY, 'allow', [], FAILED),
        ('restart restores new-failure guards', 'Stop Restart StartTurn Begin Finish Report Deliver RequestComplete Respond', False, EMPTY, EMPTY, 'allow', [], FAILED),
        ('shutdown during a held completion', 'RequestComplete Poll Stop LateFinish Deliver', True, FAILED, EMPTY, 'allow', [], FAILED),
    ]
    for policy in ('allow', 'block'):
        for scope in ([], ['primary'], ['secondary']):
            programs.append((f'inherited {policy}, selected {scope}', 'RequestPublish Respond Ack RequestComplete Respond',
                             False, FAILED, FAILED, policy, scope, FAILED))
    # Only hosts that see another process's change before settling can replay one; Pi and OpenCode 1 cannot.
    noticing = {'claude', 'codex', 'opencode2', 'neovim'}
    rows = [{'host': host, 'name': name, 'events': events.split(), 'busy': busy,
             'inTurn': name != 'idle result delivery', 'reports': reports, 'baseline': baseline, 'inherited': inherited, 'selected': scope, 'next': after}
            for host in HOSTS for name, events, busy, reports, baseline, inherited, scope, after in programs
            if host in noticing or 'Outside' not in events]
    assert len({(row['host'], row['name']) for row in rows}) == len(rows), 'Host contract case names must be unique'
    assert {row['host'] for row in rows} == set(HOSTS), f'Cases cover {[row["host"] for row in rows]}, expected {HOSTS}'
    return rows


def snapshot(value: dict) -> str:
    assert set(value) == set(CHECKS), f'Snapshot keys {set(value)} must be {CHECKS}'
    text = '[' + ', '.join(check + ' |-> {' + ', '.join(json.dumps(name) for name in value[check]) + '}' for check in CHECKS) + ']'
    assert text.startswith('[') and text.endswith(']'), f'Snapshot {text} needs record delimiters'
    return text


CONTRACT_WRAPPER = r'''----------------------- MODULE ContractTraces -----------------------
EXTENDS IntegrationContract, TLC, Sequences
Cases == CASES
VARIABLES scenario, step
traceVars == <<vars, scenario, step>>
TraceInit == Init /\ scenario \in 1..Len(Cases) /\ step = 0
             /\ host = Cases[scenario].host /\ busy = Cases[scenario].busy
             /\ reports = Cases[scenario].reports /\ baseline = Cases[scenario].baseline
             /\ inTurn = Cases[scenario].inTurn
             /\ inherited = Cases[scenario].inherited /\ selected = Cases[scenario].selected
Event == Cases[scenario].events[step + 1]
Action == CASE Event = "RequestInspect" -> Request("inspect")
            [] Event = "RequestRepair" -> Request("repair")
            [] Event = "RequestPublish" -> Request("publish")
            [] Event = "RequestComplete" -> Request("complete")
            [] Event = "Respond" -> IF reply.ready THEN UNCHANGED vars ELSE Respond
            [] Event = "Poll" -> IF CanRespond THEN Respond ELSE UNCHANGED vars
            [] Event = "Ack" -> Acknowledge
            [] Event \in {"Begin", "OutsideBegin"} -> BeginCheck
            [] Event = "OutsideFinish" -> OutsideFinish(Cases[scenario].after)
            [] Event = "Finish" -> FinishCheck(Cases[scenario].after)
            [] Event = "LateFinish" -> IF active THEN FinishCheck(Cases[scenario].after) ELSE UNCHANGED vars
            [] Event = "Report" -> Report
            [] Event = "Deliver" -> IF contextPending THEN Deliver ELSE UNCHANGED vars
            [] Event = "Stop" -> Stop
            [] Event = "Restart" -> Restart
            [] Event = "StartTurn" -> StartTurn
            [] Event = "Turn" -> IF inTurn THEN UNCHANGED vars ELSE StartTurn
            [] Event = "CorrectionTurn" -> IF inTurn THEN UNCHANGED vars ELSE IF correctionPending THEN StartCorrectionTurn ELSE StartTurn
            [] Event = "Work" -> WorkCompleted
TraceNext == IF step < Len(Cases[scenario].events)
             THEN /\ Action /\ step' = step + 1 /\ UNCHANGED scenario
             ELSE UNCHANGED traceVars
Bool(b) == IF b THEN "true" ELSE "false"
Quote(s) == "\"" \o s \o "\""
Failed == {c \in Checks : visible.failures[c] # {}}
FailedJSON == "[" \o (IF "primary" \in Failed THEN "\"primary\"" ELSE "") \o
              (IF "primary" \in Failed /\ "secondary" \in Failed THEN "," ELSE "") \o
              (IF "secondary" \in Failed THEN "\"secondary\"" ELSE "") \o "]"
Export == PrintT("CONTRACT_TRACE " \o
 "{\"scenario\":" \o ToString(scenario) \o ",\"step\":" \o ToString(step) \o
 ",\"ready\":" \o Bool(reply.ready) \o ",\"decision\":" \o Quote(reply.decision) \o
 ",\"active\":" \o Bool(active) \o ",\"busy\":" \o Bool(busy) \o
 ",\"visible\":" \o Bool(visible.known) \o ",\"failures\":" \o FailedJSON \o
 ",\"pending\":" \o Bool(contextPending) \o ",\"contexts\":" \o ToString(contexts) \o
 ",\"warnings\":" \o ToString(warnings) \o ",\"corrections\":" \o ToString(corrections) \o
 ",\"wakes\":" \o ToString(wakes) \o
 ",\"delivery\":" \o Quote(Capabilities(host).delivery) \o
 ",\"completion\":" \o Quote(Capabilities(host).completion) \o
 ",\"persistentStatus\":" \o Bool(Capabilities(host).status) \o
 ",\"waitsForCheck\":" \o Bool(Capabilities(host).waitsForCheck) \o
 ",\"idleWake\":" \o Bool(Capabilities(host).idleWake) \o
 ",\"agent\":" \o Bool(Capabilities(host).agent) \o "}")
=============================================================================
'''


def module(rows: list[dict]) -> str:
    """Constrain the normative host model to each input program; export its state after every event."""
    constants = []
    for row in rows:
        events = '<<' + ','.join(json.dumps(event) for event in row['events']) + '>>'
        selected = '{' + ','.join(json.dumps(check) for check in row['selected']) + '}'
        constants.append(f'[host |-> "{row["host"]}", busy |-> {str(row["busy"]).upper()}, inTurn |-> {str(row["inTurn"]).upper()}, reports |-> {snapshot(row["reports"])}, baseline |-> {snapshot(row["baseline"])}, inherited |-> "{row["inherited"]}", selected |-> {selected}, after |-> {snapshot(row["next"])}, events |-> {events}]')
    source = CONTRACT_WRAPPER.replace('CASES', '<<' + ','.join(constants) + '>>')
    assert 'Cases ==' in source, 'Contract wrapper must declare its input cases'
    assert 'EXTENDS IntegrationContract' in source, 'Expectations must execute the normative contract'
    return source


def generate_contracts(jar: Path) -> list[dict]:
    rows = cases()
    with tempfile.TemporaryDirectory(prefix='overwatch-contract-') as directory:
        work = Path(directory)
        for name in ('IntegrationContract.tla', 'FailurePolicy.tla'):
            shutil.copyfile(ROOT / 'spec' / name, work / name)
        (work / 'ContractTraces.tla').write_text(module(rows))
        (work / 'ContractTraces.cfg').write_text('''INIT TraceInit
NEXT TraceNext
CONSTANTS
 Hosts = {"claude", "codex", "opencode1", "opencode2", "pi", "neovim"}
 Checks = {"primary", "secondary"}
 Names = {"a"}
 MaxRequests = 3
 MaxChanges = 1
 MaxSessions = 1
 MaxNotices = 0
INVARIANTS
 TypeOK
 InspectionIndependentOfChecks
 InspectionAlwaysAllowed
 EditorNeverGuards
 StoppedSessionsStaySilent
 HostsWithoutIdleWakeStayIdle
 CorrectionRequestsAreDeduplicated
 PendingContextIsCurrent
 CompletionUsesHostCapability
 EditorOnlyReports
 Export
''')
        result = subprocess.run(['java', '-XX:+UseParallelGC', '-Xmx512m', '-cp', str(jar), 'tlc2.TLC',
                                 '-metadir', str(work / 'states'), str(work / 'ContractTraces.tla')], capture_output=True, text=True, timeout=120)
        if result.returncode:
            raise RuntimeError(f'TLC rejected host traces:\n{result.stdout}\n{result.stderr}')
        states = {}
        for line in result.stdout.splitlines():
            if line.startswith('"CONTRACT_TRACE '):
                state = json.loads(json.loads(line).removeprefix('CONTRACT_TRACE '))
                key = (state.pop('scenario'), state.pop('step'))
                previous = states.get(key)
                if previous is not None and previous != state:
                    raise ValueError(f'Non-deterministic host state {key}: {previous} / {state}')
                states[key] = state
        for index, row in enumerate(rows, 1):
            row['expected'] = [states.pop((index, step)) for step in range(len(row['events']) + 1)]
        assert not states, f'TLC produced unexpected states {states}'
        assert all(len(row['expected']) == len(row['events']) + 1 for row in rows), f'Every event in {[row["name"] for row in rows]} needs an expected model observation'
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jar', type=Path, default=os.environ.get('TLA2TOOLS_JAR', str(Path.home() / '.cache/tlalings/tla2tools.jar')))
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if not args.jar.is_file():
        parser.error(f'No TLC jar at {args.jar}; pass --jar or set TLA2TOOLS_JAR')
    rows = generate_contracts(args.jar.resolve())
    assert rows, 'TLC must produce at least one host contract trace'
    assert {row['host'] for row in rows} == set(HOSTS), f'Expected hosts {HOSTS}, got {[row["host"] for row in rows]}; add missing cases before exporting fixtures'
    body = json.dumps(rows, separators=(',', ':')) + '\n'
    ts = '// Generated by scripts/integration_traces.py from IntegrationContract.tla; do not edit.\nexport const CONTRACT_TRACES = [\n' + ',\n'.join(json.dumps(row, separators=(',', ':')) for row in rows) + '\n] as const\n'
    outputs = {ROOT / 'tests/fixtures/integration-contract.json': body, ROOT / 'tests/fixtures/integration-contract.ts': ts}
    for path, text in outputs.items():
        if args.check:
            if not path.is_file() or path.read_text() != text:
                raise SystemExit(f'{path.name} is stale; run python3 scripts/integration_traces.py')
        else:
            path.write_text(text)
    print(f'{len(rows)} host contract traces {"verified" if args.check else "generated"}')


if __name__ == '__main__':
    main()
