/** What a revert leaves to tell the agent after the command answered: which files came back, what the checks said that the revert made stale, and the failures that caused it. */
import type { EngineInterface } from 'claude-code'
import { assert } from './assert'
import { forgetSuppressed, schedule, writeLog } from './delivery'
import { CHANGED_WHILE_ACTING, pauseUnlessPaused, queueRevertNotice } from './pausing'
import { revertNotice } from './revert-slots'
import { safeLine } from './safe-text'
import { CommandError, RevertFailure, TCR_ACTIVE, dirtyFiles, fingerprintOf } from './tcr'
import type { Acting, Edit } from './judgement'
import type { Reverted } from './revert-notices'
import type { Judged, State } from './state'
import type { Report, Watcher } from './watchers'

/** How the files git listed before a revert and the files it lists after it divide: those that are no longer listed, those still listed, and those only the second listing gives, which changed after the first. */
export function stillChanged(listing: readonly string[], left: readonly string[]): { came: string[]; remaining: string[]; late: string[] } {
  assert(Array.isArray(listing) && Array.isArray(left), `the files listed before the revert are ${typeof listing} and after it ${typeof left}, not lists`)
  assert(listing.every(name => typeof name === 'string') && left.every(name => typeof name === 'string'), `the files listed around the revert hold a name that is no text`)
  const came = listing.filter(name => !left.includes(name))
  const remaining = listing.filter(name => left.includes(name))
  const late = left.filter(name => !listing.includes(name))
  assert(came.length + remaining.length === listing.length, `${came.length} came back and ${remaining.length} remain of ${listing.length} files listed`)
  return { came, remaining, late }
}

/** The fingerprint of the files a revert restored and the files that still differ from the checkpoint, or why they cannot be read: the reason the revert's answer gave, or what the questions failed with. */
export async function inspectRestored($: EngineInterface, root: string, unavailable: string | null): Promise<{ restored: string; left: string[] } | CommandError> {
  assert(unavailable === null || typeof unavailable === 'string', `why the files cannot be inspected is ${typeof unavailable}, not text or nothing`)
  if (unavailable !== null) return new CommandError(unavailable)
  try {
    const restored = await fingerprintOf($, root)
    const left = await dirtyFiles($, root)
    assert(typeof restored === 'string' && Array.isArray(left), `the fingerprint is ${typeof restored} and the files left ${typeof left}`)
    return { restored, left }
  } catch (error) {
    if (!(error instanceof CommandError)) throw error
    return error
  }
}

const ENDED_REVERT = 'overwatch: a TCR revert was running when its session ended.'
const NO_COPY_SAVED = 'No copy of the files it may have discarded was saved.'
const NO_COPY_KNOWN = 'It may have discarded files, and no copy of them is known.'

/** Tells the user, not the agent of the session that began in its place, what is known of the copy of the work a revert may have discarded, when the session ended while the revert ran; the agent of that session knows nothing of the edit. `saved` is the ref that holds the copy, null when the command says it saved none, and undefined when no answer says. */
export function tellEndedRevert($: EngineInterface, saved: string | null | undefined) {
  assert(saved === undefined || saved === null || typeof saved === 'string', `the ref of an ended revert is ${JSON.stringify(saved)}, not text or nothing`)
  const copy = typeof saved === 'string' ? `A copy of the files it may have discarded is saved in ${safeLine(saved)}.` : saved === null ? NO_COPY_SAVED : NO_COPY_KNOWN
  $.ui.toast(`${ENDED_REVERT} ${copy}`)
  assert(typeof saved !== 'object' || saved === null, `the ref ${JSON.stringify(saved)} of an ended revert was told as ${copy}`)
}

/** What the user is told when the session ended while a revert ran and the command answered: nothing when the answer says no file was reverted. */
export function tellEndedAnswer($: EngineInterface, answered: { reverted: boolean; saved: string | null | undefined }) {
  assert(typeof answered.reverted === 'boolean', `the answer of an ended revert says ${typeof answered.reverted} of whether it reverted, not true or false`)
  assert(answered.reverted || typeof answered.saved !== 'string', `the answer of an ended revert saved ${String(answered.saved)} without reverting`)
  if (answered.reverted) tellEndedRevert($, answered.saved)
}

/** The failures that caused a revert, each with the check that reported it and the failures it already had, and no log, which no write has given yet. */
export function toldOf(causes: readonly Judged[]): Reverted[] {
  assert(causes.length > 0 && causes.every(({ report }) => report?.isFailed), `a revert is told for ${causes.map(({ live }) => live.key)}, some of which do not fail`)
  const parts = causes.map(({ live, report }) => ({
    watcher: live.watcher as Watcher,
    report: report as Report,
    known: live.baseline?.isFailed ? live.baseline.failures : [],
    log: undefined,
  }))
  assert(parts.length === causes.length, `${parts.length} failures were told for ${causes.length} causes of the revert`)
  return parts
}

/**
 * Queues the notice of a revert as `build` writes it from the failures, at once and without their logs, so that it never waits
 * on a write. The promise it returns settles once the logs are written; when one was and the notice still waits, the notice
 * is replaced with one that names the logs. A bug in `build` throws here, before anything is queued.
 */
export function queueRevert($: EngineInterface, state: State, { causes, build, isSaved }: { causes: readonly Judged[]; build: (told: Reverted[]) => string; isSaved: boolean }): Promise<void> {
  const bare = toldOf(causes)
  forgetSuppressed(state)
  const first = revertNotice(build(bare), isSaved)
  const key = queueRevertNotice($, state, first)
  assert(key === undefined || state.outbox.get(key) === first, `the notice of the revert is not waiting under the key ${key} after it was queued`)
  if (key === undefined) return Promise.resolve()
  return Promise.all(causes.map(({ live, report }) => writeLog($, live, (report as Report).text))).then(logs => {
    assert(logs.length === causes.length, `${logs.length} logs were written for ${causes.length} causes of the revert`)
    if (logs.every(log => log === undefined) || state.outbox.get(key) !== first) return
    state.outbox.set(key, revertNotice(build(bare.map((part, index) => ({ ...part, log: logs[index] }))), isSaved))
    schedule($, state)
  })
}

/** What a failed question to the checkpoint command leaves, a revert that failed after it may have begun, while any other failure goes on. */
export function orFailure(error: unknown): RevertFailure {
  if (!(error instanceof RevertFailure)) throw error
  assert(error instanceof CommandError && typeof error.outcome === 'object', 'a failed revert is a command error that holds the engine\'s report of the reset')
  assert(error.outcome.reset !== undefined, `a failed revert holds the reset ${String(error.outcome.reset)}; it says how the reset ended`)
  return error
}

/** Leaves TCR on with the files the revert restored as settled, or stops it when a newer edit came or a file differs from the checkpoint; the checks' results are forgotten once none of the listed files is still changed. */
export function settleRevert($: EngineInterface, state: State, { acting, edit, aftermath, listing, isWhole }: { acting: Acting; edit: Edit; aftermath: { restored: string; left: string[] }; listing: readonly string[]; isWhole: boolean }) {
  const { tcr, epoch } = acting
  if (state.epoch !== epoch) return
  assert(typeof isWhole === 'boolean' && Array.isArray(aftermath.left), `a settled revert says whether it was whole, ${typeof isWhole}, and lists the files that are left, ${typeof aftermath.left}`)
  assert(listing.length > 0, `a revert of ${listing.length} files was settled; list the files, or the edit as one`)
  const isStill = state.tcr === tcr && tcr.seen === edit.files
  if (!isStill || aftermath.left.length > 0) pauseUnlessPaused($, state, CHANGED_WHILE_ACTING)
  else state.tcr = { status: TCR_ACTIVE, settled: aftermath.restored, seen: aftermath.restored, unjudged: false, held: undefined }
  if (isStill && isWhole) forgetResults(state, listing)
}

/** Forgets what the checks said of the edit that was reverted and what the agent was told of it, since the files they were about are gone. */
export function forgetResults(state: State, names: readonly string[]) {
  for (const each of state.liveWatchers) {
    state.outbox.delete(`${each.key}:report`)
    each.report = undefined
    each.wasFailing = false
    each.told = undefined
    each.isEditedSinceResult = true
    each.changed?.()
  }
  assert(state.liveWatchers.every(each => each.report === undefined && each.isEditedSinceResult), `a live kept its result after the revert of ${names}`)
  assert(state.liveWatchers.every(each => !state.outbox.has(`${each.key}:report`)), `a message about the failure waits after the revert of ${names}`)
}
