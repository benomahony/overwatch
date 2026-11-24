/**
 * TCR in the Claude Code plugin: decides whether it runs, judges the agent's edits with a one-shot run of the checks,
 * and commits the green ones or reverts the ones that add a failure, through engine/checkpoint.py.
 */
import type { EngineInterface } from 'claude-code'
import { assert } from './assert'
import { safeLine } from './safe-text'
import { background, describeError, markTold } from './boundary'
import { changedBecause, changedOutside, heldBecause, leftUncommitted } from './hold-notices'
import { noteHead } from './checkpoint-head'
import { rootOf } from './project'
import {
  BUG_LOG,
  COMMAND_LIMITS_MS,
  CommandError,
  OUTSIDE_CHANGE,
  TCR_ACTIVE,
  UPSTREAM_LANGUAGE,
  ask,
  checkpointedBy,
  dirtyFiles,
  fingerprintOf,
  identityOf,
  isJudging,
  judgementLimitOf,
  limitOf,
  notice,
  pausedFor,
  RevertFailure,
  refusedBecause,
  revertedBy,
  runCheck,
  savedOfError,
  secondsOf,
  shortCommit,
  stateOf,
  statusText,
  announceScale,
  tcrMessage,
  verdictOf,
  type Status,
  type Tcr,
} from './tcr'
import { envOf, languageOf, type Report, type Watcher } from './watchers'
import { brokenRevertMessage, revertMessage, unrevertedMessage, type Reverted } from './revert-notices'
import { QUIET_MS, forgetSuppressed, queueEnvironment } from './delivery'
import { CHANGED_WHILE_ACTING, activeSettings, cancelJudgement, orElse, pauseForNoChecks, pauseOnExpected, pauseTcr, pauseUnlessPaused, queueRevertNotice, queueTcr, stopForGate } from './pausing'
import { projectPolicy } from './completion'
import { activeRoot, keepPending, leaveToChecks, noteBranch, pauseForOutsideChange, tellDecision } from './deciding'
import { revertNotice } from './revert-slots'
import { forgetResults, inspectRestored, orFailure, queueRevert, settleRevert, stillChanged, tellEndedAnswer, tellEndedRevert } from './revert-aftermath'
import type { EditMarks, Judged, LiveWatcher, State } from './state'

/** Tools whose call may change the project's files; a watcher that is no long-running command reruns after each. */
export const EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])


/**
 * Whether TCR can start in the repository at `root`, as TCR_ACTIVE or the reason it cannot, with the fingerprint of the
 * files it starts from. The files are fingerprinted before and after the question, and a change between stops it. Files
 * that are still the edit TCR held for a check without an earlier result, as `held` says, or the edit that waits for its
 * checks, are no reason by themselves.
 */
async function decisionOf($: EngineInterface, root: string, held: { identity: string | undefined; checks: number; isPending: boolean }): Promise<{ next: Status; settled: string | undefined; isHeld: boolean }> {
  assert(root.startsWith('/'), `TCR was asked to decide for ${root}; pass the repository's absolute path`)
  try {
    const files = await fingerprintOf($, root)
    const isHeld = held.isPending || (held.checks > 0 && held.identity !== undefined && (await identityOf($, root)) === held.identity)
    const next = await stateOf($, root, isHeld)
    if (next !== TCR_ACTIVE) return { next, settled: undefined, isHeld: false }
    const decided = (await fingerprintOf($, root)) === files ? { next, settled: files, isHeld } : { next: pausedFor(CHANGED_WHILE_ACTING), settled: undefined, isHeld: false }
    assert((decided.next === TCR_ACTIVE) === (decided.settled !== undefined), `TCR decided ${statusText(decided.next)} with ${decided.settled} settled`)
    return decided
  } catch (error) {
    if (!(error instanceof CommandError)) throw error
    return { next: pausedFor(error.message), settled: undefined, isHeld: false }
  }
}

/**
 * Decides whether TCR runs in the session's repository: the project's mode must be tcr and nothing may stand in the
 * way of a revert, such as uncommitted changes. Decided at the session's start and again at each turn's start, and a
 * change of the files while it decides stops it.
 */
export function decideTcr($: EngineInterface, state: State): Promise<void> {
  const deciding = decideNow($, state)
  const settled = deciding.then(() => undefined, () => undefined).finally(() => {
    if (state.tcrDeciding === settled) state.tcrDeciding = undefined
  })
  state.tcrDeciding = settled
  assert(state.tcrDeciding === settled, 'the decision about TCR is not the one in flight; record it before it ends')
  assert(deciding instanceof Promise, `the decision about TCR is ${typeof deciding}, not something to wait for`)
  return deciding
}

async function decideNow($: EngineInterface, state: State) {
  const { cwd, epoch } = state
  assert(cwd === undefined || typeof cwd === 'string', `the session's directory is ${typeof cwd}, not text`)
  const found = cwd === undefined ? undefined : await rootOf($, cwd, state).catch(error => pauseOnExpected($, state, error, epoch))
  const root = await activeRoot($, state, found)
  if (root === undefined) return
  background($, state, () => announceScale($, state.announced))
  const tcr = state.tcr
  const isPending = tcr.status === TCR_ACTIVE && tcr.unjudged
  const [policy, decided] = await Promise.all([projectPolicy($, state), decisionOf($, root, { identity: tcr.held, checks: state.tcrHeld.size, isPending })])
  const { next, settled, isHeld } = decided
  const isActive = next === TCR_ACTIVE
  if (state.epoch !== epoch) return
  if (policy === undefined) return stopForGate($, state, { root })
  if (isPending && isActive) return keepPending($, state, { tcr, settled })
  const [previous, text] = [state.tcr.status, notice(state.tcr.status, next)]
  const held = isActive && isHeld ? state.tcr.held : undefined
  const isLeftToChecks = isActive && state.tcr.isLeftToChecks === true
  state.tcr = { status: next, settled, seen: settled, unjudged: false, held, isLeftToChecks }
  void cancelJudgement($, state)
  tellDecision($, state, { text, next })
  if (isActive && previous !== TCR_ACTIVE) await noteBranch($, state, root)
  assert(state.epoch !== epoch || !state.tcr.unjudged, `a fresh decision in session ${epoch} left ${state.tcr.seen} waiting to be judged, in session ${state.epoch}`)
}

/** The fingerprint of the files at `root`, or undefined when it cannot be taken, which pauses TCR with the reason. */
async function fingerprintOrPause($: EngineInterface, state: State, root: string, tcr: Tcr): Promise<string | undefined> {
  assert(root.startsWith('/'), `the files of ${root} were fingerprinted; pass the repository's absolute path`)
  try {
    return await fingerprintOf($, root)
  } catch (error) {
    if (!(error instanceof CommandError)) throw error
    if (state.tcr === tcr) pauseTcr($, state, error.message)
    assert(state.tcr.status !== TCR_ACTIVE || state.tcr !== tcr, `the fingerprint failed with ${error.message} but TCR is still ${statusText(state.tcr.status)}`)
    return undefined
  }
}

/** The repository of the session while TCR runs, or undefined when it does not or the search for it outlasted its limit, which pauses TCR with the reason. */
async function rootOrPause($: EngineInterface, state: State, tcr: Tcr): Promise<string | undefined> {
  const { cwd } = state
  assert(state.tcr === tcr || state.tcr.status !== undefined, `the files were looked for with TCR ${statusText(tcr.status)} replaced by an undecided one`)
  if (cwd === undefined || tcr.status !== TCR_ACTIVE) return undefined
  try {
    return await rootOf($, cwd, state)
  } catch (error) {
    if (!(error instanceof CommandError)) throw error
    if (state.tcr === tcr) pauseTcr($, state, error.message)
    assert(state.tcr !== tcr || state.tcr.status !== TCR_ACTIVE, `the search for the repository failed with ${error.message} but TCR is still ${statusText(state.tcr.status)}`)
    return undefined
  }
}

/** What ends the comparison of the files before an editing tool when it outlasts its limit, which the answer of the race tells from the comparison's own end. */
const COMPARISON_STOPPED = Symbol('the comparison of the files outlasted its limit')

/**
 * Before an editing tool runs, when no other one does, and before any tool that began with it does: files that differ from
 * what the agent's last edit left were written by someone else, which the tool's own write would hide in the agent's edit,
 * so TCR waits for the next turn. What a person writes after the comparison read the files, while a tool runs, cannot be told from the tool's own write.
 * The whole comparison, the search for the repository and the read of the settings with it, has the limit of a question
 * to the checkpoint command; past it TCR stops, and the tools run.
 */
export async function noteFilesBefore($: EngineInterface, state: State) {
  const { epoch, tcr } = state
  const limit = await limitOf($, COMMAND_LIMITS_MS.fingerprint)
  let timer: ReturnType<EngineInterface['clock']['after']> | undefined
  const stopped = new Promise<typeof COMPARISON_STOPPED>(resolve => {
    timer = $.clock.after(limit, () => resolve(COMPARISON_STOPPED))
  })
  const outcome = await Promise.race([compareFiles($, state), stopped]).finally(() => timer?.cancel())
  if (outcome === COMPARISON_STOPPED && state.epoch === epoch && state.tcr === tcr) pauseUnlessPaused($, state, `the comparison of the files took longer than ${secondsOf(limit)}s`)
  assert(limit > 0 && (outcome === undefined || outcome === COMPARISON_STOPPED), `the comparison of the files ended with ${String(outcome)} after the limit of ${limit}ms`)
  assert(outcome !== COMPARISON_STOPPED || state.epoch !== epoch || state.tcr !== tcr || state.tcr.status !== TCR_ACTIVE, `the comparison outlasted ${limit}ms but TCR is still ${statusText(state.tcr.status)}`)
}

async function compareFiles($: EngineInterface, state: State): Promise<undefined> {
  assert(typeof state === 'object' && state !== null && state.tcr !== undefined, `the files were compared for the state ${typeof state}`)
  const { epoch, tcr } = state
  const root = await rootOrPause($, state, tcr)
  if (root === undefined || (await activeSettings($, state, root)) === undefined) return
  const files = await fingerprintOrPause($, state, root, tcr)
  if (files === undefined || state.epoch !== epoch || state.tcr !== tcr) return
  if (files !== tcr.seen) return pauseForOutsideChange($, state, { root, epoch })
  assert(state.tcr.status === TCR_ACTIVE || !state.tcr.unjudged, `TCR is ${statusText(state.tcr.status)} but waits to judge an edit`)
}

/**
 * After a tool ran. An edit that changed the files waits to be judged by the project's checks. Files that differ at a
 * tool that does not edit, from what the agent's last edit left, are someone else's, so TCR waits for the next turn, unless an editing tool still runs, whose own write they may be.
 */
export async function noteFiles($: EngineInterface, state: State, tool: string, edit: EditMarks = { marks: new Map(), isUnchanged: false }) {
  assert(tool !== '', `a tool call named the tool ${JSON.stringify(tool)}; pass the name of the tool the agent called`)
  await state.tcrDeciding
  const { epoch, tcr } = state
  const root = await rootOrPause($, state, tcr)
  if (root === undefined || (await activeSettings($, state, root)) === undefined) return
  const files = await fingerprintOrPause($, state, root, tcr)
  if (files === undefined || state.epoch !== epoch || state.tcr !== tcr) return
  if (!EDITING_TOOLS.has(tool)) return files !== tcr.seen && state.tcrEditing.size === 0 ? pauseForOutsideChange($, state, { root, epoch }) : undefined
  if (files !== tcr.seen) {
    tcr.seen = files
    tcr.held = undefined
    tcr.isLeftToChecks = false
    tcr.unjudged = files !== tcr.settled
    if (tcr.unjudged) scheduleJudgement($, state)
    else void cancelJudgement($, state)
  } else edit.isUnchanged = true
  assert(state.tcr.status === TCR_ACTIVE || !state.tcr.unjudged, `TCR is ${statusText(state.tcr.status)} but waits to judge an edit`)
}

/** Judges the agent's latest edit once the files have been quiet for a while; a newer edit starts the wait again. */
export function scheduleJudgement($: EngineInterface, state: State) {
  void cancelJudgement($, state)
  const ticket = state.tcrTicket
  state.tcrTimer = $.clock.after(QUIET_MS, () => background($, state, () => judgeTcr($, state, ticket)))
  assert(state.tcrTimer !== undefined && state.tcrTicket === ticket, `the judgement ${ticket} was not scheduled as the one that counts`)
  assert(state.tcr.unjudged, `a judgement was scheduled for ${state.tcr.seen} with no edit waiting to be judged`)
}

/** What a judgement of the edit needs to act: the repository, the fingerprint the edit left, and the project's settings of TCR. */
export type Edit = { root: string; files: string; saveReverted: boolean }

/** What one judgement is for: the session, the TCR state and the edit it started with. */
type Started = { epoch: number; tcr: Tcr; ticket: number }

/**
 * Judges the agent's latest edit by running every check once, unless a newer edit, a change of the files or the end
 * of the session came first: then it acts on nothing. The upstream check is not judged, and the whole judgement, checks
 * and checkpoint together, has a limit. A project without checks has nothing to judge by, so TCR says it is unavailable,
 * once the search for its checks has found none.
 */
async function judgeTcr($: EngineInterface, state: State, ticket: number) {
  await state.tcrDeciding
  const { cwd, epoch, tcr } = state
  const started = { epoch, tcr, ticket }
  const root = cwd === undefined || tcr.status !== TCR_ACTIVE || !tcr.unjudged || !isJudging(state, started) ? undefined : await rootOf($, cwd, state).catch(error => pauseOnExpected($, state, error, epoch))
  if (root === undefined) return
  const limit = await judgementLimitOf($)
  assert(limit > 0 && started.ticket === ticket, `the judgement ${ticket} was given ${limit}ms as ${started.ticket}`)
  const watchdog = $.clock.after(limit, () => background($, state, () => stopOverlong($, state, { started, root }, limit)))
  await judgeFound($, state, { started, root }).finally(() => watchdog.cancel())
  assert(state.tcrTicket >= ticket, `the judgement ${ticket} ended after the latest ${state.tcrTicket}`)
}

/** Waits for the search for the checks, which the judgement's limit also bounds, and judges the edit by those it found. */
async function judgeFound($: EngineInterface, state: State, { started, root }: { started: Started; root: string }) {
  assert(root.startsWith('/'), `the checks of ${root} were awaited; pass the repository's absolute path`)
  await state.discovering
  if (!isJudging(state, started)) return
  const liveWatchers = state.liveWatchers.filter(({ watcher }) => watcher !== undefined && languageOf(watcher) !== UPSTREAM_LANGUAGE)
  if (liveWatchers.length === 0) return pauseForNoChecks($, state, started)
  assert(liveWatchers.every(each => each.dir.startsWith('/')), `a check of ${liveWatchers.map(each => each.key)} would run in a relative directory`)
  await judgeChecks($, state, { started, root, liveWatchers })
}

/** Each judgement's revert attempt, by the TCR state it began with, so that the stop at the judgement's limit knows whether a revert was asked. */
const attempts = new WeakMap<Tcr, Attempt>()

const REVERT_ASKED = '; a revert was asked'

/** Stops the judgement that `started` names when it is still the one that counts, because it took longer than `limit`; files left as a held edit stay recognisable at the next turn start, and a revert that was asked is named. */
export async function stopOverlong($: EngineInterface, state: State, { started, root }: { started: Started; root: string }, limit: number) {
  assert(limit > 0, `the judgement was given ${limit}ms`)
  if (!isJudging(state, started)) return
  const held = state.tcrHeld.size > 0 ? await identityOf($, root).catch(orElse(undefined)) : undefined
  if (!isJudging(state, started)) return
  void cancelJudgement($, state)
  const attempt = attempts.get(started.tcr)
  const copy = typeof attempt?.saved === 'string' ? `; the work is saved in ${attempt.saved}` : ''
  pauseTcr($, state, `the judgement of the edit took longer than ${secondsOf(limit)}s${attempt?.isSpawned ? REVERT_ASKED : ''}${copy}`, held)
  assert(!isJudging(state, started), `the judgement ${started.ticket} still counts after it was stopped for taking longer than ${limit}ms`)
}

/** Runs every check of the edit once and acts on what they say, when the files are still as the edit left them. */
async function judgeChecks($: EngineInterface, state: State, { started, root, liveWatchers }: { started: Started; root: string; liveWatchers: readonly LiveWatcher[] }) {
  assert(liveWatchers.length > 0 && root.startsWith('/'), `${liveWatchers.length} checks to judge in ${root}`)
  try {
    const before = await dirtyFiles($, root)
    const reports = await Promise.all(liveWatchers.map(({ watcher, dir }) => runCheck($, watcher as Watcher, { cwd: dir, ...envOf(watcher as Watcher) }, state.tcrKills)))
    assert(reports.length === liveWatchers.length, `${reports.length} results for ${liveWatchers.length} checks; judge each check once`)
    const files = await fingerprintOf($, root)
    const settings = await activeSettings($, state, root)
    if (settings === undefined || !isJudging(state, started)) return
    if (files === started.tcr.seen) await actOnJudgement($, state, { root, files, ...settings }, { started, judged: liveWatchers.map((live, index) => ({ live, report: reports[index] })) })
    else await pauseForChange($, state, { started, root, before, liveWatchers })
  } catch (error) {
    if (!(error instanceof CommandError)) throw error
    if (isJudging(state, started)) pauseTcr($, state, error.message)
  }
}

/** Stops TCR for the files that differ after the checks ran, unless the judgement ended while the reason was read. */
async function pauseForChange($: EngineInterface, state: State, { started, root, before, liveWatchers }: { started: Started; root: string; before: readonly string[]; liveWatchers: readonly LiveWatcher[] }) {
  assert(Array.isArray(before) && liveWatchers.length > 0, `${liveWatchers.length} checks changed the files of ${root}, which listed ${typeof before} before; pass the checks that ran and the files listed`)
  const reason = await changedWhileJudging($, root, before, liveWatchers.map(({ watcher }) => watcher?.name ?? ''))
  if (isJudging(state, started)) pauseTcr($, state, reason)
  assert(!isJudging(state, started) || state.tcr.status !== TCR_ACTIVE, `TCR is still ${statusText(state.tcr.status)} after the files changed while the checks of ${root} ran`)
}

/** Why the files differ after the checks ran: the files they wrote, when git can name them; otherwise that something changed them. */
export async function changedWhileJudging($: EngineInterface, root: string, before: readonly string[], checks: readonly string[]): Promise<string> {
  const after = await dirtyFiles($, root).catch(orElse(before))
  const written = after.filter(name => !before.includes(name))
  assert(written.every(name => !before.includes(name)), `${written} were named as written by the checks but were there before`)
  assert(written.length <= after.length, `${written.length} files were named as written but git lists ${after.length}`)
  return changedBecause(written, checks, OUTSIDE_CHANGE)
}

/** Leaves the edit that `files` fingerprints uncommitted and unreverted, and tells the agent why. */
async function holdTcr($: EngineInterface, state: State, { root, files }: Edit, { reason, text = leftUncommitted(reason), isFailureNamed = false }: { reason: string; text?: string; isFailureNamed?: boolean }) {
  assert(reason !== '', `TCR holds an edit for ${JSON.stringify(reason)}, which tells the agent nothing`)
  assert(files !== '', `TCR holds the edit of the files ${JSON.stringify(files)} for ${reason}; it needs their fingerprint to know them again`)
  const { epoch, tcr } = state
  tcr.unjudged = false
  const held = await identityOf($, root)
  if (state.epoch !== epoch) return
  tcr.held = held
  if (isFailureNamed) forgetSuppressed(state)
  else if (state.tcr === tcr) leaveToChecks(state)
  queueTcr($, state, 'hold', tcrMessage(text, false))
  assert(!tcr.unjudged && state.outbox.has('tcr:hold'), `holding the edit for ${reason} did not leave it unjudged and told`)
}

/**
 * Reverts when a check has a new failure, commits when none has, and does neither when a check cannot run, has no
 * earlier result to tell a new failure by, or inherited findings block. A check without an earlier result stays
 * without one, whatever it fails with, until it passes.
 */
async function actOnJudgement($: EngineInterface, state: State, edit: Edit, { started, judged }: { started: Started; judged: readonly Judged[] }) {
  assert(judged.length > 0, `TCR judges the edit ${edit.files} with no check; hold it when the project has none`)
  const policy = await projectPolicy($, state)
  if (!isJudging(state, started)) return
  if (policy === undefined) return stopForGate($, state, edit)
  const unread = judged.filter(({ report }) => report === undefined)
  for (const { live } of unread) state.tcrHeld.add(live.key)
  if (unread.length > 0) return holdTcr($, state, edit, { reason: `${unread.map(({ live }) => live.watcher?.name).join(', ')} gave no result to judge by` })
  const offline = judged.filter(({ report }) => report?.environment !== undefined)
  for (const { live, report } of offline) queueEnvironment($, { state, live, watcher: live.watcher as Watcher }, report?.environment ?? '')
  if (offline.length > 0) return holdTcr($, state, edit, { reason: 'a check cannot run in this environment' })
  const verdicts = judged.map(each => ({ ...each, verdict: verdictOf(state.tcrHeld, each.live.key, each.live.baseline, each.report as Report) }))
  const causes = verdicts.filter(({ verdict }) => verdict === 'new')
  if (causes.length > 0) return await revertTcr($, state, edit, causes)
  const unknown = verdicts.filter(({ verdict }) => verdict === 'unjudged')
  const failed = unknown.map(({ live }) => live.watcher?.name).join(', ')
  for (const { live } of unknown) state.tcrHeld.add(live.key)
  if (unknown.length > 0) return holdTcr($, state, edit, { reason: `${failed} failed and has no earlier result to compare with`, text: heldBecause(unknown.map(({ live }) => live.watcher?.name ?? '')), isFailureNamed: true })
  const isHeld = policy.inherited === 'block' && judged.some(({ report }) => report?.isFailed)
  if (isHeld) await leaveHeld($, state, edit)
  else await checkpointTcr($, state, edit, judged)
  assert(state.epoch !== started.epoch || !state.tcr.unjudged, `the edit ${edit.files} was judged green but is still waiting`)
}

/**
 * Makes the pass of each held check that passed its earlier result, and no longer held. Only a checkpoint, which commits
 * the files the pass covered, makes a pass an earlier result; a revert restores files it never covered.
 */
function judgeHeldByPass(state: State, judged: readonly Judged[]) {
  const passed = judged.filter(({ live, report }) => state.tcrHeld.has(live.key) && !(report as Report).isFailed)
  for (const { live, report } of passed) {
    state.tcrHeld.delete(live.key)
    live.baseline = report
  }
  assert(passed.every(({ live }) => !state.tcrHeld.has(live.key) && live.baseline?.isFailed === false), `a held check that passed is still held or has no passing baseline: ${passed.map(({ live }) => live.key)}`)
  assert(judged.every(({ live, report }) => !state.tcrHeld.has(live.key) || (report as Report).isFailed), 'a held check that passed is still held after the edit that passed it was checkpointed')
}

/** Leaves the edit uncommitted and unreverted without a message, recording what its files are when a check is held, so that the next turn start knows them again. */
async function leaveHeld($: EngineInterface, state: State, { root }: Edit) {
  const { tcr } = state
  const isHeld = state.tcrHeld.size > 0
  tcr.unjudged = false
  forgetSuppressed(state)
  if (isHeld) tcr.held = await identityOf($, root)
  assert(!tcr.unjudged, 'an edit left held is still waiting to be judged')
  assert(!isHeld || tcr.held !== undefined, `${String(isHeld)} checks are held but the files of the edit were recorded as ${String(tcr.held)}`)
}

/** The session and the TCR state an act of TCR began in: an answer that comes after the session ended is no one's to act on. */
export type Acting = { tcr: Tcr; epoch: number }

/**
 * Whether the files are still the edit `files` fingerprints and TCR is still the one that judged it, asked right before
 * TCR commits or reverts. Otherwise TCR stops, since what changed may be someone's work that a commit or a revert would take.
 */
async function isUnchanged($: EngineInterface, state: State, { tcr, epoch }: Acting, { root, files }: Edit): Promise<boolean> {
  assert(root.startsWith('/') && files !== '', `the files ${JSON.stringify(files)} of ${root} were checked before acting; pass the repository's absolute path and the edit's fingerprint`)
  const now = await fingerprintOf($, root)
  if (state.epoch !== epoch) return false
  const isSame = state.tcr === tcr && tcr.seen === files && now === files
  if (!isSame && state.tcr.status === TCR_ACTIVE) pauseTcr($, state, CHANGED_WHILE_ACTING)
  assert(isSame || state.tcr.status !== TCR_ACTIVE, `the files of ${files} changed but TCR is still ${statusText(state.tcr.status)}`)
  return isSame
}

/**
 * Commits the edit that `files` fingerprints as a checkpoint, notes the commit HEAD is at, and only then lets the pass of a held check judge it. When the files changed
 * before the commit or while it ran, the edit that did is neither judged nor settled, so TCR stops.
 */
async function checkpointTcr($: EngineInterface, state: State, edit: Edit, judged: readonly Judged[]) {
  const { root, files } = edit
  assert(files !== '', `a checkpoint of the files ${JSON.stringify(files)} needs their fingerprint`)
  const acting = { tcr: state.tcr, epoch: state.epoch }
  const { tcr, epoch } = acting
  if (!(await isUnchanged($, state, acting, edit))) return
  const { commit, refused, changed } = checkpointedBy(await ask($, root, 'checkpoint', ['--expect', files]))
  if (state.epoch !== epoch) return
  if (changed) return pauseUnlessPaused($, state, CHANGED_WHILE_ACTING)
  if (refused.length > 0) return pauseUnlessPaused($, state, refusedBecause(refused))
  const after = await fingerprintOf($, root)
  if (state.epoch !== epoch) return
  if (state.tcr !== tcr || tcr.seen !== files || after !== files) return pauseUnlessPaused($, state, CHANGED_WHILE_ACTING)
  state.tcr = { status: TCR_ACTIVE, settled: files, seen: files, unjudged: false, held: undefined }
  forgetSuppressed(state)
  if (typeof commit !== 'string') return
  judgeHeldByPass(state, judged)
  await noteHead($, state, { root, epoch })
  $.ui.toast(`overwatch: TCR checkpoint ${shortCommit(commit)}`)
  assert(state.epoch !== epoch || state.tcr.status !== TCR_ACTIVE || state.tcr.settled === files, `the checkpoint left ${state.tcr.settled} settled, not ${files}`)
}

const EDIT_AS_FILES = 'the files of the edit'

/**
 * Tells the agent what a revert that failed after it may have begun did, as the engine reported it: a revert, with the files
 * that came back and those still changed, only when it reported the reset as done; otherwise that TCR tried and git failed
 * (or that the end of the reset is not known), with the files said to be as `git status` shows, never unchanged, and the files that are
 * no longer listed told as now as HEAD has them. And the ref that holds a copy. TCR stops with what the command said, and
 * starts again at a turn start with a clean tree.
 */
async function failedRevert($: EngineInterface, state: State, edit: Edit, { failure, names, causes, epoch }: { failure: RevertFailure; names: readonly string[]; causes: readonly Judged[]; epoch: number }) {
  const { reset } = failure.outcome
  const aftermath = await inspectRestored($, edit.root, null)
  const listing = reset === 'done' && names.length === 0 ? [EDIT_AS_FILES] : names
  const seen = aftermath instanceof CommandError ? undefined : stillChanged(listing, aftermath.left)
  const failed = failure.answer === undefined ? 'the revert command' : reset === 'failed' ? 'git' : 'unknown'
  const build = (parts: Reverted[]): string => {
    assert(parts.length === causes.length, `${parts.length} parts were built for ${causes.length} causes of a revert`)
    assert(typeof edit.saveReverted === 'boolean', `a revert was built with saveReverted ${typeof edit.saveReverted}, not true or false`)
    return reset === 'done'
      ? revertMessage(parts, seen === undefined ? { restored: [], isUnlisted: true } : { restored: seen.came, remaining: seen.remaining, late: seen.late }, failure.saved, { saveReverted: edit.saveReverted, isFailure: true })
      : unrevertedMessage(failure.saved, { saveReverted: edit.saveReverted, failed, files: seen === undefined ? undefined : { asHead: seen.came, still: seen.remaining, late: seen.late }, causes: parts })
  }
  if (state.epoch !== epoch) return tellEndedRevert($, failure.saved)
  const logging = queueRevert($, state, { causes, build, isSaved: typeof failure.saved === 'string' })
  if (seen !== undefined && seen.came.length > 0 && seen.remaining.length === 0) forgetResults(state, seen.came)
  pauseUnlessPaused($, state, failure.message)
  await logging
  assert(failure.outcome.reset === reset && causes.length > 0, `the revert that ${reset} was told for ${causes.length} causes`)
  assert(state.epoch !== epoch || state.tcr.status !== TCR_ACTIVE, `TCR stayed ${statusText(state.tcr.status)} after a revert that failed with ${failure.message}`)
}

/** What a revert attempt knows once it asks the command, which is all that is left to tell the agent if something breaks after it. */
type Attempt = { epoch: number; isSpawned: boolean; saved: string | null | undefined; names: readonly string[] }

/**
 * Restores the latest checkpoint and tells the agent the failures that caused it, the files that came back, and whether
 * what was removed is gone or kept in a ref; the checks then run again on the restored files. When no file differs
 * from the checkpoint, nothing is reverted, and the agent is told of the failure instead. When the files changed
 * before the revert, or while it ran, the edit that did is neither judged nor settled, so TCR stops; so does any file
 * that differs from the checkpoint once the revert is done. When the files cannot be inspected after the revert, the
 * agent is still told what it reverted and where it is saved, and TCR stops with the reason. This is the one boundary of
 * the path after the revert command was asked: whatever breaks there that no answer of the command explains, the agent is
 * told TCR tried to revert, with the ref the answer named if it did, TCR stops, and the error goes on.
 */
export async function revertTcr($: EngineInterface, state: State, edit: Edit, causes: readonly Judged[]) {
  assert(causes.length > 0, `a revert was started for ${causes.length} causes; give one`)
  assert(typeof edit.saveReverted === 'boolean', `the revert was started with saveReverted ${typeof edit.saveReverted}, not true or false`)
  const attempt: Attempt = { epoch: state.epoch, isSpawned: false, saved: undefined, names: [] }
  attempts.set(state.tcr, attempt)
  try {
    await revertAttempt($, state, edit, { causes, attempt })
  } catch (error) {
    if (!attempt.isSpawned || (error instanceof CommandError && !(error instanceof RevertFailure))) throw error
    await tellBrokenRevert($, state, edit, { causes, attempt, error })
    throw error
  }
}

/** Tells the agent of a revert that broke after its command was spawned, as a revert whose reset is not known; and when even that breaks, as the notice that asks the host for nothing. */
async function tellBrokenRevert($: EngineInterface, state: State, edit: Edit, { causes, attempt, error }: { causes: readonly Judged[]; attempt: Attempt; error: unknown }) {
  assert(attempt.isSpawned && causes.length > 0, `a revert that was never asked was told as broken for ${causes.length} causes`)
  assert(typeof edit.saveReverted === 'boolean', `a broken revert was told with saveReverted ${typeof edit.saveReverted}, not true or false`)
  markTold(error, attempt.epoch)
  const saved = attempt.saved ?? savedOfError(error)
  const failure = new RevertFailure(`overwatch hit an unexpected error: ${describeError(error)}`, saved, { reset: 'unknown' }, {})
  try {
    await failedRevert($, state, edit, { failure, names: attempt.names, causes, epoch: attempt.epoch })
  } catch (secondary) {
    $.ui.log(`overwatch hit an unexpected error: ${safeLine(describeError(secondary))} while telling the revert as one whose reset is not known`, { to: BUG_LOG })
    const told = causes.map(({ live, report }) => ({ watcher: live.watcher as Watcher, report: report as Report, known: [] as string[], log: undefined }))
    if (state.epoch !== attempt.epoch) return tellEndedRevert($, saved)
    queueRevertNotice($, state, revertNotice(brokenRevertMessage(saved, told, edit.saveReverted), typeof saved === 'string'))
    pauseUnlessPaused($, state, failure.message)
  }
}

/** The revert itself, which records in `attempt` what it learns once it asks the command. */
async function revertAttempt($: EngineInterface, state: State, edit: Edit, { causes, attempt }: { causes: readonly Judged[]; attempt: Attempt }) {
  const { root, files, saveReverted } = edit
  assert(causes.length > 0 && causes.every(({ report }) => report?.isFailed), `reverting for ${causes.map(({ live }) => live.key)}, some of which do not fail`)
  assert(files !== '' && root.startsWith('/'), `the files ${JSON.stringify(files)} of ${root} were reverted; pass the repository's absolute path and the edit's fingerprint`)
  const acting = { tcr: state.tcr, epoch: attempt.epoch }
  const { epoch } = acting
  if (!(await isUnchanged($, state, acting, edit))) return
  const names = await dirtyFiles($, root)
  attempt.names = names
  attempt.isSpawned = true
  const answered = await ask($, root, 'revert', ['--expect', files, ...(saveReverted ? [] : ['--no-save-ref'])]).then(revertedBy).catch(orFailure)
  attempt.saved = answered.saved
  if (answered instanceof RevertFailure) return failedRevert($, state, edit, { failure: answered, names, causes, epoch })
  const { reverted, saved, changed, staged, skipped, unavailable } = answered
  if (state.epoch !== epoch) return tellEndedAnswer($, answered)
  if (changed) return pauseUnlessPaused($, state, CHANGED_WHILE_ACTING)
  if (!reverted) return holdTcr($, state, edit, { reason: `${causes.map(({ live, report }) => `${live.watcher?.name} reported ${report?.summary}`).join('; ')}, but no file differs from the latest checkpoint, so there is nothing to revert`, isFailureNamed: true })
  const aftermath = await inspectRestored($, root, unavailable)
  const listing = names.length > 0 ? names : [EDIT_AS_FILES]
  if (state.epoch !== epoch) return tellEndedRevert($, saved)
  const seen = aftermath instanceof CommandError ? undefined : stillChanged(listing, aftermath.left)
  const told = seen === undefined ? { restored: [], skipped, isUnlisted: true } : { restored: seen.came, remaining: seen.remaining, late: seen.late, skipped, isRemainingNew: true }
  const logging = queueRevert($, state, { causes, build: found => revertMessage(found, told, saved, { staged, saveReverted }), isSaved: typeof saved === 'string' })
  if (aftermath instanceof CommandError) pauseUnlessPaused($, state, aftermath.message)
  else settleRevert($, state, { acting, edit, aftermath, listing, isWhole: (seen?.remaining.length ?? 0) === 0 })
  await logging
}
