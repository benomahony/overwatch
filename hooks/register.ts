import type { EngineInterface, Register } from 'claude-code'
import { assert } from './assert'
import { background, failOpen, guarded, guardedNow, runBoth, tellUnexpected } from './boundary'
import { safePath } from './safe-text'
import { commandOf, protectedChecks } from './gating'
import {
  commandLine,
  environmentIn,
  exitMessage,
  gaveUpMessage,
  envOf,
  languageOf,
  lastBuild,
  readReport,
  type Watcher,
} from './watchers'
import { findIn, within } from './project'
import { toolchainOf, replacedToolchain, stopIfReplaced, restartOnReplaced, holdOffAfterRead } from './toolchain'
import { leaveUnjudged } from './deciding'
import { initialState, liveWatcher, unmark, type EditMarks, type LiveWatcher, type Mark, type State, type Run, type Restart, type Ending } from './state'
import { RETRY_MS, setStatus, schedule, queue, queueEnvironment, writeLog, deliver, tellSuppressed } from './delivery'
import { endMainTurn } from './completion'
import { stopWaiting, whenQuiet } from './quiet'
import { deniedWhileFailing, whileEditing } from './tool-calls'
import { EDITING_TOOLS, decideTcr, noteFiles } from './judgement'
import { cancelJudgement, pauseOnExpected } from './pausing'
import { rebaselineOnMove } from './head-move'

export { rebaselineOnMove }
import { CommandError, announceUnreadable, initialTcr } from './tcr'

/** After this many quick exits in a row, a watcher is no longer restarted on a timer, only as turns start. */
const GIVE_UP_AFTER = 3

/** Runs a command to its end and reports what it printed, unless it was stopped for a newer run first. */
export async function runOnce($: EngineInterface, run: Run, argv: readonly string[], isStale = () => false) {
  const { state, live, watcher, cwd } = run
  assert(argv.length > 0, `${watcher.name} was asked to run an empty command; give it argv or baseline`)
  assert(live.kill === undefined, `${live.key} starts ${commandLine(watcher, argv)} while another run is still killable; stop it first`)
  const child = $.process.spawn({ argv, cwd, ...envOf(watcher) })
  live.kill = () => child.return({ code: null, signal: null })
  let output = ''
  let code: number | null
  try {
    for await (const { text } of child) output += text
    ;({ code } = await child.result)
  } catch (error) {
    if (isStale()) return
    setStatus($, state, live, `${watcher.name}: could not start ${commandLine(watcher, argv)}`)
    $.ui.log(`overwatch: ${String(error)}`, { to: 'debug' })
    return
  } finally {
    live.kill = undefined
  }
  if (!live.isWatching || isStale()) return
  const report = readReport(watcher, output, code)
  if (report === undefined) {
    $.ui.log(`overwatch: ${commandLine(watcher, argv)} gave no summary:\n${output}`, { to: 'debug' })
    return
  }
  await deliver($, run, report)
}

/**
 * Reruns the suite once the agent's edits go quiet, one run at a time. An edit
 * made while it runs stops that run, whose result would already be out of
 * date, and starts another.
 */
export function rerunOnChange($: EngineInterface, run: Run, argv: readonly string[]) {
  assert(argv.length > 0, `${run.watcher.name} reruns an empty command; give it a baseline`)
  let isRunning = false
  let isPending = false
  const rerun = async () => {
    if (!run.live.isWatching || run.epoch !== run.state.epoch) return
    if (isRunning) {
      isPending = true
      await run.live.kill?.()
      return
    }
    isRunning = true
    isPending = false
    await runOnce($, run, argv, () => isPending)
    assert(run.live.kill === undefined, `${run.live.key}'s run ended but is still killable; clear live.kill when it ends`)
    isRunning = false
    if (isPending) await rerun()
    assert(!isRunning || isPending, `${run.live.key} is marked running after its last run ended`)
  }
  const { live } = run
  live.changed = () => whenQuiet($, run, rerun)
  assert(live.changed !== undefined, `${run.live.key} has no change handler after rerunOnChange`)
}

/** Watches until the watcher ends of itself, resolving how; a watcher with no command never ends. */
async function watch($: EngineInterface, run: Run): Promise<Ending | undefined> {
  const { state, live, watcher, cwd } = run
  assert(live.isWatching, `${live.key} is asked to watch ${watcher.name} while not watching; set isWatching first`)
  if (watcher.baseline !== undefined && watcher.baseline.length > 0) {
    const text = `${watcher.name}: running the full suite`
    setStatus($, state, live, text)
    await runOnce($, run, watcher.baseline)
    if (!live.isWatching) return undefined
  }
  if (watcher.argv === undefined) {
    if (watcher.baseline !== undefined) rerunOnChange($, run, watcher.baseline)
    if (live.isEdited) live.changed?.()
    return undefined
  }
  const [startedAt, toolchain] = await Promise.all([$.clock.now(), toolchainOf($, watcher.argv[0])])
  if (!live.isWatching) return undefined
  live.toolchain = toolchain
  const child = $.process.spawn({ argv: watcher.argv, cwd, ...envOf(watcher) })
  live.kill = () => child.return({ code: null, signal: null })
  setStatus($, state, live, `${watcher.name}: starting`)
  let output = ''
  let isStarted = true
  try {
    for await (const { text } of child) {
      output += text
      whenQuiet($, run, () => {
        // A transport chunk can stop in the middle of a summary line.
        const end = output.lastIndexOf('\n') + 1
        const lines = output.slice(0, end)
        const report = readReport(watcher, lines)
        if (report === undefined) return undefined
        output = lastBuild(watcher, lines).remaining + output.slice(end)
        return deliver($, run, report)
      })
    }
    stopWaiting(run)
    if (!live.isWatching) return undefined
  } catch (error) {
    stopWaiting(run)
    if (!live.isWatching) return undefined
    $.ui.log(`overwatch: ${String(error)}`, { to: 'debug' })
    isStarted = false
    output += String(error)
  } finally {
    live.kill = undefined
  }
  if (!live.isWatching) return undefined
  const endedAt = await $.clock.now()
  assert(endedAt >= startedAt, `${watcher.name} ended at ${endedAt}, before it started at ${startedAt}; read both from $.clock`)
  if (isStarted) await deliverExit($, run, output)
  return { isStarted, startedAt, endedAt, output }
}

/** Delivers the last report before showing that the watcher exited. */
export async function deliverExit($: EngineInterface, run: Run, output: string) {
  assert(run.live.kill === undefined, `${run.live.key} exited but is still killable; clear live.kill when it ends`)
  const report = readReport(run.watcher, output)
  if (report !== undefined) await deliver($, run, report)
  assert(report === undefined || run.epoch !== run.state.epoch || run.live.report === report, `${run.watcher.name}'s last report was not delivered to ${run.live.key}`)
  if (run.live.isWatching && run.epoch === run.state.epoch) $.ui.toast(`overwatch: ${safePath(commandLine(run.watcher))} exited`)
}

/**
 * Finds the watchers of the git repository the session is in afresh, reading
 * its markers and override, so a
 * project scaffolded mid-session gets its watcher, and starts each that is
 * not running or waiting out a retry. One running a program PATH now finds
 * somewhere else is stopped, so it restarts on the new one. One search runs at
 * a time; asked for during one, another follows it. A watcher that exits asks
 * for another, see `restart`.
 */
async function ensureAll($: EngineInterface, state: State) {
  if (state.cwd === undefined) return
  if (state.isFinding) {
    state.isFindDue = true
    return
  }
  const searching = searchAll($, state).finally(() => {
    if (state.discovering === searching) state.discovering = undefined
  })
  state.discovering = searching
  assert(state.discovering === searching, 'the search for watchers is not the one in flight; record it before it ends')
  assert(state.isFinding, `a search of ${state.cwd} began but the session does not say it is searching`)
  return searching
}

/** What a search of a session that ended finds when its read failed: no watchers. A bug of the plugin is shown to the user and tells the session that follows nothing, so the search the next round runs for that session goes on. */
function forgetFailure($: EngineInterface, state: State, error: unknown, epoch: number): [] {
  assert(state.epoch !== epoch, `a search of the session ${epoch} was dropped while that session still runs`)
  assert(Number.isInteger(epoch) && epoch < state.epoch, `a search began in the session ${epoch}, which is not older than the session ${state.epoch}`)
  if (!(error instanceof CommandError)) tellUnexpected($, state, error, epoch)
  return []
}

/** Searches the session's directory for watchers, and again while another search is due, and starts those found. */
export async function searchAll($: EngineInterface, state: State) {
  // A search asked for during one runs once after it; asks come from hooks and exits, so each round answers all so far.
  // The search stays marked running until its watchers have started, so a search asked for meanwhile waits its turn.
  // Each round reads the session afresh, so a search a newer session asked for runs in that session's directory.
  try {
    do {
      const { cwd, epoch } = state
      if (cwd === undefined) break
      state.isFinding = true
      state.isFindDue = false
      const finding = findIn($, cwd, state)
      state.finding = finding
      const watchers = await finding.finally(() => {
        if (state.finding === finding) state.finding = undefined
      }).catch(error => (state.epoch === epoch ? pauseOnExpected($, state, error, epoch) : forgetFailure($, state, error, epoch)))
      if (watchers === undefined) break
      const now = await $.clock.now()
      if (state.epoch !== epoch) continue
      for (const { watcher, dir } of watchers) {
        const key = `${languageOf(watcher)}:${dir}`
        let found = state.liveWatchers.find(each => each.key === key)
        if (found === undefined) {
          found = liveWatcher(key, dir)
          state.liveWatchers.push(found)
        }
        if (found.isWatching) background($, state, () => stopIfReplaced($, found).catch(error => pauseOnExpected($, state, error, epoch)))
        if (found.isWatching || now < found.retryAt) continue
        found.isWatching = true
        const starting = found
        background($, state, () => start($, state, starting, watcher).catch(error => holdOffAfterRead($, state, { live: starting, watcher, epoch }, error)))
      }
      assert(watchers.every(({ watcher, dir }) => state.liveWatchers.some(each => each.key === `${languageOf(watcher)}:${dir}`)), `a watcher of ${cwd} has no live`)
    } while (state.isFindDue)
  } finally {
    state.isFinding = false
  }
  assert(state.finding === undefined, `a search of ${state.cwd} left its finding ${state.finding} behind after it ended`)
}

async function start($: EngineInterface, state: State, live: LiveWatcher, watcher: Watcher) {
  const { epoch } = state
  assert(state.liveWatchers.includes(live), `live ${live.key} is not one of the session's; push it to state.liveWatchers first`)
  live.watcher = watcher
  live.isWatching = true
  live.retryAt = 0
  const ending = await watch($, { state, live, watcher, cwd: live.dir, epoch })
  assert(ending === undefined || ending.endedAt >= ending.startedAt, `${watcher.name} ended at ${ending?.endedAt}, before it started at ${ending?.startedAt}`)
  if (ending === undefined || state.epoch !== epoch) return
  const replaced = await replacedToolchain($, live)
  if (state.epoch !== epoch) return
  if (replaced === undefined) await restart($, { state, live, watcher, ending })
  else restartOnReplaced($, { state, live, watcher }, replaced)
}

/** Stops restarting a check that exited quickly too often in a row until the first turn after RETRY_MS, and tells the agent once, with where its output is logged, unless an environment error says why or the session `epoch` ended while the log was written. */
async function giveUp($: EngineInterface, { state, live, watcher }: Omit<Run, 'cwd' | 'epoch'>, { what, output, epoch, endedAt, hasEnvironment }: { what: string; output: string; epoch: number; endedAt: number; hasEnvironment: boolean }) {
  assert(live.quickExits >= GIVE_UP_AFTER, `${watcher.name} was given up after ${live.quickExits} exits, fewer than ${GIVE_UP_AFTER}`)
  assert(typeof output === 'string', `the output of ${watcher.name} is ${typeof output}, not text`)
  live.retryAt = endedAt + RETRY_MS
  setStatus($, state, live, `${watcher.name}: ${what} ${live.quickExits} times in a row; retrying at the first turn after ${RETRY_MS / 1000}s`)
  if (live.quickExits !== GIVE_UP_AFTER || hasEnvironment) return
  const text = gaveUpMessage(watcher, live.quickExits, RETRY_MS, await writeLog($, live, output))
  if (state.epoch !== epoch) return
  queue($, { state, live }, `exited:${output}`, { text, isWaking: true, kind: 'exit' })
}

/**
 * After a watcher ends of itself: one that ran RETRY_MS or longer restarts at
 * once; a quick exit waits RETRY_MS, doubling with each one in a row, until
 * GIVE_UP_AFTER of them, when only a turn starts it again, still RETRY_MS
 * apart. The status line says it is down and the agent is told during a
 * turn, woken only once overwatch gives up, since until then the watcher
 * comes back on its own. One that cannot run in this environment is told of
 * once, in the environment summary, and never wakes the agent.
 */
export async function restart($: EngineInterface, { state, live, watcher, ending }: Restart) {
  const { epoch } = state
  const { isStarted, startedAt, endedAt, output } = ending
  assert(live.watcher === watcher, `${live.key} restarts ${watcher.name} but runs ${live.watcher?.name}`)
  const isQuick = !isStarted || endedAt - startedAt < RETRY_MS
  live.quickExits = isQuick ? live.quickExits + 1 : 0
  live.isWatching = false
  const what = isStarted ? `${commandLine(watcher)} exited` : `could not start ${commandLine(watcher)}`
  const environment = environmentIn(output)
  const hasEnvironment = environment !== undefined
  if (hasEnvironment) queueEnvironment($, { state, live, watcher }, environment)
  if (live.quickExits >= GIVE_UP_AFTER) return giveUp($, { state, live, watcher }, { what, output, epoch, endedAt, hasEnvironment })
  const delay = isQuick ? RETRY_MS * 2 ** (live.quickExits - 1) : 0
  assert(delay < RETRY_MS * 2 ** GIVE_UP_AFTER, `${watcher.name} waits ${delay}ms to restart after ${live.quickExits} quick exits; it should have given up`)
  live.retryAt = endedAt + delay
  setStatus($, state, live, `${watcher.name}: ${what}, restarting ${delay === 0 ? 'now' : `in ${delay / 1000}s`}`)
  if (delay === 0) state.onWatcherEnded?.()
  else
    $.clock.after(delay, () => {
      if (state.epoch === epoch) state.onWatcherEnded?.()
    })
  if (hasEnvironment) return
  queue($, { state, live }, `exited:${output}`, { text: exitMessage(watcher, delay), isWaking: false, kind: 'exit' })
}

/** Stops every watcher and forgets what the session found and told, so the next session starts afresh. */
export async function stop($: EngineInterface, state: State): Promise<number> {
  state.cwd = undefined
  state.onWatcherEnded = undefined
  state.completionCorrection = undefined
  state.isCorrectionTurn = false
  state.isEditedSinceCorrection = false
  state.head = undefined
  state.isTurnRunning = false
  state.isPromptQueued = false
  state.isToldThisTurn = false
  state.epoch += 1
  const { epoch } = state
  state.flushing?.cancel()
  state.outbox.clear()
  state.policyTold = undefined
  state.rootStall = undefined
  state.environment.clear()
  state.tcr = initialTcr()
  state.tcrHeld.clear()
  state.tcrEditing.clear()
  void cancelJudgement($, state)
  const liveWatchers = state.liveWatchers.map(each => {
    each.isWatching = false
    each.retryAt = 0
    each.quickExits = 0
    each.toolchain = undefined
    each.changed = undefined
    for (const timer of each.quiet.values()) timer.cancel()
    each.quiet.clear()
    each.wasFailing = false
    each.baseline = undefined
    each.isEdited = false
    each.isEditedSinceResult = false
    each.report = undefined
    each.told = undefined
    each.status = undefined
    return each.kill?.()
  })
  const { finding } = state
  await Promise.all([...liveWatchers, finding === undefined ? undefined : within($, () => finding).catch(() => undefined)])
  if (state.epoch !== epoch) return epoch
  assert(state.liveWatchers.every(each => !each.isWatching), `liveWatchers ${state.liveWatchers.filter(each => each.isWatching).map(each => each.key)} still watch after stop`)
  state.outbox.clear()
  assert(state.outbox.size === 0, `${state.outbox.size} messages wait after the outbox was cleared`)
  $.ui.status(undefined)
  return epoch
}

/**
 * A tool that ran is work, so the same correction may be told again, except in the correction's own turn, where
 * inspecting it is the answer to it. An editing tool also reruns each check and may have moved HEAD.
 */
async function afterTool($: EngineInterface, state: State, tool: string, command = '') {
  assert(tool !== '', `a tool call named the tool ${JSON.stringify(tool)}; pass the name of the tool the agent called`)
  if (!state.isCorrectionTurn) state.completionCorrection = undefined
  assert(!state.isCorrectionTurn || state.completionCorrection !== undefined, `the correction turn lost its correction after ${tool}; keep it while the turn answers it`)
  const isEditing = EDITING_TOOLS.has(tool)
  const edit: EditMarks = { marks: isEditing ? markEdited(state) : new Map<LiveWatcher, Mark>(), isUnchanged: false }
  const move = await runBoth($, state, { before: () => noteFiles($, state, tool, edit), after: () => (isEditing ? afterEdit($, state, tool, command) : 'none') })
  if (edit.isUnchanged && move === 'none' && state.tcrEditing.size <= 1) unmark(edit.marks)
}

/** Marks each check as edited, so that its next result is read against the edit, before anything that can fail reads the files. Answers what each check was marked as before, which a tool that changed nothing restores. */
function markEdited(state: State): Map<LiveWatcher, Mark> {
  assert(Array.isArray(state.liveWatchers), `the live watchers are ${typeof state.liveWatchers}, not a list`)
  state.isEditedSinceCorrection = true
  const before = new Map<LiveWatcher, Mark>()
  for (const each of state.liveWatchers) {
    before.set(each, { isEdited: each.isEdited, isEditedSinceResult: each.isEditedSinceResult })
    each.isEdited = true
    each.isEditedSinceResult = true
  }
  assert(state.liveWatchers.every(each => each.isEdited), 'a live watcher was not marked edited; mark each so its next result is read against the edit')
  return before
}

/** What an editing tool leaves once the files were noted, or the note failed: HEAD may have moved, and then the edit is not judged. */
async function afterEdit($: EngineInterface, state: State, tool: string, command: string): Promise<'fresh' | 'kept' | 'none'> {
  assert(EDITING_TOOLS.has(tool) && typeof command === 'string', `${tool} is no editing tool, or its command is ${typeof command}, not text`)
  const { epoch } = state
  for (const each of state.liveWatchers) each.changed?.()
  const move = await rebaselineOnMove($, state, command)
  if (move === 'fresh') await leaveUnjudged($, state)
  if (move === 'kept' && !state.tcr.unjudged) state.tcr.isLeftToChecks = true
  assert(state.epoch !== epoch || state.liveWatchers.every(each => each.isEdited || each.baseline === undefined), `a live watcher was not marked edited after ${tool}; mark each so its next result is read against the edit`)
  return move
}

/** Notes whether a starting turn is overwatch's own correction, submitted with that correction's text. */
function startTurn(state: State, text: string) {
  assert(typeof text === 'string', `a turn started with ${JSON.stringify(text)}, not its prompt text; pass turn.start's text`)
  state.isCorrectionTurn = state.completionCorrection !== undefined && text === state.completionCorrection
  assert(typeof state.isCorrectionTurn === 'boolean', `the turn is marked ${typeof state.isCorrectionTurn} as a correction`)
}

/** Stops the session's watchers, and starts afresh in the directory the host resumes it in when it resumes. */
async function endSession($: EngineInterface, state: State, reason: string) {
  assert(typeof state === 'object' && state !== null, `the session ended for the state ${typeof state}`)
  const epoch = await stop($, state)
  if (reason !== 'resume') state.announced.clear()
  if (reason === 'resume') {
    const cwd = await $.session.cwd()
    if (state.epoch !== epoch) return
    state.cwd = cwd
    state.onWatcherEnded = () => background($, state, () => ensureAll($, state))
    state.onUntold = () => background($, state, () => tellSuppressed($, state))
    $.clock.after(0, () => background($, state, () => ensureAll($, state)))
  }
  assert(Number.isInteger(state.epoch) && state.epoch >= epoch, `the session is at epoch ${state.epoch} after its end at epoch ${epoch}, which is no count that only grows`)
}

export const register: Register = on => {
  const state = initialState()
  assert(state.cwd === undefined, `overwatch registered with session directory ${state.cwd}; it is set when the session starts`)
  assert(state.epoch === 0, `overwatch registered at epoch ${state.epoch}; start from initialState()`)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive) return started
    if (state.cwd === undefined) state.epoch += 1
    await guarded($, state, () => {
      state.cwd = e.cwd
      state.onWatcherEnded = () => background($, state, () => ensureAll($, state))
      state.onUntold = () => background($, state, () => tellSuppressed($, state))
      background($, state, () => announceUnreadable($, state.announced))
      background($, state, () => ensureAll($, state))
      background($, state, () => rebaselineOnMove($, state))
      background($, state, () => decideTcr($, state))
    })
    return started
  })

  on('tool.call', async ($, e, next) => {
    const denied = await failOpen($, state, () => deniedWhileFailing($, state, e))
    if (denied !== undefined) return denied
    return whileEditing($, state, e.tool, async () => {
      const result = await next(e)
      await failOpen($, state, () => afterTool($, state, e.tool, commandOf(e)))
      return result
    })
  })

  on('turn.start', ($, e, next) => {
    guardedNow($, state, () => {
      startTurn(state, e.text)
      state.isTurnRunning = true
      state.isToldThisTurn = state.isPromptQueued
      state.isPromptQueued = false
      schedule($, state)
      background($, state, () => ensureAll($, state))
      background($, state, () => rebaselineOnMove($, state))
      background($, state, () => decideTcr($, state))
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      state.tcrEditing.clear()
      const isAnswered = !e.isAborted && e.reason === 'answer'
      const reason = await endMainTurn($, state, isAnswered)
      if (reason !== undefined) return { text: reason }
      if (!isAnswered) return next(e)
    }
    background($, state, () => ensureAll($, state))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') return next(e)
    const epochAfterEnd = state.epoch + 1
    await failOpen($, state, () => endSession($, state, e.reason), epochAfterEnd)
    return next(e)
  })
}
