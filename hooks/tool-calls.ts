/** The tool calls of the agent as the plugin sees them: the denial of one over a failing check, and the count of the editing ones that run. */
import type { EngineInterface } from 'claude-code'
import { assert } from './assert'
import { failOpen } from './boundary'
import { guardedFailure, projectPolicy } from './completion'
import { protectedChecks } from './gating'
import { EDITING_TOOLS, noteFilesBefore } from './judgement'
import type { State } from './state'

/**
 * Counts an editing tool call as running. The call that begins when none runs compares the files with what the agent's
 * last edit left; a call that begins while that comparison runs waits for it, so that no tool of the batch writes meanwhile
 * and any difference is a person's, and one that begins while a tool runs compares nothing, since that tool's write may be
 * what changed the files. The wait ends when the comparison does, and a comparison that fails does not keep the call from running.
 */
async function startEditing($: EngineInterface, state: State, call: symbol) {
  assert(!state.tcrEditing.has(call), `the editing tool call of ${String(call.description)} was counted as running twice`)
  const isAlone = state.tcrEditing.size === 0
  state.tcrEditing.add(call)
  if (isAlone) state.tcrCompared = failOpen($, state, () => noteFilesBefore($, state)).then(() => undefined)
  await state.tcrCompared
  assert(!isAlone || state.tcrCompared !== undefined, `the comparison of the files before the editing tool call of ${String(call.description)} was not kept for the calls that begin while it runs`)
}

/** Runs a tool call. An editing one counts as in flight from before it changes the files until TCR has looked at the result, so that a decision about TCR that ends meanwhile knows the agent's own edit may be what changed them. */
export async function whileEditing<T>($: EngineInterface, state: State, tool: string, run: () => Promise<T>): Promise<T> {
  assert(typeof state === 'object' && state !== null && typeof run === 'function', `an editing tool call ran for the state ${typeof state} and the work ${typeof run}`)
  const call = Symbol(tool)
  try {
    if (EDITING_TOOLS.has(tool)) await startEditing($, state, call)
    return await run()
  } finally {
    state.tcrEditing.delete(call)
    assert(!state.tcrEditing.has(call), `the editing tool call of ${tool} still counts as running after it ended`)
  }
}

/** The denial of a tool call that a failing check guards, or undefined when the call may run. */
export async function deniedWhileFailing($: EngineInterface, state: State, e: { tool: string }): Promise<{ deny: string } | undefined> {
  assert(typeof e === 'object' && e !== null, `a tool call is ${typeof e}, not an event`)
  assert(typeof e.tool === 'string', `a tool call named the tool ${typeof e.tool}, not a tool name`)
  if (!state.liveWatchers.some(each => each.report?.isFailed)) return undefined
  const policy = await projectPolicy($, state)
  if (policy === undefined) return undefined
  const checks = protectedChecks(e.tool, e, policy)
  const reason = checks === undefined ? undefined : guardedFailure(state, policy, checks)
  return reason === undefined ? undefined : { deny: reason }
}
