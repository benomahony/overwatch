/**
 * What a turn start does around its decision: which repository it decides for, what it leaves for the next edit to be judged,
 * and the note that TCR checkpoints land on main or master.
 */
import type { EngineInterface } from 'claude-code'
import { assert } from './assert'
import { activeSettings, cancelJudgement, orElse, pauseOnExpected, pauseTcr, queueTcr } from './pausing'
import { changedOutside } from './hold-notices'
import { branchOf } from './project'
import { forgetSuppressed } from './delivery'
import { OUTSIDE_CHANGE, TCR_ACTIVE, dirtyFiles, statusText, tcrMessage, type Status, type Tcr } from './tcr'
import type { State } from './state'

/** The repository at `root` when the project's settings let TCR decide; undefined when there is none or they do not, TCR then being off, or paused with the reason. */
export async function activeRoot($: EngineInterface, state: State, root: string | undefined): Promise<string | undefined> {
  assert(root === undefined || typeof root === 'string', `TCR was asked to decide for ${typeof root}, not a repository`)
  const settings = root === undefined ? undefined : await activeSettings($, state, root)
  assert(settings === undefined || root !== undefined, `the settings of ${root} let TCR decide but there is no repository`)
  return settings === undefined ? undefined : root
}

/** Leaves the edit that waits to be judged, unless the files are no longer what it left and no editing tool call of the agent runs, whose own write is what may have changed them, and which looked at the files before it began: then a person wrote some, which a checkpoint or a revert would take with the edit, so TCR stops. An edit that was judged, held or replaced while the decision ran is no longer the one it was about, and is left to what ended it. */
export function keepPending($: EngineInterface, state: State, { tcr, settled }: { tcr: Tcr; settled: string | undefined }) {
  if (state.tcr !== tcr || !tcr.unjudged) return
  assert(tcr.seen !== undefined, `an edit that waits was kept with ${tcr.seen} seen`)
  if (settled !== tcr.seen && state.tcrEditing.size === 0) pauseTcr($, state, OUTSIDE_CHANGE)
  assert(settled === tcr.seen || state.tcrEditing.size > 0 || state.tcr.status !== TCR_ACTIVE, `the files are ${settled} but the edit that waits left ${tcr.seen}, and TCR stayed on with no editing tool running`)
}

/** Leaves the failures of the edit to the checks, which tell the ones they reported while TCR waited and every one they report next, since TCR tells none. */
export function leaveToChecks(state: State) {
  assert(state.tcr.status === TCR_ACTIVE, `the failures of an edit were left to the checks while TCR is ${statusText(state.tcr.status)}`)
  state.tcr.isLeftToChecks = true
  state.onUntold?.()
  assert(state.tcr.isLeftToChecks === true && !state.tcr.unjudged, `the failures of an edit were left to the checks but the edit is marked ${String(state.tcr.isLeftToChecks)} and waits ${state.tcr.unjudged}`)
}

/** Stops TCR for files that changed outside the agent's edits, naming the files git lists as changed when it can, unless the session ended meanwhile, or TCR stopped itself, which leaves nothing to stop. */
export async function pauseForOutsideChange($: EngineInterface, state: State, { root, epoch }: { root: string; epoch: number }): Promise<undefined> {
  assert(root.startsWith('/'), `the files of ${root} differ from what the agent left; pass the repository's absolute path`)
  const names = await dirtyFiles($, root).catch(orElse([] as string[]))
  if (state.epoch === epoch && state.tcr.status === TCR_ACTIVE) pauseTcr($, state, changedOutside(names, OUTSIDE_CHANGE))
  assert(state.epoch !== epoch || state.tcr.status !== TCR_ACTIVE, `the files of ${root} differ from what the agent left, but TCR stayed on`)
  return undefined
}

/** Tells the agent what a decision changed, `text` when it is one, and has the checks tell the failures that wait for a judgement no edit is left to get: a decision that keeps an edit waiting does not come here. */
export function tellDecision($: EngineInterface, state: State, { text, next }: { text: string | undefined; next: Status }) {
  assert(typeof state === 'object' && state !== null, `a decision about TCR was told for the state ${typeof state}`)
  if (text !== undefined) queueTcr($, state, 'state', tcrMessage(text, false))
  state.onUntold?.()
  assert(next === TCR_ACTIVE || typeof next === 'object', `a decision about TCR left the status ${typeof next}, not active or paused`)
}

/**
 * Leaves the edit that waits neither committed, held nor reverted, for the step also moved HEAD: the failures the move
 * brought in are in the fresh baselines as inherited, so the checks say nothing of the edit. The files stay as they are
 * and TCR looks at them again at the next edit or turn start.
 */
export async function leaveUnjudged($: EngineInterface, state: State) {
  assert(state.tcr.status !== undefined || !state.tcr.unjudged, `an edit waits to be judged while TCR is ${statusText(state.tcr.status)}; decide TCR before judging`)
  const { epoch, tcr } = state
  tcr.unjudged = false
  forgetSuppressed(state)
  await cancelJudgement($, state)
  assert(state.epoch !== epoch || (!tcr.unjudged && state.tcrTimer === undefined), `an edit that came with a move of HEAD still waits to be judged: unjudged ${tcr.unjudged}, timer ${String(state.tcrTimer)}, epoch ${state.epoch} of ${epoch}`)
}

/** Tells the agent when TCR starts on main or master, where its checkpoints then land. */
export async function noteBranch($: EngineInterface, state: State, root: string) {
  assert(root.startsWith('/'), `the branch of ${root} was asked for; pass the repository's absolute path`)
  const { epoch } = state
  const branch = await branchOf($, root).catch(error => pauseOnExpected($, state, error, epoch))
  if (state.epoch === epoch && (branch === 'main' || branch === 'master')) queueTcr($, state, 'branch', tcrMessage(`overwatch: TCR checkpoints land on ${branch}`, false))
  assert(branch === undefined || branch !== '', `the branch of ${root} is the empty name ${JSON.stringify(branch)}`)
}
