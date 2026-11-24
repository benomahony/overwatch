/**
 * What TCR does to stop itself and to tell the agent: the messages it queues, the judgement it cancels, the pause that holds
 * until the next turn start, and the settings of `.overwatch.json` that decide whether it may act at all.
 */
import type { EngineInterface } from 'claude-code'
import { assert } from './assert'
import { safeLine } from './safe-text'
import { isOverride, readSettings } from './project'
import { BUG_LOG, CommandError, TCR_ACTIVE, identityOf, initialTcr, isJudging, notice, pausedFor, statusText, tcrMessage, type Tcr } from './tcr'
import { readExpecting } from './command-error'
import { readMode, readTcrSettings } from './tcr-settings'
import { OVERRIDE_PATH } from './watchers'
import { schedule } from './delivery'
import { placeRevertNotice } from './revert-slots'
import type { Message, State } from './state'

/** Holds a message about TCR for the agent, in place of one with the same key; a revert wakes the agent. */
export function queueTcr($: EngineInterface, state: State, key: string, queued: Message) {
  assert(typeof queued === 'object' && queued !== null, `the message ${key} is ${typeof queued}, not a message`)
  state.outbox.set(`tcr:${key}`, queued)
  assert(key.length > 0, `a message about TCR was queued with the key ${JSON.stringify(key)}, which names nothing to replace`)
  schedule($, state)
}

/** Holds the notice of a revert beside the notices of the reverts the agent was not told of yet, each under its own key, so that none replaces another. Past MAX_REVERT_NOTICES the rest become one notice with their count. Answers the outbox key of the notice, or undefined when it was counted. */
export function queueRevertNotice($: EngineInterface, state: State, queued: Message): string | undefined {
  assert(typeof queued === 'object' && queued !== null && queued.isWaking, `a revert notice was queued as ${typeof queued}; a revert wakes the agent`)
  const key = placeRevertNotice(state.outbox, queued)
  schedule($, state)
  assert(key === undefined || state.outbox.get(key) === queued, `the revert notice waits under neither its own key ${key} nor the count`)
  return key
}

/** Stops judging the edit that waits, whether its checks have started or not, and makes any judgement in flight stale. */
export async function cancelJudgement($: EngineInterface, state: State) {
  const { epoch } = state
  state.tcrTimer?.cancel()
  state.tcrTimer = undefined
  state.tcrTicket += 1
  assert(state.tcrTimer === undefined, 'a cancelled judgement still has a timer that will start it')
  const kills = [...state.tcrKills]
  state.tcrKills.clear()
  const failures = (await Promise.all(kills.map(kill => kill().then(() => [], (error: unknown) => [error])))).flat()
  if (failures.length > 0) tellUnstoppedSafely($, state, { errors: failures, epoch })
  assert(state.epoch !== epoch || state.tcrKills.size === 0 || kills.length > 0, `${state.tcrKills.size} checks of a cancelled judgement still run`)
  assert(state.epoch !== epoch || kills.every(kill => !state.tcrKills.has(kill)), `${kills.length} stopped checks are still among the ${state.tcrKills.size} that wait to be stopped`)
}

/** Tells the user and the agent that checks could not be stopped, which keep running unseen: the judgement of a newer edit goes on. Each distinct reason is told in its own message, so that a second failed stop does not replace the first. */
export function tellUnstopped($: EngineInterface, state: State, errors: readonly unknown[]) {
  assert(Array.isArray(errors) && typeof state === 'object' && state !== null, `checks that could not be stopped were told with ${typeof errors} errors for the state ${typeof state}`)
  const reasons = [...new Set(errors.map(error => safeLine(error instanceof Error ? error.message : String(error))))].join('; ')
  const text = `overwatch: a check could not be stopped and may keep running: ${reasons}`
  $.ui.toast(text)
  queueTcr($, state, `unstopped:${reasons}`, tcrMessage(text, false))
  assert(state.outbox.has(`tcr:unstopped:${reasons}`), `the check that could not be stopped, for ${reasons}, is not told to the agent`)
}

/** Writes each failure that is no CommandError to the log of the plugin's bugs, and tells of the checks that could not be stopped unless the session they ran in ended meanwhile. It never rejects: an error of the telling itself goes to the log of the plugin's bugs too, since no caller waits for the stop. */
function tellUnstoppedSafely($: EngineInterface, state: State, { errors, epoch }: { errors: readonly unknown[]; epoch: number }) {
  assert(Array.isArray(errors) && Number.isInteger(epoch), `checks that could not be stopped were told with ${typeof errors} errors for the session ${epoch}`)
  for (const error of errors) if (!(error instanceof CommandError)) $.ui.log(`overwatch hit an unexpected error: ${safeLine(String(error))}`, { to: BUG_LOG })
  if (state.epoch !== epoch) return
  try {
    tellUnstopped($, state, errors)
  } catch (error) {
    $.ui.log(`overwatch hit an unexpected error: ${safeLine(String(error))}`, { to: BUG_LOG })
  }
  assert(Number.isInteger(state.epoch) && epoch <= state.epoch, `checks that could not be stopped began in the session ${epoch}, which has not begun at ${state.epoch}`)
}

/** Stops TCR committing and reverting, for `reason`, until it is decided again at the start of a turn; `held` is the identity of an edit it leaves held, which that decision then recognises. */
export function pauseTcr($: EngineInterface, state: State, reason: string, held?: string) {
  assert(typeof reason === 'string', `TCR was paused for a reason of ${typeof reason}`)
  const status = pausedFor(reason)
  const text = notice(state.tcr.status, status)
  state.tcr = { status, settled: undefined, seen: undefined, unjudged: false, held }
  void cancelJudgement($, state)
  state.onUntold?.()
  if (text !== undefined) queueTcr($, state, 'state', tcrMessage(text, false))
  assert(!state.tcr.unjudged && state.tcr.held === held, `TCR was paused but judges ${state.tcr.unjudged} and holds ${state.tcr.held}, not ${held}`)
}

/** Stops TCR with what a failed read of the project's files says, which is an expected failure, as one that outlasted its limit is; any other error goes on. TCR that is not decided yet stops too, since a read that failed cannot tell whether it runs. A read of a session that ended stops nothing: `epoch` is the session it began in. */
export function pauseOnExpected($: EngineInterface, state: State, error: unknown, epoch: number): undefined {
  assert(typeof state === 'object' && state !== null, `a failed read was told for the state ${typeof state}`)
  assert(Number.isInteger(epoch) && epoch <= state.epoch, `a read began in the session ${epoch}, which has not begun`)
  if (!(error instanceof CommandError)) throw error
  if (state.epoch !== epoch) return undefined
  if (state.tcr.status === undefined) pauseTcr($, state, `${error.message}, and overwatch cannot tell whether this project uses TCR`)
  else pauseUnlessPaused($, state, error.message)
  assert(state.tcr.status !== TCR_ACTIVE && state.tcr.status !== undefined, `TCR is still ${statusText(state.tcr.status)} after a read failed with ${error.message}`)
  return undefined
}

/** What the agent is told when the mode of TCR is taken away from `.overwatch.json` while TCR runs. */
const MODE_OFF = 'overwatch: TCR is off: "mode": "tcr" is no longer set in .overwatch.json, so nothing is committed or reverted.'

/** Why TCR stops when files change while it commits, reverts or decides, since it cannot tell whose they are. */
export const CHANGED_WHILE_ACTING = 'files changed while TCR was committing, reverting or deciding, so it cannot tell whose they are'

/** The settings of TCR the project's `.overwatch.json` holds now, or undefined when TCR must not act: its mode is gone, which switches it off and tells the agent, or invalid, which is reported and pauses it. */
export async function activeSettings($: EngineInterface, state: State, root: string): Promise<{ saveReverted: boolean } | undefined> {
  assert(root.startsWith('/'), `the settings of TCR were read for ${root}; pass the repository's absolute path`)
  const { epoch } = state
  try {
    const override = await readSettings($, root)
    if (state.epoch !== epoch) return undefined
    if (!isOverride(override)) throw new CommandError(`${root}/${OVERRIDE_PATH} must contain a JSON object`)
    if (readMode(override) !== undefined) return readTcrSettings(override)
    const was = state.tcr.status
    state.tcr = initialTcr()
    state.tcrHeld.clear()
    void cancelJudgement($, state)
    state.onUntold?.()
    if (was !== undefined) queueTcr($, state, 'state', tcrMessage(MODE_OFF, false))
  } catch (error) {
    if (!(error instanceof CommandError)) throw error
    if (state.epoch !== epoch) return undefined
    $.ui.toast(`overwatch: ${safeLine(error.message)}`)
    pauseTcr($, state, error.message)
  }
  assert(state.epoch !== epoch || state.tcr.status !== TCR_ACTIVE, `the settings of TCR said it must not act but it is ${statusText(state.tcr.status)}`)
  return undefined
}

/** Stops TCR for `reason`, unless something else stopped it already, whose reason then stands. */
export function pauseUnlessPaused($: EngineInterface, state: State, reason: string) {
  assert(typeof reason === 'string', `TCR was paused for a reason of ${typeof reason}`)
  if (state.tcr.status === TCR_ACTIVE) pauseTcr($, state, reason)
  assert(state.tcr.status !== TCR_ACTIVE, `TCR is still ${statusText(state.tcr.status)} after it was paused for ${reason}`)
}

/** Why TCR stops when the project's gate cannot be used, which the agent is told in its own message. */
const GATE_UNUSABLE = 'the gate in .overwatch.json cannot be used; fix the file, or the gate setting that the gate message names if it names one, and commit any files that changed'

/** Stops TCR for a gate that cannot be used, leaving the edit uncommitted and unreverted, and recording what its files are when a check is held, so that the next turn start knows them again. The Python engine does nothing at an event with such a gate, so that TCR starts again once it is fixed. */
export async function stopForGate($: EngineInterface, state: State, { root }: { root: string }) {
  const { epoch } = state
  const held = state.tcrHeld.size > 0 ? await identityOf($, root) : undefined
  if (state.epoch !== epoch) return
  pauseTcr($, state, GATE_UNUSABLE, held)
  assert(state.tcr.status !== TCR_ACTIVE && !state.tcr.unjudged, `TCR is ${statusText(state.tcr.status)} after the gate could not be used`)
  assert(state.tcrHeld.size === 0 || state.tcr.held !== undefined, `${state.tcrHeld.size} checks are held but the files of the edit were not recorded`)
}

/** What a failed question to the checkpoint command leaves, `fallback`, while any other failure goes on. */
export function orElse<T>(fallback: T): (error: unknown) => T {
  return error => {
    if (!(error instanceof CommandError)) throw error
    assert(typeof error.message === 'string', `the message of ${String(error)} is ${typeof error.message}, not text`)
    assert(typeof fallback !== 'function', `the fallback of a failed question is a ${typeof fallback}; give a value, not a function to call`)
    return fallback
  }
}

/** Why TCR cannot act on a project that has no check to judge an edit by. */
const NO_CHECKS = 'no checks are configured'

/** Stops TCR for a project with no check to judge by, saying that PATH could not be read when the host refused it, since no checker can be found then; unless the judgement ended while PATH was read. */
export async function pauseForNoChecks($: EngineInterface, state: State, started: { epoch: number; tcr: Tcr; ticket: number }) {
  assert(started.ticket <= state.tcrTicket, `the judgement ${started.ticket} is from the future; the latest is ${state.tcrTicket}`)
  const { failure } = await readExpecting(() => $.env.get('PATH'))
  if (!isJudging(state, started)) return
  pauseTcr($, state, failure === undefined ? NO_CHECKS : `PATH could not be read (${safeLine(failure)}), so overwatch may not find the checks`)
  assert(state.tcr.status !== TCR_ACTIVE, `TCR is still ${statusText(state.tcr.status)} after it found no check`)
}
