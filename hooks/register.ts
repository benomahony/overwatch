import type { EngineInterface, Register, Timer } from 'claude-code'
import { assert } from './assert'
import { protectedChecks } from './gating'
import {
  commandLine,
  environmentIn,
  exitMessage,
  gaveUpMessage,
  languageOf,
  lastBuild,
  readReport,
  type Watcher,
} from './watchers'
import { repositoryOf, COMMIT, commitOf, isCommitted, findIn } from './project'
import { toolchainOf, movedToolchain, stopIfMoved, restartOnMoved } from './toolchain'
import type { LiveWatcher, State, Run, Restart, Ending } from './state'
import { QUIET_MS, setStatus, schedule, queue, queueEnvironment, writeLog, deliver } from './delivery'
import { projectPolicy, guardedFailure, completeTurn } from './completion'

/**
 * A watcher that ends within this long of its start counts as a quick exit and
 * waits before it restarts: this long after the first, doubling after each further one.
 */
const RETRY_MS = 30_000

/** After this many quick exits in a row, a watcher is no longer restarted on a timer, only as turns start. */
const GIVE_UP_AFTER = 3

/** Tools whose call may change the project's files; a watcher that is no long-running command reruns after each. */
const EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])

/** The spawn option that sets a watcher's env over overwatch's own; none when it sets none. */
function envOf(watcher: Watcher): { env?: Record<string, string> } {
  assert(watcher.env === undefined || Object.values(watcher.env).every(value => typeof value === 'string'), `${watcher.name}'s env ${JSON.stringify(watcher.env)} holds a value that is not a string; give each variable a string`)
  const option = watcher.env === undefined ? {} : { env: { ...watcher.env } }
  assert(option.env === undefined || Object.keys(option.env).length === Object.keys(watcher.env ?? {}).length, `the env option for ${watcher.name} lost variables of ${JSON.stringify(watcher.env)}; copy each`)
  return option
}

/** Runs a command to its end and reports what it printed, unless it was stopped for a newer run first. */
async function runOnce($: EngineInterface, run: Run, argv: readonly string[], isStale = () => false) {
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
function rerunOnChange($: EngineInterface, run: Run, argv: readonly string[]) {
  assert(argv.length > 0, `${run.watcher.name} reruns an empty command; give it a baseline`)
  let timer: Timer | undefined
  let isRunning = false
  let isPending = false
  const rerun = async () => {
    if (!run.live.isWatching) return
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
  run.live.changed = () => {
    timer?.cancel()
    timer = $.clock.after(QUIET_MS, () => void rerun())
  }
  assert(run.live.changed !== undefined, `${run.live.key} has no change handler after rerunOnChange`)
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
  let flush: Timer | undefined
  let isStarted = true
  try {
    for await (const { text } of child) {
      output += text
      flush?.cancel()
      flush = $.clock.after(QUIET_MS, () => {
        // A transport chunk can stop in the middle of a summary line.
        const end = output.lastIndexOf('\n') + 1
        const lines = output.slice(0, end)
        const report = readReport(watcher, lines)
        if (report === undefined) return
        output = lastBuild(watcher, lines).remaining + output.slice(end)
        void deliver($, run, report)
      })
    }
    flush?.cancel()
    if (!live.isWatching) return undefined
  } catch (error) {
    flush?.cancel()
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
async function deliverExit($: EngineInterface, run: Run, output: string) {
  assert(run.live.kill === undefined, `${run.live.key} exited but is still killable; clear live.kill when it ends`)
  const report = readReport(run.watcher, output)
  if (report !== undefined) await deliver($, run, report)
  assert(report === undefined || run.live.report === report, `${run.watcher.name}'s last report was not delivered to ${run.live.key}`)
  if (run.live.isWatching) $.ui.toast(`overwatch: ${commandLine(run.watcher)} exited`)
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
  // A search asked for during one runs once after it; asks come from hooks and exits, so each round answers all so far.
  // The search stays marked running until its watchers have started, so a search asked for meanwhile waits its turn.
  // Each round reads the session afresh, so a search a newer session asked for runs in that session's directory.
  try {
    do {
      const { cwd, epoch } = state
      if (cwd === undefined) break
      state.isFinding = true
      state.isFindDue = false
      state.finding = findIn($, cwd)
      const watchers = await state.finding.finally(() => {
        state.finding = undefined
      })
      if (state.epoch !== epoch) continue
      const now = await $.clock.now()
      for (const { watcher, dir } of watchers) {
        const key = `${languageOf(watcher)}:${dir}`
        let found = state.liveWatchers.find(each => each.key === key)
        if (found === undefined) {
          found = liveWatcher(key, dir)
          state.liveWatchers.push(found)
        }
        if (found.isWatching) void stopIfMoved($, found)
        if (found.isWatching || now < found.retryAt) continue
        found.isWatching = true
        void start($, state, found, watcher)
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
  const ending = await watch($, { state, live, watcher, cwd: live.dir })
  assert(ending === undefined || ending.endedAt >= ending.startedAt, `${watcher.name} ended at ${ending?.endedAt}, before it started at ${ending?.startedAt}`)
  if (ending === undefined || state.epoch !== epoch) return
  const moved = await movedToolchain($, live)
  if (state.epoch !== epoch) return
  if (moved === undefined) await restart($, { state, live, watcher, ending })
  else restartOnMoved($, { state, live, watcher }, moved)
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
async function restart($: EngineInterface, { state, live, watcher, ending }: Restart) {
  const { epoch } = state
  const { isStarted, startedAt, endedAt, output } = ending
  assert(live.watcher === watcher, `${live.key} restarts ${watcher.name} but runs ${live.watcher?.name}`)
  const isQuick = !isStarted || endedAt - startedAt < RETRY_MS
  live.quickExits = isQuick ? live.quickExits + 1 : 0
  live.isWatching = false
  const what = isStarted ? `${commandLine(watcher)} exited` : `could not start ${commandLine(watcher)}`
  const environment = environmentIn(output)
  if (environment !== undefined) queueEnvironment($, { state, live, watcher }, environment)
  if (live.quickExits >= GIVE_UP_AFTER) {
    live.retryAt = endedAt + RETRY_MS
    const status = `${what} ${live.quickExits} times in a row; retrying at the first turn after ${RETRY_MS / 1000}s`
    setStatus($, state, live, `${watcher.name}: ${status}`)
    if (live.quickExits === GIVE_UP_AFTER && environment === undefined) {
      const text = gaveUpMessage(watcher, live.quickExits, RETRY_MS, await writeLog($, live, output))
      queue($, { state, live }, `exited:${output}`, { text, isWaking: true, kind: 'exit' })
    }
    return
  }
  const delay = isQuick ? RETRY_MS * 2 ** (live.quickExits - 1) : 0
  assert(delay < RETRY_MS * 2 ** GIVE_UP_AFTER, `${watcher.name} waits ${delay}ms to restart after ${live.quickExits} quick exits; it should have given up`)
  live.retryAt = endedAt + delay
  setStatus($, state, live, `${watcher.name}: ${what}, restarting ${delay === 0 ? 'now' : `in ${delay / 1000}s`}`)
  if (delay === 0) state.onWatcherEnded?.()
  else
    $.clock.after(delay, () => {
      if (state.epoch === epoch) state.onWatcherEnded?.()
    })
  if (environment !== undefined || !state.isTurnRunning) return
  queue($, { state, live }, `exited:${output}`, { text: exitMessage(watcher, delay), isWaking: false, kind: 'exit' })
}

/** Stops every watcher and forgets what the session found and told, so the next session starts afresh. */
async function stop($: EngineInterface, state: State) {
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
  state.flushing?.cancel()
  state.outbox.clear()
  state.environment.clear()
  const liveWatchers = state.liveWatchers.map(each => {
    each.isWatching = false
    each.retryAt = 0
    each.quickExits = 0
    each.toolchain = undefined
    each.changed = undefined
    each.wasFailing = false
    each.baseline = undefined
    each.isEdited = false
    each.isEditedSinceResult = false
    each.report = undefined
    each.told = undefined
    each.status = undefined
    return each.kill?.()
  })
  await Promise.all([...liveWatchers, state.finding])
  assert(state.liveWatchers.every(each => !each.isWatching), `liveWatchers ${state.liveWatchers.filter(each => each.isWatching).map(each => each.key)} still watch after stop`)
  assert(state.outbox.size === 0, `${state.outbox.size} messages wait after stop; the next session must start afresh`)
  $.ui.status(undefined)
}

/** A new live for the watcher of one language in dir, watching nothing yet. */
const liveWatcher = (key: string, dir: string): LiveWatcher => {
  assert(key.endsWith(`:${dir}`), `live watcher key ${key} does not end with its directory ${dir}; key live watchers by language and dir`)
  const made: LiveWatcher = {
    watcher: undefined,
    report: undefined,
    key,
    dir,
    isWatching: false,
    retryAt: 0,
    quickExits: 0,
    kill: undefined,
    toolchain: undefined,
    changed: undefined,
    wasFailing: false,
    baseline: undefined,
    isEdited: false,
    isEditedSinceResult: false,
    origin: 'session',
    told: undefined,
    status: undefined,
  }
  assert(made.key === key && made.dir === dir, `live watcher for ${key} was made with key ${made.key} and dir ${made.dir}`)
  return made
}

/**
 * Notes the commit the session's baselines belong to, and takes fresh ones once it moves under the session, as a
 * pull or checkout brings in failures the agent did not make. Each check reruns, stopping a run still reading the
 * old commit, and its next result is its baseline unless the agent edits first. A commit keeps the baselines, even
 * one made in the same step as an edit, since it changes no file.
 */
async function rebaselineOnMove($: EngineInterface, state: State) {
  const { cwd, epoch } = state
  assert(state.head === undefined || COMMIT.test(state.head), `the session's HEAD ${state.head} is not a commit id; note only what commitOf returns`)
  if (cwd === undefined) return
  const root = await repositoryOf($, cwd)
  const head = root === undefined ? undefined : await commitOf($, root)
  if (state.epoch !== epoch || head === undefined || head === state.head) return
  assert(root !== undefined, `HEAD ${head} was read with no repository for ${cwd}; read it only from one`)
  const from = state.head
  state.head = head
  if (from === undefined || await isCommitted($, root, from, head) || state.epoch !== epoch) return
  for (const each of state.liveWatchers) {
    each.baseline = undefined
    each.isEdited = false
    each.isEditedSinceResult = false
    each.changed?.()
  }
  assert(state.liveWatchers.every(each => each.baseline === undefined && !each.isEdited), `a live watcher kept its baseline after HEAD moved to ${head}; clear each`)
}

/**
 * A tool that ran is work, so the same correction may be told again, except in the correction's own turn, where
 * inspecting it is the answer to it. An editing tool also reruns each check and may have moved HEAD.
 */
async function afterTool($: EngineInterface, state: State, tool: string) {
  assert(tool !== '', `a tool call named the tool ${JSON.stringify(tool)}; pass the name of the tool the agent called`)
  if (!state.isCorrectionTurn) state.completionCorrection = undefined
  assert(!state.isCorrectionTurn || state.completionCorrection !== undefined, `the correction turn lost its correction after ${tool}; keep it while the turn answers it`)
  if (!EDITING_TOOLS.has(tool)) return
  state.isEditedSinceCorrection = true
  for (const each of state.liveWatchers) {
    each.isEdited = true
    each.isEditedSinceResult = true
    each.changed?.()
  }
  await rebaselineOnMove($, state)
  assert(state.liveWatchers.every(each => each.isEdited || each.baseline === undefined), `a live watcher was not marked edited after ${tool}; mark each so its next result is read against the edit`)
}

/** Notes whether a starting turn is overwatch's own correction, submitted with that correction's text. */
function startTurn(state: State, text: string) {
  assert(typeof text === 'string', `a turn started with ${JSON.stringify(text)}, not its prompt text; pass turn.start's text`)
  state.isCorrectionTurn = state.completionCorrection !== undefined && text === state.completionCorrection
  assert(!state.isCorrectionTurn || text.startsWith('overwatch: '), `the turn ${JSON.stringify(text)} was taken for overwatch's correction; only its own text starts one`)
}

/** A session's state before it starts: no directory, liveWatchers or messages. */
const initialState = (): State => {
  const state: State = {
    cwd: undefined,
    epoch: 0,
    isTurnRunning: false,
    isPromptQueued: false,
    head: undefined,
    completionCorrection: undefined,
    isCorrectionTurn: false,
    isEditedSinceCorrection: false,
    isToldThisTurn: false,
    outbox: new Map(),
    flushing: undefined,
    environment: new Set(),
    isFinding: false,
    finding: undefined,
    isFindDue: false,
    onWatcherEnded: undefined,
    liveWatchers: [],
  }
  assert(state.liveWatchers.length === 0 && state.outbox.size === 0, `a new session starts with ${state.liveWatchers.length} liveWatchers and ${state.outbox.size} messages`)
  assert(!state.isTurnRunning && !state.isFinding, 'a new session starts with a turn or search running')
  return state
}

export const register: Register = on => {
  const state = initialState()
  assert(state.cwd === undefined, `overwatch registered with session directory ${state.cwd}; it is set when the session starts`)
  assert(state.epoch === 0, `overwatch registered at epoch ${state.epoch}; start from initialState()`)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive) return started
    state.cwd = e.cwd
    state.onWatcherEnded = () => void ensureAll($, state)
    void ensureAll($, state)
    void rebaselineOnMove($, state)
    return started
  })

  on('tool.call', async ($, e, next) => {
    if (state.liveWatchers.some(each => each.report?.isFailed)) {
      const policy = await projectPolicy($, state)
      const checks = protectedChecks(e.tool, e, policy)
      const reason = checks === undefined ? undefined : guardedFailure(state, policy, checks)
      if (reason !== undefined) return { deny: reason }
    }
    const result = await next(e)
    await afterTool($, state, e.tool)
    return result
  })

  on('turn.start', ($, e, next) => {
    startTurn(state, e.text)
    state.isTurnRunning = true
    state.isToldThisTurn = state.isPromptQueued
    state.isPromptQueued = false
    schedule($, state)
    void ensureAll($, state)
    void rebaselineOnMove($, state)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const isAnswered = !e.isAborted && e.reason === 'answer'
      const reason = await completeTurn($, state, isAnswered)
      if (reason !== undefined) return { text: reason }
      if (!isAnswered) return next(e)
    }
    void ensureAll($, state)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') return next(e)
    await stop($, state)
    if (e.reason === 'resume') {
      state.cwd = await $.session.cwd()
      state.onWatcherEnded = () => void ensureAll($, state)
      $.clock.after(0, () => void ensureAll($, state))
    }
    return next(e)
  })
}
