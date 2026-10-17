import type { EngineInterface, Register, Timer } from 'claude-code'
import {
  OVERRIDE_PATH,
  WATCHERS,
  applyOverride,
  commandLine,
  failureMessage,
  overrideWatcher,
  readReport,
  recoveryMessage,
  statusLine,
  type Override,
  type Report,
  type Watcher,
} from './watchers'

const QUIET_MS = 400

/** A watcher that ends within this long of its start is not started again until it has passed. */
const RETRY_MS = 30_000

/** Tools whose call may change the project's files; a watcher that is no long-running command reruns after each. */
const EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])

type State = {
  /** The interactive session's directory; undefined before it starts and once it ends. */
  cwd: string | undefined
  /** Bumped when the session ends, so a check still in flight starts nothing. */
  epoch: number
  isChecking: boolean
  /** A check was asked for while one was in flight, which may have read the project before it changed. */
  isRecheckDue: boolean
  isWatching: boolean
  /** When a watcher that ended soon after its start may be started again. */
  retryAt: number
  kill: (() => Promise<unknown>) | undefined
  changed: (() => void) | undefined
  isTurnRunning: boolean
  isPromptQueued: boolean
  wasFailing: boolean
}

async function deliver($: EngineInterface, state: State, watcher: Watcher, report: Report) {
  $.ui.status(statusLine(watcher, report))
  const isRecovery = !report.isFailed && state.wasFailing
  state.wasFailing = report.isFailed
  if (!report.isFailed && !isRecovery) return
  const text = report.isFailed ? failureMessage(watcher, report) : recoveryMessage(watcher, report)
  if (state.isTurnRunning) {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    return
  }
  if (!report.isFailed || state.isPromptQueued) return
  state.isPromptQueued = true
  await $.prompt.submit({ text })
}

/** Runs a command to its end and reports what it printed. */
async function runOnce($: EngineInterface, state: State, watcher: Watcher, argv: readonly string[], cwd: string) {
  const child = $.process.spawn({ argv, cwd })
  state.kill = () => child.return({ code: null, signal: null })
  let output = ''
  try {
    for await (const { text } of child) output += text
  } catch (error) {
    $.ui.status(`overwatch ${watcher.name}: could not start ${commandLine(watcher, argv)}`)
    $.ui.log(`overwatch: ${String(error)}`, { to: 'debug' })
    return
  } finally {
    state.kill = undefined
  }
  if (!state.isWatching) return
  const report = readReport(watcher, output)
  if (report === undefined) {
    $.ui.log(`overwatch: ${commandLine(watcher, argv)} gave no summary:\n${output}`, { to: 'debug' })
    return
  }
  await deliver($, state, watcher, report)
}

/** Reruns the suite once the agent's edits go quiet, one run at a time. */
function rerunOnChange($: EngineInterface, state: State, watcher: Watcher, argv: readonly string[], cwd: string) {
  let timer: Timer | undefined
  let isRunning = false
  let isPending = false
  const run = async () => {
    if (!state.isWatching) return
    if (isRunning) {
      isPending = true
      return
    }
    isRunning = true
    await runOnce($, state, watcher, argv, cwd)
    isRunning = false
    if (!isPending) return
    isPending = false
    await run()
  }
  state.changed = () => {
    timer?.cancel()
    timer = $.clock.after(QUIET_MS, () => void run())
  }
}

/** How a watcher ended of itself: its process exited, or it never started. */
type Ending = { isStarted: boolean; startedAt: number }

/** Watches until the watcher ends of itself, resolving how; a watcher with no command never ends. */
async function watch($: EngineInterface, state: State, watcher: Watcher, cwd: string): Promise<Ending | undefined> {
  if (watcher.baseline !== undefined && watcher.baseline.length > 0) {
    $.ui.status(`overwatch ${watcher.name}: running the full suite with ${commandLine(watcher, watcher.baseline)}`)
    await runOnce($, state, watcher, watcher.baseline, cwd)
    if (!state.isWatching) return undefined
  }
  if (watcher.argv === undefined) {
    if (watcher.baseline !== undefined) rerunOnChange($, state, watcher, watcher.baseline, cwd)
    return undefined
  }
  const startedAt = await $.clock.now()
  if (!state.isWatching) return undefined
  const child = $.process.spawn({ argv: watcher.argv, cwd })
  state.kill = () => child.return({ code: null, signal: null })
  $.ui.status(`overwatch ${watcher.name}: starting ${commandLine(watcher)}`)
  let output = ''
  let flush: Timer | undefined
  try {
    for await (const { text } of child) {
      output += text
      flush?.cancel()
      flush = $.clock.after(QUIET_MS, () => {
        const report = readReport(watcher, output)
        if (report === undefined) return
        output = ''
        void deliver($, state, watcher, report)
      })
    }
    if (!state.isWatching) return undefined
    $.ui.toast(`overwatch: ${commandLine(watcher)} exited`)
    return { isStarted: true, startedAt }
  } catch (error) {
    if (!state.isWatching) return undefined
    $.ui.log(`overwatch: ${String(error)}`, { to: 'debug' })
    return { isStarted: false, startedAt }
  } finally {
    state.kill = undefined
  }
}

async function findWatcher($: EngineInterface, cwd: string): Promise<Watcher | undefined> {
  const override: Override = await $.fs
    .read(`${cwd}/${OVERRIDE_PATH}`)
    .then(text => JSON.parse(text) as Override)
    .catch(() => ({}))
  if (override.enabled === false) return undefined
  for (const watcher of WATCHERS) {
    if (await $.fs.exists(`${cwd}/${watcher.marker}`)) return applyOverride(watcher, override)
  }
  return overrideWatcher(override)
}

/**
 * Starts the project's watcher unless one runs or a check is in flight, reading the
 * marker and the override afresh, so a project scaffolded mid-session gets its
 * watcher. One that could not start, or exited within RETRY_MS, waits that long.
 */
async function ensureWatching($: EngineInterface, state: State) {
  const { cwd, epoch } = state
  if (cwd === undefined || state.isWatching) return
  if (state.isChecking) {
    state.isRecheckDue = true
    return
  }
  state.isChecking = true
  state.isRecheckDue = false
  const watcher = await (async () => {
    if (state.retryAt > 0 && (await $.clock.now()) < state.retryAt) return undefined
    return findWatcher($, cwd)
  })().finally(() => {
    state.isChecking = false
  })
  if (state.isWatching || state.epoch !== epoch) return
  if (watcher === undefined) {
    if (state.isRecheckDue) await ensureWatching($, state)
    return
  }
  state.isWatching = true
  state.retryAt = 0
  const ending = await watch($, state, watcher, cwd)
  if (ending === undefined || state.epoch !== epoch) return
  const endedAt = await $.clock.now()
  const isQuick = !ending.isStarted || endedAt - ending.startedAt < RETRY_MS
  state.retryAt = isQuick ? endedAt + RETRY_MS : 0
  const what = ending.isStarted ? `${commandLine(watcher)} exited` : `could not start ${commandLine(watcher)}`
  const when = isQuick ? `retrying at the first turn after ${RETRY_MS / 1000}s` : 'restarting at the next turn'
  if (state.epoch !== epoch) return
  $.ui.status(`overwatch ${watcher.name}: ${what}, ${when}`)
  state.isWatching = false
}

export const register: Register = on => {
  const state: State = {
    cwd: undefined,
    epoch: 0,
    isChecking: false,
    isRecheckDue: false,
    isWatching: false,
    retryAt: 0,
    kill: undefined,
    changed: undefined,
    isTurnRunning: false,
    isPromptQueued: false,
    wasFailing: false,
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive) return started
    state.cwd = e.cwd
    void ensureWatching($, state)
    return started
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (EDITING_TOOLS.has(e.tool)) state.changed?.()
    return result
  })

  on('turn.start', ($, e, next) => {
    state.isTurnRunning = true
    state.isPromptQueued = false
    void ensureWatching($, state)
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) state.isTurnRunning = false
    void ensureWatching($, state)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') return next(e)
    state.cwd = undefined
    state.epoch += 1
    state.isWatching = false
    state.changed = undefined
    await state.kill?.()
    $.ui.status(undefined)
    return next(e)
  })
}
