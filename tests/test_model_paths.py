"""Replay TLC expectations through the command hook and its stream reader."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from paths import ROOT
from discovery import TABLE
import engine
from reading import last_build, read_report

TRACES = json.loads((ROOT / 'tests/fixtures/model-traces.json').read_text())
ZIG = TABLE['watchers'][0]


def build_output(failures: list[str]) -> str:
    """Runner bytes for the model's named failures, without interpreting their meaning."""
    body = ''.join(f"error: '{name}' failed:\n" for name in failures)
    summary = (f'Build Summary: 2/3 steps succeeded (1 failed); 0/{len(failures)} tests passed ({len(failures)} failed)\n'
               if failures else 'Build Summary: 3/3 steps succeeded; 1/1 tests passed\n')
    assert all(f"'{name}'" in body for name in failures), f'Fixture body {body!r} lost failures {failures}'
    assert summary.endswith('\n'), f'Fixture summary {summary!r} needs a complete line'
    return body + summary


class CommandReplay:
    """Real file-backed hook state; only the runner is replaced with controlled process output."""
    def __init__(self, directory: Path, trace: dict) -> None:
        directory.mkdir()
        self.project = directory.resolve() / 'project'
        self.project.mkdir()
        subprocess.run(['git', 'init', '-q', str(self.project)], check=True)
        (self.project / '.git/HEAD').write_text('a' * 40 + '\n')
        (self.project / 'build.zig').write_text('version 0')
        (self.project / '.overwatch.json').write_text(json.dumps({'baseline': ['sh', '-c', 'cat result; if [ -f overlap ]; then echo changed > build.zig; rm overlap; fi'], 'gate': {'protected_actions': [{'tool': 'Publish'}]}}))
        self.data = engine.data_root(str(directory / 'data'))
        self.trace = trace
        self.version = 0
        self.first = True
        self.output = ''
        self.overlap = False
        assert self.project.is_dir(), f'No fixture project at {self.project}'
        assert self.data != self.project, f'Hook state {self.data} must stay outside the project fingerprint'

    def event(self, name: str, tool: str = '') -> dict:
        event = engine.Event(name, 'model', str(self.project), tool, {})
        with patch.dict('os.environ', {'PATH': '/usr/bin:/bin'}):
            return engine.process_event(event, self.data)

    def step(self, action: str) -> dict | None:
        if action == 'Edit':
            # Codex runs an editing tool's PreToolUse before the tool itself, as the agent starts its edit.
            self.event('PreToolUse', 'Edit')
        if action in ('Edit', 'Move', 'Outside'):
            self.version += 1
            self.overlap = self.first and 'during initial check' in self.trace['name']
            if not self.overlap:
                (self.project / 'build.zig').write_text(f'version {self.version}')
            if action == 'Move':
                (self.project / '.git/HEAD').write_text('b' * 40 + '\n')
        if action == 'Build':
            self.output = build_output(self.trace['truth'][self.version])
            (self.project / 'result').write_text(self.output)
            if self.overlap:
                (self.project / 'overlap').touch()
        if action == 'Read':
            result = self.event('SessionStart' if self.first else 'PostToolUse', 'Edit')
            self.first = False
            return result
        if action == 'Complete':
            return self.event('Stop')
        return None


class ModelPathsTests(unittest.TestCase):
    def setUp(self) -> None:
        """Own all replay projects through unittest's cleanup lifecycle."""
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        assert self.directory.is_dir(), f'Missing replay root {self.directory}'
        assert not any(self.directory.iterdir()), f'Replay root {self.directory} must start empty'

    def test_command_hook_sequences(self) -> None:
        """Real commands and persisted hook state follow the model's baseline and guard decisions."""
        for trace in TRACES:
            if trace['kind'] != 'check':
                continue
            with self.subTest(trace=trace['name']):
                directory = self.directory / str(TRACES.index(trace))
                replay = CommandReplay(directory, trace)
                for index, action in enumerate(trace['events'], 1):
                    output = replay.step(action)
                    if output is None:
                        continue
                    expected = trace['expected'][index]
                    if 'during initial check' in trace['name'] and expected['guarded']:
                        self.assertNotIn('inherited backlog', json.dumps(output), trace['name'])
                    if action == 'Complete':
                        self.assertEqual(output.get('decision') == 'block', expected['guarded'], (trace['name'], index))
                    published = replay.event('PreToolUse', 'Publish')
                    self.assertEqual(published.get('hookSpecificOutput', {}).get('permissionDecision') == 'deny', expected['guarded'], (trace['name'], index))
                    with engine.locked(engine.state_path(engine.Event('', 'model', '', '', {}), replay.project, replay.data), replay.data) as session:
                        state = engine.load_state(session)
                    self.assertEqual(list(state.reports[0].failures), expected['failures'], (trace['name'], index))

    def test_command_reader_uses_latest_complete_build(self) -> None:
        """Raw chunks select only the newest completed build and retain the next build's prefix."""
        for trace in TRACES:
            with self.subTest(trace=trace['name']):
                for index, report, partial_read in reader_steps(trace):
                    if partial_read:
                        self.assertIsNone(report, trace['name'])
                    else:
                        self.assertIsNotNone(report, trace['name'])
                        self.assertEqual(list(report.failures), trace['expected'][index]['failures'], trace['name'])


def reader_steps(trace: dict):
    """Feed the model's external byte events into the production reader."""
    version, pending, partial = 0, '', ''
    for index, action in enumerate(trace['events'], 1):
        if action in ('Edit', 'Move', 'Outside'):
            version += 1
        if action in ('Build', 'Partial', 'PartialSummary'):
            text = build_output(trace['truth'][version])
            body, summary = text.split('Build Summary:', 1)
            pending += body if action == 'Partial' else body + 'Build Summary:' if action == 'PartialSummary' else summary if partial == 'PartialSummary' else ('Build Summary:' + summary if partial else text)
            partial = '' if action == 'Build' else action
        if action in ('Read', 'Poll'):
            lines = pending[:pending.rfind('\n') + 1]
            report = read_report(ZIG, lines)
            yield index, report, action == 'Poll'
            if report is not None:
                pending = last_build(ZIG, lines)[1] + pending[len(lines):]
