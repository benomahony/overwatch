/**
 * TCR in the Claude Code plugin: decides whether it runs, judges the agent's edits with a one-shot run of the checks,
 * and commits the green ones or reverts the ones that add a failure, through engine/checkpoint.py.
 */
import type { EngineInterface } from 'claude-code'
import { assert } from './assert'
import { branchOf, commitOf, readOverride, repositoryOf } from './project'
import {
  CommandError,
  OUTSIDE_CHANGE,
  TCR_ACTIVE,
  UPSTREAM_LANGUAGE,
  ask,
  checkpointedBy,
  dirtyFiles,
  fingerprintOf,
  identityOf,
  initialTcr,
  isJudging,
  judgementLimitOf,
  notice,
  readMode,
  readTcrSettings,
  refusedBecause,
  revertedBy,
  runCheck,
  shortCommit,
  stateOf,
  tcrMessage,
  verdictOf,
  type Tcr,
} from './tcr'
import { envOf, languageOf, revertMessage, type Report, type Watcher } from './watchers'
import { QUIET_MS, queueEnvironment, schedule, writeLog } from './delivery'
import { projectPolicy } from './completion'
import type { LiveWatcher, Message, State } from './state'

/** Tools whose call may change the project's files; a watcher that is no long-running command reruns after each. */
export const EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])

/** Holds a message about TCR for the agent, in place of one with the same key; a revert wakes the agent. */
function queueTcr($: EngineInterface, state: State, key: string, message: Message) {
  assert(message.kind === 'tcr' && message.text.startsWith('overwatch: TCR '), `${JSON.stringify(message)} is no TCR message; say overwatch: TCR and give it the tcr kind`)
  state.outbox.set(`tcr:${key}`, message)
  schedule($, state)
  assert(state.outbox.get(`tcr:${key}`) === message, `the TCR message ${key} is not waiting after queueing it`)
}

/** Stops judging the edit that waits, whether its checks have started or not, and makes any judgement in flight stale. */
export async function cancelJudgement(state: State) {
  state.tcrTimer?.cancel()
  state.tcrTimer = undefined
  state.tcrTicket += 1
  assert(state.tcrTimer === undefined, 'a cancelled judgement still has a timer that will start it')
  const kills = [...state.tcrKills]
  state.tcrKills.clear()
  await Promise.all(kills.map(kill => kill().catch(() => undefined)))
  assert(state.tcrKills.size === 0 || kills.length > 0, `${state.tcrKills.size} checks of a cancelled judgement still run`)
  assert(kills.every(kill => !state.tcrKills.has(kill)), `${kills.length} stopped checks are still among the ${state.tcrKills.size} that wait to be stopped`)
}

/**
 * Leaves the edit that waits neither committed, held nor reverted, for the step also moved HEAD: the failures the move
 * brought in are in the fresh baselines as inherited, so the checks say nothing of the edit. The files stay as they are
 * and TCR looks at them again at the next edit or turn start.
 */
export async function leaveUnjudged(state: State) {
  assert(state.tcr.status !== undefined || !state.tcr.unjudged, `an edit waits to be judged while TCR is ${state.tcr.status}; decide TCR before judging`)
  state.tcr.unjudged = false
  await cancelJudgement(state)
  assert(!state.tcr.unjudged && state.tcrTimer === undefined, 'an edit that came with a move of HEAD still waits to be judged')
}

/** Stops TCR committing and reverting, for `reason`, until it is decided again at the start of a turn. */
function pauseTcr($: EngineInterface, state: State, reason: string) {
  assert(reason !== '' && reason !== TCR_ACTIVE, `TCR was paused for ${JSON.stringify(reason)}; give the reason it cannot run`)
  const text = notice(state.tcr.status, reason)
  state.tcr = { status: reason, settled: undefined, seen: undefined, unjudged: false, held: undefined }
  void cancelJudgement(state)
  if (text !== undefined) queueTcr($, state, 'state', tcrMessage(text, false))
  assert(state.tcr.status === reason && !state.tcr.unjudged, `TCR paused for ${reason} but is ${state.tcr.status}, judging ${state.tcr.unjudged}`)
}

/** What the agent is told when the mode of TCR is taken away from `.overwatch.json` while TCR runs. */
const MODE_OFF = 'overwatch: TCR is off: "mode": "tcr" is no longer set in .overwatch.json, so nothing is committed or reverted.'

/** Why TCR cannot act on a project that has no check to judge an edit by. */
const NO_CHECKS = 'no checks are configured'

/** Why TCR stops when files change while it commits, reverts or decides, since it cannot tell whose they are. */
const CHANGED_WHILE_ACTING = 'files changed while TCR was committing, reverting or deciding, so it cannot tell whose they are'

/** The settings of TCR the project's `.overwatch.json` holds now, or undefined when TCR must not act: its mode is gone, which switches it off and tells the agent, or invalid, which is reported and pauses it. */
async function activeSettings($: EngineInterface, state: State, root: string): Promise<{ saveReverted: boolean } | undefined> {
  assert(root.startsWith('/'), `the settings of TCR were read for ${root}; pass the repository's absolute path`)
  try {
    const override = await readOverride($, root)
    if (readMode(override) !== undefined) return readTcrSettings(override)
    const was = state.tcr.status
    state.tcr = initialTcr()
    state.tcrHeld.clear()
    void cancelJudgement(state)
    if (was !== undefined) queueTcr($, state, 'state', tcrMessage(MODE_OFF, false))
  } catch (error) {
    if (!(error instanceof CommandError)) throw error
    $.ui.toast(`overwatch: ${error.message}`)
    pauseTcr($, state, error.message)
  }
  assert(state.tcr.status !== TCR_ACTIVE, `the settings of TCR said it must not act but it is ${state.tcr.status}`)
  return undefined
}

/**
 * Whether TCR can start in the repository at `root`, as TCR_ACTIVE or the reason it cannot, with the fingerprint of the
 * files it starts from. The files are fingerprinted before and after the question, and a change between stops it. Files
 * that are still the edit TCR held for a check without an earlier result, as `held` says, are no reason by themselves.
 */
async function decisionOf($: EngineInterface, root: string, held: { identity: string | undefined; checks: number }): Promise<{ next: string; settled: string | undefined; isHeld: boolean }> {
  assert(root.startsWith('/'), `TCR was asked to decide for ${root}; pass the repository's absolute path`)
  try {
    const files = await fingerprintOf($, root)
    const isHeld = held.checks > 0 && held.identity !== undefined && (await identityOf($, root)) === held.identity
    const next = await stateOf($, root, isHeld)
    if (next !== TCR_ACTIVE) return { next, settled: undefined, isHeld: false }
    const decided = (await fingerprintOf($, root)) === files ? { next, settled: files, isHeld } : { next: CHANGED_WHILE_ACTING, settled: undefined, isHeld: false }
    assert((decided.next === TCR_ACTIVE) === (decided.settled !== undefined), `TCR decided ${decided.next} with ${decided.settled} settled`)
    return decided
  } catch (error) {
    if (!(error instanceof CommandError)) throw error
    return { next: error.message, settled: undefined, isHeld: false }
  }
}

/**
 * Decides whether TCR runs in the session's repository: the project's mode must be tcr and nothing may stand in the
 * way of a revert, such as uncommitted changes. Decided at the session's start and again at each turn's start, and a
 * change of the files while it decides stops it.
 */
export function decideTcr($: EngineInterface, state: State): Promise<void> {
  const deciding = decideNow($, state).finally(() => {
    if (state.tcrDeciding === deciding) state.tcrDeciding = undefined
  })
  state.tcrDeciding = deciding
  assert(state.tcrDeciding === deciding, 'the decision about TCR is not the one in flight; record it before it ends')
  assert(deciding instanceof Promise, `the decision about TCR is ${typeof deciding}, not something to wait for`)
  return deciding
}

async function decideNow($: EngineInterface, state: State) {
  const { cwd, epoch } = state
  assert(cwd === undefined || cwd.startsWith('/'), `the session's directory ${cwd} is not an absolute path`)
  const root = cwd === undefined ? undefined : await repositoryOf($, cwd)
  if (root === undefined || (await activeSettings($, state, root)) === undefined) return
  const { next, settled, isHeld } = await decisionOf($, root, { identity: state.tcr.held, checks: state.tcrHeld.size })
  if (state.epoch !== epoch) return
  const [previous, text] = [state.tcr.status, notice(state.tcr.status, next)]
  const held = next === TCR_ACTIVE && isHeld ? state.tcr.held : undefined
  state.tcr = { status: next, settled, seen: settled, unjudged: false, held }
  void cancelJudgement(state)
  if (text !== undefined) queueTcr($, state, 'state', tcrMessage(text, false))
  const branch = next === TCR_ACTIVE && previous !== TCR_ACTIVE ? await branchOf($, root) : undefined
  if (branch === 'main' || branch === 'master') queueTcr($, state, 'branch', tcrMessage(`overwatch: TCR checkpoints land on ${branch}`, false))
  assert(!state.tcr.unjudged, 'a fresh decision left an edit waiting to be judged')
}

/** The fingerprint of the files at `root`, or undefined when it cannot be taken, which pauses TCR with the reason. */
async function fingerprintOrPause($: EngineInterface, state: State, root: string, tcr: Tcr): Promise<string | undefined> {
  assert(root.startsWith('/'), `the files of ${root} were fingerprinted; pass the repository's absolute path`)
  try {
    return await fingerprintOf($, root)
  } catch (error) {
    if (!(error instanceof CommandError)) throw error
    if (state.tcr === tcr) pauseTcr($, state, error.message)
    assert(state.tcr.status !== TCR_ACTIVE || state.tcr !== tcr, `the fingerprint failed with ${error.message} but TCR is still ${state.tcr.status}`)
    return undefined
  }
}

/**
 * After a tool ran. An edit that changed the files waits to be judged by the project's checks. Files that differ at a
 * tool that does not edit, from what the agent's last edit left, are someone else's, so TCR waits for the next turn.
 */
export async function noteFiles($: EngineInterface, state: State, tool: string) {
  assert(tool !== '', `a tool call named the tool ${JSON.stringify(tool)}; pass the name of the tool the agent called`)
  await state.tcrDeciding
  const { cwd, epoch, tcr } = state
  const root = cwd === undefined || tcr.status !== TCR_ACTIVE ? undefined : await repositoryOf($, cwd)
  if (root === undefined || (await activeSettings($, state, root)) === undefined) return
  const files = await fingerprintOrPause($, state, root, tcr)
  if (files === undefined || state.epoch !== epoch || state.tcr !== tcr) return
  if (!EDITING_TOOLS.has(tool)) {
    if (files !== tcr.seen) pauseTcr($, state, OUTSIDE_CHANGE)
  } else if (files !== tcr.seen) {
    tcr.seen = files
    tcr.held = undefined
    tcr.unjudged = files !== tcr.settled
    if (tcr.unjudged) scheduleJudgement($, state)
    else void cancelJudgement(state)
  }
  assert(state.tcr.status === TCR_ACTIVE || !state.tcr.unjudged, `TCR is ${state.tcr.status} but waits to judge an edit`)
}

/** Judges the agent's latest edit once the files have been quiet for a while; a newer edit starts the wait again. */
function scheduleJudgement($: EngineInterface, state: State) {
  void cancelJudgement(state)
  const ticket = state.tcrTicket
  state.tcrTimer = $.clock.after(QUIET_MS, () => void judgeTcr($, state, ticket))
  assert(state.tcrTimer !== undefined && state.tcrTicket === ticket, `the judgement ${ticket} was not scheduled as the one that counts`)
  assert(state.tcr.unjudged, `a judgement was scheduled for ${state.tcr.seen} with no edit waiting to be judged`)
}

/** The live's watcher and what its one-shot run printed, or undefined when it could not be read. */
type Judged = { live: LiveWatcher; report: Report | undefined }

/** What a judgement of the edit needs to act: the repository, the fingerprint the edit left, and the project's settings of TCR. */
type Edit = { root: string; files: string; saveReverted: boolean }

/** What one judgement is for: the session, the TCR state and the edit it started with. */
type Started = { epoch: number; tcr: Tcr; ticket: number }

/**
 * Judges the agent's latest edit by running every check once, unless a newer edit, a change of the files or the end
 * of the session came first: then it acts on nothing. The upstream check is not judged, and the whole judgement, checks
 * and checkpoint together, has a limit. A project without checks has nothing to judge by, so TCR says it is unavailable.
 */
async function judgeTcr($: EngineInterface, state: State, ticket: number) {
  await state.tcrDeciding
  const { cwd, epoch, tcr } = state
  const started = { epoch, tcr, ticket }
  const liveWatchers = state.liveWatchers.filter(({ watcher }) => watcher !== undefined && languageOf(watcher) !== UPSTREAM_LANGUAGE)
  const root = cwd === undefined || tcr.status !== TCR_ACTIVE || !tcr.unjudged || !isJudging(state, started) ? undefined : await repositoryOf($, cwd)
  if (root === undefined) return
  if (liveWatchers.length === 0) return pauseTcr($, state, NO_CHECKS)
  assert(liveWatchers.every(each => each.dir.startsWith('/')), `a check of ${liveWatchers.map(each => each.key)} would run in a relative directory`)
  const limit = await judgementLimitOf($)
  const watchdog = $.clock.after(limit, () => stopOverlong($, state, started, limit))
  await judgeChecks($, state, { started, root, liveWatchers }).finally(() => watchdog.cancel())
  assert(state.tcrTicket >= ticket, `the judgement ${ticket} ended after the latest ${state.tcrTicket}`)
}

/** Stops the judgement that `started` names when it is still the one that counts, because it took longer than `limit`. */
function stopOverlong($: EngineInterface, state: State, started: Started, limit: number) {
  assert(limit > 0, `the judgement was given ${limit}ms`)
  if (!isJudging(state, started)) return
  void cancelJudgement(state)
  pauseTcr($, state, `the judgement of the edit took longer than ${Math.ceil(limit / 1000)}s`)
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
    if (files === started.tcr.seen) await actOnJudgement($, state, { root, files, ...settings }, liveWatchers.map((live, index) => ({ live, report: reports[index] })))
    else pauseTcr($, state, await changedWhileJudging($, root, before, liveWatchers.map(({ watcher }) => watcher?.name ?? '')))
  } catch (error) {
    if (!(error instanceof CommandError)) throw error
    if (isJudging(state, started)) pauseTcr($, state, error.message)
  }
}

/** Why the files differ after the checks ran: the files they wrote, when git can name them; otherwise that something changed them. */
async function changedWhileJudging($: EngineInterface, root: string, before: readonly string[], checks: readonly string[]): Promise<string> {
  const after = await dirtyFiles($, root).catch(() => before)
  const written = after.filter(name => !before.includes(name))
  assert(written.every(name => !before.includes(name)), `${written} were named as written by the checks but were there before`)
  assert(written.length <= after.length, `${written.length} files were named as written but git lists ${after.length}`)
  const writer = checks.length === 1 ? `the check ${checks[0]}` : `one of the checks ${checks.join(', ')}`
  return written.length > 0 ? `${writer} wrote files (${written.join(', ')}), so TCR cannot tell them from the agent's; add them to .gitignore` : OUTSIDE_CHANGE
}

/** Leaves the edit that `files` fingerprints uncommitted and unreverted, and tells the agent why. */
async function holdTcr($: EngineInterface, state: State, { root, files }: Edit, { reason, text = `overwatch: TCR left the latest change uncommitted and unreverted: ${reason}.` }: { reason: string; text?: string }) {
  assert(reason !== '' && reason !== TCR_ACTIVE, `TCR holds an edit for ${JSON.stringify(reason)}, which tells the agent nothing`)
  assert(files !== '', `TCR holds the edit of the files ${JSON.stringify(files)} for ${reason}; it needs their fingerprint to know them again`)
  state.tcr.unjudged = false
  state.tcr.held = await identityOf($, root)
  queueTcr($, state, 'hold', tcrMessage(text, false))
  assert(!state.tcr.unjudged && state.outbox.has('tcr:hold'), `holding the edit for ${reason} did not leave it unjudged and told`)
}

/**
 * Reverts when a check has a new failure, commits when none has, and does neither when a check cannot run, has no
 * earlier result to tell a new failure by, or inherited findings block. A check without an earlier result stays
 * without one, whatever it fails with, until it passes.
 */
async function actOnJudgement($: EngineInterface, state: State, edit: Edit, judged: readonly Judged[]) {
  assert(judged.length > 0, `TCR judges the edit ${edit.files} with no check; hold it when the project has none`)
  const unread = judged.filter(({ report }) => report === undefined)
  for (const { live } of unread) state.tcrHeld.add(live.key)
  if (unread.length > 0) return holdTcr($, state, edit, { reason: `${unread.map(({ live }) => live.watcher?.name).join(', ')} gave no result to judge by` })
  const offline = judged.filter(({ report }) => report?.environment !== undefined)
  for (const { live, report } of offline) queueEnvironment($, { state, live, watcher: live.watcher as Watcher }, report?.environment ?? '')
  if (offline.length > 0) return holdTcr($, state, edit, { reason: 'a check cannot run in this environment' })
  for (const { live, report } of judged) {
    if (state.tcrHeld.has(live.key) && !(report as Report).isFailed) {
      state.tcrHeld.delete(live.key)
      live.baseline = report
    }
  }
  const verdicts = judged.map(each => ({ ...each, verdict: verdictOf(state.tcrHeld, each.live.key, each.live.baseline, each.report as Report) }))
  const causes = verdicts.filter(({ verdict }) => verdict === 'new')
  if (causes.length > 0) return await revertTcr($, state, edit, causes)
  const unknown = verdicts.filter(({ verdict }) => verdict === 'unjudged')
  const failed = unknown.map(({ live }) => live.watcher?.name).join(', ')
  for (const { live } of unknown) state.tcrHeld.add(live.key)
  if (unknown.length > 0) return holdTcr($, state, edit, { reason: `${failed} failed and has no earlier result to compare with`, text: `overwatch: TCR held the edit: ${failed} failed and has no earlier result to compare with` })
  const isHeld = (await projectPolicy($, state)).inherited === 'block' && judged.some(({ report }) => report?.isFailed)
  if (isHeld) state.tcr.unjudged = false
  else await checkpointTcr($, state, edit)
  assert(!state.tcr.unjudged, `the edit ${edit.files} was judged green but is still waiting`)
}

/** Stops TCR for `reason`, unless something else stopped it already, whose reason then stands. */
function pauseUnlessPaused($: EngineInterface, state: State, reason: string) {
  assert(reason !== '' && reason !== TCR_ACTIVE, `TCR was paused for ${JSON.stringify(reason)}; give the reason it cannot run`)
  if (state.tcr.status === TCR_ACTIVE) pauseTcr($, state, reason)
  assert(state.tcr.status !== TCR_ACTIVE, `TCR is still ${state.tcr.status} after it was paused for ${reason}`)
}

/**
 * Whether the files are still the edit `files` fingerprints and TCR is still the one that judged it, asked right before
 * TCR commits or reverts. Otherwise TCR stops, since what changed may be someone's work that a commit or a revert would take.
 */
async function isUnchanged($: EngineInterface, state: State, tcr: Tcr, { root, files }: Edit): Promise<boolean> {
  assert(root.startsWith('/') && files !== '', `the files ${JSON.stringify(files)} of ${root} were checked before acting; pass the repository's absolute path and the edit's fingerprint`)
  const now = await fingerprintOf($, root)
  const isSame = state.tcr === tcr && tcr.seen === files && now === files
  if (!isSame && state.tcr.status === TCR_ACTIVE) pauseTcr($, state, CHANGED_WHILE_ACTING)
  assert(isSame || state.tcr.status !== TCR_ACTIVE, `the files of ${files} changed but TCR is still ${state.tcr.status}`)
  return isSame
}

/**
 * Commits the edit that `files` fingerprints as a checkpoint, and notes the commit HEAD is at. When the files changed
 * before the commit or while it ran, the edit that did is neither judged nor settled, so TCR stops.
 */
async function checkpointTcr($: EngineInterface, state: State, edit: Edit) {
  const { root, files } = edit
  assert(files !== '', `a checkpoint of the files ${JSON.stringify(files)} needs their fingerprint`)
  const tcr = state.tcr
  if (!(await isUnchanged($, state, tcr, edit))) return
  const { commit, refused, changed } = checkpointedBy(await ask($, root, 'checkpoint', ['--expect', files]))
  if (changed) return pauseUnlessPaused($, state, CHANGED_WHILE_ACTING)
  if (refused.length > 0) return pauseUnlessPaused($, state, refusedBecause(refused))
  const after = await fingerprintOf($, root)
  if (state.tcr !== tcr || tcr.seen !== files || after !== files) return pauseUnlessPaused($, state, CHANGED_WHILE_ACTING)
  state.tcr = { status: TCR_ACTIVE, settled: files, seen: files, unjudged: false, held: undefined }
  if (typeof commit !== 'string') return
  state.head = (await commitOf($, root)) ?? state.head
  $.ui.toast(`overwatch: TCR checkpoint ${shortCommit(commit)}`)
  assert(state.tcr.settled === files, `the checkpoint left ${state.tcr.settled} settled, not ${files}`)
}

/**
 * Restores the latest checkpoint and tells the agent the failures that caused it, the files that came back, and whether
 * what was removed is gone or kept in a ref; the checks then run again on the restored files. When no file differs
 * from the checkpoint, nothing is reverted, and the agent is told of the failure instead. When the files changed
 * before the revert, or while it ran, the edit that did is neither judged nor settled, so TCR stops; so does any file
 * that differs from the checkpoint once the revert is done.
 */
async function revertTcr($: EngineInterface, state: State, edit: Edit, causes: readonly Judged[]) {
  const { root, files, saveReverted } = edit
  assert(causes.length > 0 && causes.every(({ report }) => report?.isFailed), `reverting for ${causes.map(({ live }) => live.key)}, some of which do not fail`)
  const tcr = state.tcr
  if (!(await isUnchanged($, state, tcr, edit))) return
  const names = await dirtyFiles($, root)
  const { reverted, saved, changed, staged } = revertedBy(await ask($, root, 'revert', ['--expect', files, ...(saveReverted ? [] : ['--no-save-ref'])]))
  if (changed) return pauseUnlessPaused($, state, CHANGED_WHILE_ACTING)
  if (!reverted) return holdTcr($, state, edit, { reason: `${causes.map(({ live, report }) => `${live.watcher?.name} reported ${report?.summary}`).join('; ')}, but no file differs from the latest checkpoint, so there is nothing to revert` })
  const restored = await fingerprintOf($, root)
  const left = await dirtyFiles($, root)
  const told = await Promise.all(causes.map(async ({ live, report }) => ({
    watcher: live.watcher as Watcher,
    report: report as Report,
    known: live.baseline?.isFailed ? live.baseline.failures : [],
    log: await writeLog($, live, (report as Report).text),
  })))
  queueTcr($, state, 'revert', tcrMessage(revertMessage(told, names.length > 0 ? names : ['the files of the edit'], saved, staged), true))
  if (state.tcr !== tcr || tcr.seen !== files || left.length > 0) return pauseUnlessPaused($, state, CHANGED_WHILE_ACTING)
  state.tcr = { status: TCR_ACTIVE, settled: restored, seen: restored, unjudged: false, held: undefined }
  for (const each of state.liveWatchers) {
    state.outbox.delete(`${each.key}:report`)
    each.report = undefined
    each.wasFailing = false
    each.told = undefined
    each.isEditedSinceResult = true
    each.changed?.()
  }
  assert(state.liveWatchers.every(each => each.report === undefined && each.isEditedSinceResult), `a live kept its result after the revert of ${names}`)
}

