"""Tests that no call of the hooks that queues a message or pauses TCR follows an await without a guard that names the session.

A queue or a pause changes the state of the session that is current when it runs. An old session that waits for a read, a command or a limit may be followed by a new one, whose agent would be told what the old one learned, and whose TCR would stop for it. The scan reads each function of hooks/ and each call of a name in QUEUES: when the function awaits before the call, the call needs, after the last await, one of these. A `tellUnexpected` whose last argument is the plain name `epoch`, which the entry captured when it began. An `if` in a block that holds the call, whose condition compares `state.epoch` with a captured `epoch`, or `state.tcr` with a captured `tcr`, by `!==` with nothing joined to it by `&&`, and that leaves; or a call of `isJudging` that is negated, with nothing joined to it by `&&`, and that leaves. The statement under an `if` that compares them by `===` with nothing joined to it by `||`, or that calls `isJudging` with nothing joined to it by `||`. A condition that negates a group, as in `!(state.epoch !== epoch)`, is no guard. A call in a `catch` block needs a guard inside that block, since the throw may come before any guard of the `try`.

Its limits (unverified where the scan was not run against an example): it reads one function at a time, so a function that queues only after its caller guarded it, or that a caller awaits, is not found; a wrapper such as `holdTcr`, `checkpointTcr`, `noteBranch` or `activeSettings` is read for its own calls only, and `judgeChecks` reaches `actOnJudgement` guarded by the callee alone; the awaits of a function nested in another count for both; it does not tell whether the captured value it compares with is the right one, and a `.then(...)` in a function with no `await` is not read as a wait; a call that a loop repeats after an earlier turn awaited is read once; a call through an alias, with `?.()` or as `module.name()` is not scanned; a name that QUEUES lacks is not scanned, which holds `$.prompt.submit`, `$.ui.toast` and `state.outbox.set`. The toast after `noteHead` in `checkpointTcr` is shown to the user and queues nothing for an agent, and it names a commit that was made, so it is no message to a wrong session.

Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
"""
from __future__ import annotations

import unittest

import paths
from codex_hook import read
from hook_epochs import without_guard
from ts_source import calls, masked

HOOKS = paths.ROOT / "hooks"
QUEUES = ("queueTcr", "queueRevertNotice", "queueRevert", "queue", "queueEnvironment", "tellUnexpected", "pauseTcr", "pauseUnlessPaused", "stopForGate")
EXEMPT: dict[tuple[str, str, str], str] = {
    ("delivery.ts", "deliver", "queue"): "takeBaseline answers nothing once the session ended, and the function returns then, with no await between that answer and the queue",
}


def is_declaration(code: str, opening: int, name: str) -> bool:
    """Whether the parenthesis at opening follows the name that a `function` declares."""
    return code[:opening - len(name)].rstrip().endswith("function")


def scan_hooks() -> tuple[tuple[int, int], list[tuple[str, str, str]]]:
    """How many declarations of a name in QUEUES and how many calls of one the hooks hold, and the calls that follow an await unguarded."""
    declarations, called, found = 0, 0, []
    for path in sorted(HOOKS.glob("*.ts")):
        source = read(path)
        code = masked(source)
        for name in QUEUES:
            opened = calls(code, name)
            declarations += sum(is_declaration(code, opening, name) for opening in opened)
            called += sum(not is_declaration(code, opening, name) for opening in opened)
        found += without_guard(path.name, source, QUEUES)
    return (declarations, called), found


DECLARATIONS_OF_QUEUES = 9
CALLS_OF_QUEUES = 47


class QueueEpochTests(unittest.TestCase):
    def test_the_scan_reads_the_calls_the_hooks_hold(self) -> None:
        """The two numbers are what the scan finds now: the declarations of a name in QUEUES, and the calls of one, wherever they stand. A change to a hook that adds or removes either changes them: read the new call, then set the literals to the numbers the failure prints."""
        self.assertEqual(scan_hooks()[0], (DECLARATIONS_OF_QUEUES, CALLS_OF_QUEUES))

    def test_no_queue_or_pause_follows_an_await_unguarded(self) -> None:
        found = scan_hooks()[1]
        self.assertEqual([key for key in found if key not in EXEMPT], [], "a call that queues a message or pauses TCR follows an await with no guard that names the session")

    def test_every_exemption_names_a_call_that_still_needs_it(self) -> None:
        self.assertEqual(sorted(set(EXEMPT) - set(scan_hooks()[1])), [], "an exemption names a call that no longer needs it")

    def test_the_scan_flags_the_calls_that_reach_a_newer_session(self) -> None:
        """Each source holds one call that follows an await with no guard that names the session, in a form that looks like one, and the scan finds it."""
        awaited = "async function f($, state) {\n  const { epoch } = state\n  await g()\n  queueTcr($, state, 'x', m)\n}"
        paused = "async function f($, state) {\n  await g()\n  pauseTcr($, state, 'x')\n}"
        weak = "async function f($, state) {\n  const { epoch } = state\n  await g()\n  if (state.epoch !== epoch) {}\n  queueTcr($, state, 'x', m)\n}"
        before_await = "async function f($, state) {\n  const { epoch } = state\n  if (state.epoch !== epoch) return\n  await g()\n  queueTcr($, state, 'x', m)\n}"
        catching = "async function f($, state) {\n  const { epoch } = state\n  try {\n    await g()\n    if (state.epoch !== epoch) return\n  } catch (error) {\n    pauseTcr($, state, 'x')\n  }\n}"
        message_text = "async function f($, state) {\n  await g()\n  pauseTcr($, state, 'the epoch moved')\n}"
        current_epoch = "async function f($, state) {\n  const { epoch } = state\n  await g()\n  tellUnexpected($, state, e, state.epoch)\n}"
        and_exit = "async function f($, state) {\n  const { epoch } = state\n  await g()\n  if (state.epoch !== epoch && cond) return\n  queueTcr($, state, 'x', m)\n}"
        other_object = "async function f($, state) {\n  const { epoch } = state\n  await g()\n  if (other.epoch !== epoch) return\n  queueTcr($, state, 'x', m)\n}"
        same_side = "async function f($, state) {\n  await g()\n  if (state.epoch !== state.epoch) return\n  queueTcr($, state, 'x', m)\n}"
        or_act = "async function f($, state) {\n  const { epoch } = state\n  await g()\n  if (state.epoch === epoch || cond) pauseTcr($, state, 'x')\n}"
        negated_leave = "async function f($, state) {\n  const { epoch } = state\n  await g()\n  if (!(state.epoch !== epoch)) return\n  queueTcr($, state, 'x', m)\n}"
        negated_act = "async function f($, state) {\n  const { epoch } = state\n  await g()\n  if (!(state.epoch === epoch)) pauseTcr($, state, 'x')\n}"
        and_judging_exit = "async function f($, state) {\n  await g()\n  if (!isJudging(state, s) && cond) return\n  queueTcr($, state, 'x', m)\n}"
        or_judging_act = "async function f($, state) {\n  await g()\n  if (isJudging(state, s) || cond) pauseTcr($, state, 'x')\n}"
        negated_judging_act = "async function f($, state) {\n  await g()\n  if (!(isJudging(state, s))) pauseTcr($, state, 'x')\n}"
        nested = "async function f($, state) {\n  const { epoch } = state\n  await g()\n  if (cond) {\n    if (state.epoch !== epoch) return\n  }\n  queueTcr($, state, 'x', m)\n}"
        for source in (awaited, paused, weak, before_await, catching, message_text, current_epoch, and_exit, other_object, same_side, or_act, negated_leave, negated_act, and_judging_exit, or_judging_act, negated_judging_act, nested):
            self.assertEqual(len(without_guard("x.ts", source, QUEUES)), 1, source)

    def test_the_scan_accepts_the_calls_that_name_the_session(self) -> None:
        sources = [
            "async function f($, state) {\n  const { epoch } = state\n  await g()\n  if (state.epoch !== epoch) return\n  queueTcr($, state, 'x', m)\n}",
            "async function f($, state) {\n  const { epoch } = state\n  await g()\n  if (state.epoch === epoch) queueTcr($, state, 'x', m)\n}",
            "async function f($, state) {\n  const { epoch } = state\n  await g()\n  tellUnexpected($, state, e, epoch)\n}",
            "async function f($, state) {\n  const { tcr } = state\n  await g()\n  if (state.tcr === tcr) pauseTcr($, state, 'x')\n}",
            "function f($, state) {\n  pauseTcr($, state, 'x')\n}",
            "async function f($, state) {\n  const { epoch } = state\n  try {\n    await g()\n  } catch (error) {\n    if (state.epoch !== epoch) return\n    pauseTcr($, state, 'x')\n  }\n}",
            "async function f($, state) {\n  const { epoch } = state\n  await g()\n  if (state.epoch === epoch && (b === 'x' || b === 'y')) queueTcr($, state, 'x', m)\n}",
            "async function f($, state) {\n  const { epoch } = state\n  await g()\n  if (cond || state.epoch !== epoch) return\n  queueTcr($, state, 'x', m)\n}",
            "async function f($, state) {\n  await g()\n  if (!isJudging(state, s) || cond) return\n  queueTcr($, state, 'x', m)\n}",
            "async function f($, state) {\n  await g()\n  if (isJudging(state, s) && cond) pauseTcr($, state, 'x')\n}",
            "async function f($, state) {\n  const { epoch } = state\n  if (cond) {\n    await g()\n    if (state.epoch !== epoch) return\n    queueTcr($, state, 'x', m)\n  }\n}",
        ]
        for source in sources:
            self.assertEqual(without_guard("x.ts", source, QUEUES), [], source)


if __name__ == "__main__":
    unittest.main()
