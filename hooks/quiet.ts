/**
 * The quiet timer of a watcher's run: it waits for the watcher's output, or the agent's edits, to stop for QUIET_MS before it works. Each run has its own,
 * by the epoch of its session, so that an old run cannot cancel the timer of the one after it.
 */
import type { EngineInterface } from 'claude-code'
import { assert } from './assert'
import { background } from './boundary'
import { QUIET_MS } from './delivery'
import type { Run } from './state'

/** Runs `work` once the run's watcher has been quiet for QUIET_MS, in place of the work this run waits to do; a run of a session that ended waits for nothing, and no run touches the timer of another. */
export function whenQuiet($: EngineInterface, run: Run, work: () => unknown) {
  const { state, live, epoch } = run
  assert(Number.isInteger(epoch) && epoch <= state.epoch, `the run of ${live.key} began in the session ${epoch}, which is after the present ${state.epoch}`)
  live.quiet.get(epoch)?.cancel()
  live.quiet.delete(epoch)
  if (epoch === state.epoch) live.quiet.set(epoch, $.clock.after(QUIET_MS, () => background($, state, work)))
  assert(live.quiet.has(epoch) === (epoch === state.epoch), `${live.key} waits for the session ${epoch} while the present is ${state.epoch}`)
}

/** Cancels the wait of this run, and no other. */
export function stopWaiting({ live, epoch }: Run) {
  assert(live.quiet instanceof Map, `${live.key} keeps its quiet timers in ${typeof live.quiet}, not a map by epoch`)
  live.quiet.get(epoch)?.cancel()
  live.quiet.delete(epoch)
  assert(!live.quiet.has(epoch), `${live.key} still waits for the session ${epoch} after its run stopped waiting`)
}
