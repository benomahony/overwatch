/**
 * Whether a turn may end or a protected action run while checks fail, and the correction the agent is sent when one
 * may not.
 */
import type { EngineInterface } from 'claude-code'
import { assert } from './assert'
import type { GatePolicy } from './gating'
import { OVERRIDE_PATH, bareSummary, hasRegression, languageOf } from './watchers'
import { repositoryOf, readOverride } from './project'
import type { State } from './state'
import { schedule } from './delivery'

/** Policy is read afresh, but ordinary tool calls never rerun a check. */
export async function projectPolicy($: EngineInterface, state: State): Promise<GatePolicy> {
  if (state.cwd === undefined) return {}
  const root = await repositoryOf($, state.cwd)
  const policy = root === undefined ? {} : (await readOverride($, root)).gate ?? {}
  assert(policy.inherited === undefined || ['allow', 'block'].includes(policy.inherited), `gate.inherited is ${policy.inherited}; set allow or block in ${OVERRIDE_PATH}`)
  assert(policy.protected_actions === undefined || Array.isArray(policy.protected_actions), `gate.protected_actions is ${JSON.stringify(policy.protected_actions)}; make it an array in ${OVERRIDE_PATH}`)
  return policy
}

/** Why an action is refused: the failing checks among checks that guard it, or undefined when none does. */
export function guardedFailure(state: State, policy: GatePolicy, checks: readonly string[] = []): string | undefined {
  const blocked = state.liveWatchers.filter(({ report, baseline, watcher }) => {
    if (report === undefined || baseline === undefined || !report.isFailed || report.environment !== undefined) return false
    if (checks.length > 0 && !checks.includes(watcher?.name ?? '') && !checks.includes(watcher === undefined ? '' : languageOf(watcher))) return false
    return policy.inherited === 'block' || hasRegression(report, baseline)
  })
  if (blocked.length === 0) return undefined
  assert(blocked.every(each => each.report?.isFailed), `liveWatchers ${blocked.map(each => each.key)} guard while passing`)
  const summaries = blocked.map(each => `${each.watcher?.name}: ${each.report === undefined ? '' : bareSummary(each.report)}`).join('; ').replace(/\.$/, '')
  assert(summaries.split('; ').length >= blocked.length, `reason ${summaries} names fewer than ${blocked.length} guarding checks`)
  assert(!summaries.endsWith('.'), `reason ${summaries} ends in a full stop the guard text adds again; strip it`)
  return `overwatch: this action is guarded while relevant checks fail. ${summaries}. Inspection, edits, and check commands remain available.`
}

/** Completion hooks return text; queue a correction instead of returning a tool-only denial. */
export async function completionGuard($: EngineInterface, state: State): Promise<string | undefined> {
  if (!state.liveWatchers.some(each => each.report?.isFailed)) {
    state.completionCorrection = undefined
    return undefined
  }
  const reason = guardedFailure(state, await projectPolicy($, state))
  if (reason === undefined) {
    state.completionCorrection = undefined
    return undefined
  }
  if (state.completionCorrection === reason) return reason
  if (state.completionCorrection !== undefined && !state.isEditedSinceCorrection) return reason
  assert(reason.startsWith('overwatch: '), `completion correction ${reason} does not say it is from overwatch`)
  state.completionCorrection = reason
  state.isEditedSinceCorrection = false
  state.isTurnRunning = false
  if (!state.isPromptQueued) {
    state.isPromptQueued = true
    await $.prompt.submit({ text: reason })
  }
  assert(state.isPromptQueued, `the correction ${reason} was neither queued nor already waiting`)
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
  const reason = await completionGuard($, state)
  if (reason !== undefined) {
    assert(reason.startsWith('overwatch: ') && (state.isTurnRunning || state.isPromptQueued), `correction ${reason} neither holds the running turn nor has a queued prompt`)
    return reason
  }
  state.isTurnRunning = false
  schedule($, state)
  assert(!state.isTurnRunning, `the turn still runs after it ended without a correction; set isTurnRunning to false`)
  return undefined
}
