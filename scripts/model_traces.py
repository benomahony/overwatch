#!/usr/bin/env python3
"""Ask TLC for expected observations, then generate traces replayed by the integrations.

Only inputs live here. The expected results come from spec/Overwatch.tla, not a Python port.
Set TLA2TOOLS_JAR or pass --jar; --check rejects stale committed fixtures.
"""
from __future__ import annotations

import argparse
import json
from itertools import product
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / 'tests/fixtures/model-traces.ts'
JSON_TARGET = TARGET.with_suffix('.json')
# Each truth entry is the failure set at one workspace version. Partial output
# has no completed result and therefore stutters in the abstract model.
CASES = [
    ('buffered recovery', [[], ['a'], []], 'Build Read Start Edit Quiet Build Edit Quiet Build Read Flush Complete'),
    ('buffered regression', [[], [], ['b']], 'Build Read Start Edit Quiet Build Edit Quiet Build Read Flush'),
    ('inherited baseline uses latest buffered build', [['a'], ['b']], 'Build Move Quiet Build Read Flush Start Complete'),
    ('edit before initial read cannot become baseline', [[], ['a']], 'Start Edit Build Read Flush'),
    ('partial next build survives reading', [[], ['a'], ['b']], 'Build Read Start Edit Quiet Build Edit Quiet Partial Read Flush Build Read Flush'),
    ('recovery cancels unsent failure', [[], ['a'], []], 'Build Read Start Edit Quiet Build Read Edit Quiet Build Read Flush Complete'),
    ('recovery after notification', [[], ['a'], []], 'Build Read Start Edit Quiet Build Read Flush Edit Quiet Build Read Flush Complete'),
    ('idle failure wakes once', [[], ['a'], ['a']], 'Build Read Start Edit Quiet Complete Build Read Flush Start Edit Quiet Build Read Flush'),
    ('partial summary is not a complete result', [[], ['a']], 'Build Read Start Edit Quiet PartialSummary Poll Build Read Flush'),
    ('partial initial summary cannot establish baseline', [[], ['a']], 'Start Edit PartialSummary Poll Build Read Flush'),
    ('completion stays guarded without tool progress', [[], ['a']], 'Build Read Start Edit Quiet Build Read Complete Complete Flush'),
    ('outside change does not wake', [[], ['a']], 'Build Read Outside Quiet Build Read Flush'),
    ('outside change waits for the next turn', [[], ['a']], 'Build Read Outside Quiet Build Read Flush Start Flush'),
    ('outside change after a read edit does not wake', [[], [], ['a']], 'Build Read Start Edit Quiet Complete Build Read Flush Outside Quiet Build Read Flush'),
]


# Sweep every failure set for the buffered-read and notification interleavings.
# These are model inputs, never expected observations.
for schedule_index in (0, 4, 5):
    schedule_name, _, schedule_events = CASES[schedule_index]
    for combination in product(([], ['a'], ['b'], ['a', 'b']), repeat=3):
        label = '/'.join(''.join(names) or 'green' for names in combination)
        CASES.append((f'{schedule_name}: {label}', list(combination), schedule_events))

for name, events in (
    ('check: sequential results', 'Build Read Start Edit Quiet Build Read Flush Edit Quiet Build Read Flush Complete Complete'),
    ('check: moved commit establishes a new baseline', 'Build Read Start Move Quiet Build Read Flush Edit Quiet Build Read Flush Complete Complete'),
):
    for combination in product(([], ['a'], ['b'], ['a', 'b']), repeat=3):
        label = '/'.join(''.join(names) or 'green' for names in combination)
        CASES.append((f'{name}: {label}', list(combination), events))
for failures in ([], ['a'], ['b'], ['a', 'b']):
    CASES.append((f'check: edit during initial check: {failures}', [[], failures], 'Start Edit Build Read Flush Complete Complete'))


def tla_set(names: set[str]) -> str:
    assert names <= {'a', 'b'}, f'Unexpected model names: {names}'
    text = '{' + ', '.join(json.dumps(item) for item in sorted(names)) + '}'
    assert text.startswith('{') and text.endswith('}'), 'TLA+ failure sets need braces'
    return text


def wrapper() -> str:
    events = [events.split() for _, _, events in CASES]
    truths = ['[v \\in Versions |-> CASE ' + ' [] '.join(
        f'v = {index} -> {tla_set(set(names))}' for index, names in enumerate(truth)
    ) + ' [] OTHER -> {}]' for _, truth, _ in CASES]
    assert all(truth for _, truth, _ in CASES), f'Every schedule in {[name for name, _, _ in CASES]} needs an initial workspace result'
    module = r'''------------------------- MODULE Conformance -------------------------
EXTENDS Overwatch, TLC
Events == EVENTS
Truths == TRUTHS
VARIABLES scenario, step, sent, wakes
traceVars == <<vars, scenario, step, sent, wakes>>
TraceInit == Init /\ scenario \in 1..Len(Events) /\ truth = Truths[scenario]
             /\ step = 0 /\ sent = 0 /\ wakes = 0
Event == Events[scenario][step + 1]
Action == CASE Event = "Start" -> TurnStarts
            [] Event = "Edit" -> Edit
            [] Event = "Outside" -> OutsideEdit
            [] Event = "Move" -> HeadMoves
            [] Event = "Quiet" -> QuietElapses
            [] Event = "Build" -> RunEnds /\ pending'[Len(pending')].at = head
            [] Event = "Read" -> ReadResults
            [] Event = "Flush" -> IF flush THEN Flush ELSE UNCHANGED vars
            [] Event = "Complete" -> IF turn = "running" THEN TurnCompletes ELSE UNCHANGED vars
            [] Event \in {"Partial", "PartialSummary"} -> UNCHANGED vars
            [] Event = "Poll" -> pending = <<>> /\ UNCHANGED vars
TraceNext == IF step < Len(Events[scenario])
             THEN /\ Action /\ step' = step + 1 /\ UNCHANGED scenario
                  /\ sent' = sent + IF Event = "Flush" /\ outbox.held /\ ~Held THEN 1 ELSE 0
                  /\ wakes' = wakes + IF Event = "Flush" /\ outbox.held /\ ~Held /\ turn = "idle" THEN 1 ELSE 0
             ELSE UNCHANGED traceVars
RECURSIVE Join(_)
Join(xs) == IF Len(xs) = 0 THEN "" ELSE Head(xs) \o IF Len(xs) = 1 THEN "" ELSE "," \o Join(Tail(xs))
Quote(s) == "\"" \o s \o "\""
SetJSON(f) == "[" \o Join([i \in 1..Len(SelectSeq(<<"a", "b", "timeout">>, LAMBDA n: n \in f)) |->
                       Quote(SelectSeq(<<"a", "b", "timeout">>, LAMBDA n: n \in f)[i])]) \o "]"
Bool(b) == IF b THEN "true" ELSE "false"
Export == PrintT("OVERWATCH_TRACE " \o
    "{\"scenario\":" \o ToString(scenario) \o ",\"step\":" \o ToString(step) \o
    ",\"known\":" \o Bool(report.known) \o ",\"failures\":" \o SetJSON(report.failures) \o
    ",\"guarded\":" \o Bool(Guard) \o ",\"sent\":" \o ToString(sent) \o
    ",\"wakes\":" \o ToString(wakes) \o ",\"turn\":" \o Quote(turn) \o "}")
=============================================================================
'''.replace('EVENTS', '<<' + ', '.join('<<' + ', '.join(json.dumps(event) for event in steps) + '>>' for steps in events) + '>>').replace('TRUTHS', '<<' + ', '.join(truths) + '>>')
    assert 'EVENTS' not in module and 'TRUTHS' not in module, 'All trace constants must be expanded'
    return module


def generate(jar: Path) -> str:
    with tempfile.TemporaryDirectory(prefix='overwatch-traces-') as directory:
        work = Path(directory)
        for name in ('Overwatch.tla', 'FailurePolicy.tla'):
            shutil.copyfile(ROOT / 'spec' / name, work / name)
        (work / 'Conformance.tla').write_text(wrapper())
        (work / 'Conformance.cfg').write_text('''INIT TraceInit
NEXT TraceNext
CONSTANTS
    Names = {"a", "b"}
    MaxEdits = 2
    Timeout = 2
    TcrMode = FALSE
INVARIANTS
    TypeOK
    BufferedResultsAreOrdered
    ReadsSelectLatestComplete
    ResultsMatchBuilds
    BaselineNeverAbsorbsEdits
    Export
''')
        result = subprocess.run(['java', '-XX:+UseParallelGC', '-Xmx512m', '-cp', str(jar),
                                 'tlc2.TLC', '-workers', '1', '-metadir', str(work / 'states'),
                                 str(work / 'Conformance.tla')], text=True, capture_output=True, timeout=120)
        if result.returncode:
            raise RuntimeError(f'TLC could not generate conformance traces:\n{result.stdout}\n{result.stderr}')
        rows = {}
        for line in result.stdout.splitlines():
            if line.startswith('"OVERWATCH_TRACE '):
                row = json.loads(json.loads(line).removeprefix('OVERWATCH_TRACE '))
                key = (row.pop('scenario'), row.pop('step'))
                previous = rows.get(key)
                if previous is not None and previous != row:
                    raise ValueError(f'Non-deterministic observation at {key}: {previous} / {row}')
                rows[key] = row
        traces = []
        for scenario, (name, truth, events) in enumerate(CASES, 1):
            steps = events.split()
            expected = [rows.pop((scenario, step)) for step in range(len(steps) + 1)]
            traces.append({'name': name, 'kind': 'check' if name.startswith('check:') else 'watch',
                           'truth': truth, 'events': steps, 'expected': expected})
        assert not rows, f'TLC emitted unexpected states: {rows}'
        assert len(traces) == len(CASES), 'Every model schedule must have a replay fixture'
        return '// Generated by python3 scripts/model_traces.py from spec/Overwatch.tla; do not edit.\nexport const MODEL_TRACES = [\n' + ',\n'.join(json.dumps(trace, separators=(',', ':')) for trace in traces) + '\n] as const\n'


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jar', type=Path, default=os.environ.get('TLA2TOOLS_JAR', str(Path.home() / '.cache/tlalings/tla2tools.jar')))
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if not args.jar.is_file():
        parser.error('Set TLA2TOOLS_JAR or pass --jar pointing to tla2tools.jar')
    assert len({name for name, _, _ in CASES}) == len(CASES), 'Trace names must be unique'
    text = generate(args.jar.resolve())
    assert text.startswith('// Generated'), 'Only generated fixtures may be written'
    values = json.loads(text.split('export const MODEL_TRACES = ', 1)[1].removesuffix(' as const\n'))
    outputs = {TARGET: text, JSON_TARGET: json.dumps(values, separators=(',', ':')) + '\n'}
    if args.check:
        if any(not path.is_file() or path.read_text() != body for path, body in outputs.items()):
            raise SystemExit('Model traces are stale; run python3 scripts/model_traces.py')
        print(f'{len(CASES)} conformance traces match the TLA+ model')
    else:
        for path, body in outputs.items():
            path.write_text(body)
        print(f'Generated {len(CASES)} model-derived traces in {TARGET.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
