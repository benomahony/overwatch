/**
 * Whether a turn may end or a protected action run while checks fail, and the correction the agent is sent when one
 * may not.
 */
import type { EngineInterface } from 'claude-code'
import { assert } from './assert'
import { failOpen } from './boundary'
import { safeLine, safePath } from './safe-text'
import { readGate, type GatePolicy } from './gating'
import { CommandError, isEditJudgedByTcr, UPSTREAM_LANGUAGE } from './tcr'
import { bareSummary, hasRegression, languageOf } from './watchers'
import { rootOf, readOverride } from './project'
import type { LiveWatcher, State } from './state'
import { schedule } from './delivery'

/** Tells the agent that the project's gate cannot be read or is malformed, once for each message, as the Python engine tells it in a system message; the gate then decides nothing until it is fixed. */
function tellPolicyError($: EngineInterface, state: State, error: CommandError) {
  assert(error instanceof CommandError, `the gate that cannot be used was told from ${typeof error}, not an expected failure`)
  const text = `overwatch: ${safeLine(error.message)}`
  if (state.policyTold === text) return
  state.policyTold = text
  state.outbox.set('gate:policy', { text, isWaking: false, kind: 'gate' })
  schedule($, state)
  assert(state.outbox.has('gate:policy'), 'the message about the malformed gate is not waiting after queueing it')
}

/** Policy is read afresh, but ordinary tool calls never rerun a check. Undefined when the project's gate is malformed or its file cannot be read: the agent is told once, and nothing is held until it is fixed, since the agent may not be able to fix it while a tool is held. */
export async function projectPolicy($: EngineInterface, state: State): Promise<GatePolicy | undefined> {
  assert(typeof state === 'object' && state !== null, `the policy was read for the state ${typeof state}`)
  assert(state.cwd === undefined || typeof state.cwd === 'string', `the session's directory is ${typeof state.cwd}, not text`)
  if (state.cwd === undefined) return {}
  const { epoch } = state
  try {
    const root = await rootOf($, state.cwd, state)
    if (root === undefined) return {}
    const policy = readGate(await readOverride($, root))
    if (state.epoch === epoch) state.policyTold = undefined
    return policy
  } catch (error) {
    if (!(error instanceof CommandError)) throw error
    if (state.epoch === epoch) tellPolicyError($, state, error)
    return undefined
  }
}

/** Whether TCR tells this new failure, by a revert or by why it held the edit, or has not judged it yet: the guard of a turn's end then says nothing of it, since the agent would be sent to fix a failure that TCR reverted, or hear it twice. */
function isToldByTcr(state: State, { watcher, report, baseline }: LiveWatcher): boolean {
  assert(watcher === undefined || typeof watcher.name === 'string', `a check of ${typeof watcher} was asked whether TCR tells its failure`)
  if (watcher === undefined || report === undefined || baseline === undefined) return false
  const isTold = isEditJudgedByTcr(state.tcr) && languageOf(watcher) !== UPSTREAM_LANGUAGE && hasRegression(report, baseline)
  assert(!isTold || report.isFailed, `${watcher.name} is told by TCR as a failure but its report ${report.summary} passes`)
  return isTold
}

/** Whether a failing check guards the actions among `checks`, or every action when `checks` is empty. */
function guards({ report, baseline, watcher }: LiveWatcher, policy: GatePolicy, checks: readonly string[]): boolean {
  assert(Array.isArray(checks), `the checks that guard are ${typeof checks}, not a list`)
  if (report === undefined || baseline === undefined || !report.isFailed || report.environment !== undefined) return false
  if (checks.length > 0 && !checks.includes(watcher?.name ?? '') && !checks.includes(watcher === undefined ? '' : languageOf(watcher))) return false
  const isGuarding = policy.inherited === 'block' || hasRegression(report, baseline)
  assert(!isGuarding || report.isFailed, `a check guards with the report ${report.summary}, which passes`)
  return isGuarding
}

/** Why an action is refused: the failing checks among checks that guard it, or undefined when none does. With `skipsTcrFailures`, a new failure that TCR tells, has reverted or has not judged yet guards nothing. */
export function guardedFailure(state: State, policy: GatePolicy, checks: readonly string[] = [], { skipsTcrFailures = false }: { skipsTcrFailures?: boolean } = {}): string | undefined {
  const blocked = state.liveWatchers.filter(live => !(skipsTcrFailures && isToldByTcr(state, live)) && guards(live, policy, checks))
  if (blocked.length === 0) return undefined
  assert(blocked.every(each => each.report?.isFailed), `liveWatchers ${blocked.map(each => each.key)} guard while passing`)
  assert(blocked.length <= state.liveWatchers.length, `${blocked.length} checks guard of the ${state.liveWatchers.length} that run`)
  const summaries = blocked.map(each => `${safePath(each.watcher?.name ?? '')}: ${each.report === undefined ? '' : safeLine(bareSummary(each.report))}`).join('; ').replace(/\.+$/, '')
  return `overwatch: this action is guarded while relevant checks fail. ${summaries}. Inspection, edits, and check commands remain available.`
}

/** Completion hooks return text; queue a correction instead of returning a tool-only denial. */
export async function completionGuard($: EngineInterface, state: State): Promise<string | undefined> {
  const { epoch } = state
  if (!state.liveWatchers.some(each => each.report?.isFailed)) {
    state.completionCorrection = undefined
    return undefined
  }
  const policy = await projectPolicy($, state)
  const reason = policy === undefined ? undefined : guardedFailure(state, policy, [], { skipsTcrFailures: true })
  if (reason === undefined) {
    state.completionCorrection = undefined
    return undefined
  }
  assert(typeof reason === 'string', `the guard gave ${typeof reason}, not text`)
  if (state.completionCorrection === reason) return reason
  if (state.completionCorrection !== undefined && !state.isEditedSinceCorrection) return reason
  state.completionCorrection = reason
  state.isEditedSinceCorrection = false
  state.isTurnRunning = false
  if (!state.isPromptQueued) {
    state.isPromptQueued = true
    await $.prompt.submit({ text: reason })
  }
  assert(state.epoch !== epoch || state.isPromptQueued, `the correction ${reason} was neither queued nor already waiting`)
  return reason
}

/**
 * Ends the main agent's turn, unless a guarded failure stands: then the turn goes on and this returns the
 * correction for it. A cancelled or unsuccessful turn cannot carry out a correction pass, so it ends.
 */
export async function completeTurn($: EngineInterface, state: State, isAnswered: boolean): Promise<string | undefined> {
  if (!isAnswered) {
    state.isTurnRunning = false
    // Hold automatic wakeups until the next turn starts, including queued watcher reports.
    state.isPromptQueued = true
    assert(!state.isTurnRunning && state.isPromptQueued, `an unanswered turn left isTurnRunning ${state.isTurnRunning} and isPromptQueued ${state.isPromptQueued}; end it and hold wakeups`)
    return undefined
  }
  const { epoch } = state
  const reason = await completionGuard($, state)
  if (state.epoch !== epoch) return reason
  if (reason !== undefined) {
    assert(state.isTurnRunning || state.isPromptQueued, `the correction neither holds the running turn, ${state.isTurnRunning}, nor has a queued prompt, ${state.isPromptQueued}`)
    return reason
  }
  state.isTurnRunning = false
  schedule($, state)
  assert(!state.isTurnRunning, `the turn still runs after it ended without a correction; set isTurnRunning to false`)
  return undefined
}

/** `completeTurn` inside the boundary: an error nobody expected is told and written to the host's log, and the turn ends, since nothing the agent can do clears it. */
export async function endMainTurn($: EngineInterface, state: State, isAnswered: boolean): Promise<string | undefined> {
  assert(typeof isAnswered === 'boolean', `whether the turn was answered is ${typeof isAnswered}, not true or false`)
  assert(Array.isArray(state.liveWatchers), `the session holds ${typeof state.liveWatchers}, not a list of checks`)
  const { epoch } = state
  const reason = await failOpen($, state, () => completeTurn($, state, isAnswered))
  if (reason === undefined && state.epoch === epoch) state.isTurnRunning = false
  return reason
}
