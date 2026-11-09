"""Acceptance steps that drive Claude Code: each scenario builds a transcript of hook calls and expectations, then
runs it once against a copy of the plugin with `claude plugin test`."""
from __future__ import annotations

from functools import partialmethod
import json
from pathlib import Path
import shutil
import subprocess

from paths import ROOT


class ClaudeSteps:
    """The Claude Code steps of the acceptance world, which provides fixture_root, the test's own directory."""

    fixture_root: Path

    def claude_new_failure(self) -> None:
        """Prepare a real Claude hook chain with a passing baseline followed by warnings."""
        assert not hasattr(self, "claude_steps"), f"Start in a fresh acceptance world; existing transcript: {getattr(self, 'claude_steps', None)!r}"
        assert (ROOT / "tests" / "fixtures" / "gating.ts").is_file(), "Claude scenarios require the shared watcher fixture"
        self.claude_phase = "ready"
        self.claude_steps = [
            "await $.session.start(start)",
            "await clock.advance(500)",
            "await $.tool.call({ tool: 'Edit', file_path: '/repo/example.py', old_string: 'a', new_string: 'b' })",
            "await clock.advance(1000)",
            "await $.turn.start({ text: 'finish', turnId: 't1' })",
            "prompts.length = 0",
            "calls.length = 0",
        ]

    def prepare_claude_steps(self, *, expected_phase: str, phase: str, steps: tuple[str, ...]) -> None:
        """Compose an action only after its required scenario phase has been prepared."""
        assert self.claude_phase == expected_phase, f"Expected {expected_phase}, got {self.claude_phase}"
        assert self.claude_steps and steps, "Prepare the watcher and supply executable action steps"
        self.claude_phase = phase
        self.claude_steps.extend(steps)

    def verify_claude(self, *, phase: str, expectations: tuple[str, ...]) -> None:
        """Run the scenario transcript and its observable outcome assertions once."""
        assert self.claude_phase == phase, f"Expected {phase}, got {self.claude_phase}"
        assert not (self.fixture_root / "claude-plugin").exists(), "Verify each transcript once"
        self.claude_steps.extend(expectations)
        self.run_claude_scenario()

    claude_empty_corrections = partialmethod(prepare_claude_steps, expected_phase='ready', phase='guarded', steps=(
        'await $.turn.complete(ended)',
        'expect(prompts.length).toBe(1)',
        'for (let i = 0; i < 3; i++) {',
        'await $.turn.start({ text: prompts[0]!, turnId: `retry-${i}` })',
        'await $.turn.complete({ ...ended, turnId: `retry-${i}` })',
        '}',
    ))

    def claude_clean_session(self) -> None:
        """A real Claude hook chain whose checks start clean, with no edit of the session's to follow."""
        assert not hasattr(self, "claude_steps"), f"Start in a fresh acceptance world; existing transcript: {getattr(self, 'claude_steps', None)!r}"
        self.claude_phase = "clean"
        self.claude_steps = ["await $.session.start(start)", "await clock.advance(300)"]

    claude_outside_changes = partialmethod(prepare_claude_steps, expected_phase='clean', phase='outside', steps=(
        'await clock.advance(1200)',
        "await $.turn.start({ text: 'what does this module do?', turnId: 'q1' })",
        "await $.turn.complete({ ...ended, turnId: 'q1' })",
        "setReport('zanity: 0 errors and 31 warnings in 1 of 1 files\\n')",
        'await clock.advance(1000)',
        "await $.turn.start({ text: prompts[0] ?? 'next', turnId: 'q2' })",
        "await $.turn.complete({ ...ended, turnId: 'q2' })",
        "setReport('zanity: 0 errors and 33 warnings in 1 of 1 files\\n')",
        'await clock.advance(1000)',
        "await $.turn.start({ text: 'and this one?', turnId: 'q3' })",
        "await $.turn.complete({ ...ended, turnId: 'q3' })",
    ))

    claude_outside_changes_correct_once = partialmethod(verify_claude, phase='outside', expectations=(
        'expect(prompts.length).toBe(1)',
        "expect(prompts.filter(text => text.includes('after the latest change'))).toEqual([])",
        "expect(calls).toEqual([])",
    ))

    claude_inspecting_corrections = partialmethod(prepare_claude_steps, expected_phase='ready', phase='inspected', steps=(
        'await $.turn.complete(ended)',
        'expect(prompts.length).toBe(1)',
        'for (let i = 0; i < 3; i++) {',
        'await $.turn.start({ text: prompts[0]!, turnId: `inspect-${i}` })',
        "await $.tool.call({ tool: 'Read', file_path: '/repo/example.py' })",
        "await $.tool.call({ tool: 'Bash', command: 'zanity check .' })",
        'await $.turn.complete({ ...ended, turnId: `inspect-${i}` })',
        '}',
    ))

    claude_inspection_does_not_repeat = partialmethod(verify_claude, phase='inspected', expectations=(
        'expect(prompts.length).toBe(1)',
        "expect(calls).toEqual(['Read', 'Bash', 'Read', 'Bash', 'Read', 'Bash'])",
    ))

    claude_loop_stops = partialmethod(verify_claude, phase='guarded', expectations=(
        'expect(prompts.length).toBe(1)',
        "expect(calls).toEqual([])",
        "try { await $.tool.call({ tool: 'Publish' }) } catch {}",
        "expect(calls).toEqual([])",
    ))

    def claude_work_resumes(self) -> None:
        """While an empty correction remains guarded, start a new turn and inspect the project."""
        assert self.claude_phase == "ready", "Resume work only after preparing a failing turn"
        self.claude_empty_corrections()
        assert self.claude_phase == "guarded", "Work must resume after the empty correction remains guarded"
        self.claude_phase = "resumed"
        self.claude_steps.extend([
            "await $.turn.start({ text: 'investigate', turnId: 'investigate' })",
            "await $.tool.call({ tool: 'Read', file_path: '/repo/example.py' })",
            "await $.turn.complete({ ...ended, turnId: 'investigate' })",
        ])

    claude_correction_resumes = partialmethod(verify_claude, phase='resumed', expectations=(
        "expect(calls).toEqual(['Read'])",
        'expect(prompts.length).toBe(2)',
        "expect(prompts[1]).toContain('29 warnings')",
    ))

    claude_abort = partialmethod(prepare_claude_steps, expected_phase='ready', phase='aborted', steps=(
        "await $.turn.complete({ ...ended, reason: 'aborted', isAborted: true })",
    ))

    claude_abort_settles = partialmethod(verify_claude, phase='aborted', expectations=(
        'expect(prompts).toEqual([])',
        "expect(calls).toEqual(['complete'])",
    ))

    def claude_denied_tools(self) -> None:
        """A rejected publication attempt does not count as completed work."""
        assert self.claude_phase == "ready", "Prepare the failing turn before testing denied tools"
        self.claude_empty_corrections()
        assert self.claude_phase == "guarded", "First exercise the unchanged completion guard"
        self.claude_steps.extend([
            "await $.turn.start({ text: 'publish', turnId: 'publish' })",
            "for (let i = 0; i < 3; i++) {",
            "try { await $.tool.call({ tool: 'Publish' }) } catch {}",
            "await $.turn.complete({ ...ended, turnId: 'publish' })",
            "}",
        ])

    claude_denials_do_not_restart = partialmethod(verify_claude, phase='guarded', expectations=(
        'expect(prompts.length).toBe(1)',
        "expect(calls).toEqual([])",
    ))

    def claude_findings_change(self) -> None:
        """New findings arrive while an unchanged correction remains guarded."""
        assert self.claude_phase == "ready", "Prepare the watcher before changing findings"
        self.claude_empty_corrections()
        assert self.claude_phase == "guarded", "Exercise the retry limit before reporting new findings"
        self.claude_phase = "changed"
        self.claude_steps.extend([
            "await $.turn.start({ text: 'review changed findings', turnId: 'changed' })",
            "await $.tool.call({ tool: 'Edit', file_path: '/repo/example.py', old_string: 'a', new_string: 'b' })",
            "setReport('zanity: 0 errors and 30 warnings in 1 of 1 files\\n')",
            "await clock.advance(1000)",
            "await $.turn.complete({ ...ended, turnId: 'changed' })",
            "await $.turn.start({ text: prompts[1]!, turnId: 'changed-retry' })",
            "await $.turn.complete({ ...ended, turnId: 'changed-retry' })",
        ])

    claude_changed_findings_get_one_correction = partialmethod(verify_claude, phase='changed', expectations=(
        'expect(prompts.length).toBe(2)',
        "expect(prompts[1]).toContain('30 warnings')",
        "expect(calls).toEqual(['Edit'])",
    ))

    claude_checks_recover = partialmethod(prepare_claude_steps, expected_phase='ready', phase='recovered', steps=(
        'await $.turn.complete(ended)',
        "await $.turn.start({ text: prompts[0]!, turnId: 'repair' })",
        'repair()',
        'await clock.advance(1000)',
        "await $.tool.call({ tool: 'Publish' })",
        "await $.turn.complete({ ...ended, turnId: 'repair' })",
    ))

    claude_recovery_releases_gate = partialmethod(verify_claude, phase='recovered', expectations=(
        'expect(prompts.length).toBe(1)',
        "expect(calls).toEqual(['Publish', 'complete'])",
    ))

    claude_abort_correction = partialmethod(prepare_claude_steps, expected_phase='ready', phase='correction-aborted', steps=(
        'await $.turn.complete(ended)',
        "await $.turn.start({ text: prompts[0]!, turnId: 'correction' })",
        "await $.turn.complete({ ...ended, turnId: 'correction', isAborted: true })",
        'await clock.advance(1000)',
    ))

    claude_interrupted_correction_stays_stopped = partialmethod(verify_claude, phase='correction-aborted', expectations=(
        'expect(prompts.length).toBe(1)',
        "expect(calls).toEqual(['complete'])",
    ))

    claude_api_error = partialmethod(prepare_claude_steps, expected_phase='ready', phase='api-error', steps=(
        "await $.turn.complete({ ...ended, reason: 'error', isAborted: false })",
        'await clock.advance(1000)',
    ))

    claude_api_error_settles = partialmethod(verify_claude, phase='api-error', expectations=(
        'expect(prompts).toEqual([])',
        "expect(calls).toEqual(['complete'])",
    ))

    claude_resume_after_interruption = partialmethod(prepare_claude_steps, expected_phase='ready', phase='user-resumed', steps=(
        "await $.turn.complete({ ...ended, reason: 'aborted', isAborted: true })",
        'await clock.advance(1000)',
        'expect(prompts).toEqual([])',
        "await $.turn.start({ text: 'continue investigation', turnId: 'user-resumed' })",
        "await $.tool.call({ tool: 'Read', file_path: '/repo/example.py' })",
        "await $.turn.complete({ ...ended, turnId: 'user-resumed' })",
    ))

    claude_user_resume_reports_again = partialmethod(verify_claude, phase='user-resumed', expectations=(
        'expect(prompts.length).toBe(1)',
        "expect(prompts[0]).toContain('29 warnings')",
        "expect(calls).toEqual(['complete', 'Read'])",
    ))

    claude_repeat_failure_cycle = partialmethod(prepare_claude_steps, expected_phase='ready', phase='failed-again', steps=(
        'await $.turn.complete(ended)',
        "await $.turn.start({ text: prompts[0]!, turnId: 'repair-cycle' })",
        'repair()',
        'await clock.advance(1000)',
        "await $.turn.complete({ ...ended, turnId: 'repair-cycle' })",
        "expect(calls).toEqual(['complete'])",
        "await $.turn.start({ text: 'review next change', turnId: 'failed-again' })",
        "setReport('zanity: 0 errors and 29 warnings in 1 of 1 files\\n')",
        'await clock.advance(1000)',
        "await $.turn.complete({ ...ended, turnId: 'failed-again' })",
        "await $.turn.start({ text: prompts[1]!, turnId: 'retry-again' })",
        "await $.turn.complete({ ...ended, turnId: 'retry-again' })",
    ))

    claude_repeat_failure_is_fresh = partialmethod(verify_claude, phase='failed-again', expectations=(
        'expect(prompts.length).toBe(2)',
        "expect(prompts[1]).toContain('29 warnings')",
        "expect(calls).toEqual(['complete'])",
    ))

    def claude_two_watchers(self) -> None:
        """Use two independent watcher outputs and retain the configured Zanity publication scope."""
        assert not hasattr(self, 'claude_steps'), f"Configure both watchers before preparing transcript {getattr(self, 'claude_steps', None)!r}"
        self.claude_with_zig = True
        self.claude_new_failure()
        assert self.claude_phase == 'ready', "Both watchers must start before exercising mixed recovery"

    claude_mixed_recovery = partialmethod(prepare_claude_steps, expected_phase='ready', phase='mixed-recovery', steps=(
        'await $.turn.complete(ended)',
        "expect(prompts[0]).toContain('zig')",
        "expect(prompts[0]).toContain('zanity')",
        "await $.turn.start({ text: 'repair zanity', turnId: 'partial-repair' })",
        'repair()',
        'await clock.advance(1000)',
        "await $.tool.call({ tool: 'Publish' })",
        "await $.turn.complete({ ...ended, turnId: 'partial-repair' })",
        'expect(prompts.length).toBe(2)',
        "expect(prompts[1]).toContain('zig')",
        "expect(prompts[1]).not.toContain('zanity')",
        "expect(calls).toEqual(['Publish'])",
        "await $.turn.start({ text: 'repair zig', turnId: 'all-repaired' })",
        "setZigReport('Build Summary: 3/3 steps succeeded; 1/1 tests passed\\n')",
        'await clock.advance(1000)',
        "await $.turn.complete({ ...ended, turnId: 'all-repaired' })",
    ))

    claude_mixed_gates_follow_reports = partialmethod(verify_claude, phase='mixed-recovery', expectations=(
        'expect(prompts.length).toBe(2)',
        "expect(calls).toEqual(['Publish', 'complete'])",
    ))

    claude_restart_session = partialmethod(prepare_claude_steps, expected_phase='ready', phase='restarted', steps=(
        'await $.turn.complete(ended)',
        "await $.turn.start({ text: prompts[0]!, turnId: 'old-correction' })",
        "await $.turn.complete({ ...ended, turnId: 'old-correction', reason: 'aborted', isAborted: true })",
        'expect(prompts.length).toBe(1)',
        '// fresh hook instance after restart',
        'await $.session.start(start)',
        'await clock.advance(500)',
        "await $.tool.call({ tool: 'Edit', file_path: '/repo/example.py', old_string: 'a', new_string: 'b' })",
        'calls.length = 0',
        'await clock.advance(1000)',
        'await clock.advance(1000)',
        'expect(prompts.length).toBe(1)',
        "await $.turn.start({ text: prompts[0]!, turnId: 'new-session' })",
        "await $.turn.complete({ ...ended, turnId: 'new-session' })",
    ))

    claude_restarted_session_corrects = partialmethod(verify_claude, phase='restarted', expectations=(
        'expect(prompts.length).toBe(2)',
        "expect(prompts[1]).toContain('29 warnings')",
        'expect(calls).toEqual([])',
    ))

    claude_resume_session = partialmethod(prepare_claude_steps, expected_phase='ready', phase='session-resumed', steps=(
        'await $.turn.complete(ended)',
        "await $.turn.start({ text: prompts[0]!, turnId: 'old-correction' })",
        "await $.turn.complete({ ...ended, turnId: 'old-correction', reason: 'aborted', isAborted: true })",
        "const resuming = $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })",
        'await clock.advance(1000)',
        'await resuming',
        'prompts.length = 0',
        'calls.length = 0',
        'await clock.advance(500)',
        "await $.tool.call({ tool: 'Edit', file_path: '/repo/example.py', old_string: 'a', new_string: 'b' })",
        'calls.length = 0',
        'await clock.advance(1000)',
        'expect(prompts.length).toBe(1)',
        "await $.turn.start({ text: prompts[0]!, turnId: 'resumed-session' })",
        "await $.turn.complete({ ...ended, turnId: 'resumed-session' })",
    ))

    claude_resumed_session_corrects = partialmethod(verify_claude, phase='session-resumed', expectations=(
        'expect(prompts.length).toBe(2)',
        "expect(prompts[1]).toContain('29 warnings')",
        'expect(calls).toEqual([])',
    ))

    def run_claude_scenario(self) -> None:
        """Run the accumulated DSL steps against the plugin in an isolated Claude test directory."""
        executable = shutil.which("claude")
        assert executable is not None, "Claude Code is required to verify Claude acceptance scenarios"
        plugin = self.fixture_root / "claude-plugin"
        plugin.mkdir()
        shutil.copytree(ROOT / "hooks", plugin / "hooks", ignore=shutil.ignore_patterns("__pycache__"))
        (plugin / ".claude-plugin").mkdir()
        shutil.copyfile(ROOT / ".claude-plugin" / "plugin.json", plugin / ".claude-plugin" / "plugin.json")
        # The fixture keeps its place beside hooks/, so its imports of the hooks resolve as they do in the repository.
        (plugin / "tests" / "fixtures").mkdir(parents=True)
        shutil.copyfile(ROOT / "tests" / "fixtures" / "gating.ts", plugin / "tests" / "fixtures" / "gating.ts")
        fixture = json.dumps("./tests/fixtures/gating")
        bodies = "\n".join(self.claude_steps).split("// fresh hook instance after restart")
        source = f'''
import {{ expect, test }} from 'claude-code/testing'
import {{ start, ended, gatingProject }} from {fixture}
'''
        for number, body in enumerate(bodies):
            source += f'''
test('Claude acceptance scenario {number + 1}', async ($, on) => {{
  const {{ clock, calls, prompts, setReport, setZigReport, repair }} = gatingProject(on, {{ withZig: {str(getattr(self, 'claude_with_zig', False)).lower()} }})
  try {{
    {body}
  }} finally {{
    const ending = $.session.end({{ reason: 'prompt_input_exit', sessionId: 's1', resume: {{ id: 's1' }} }})
    await clock.advance(1000)
    await ending
  }}
}})
'''
        (plugin / "scenario.test.ts").write_text(source)
        result = subprocess.run([executable, "plugin", "test", str(plugin)],
                                text=True, capture_output=True, timeout=30)
        assert result.returncode == 0, result.stdout + result.stderr
