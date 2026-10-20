import type { EngineInterface, Register, Timer } from 'claude-code'
import {
  CHECKERS,
  OVERRIDE_PATH,
  WATCHERS,
  applyOverride,
  commandLine,
  exitMessage,
  failureMessage,
  gaveUpMessage,
  overrideWatcher,
  readReport,
  recoveryMessage,
  statusLine,
  type Override,
  type Report,
  type Watcher,
} from './watchers'

const QUIET_MS = 400

/**
 * A watcher that ends within this long of its start counts as a quick exit and
 * waits before it restarts: this long after the first, doubling after each further one.
 */
const RETRY_MS = 30_000

/** After this many quick exits in a row, a watcher is no longer restarted on a timer, only as turns start. */
const GIVE_UP_AFTER = 3

/** Tools whose call may change the project's files; a watcher that is no long-running command reruns after each. */
const EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])

/** One watcher's place beside the others: the project's test watcher, or a checker such as zanity. */
type Slot = {
  /** The checker this slot runs; undefined for the project's test watcher. */
  checker: Watcher | undefined
  isChecking: boolean
  /** A check was asked for while one was in flight, which may have read the project before it changed. */
  isRecheckDue: boolean
  isWatching: boolean
  /** When a watcher that ended soon after its start may be started again. */
  retryAt: number
  /** How many times in a row the watcher ended within RETRY_MS of its start. */
  quickExits: number
  kill: (() => Promise<unknown>) | undefined
  changed: (() => void) | undefined
  wasFailing: boolean
  /** This watcher's part of the plugin's one status line. */
  status: string | undefined
}

type State = {
  /** The interactive session's directory; undefined before it starts and once it ends. */
  cwd: string | undefined
  /** Bumped when the session ends, so a check still in flight starts nothing. */
  epoch: number
  isTurnRunning: boolean
  isPromptQueued: boolean
  slots: readonly Slot[]
}

/** One watcher running in its slot: what each step of a run needs. */
type Run = { state: State; slot: Slot; watcher: Watcher; cwd: string }

/** Sets this slot's part of the status line, which shows every running watcher's. */
function setStatus($: EngineInterface, state: State, slot: Slot, text: string | undefined) {
  slot.status = text
  const parts = state.slots.flatMap(({ status }) => (status === undefined ? [] : [status]))
  $.ui.status(parts.length === 0 ? undefined : parts.join(' · '))
}

/** Joins the running turn; with none, starts one only when `isWaking`. */
async function tell($: EngineInterface, state: State, text: string, isWaking: boolean) {
  if (state.isTurnRunning) {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    return
  }
  if (!isWaking || state.isPromptQueued) return
  state.isPromptQueued = true
  await $.prompt.submit({ text })
}

async function deliver($: EngineInterface, { state, slot, watcher }: Run, report: Report) {
  setStatus($, state, slot, statusLine(watcher, report))
  const isRecovery = !report.isFailed && slot.wasFailing
  slot.wasFailing = report.isFailed
  if (!report.isFailed && !isRecovery) return
  const text = report.isFailed ? failureMessage(watcher, report) : recoveryMessage(watcher, report)
  await tell($, state, text, report.isFailed)
}

/** Runs a command to its end and reports what it printed. */
async function runOnce($: EngineInterface, run: Run, argv: readonly string[]) {
  const { state, slot, watcher, cwd } = run
  const child = $.process.spawn({ argv, cwd })
  slot.kill = () => child.return({ code: null, signal: null })
  let output = ''
  try {
    for await (const { text } of child) output += text
  } catch (error) {
    setStatus($, state, slot, `overwatch ${watcher.name}: could not start ${commandLine(watcher, argv)}`)
    $.ui.log(`overwatch: ${String(error)}`, { to: 'debug' })
    return
  } finally {
    slot.kill = undefined
  }
  if (!slot.isWatching) return
  const report = readReport(watcher, output)
  if (report === undefined) {
    $.ui.log(`overwatch: ${commandLine(watcher, argv)} gave no summary:\n${output}`, { to: 'debug' })
    return
  }
  await deliver($, run, report)
}

/** Reruns the suite once the agent's edits go quiet, one run at a time. */
function rerunOnChange($: EngineInterface, run: Run, argv: readonly string[]) {
  let timer: Timer | undefined
  let isRunning = false
  let isPending = false
  const rerun = async () => {
    if (!run.slot.isWatching) return
    if (isRunning) {
      isPending = true
      return
    }
    isRunning = true
    await runOnce($, run, argv)
    isRunning = false
    if (!isPending) return
    isPending = false
    await rerun()
  }
  run.slot.changed = () => {
    timer?.cancel()
    timer = $.clock.after(QUIET_MS, () => void rerun())
  }
}

/** How a watcher ended of itself, its process exited or never started, when, and what it printed after its last report. */
type Ending = { isStarted: boolean; startedAt: number; endedAt: number; output: string }

/** Watches until the watcher ends of itself, resolving how; a watcher with no command never ends. */
async function watch($: EngineInterface, run: Run): Promise<Ending | undefined> {
  const { state, slot, watcher, cwd } = run
  if (watcher.baseline !== undefined && watcher.baseline.length > 0) {
    const text = `overwatch ${watcher.name}: running the full suite with ${commandLine(watcher, watcher.baseline)}`
    setStatus($, state, slot, text)
    await runOnce($, run, watcher.baseline)
    if (!slot.isWatching) return undefined
  }
  if (watcher.argv === undefined) {
    if (watcher.baseline !== undefined) rerunOnChange($, run, watcher.baseline)
    return undefined
  }
  const startedAt = await $.clock.now()
  if (!slot.isWatching) return undefined
  const child = $.process.spawn({ argv: watcher.argv, cwd })
  slot.kill = () => child.return({ code: null, signal: null })
  setStatus($, state, slot, `overwatch ${watcher.name}: starting ${commandLine(watcher)}`)
  let output = ''
  let flush: Timer | undefined
  let isStarted = true
  try {
    for await (const { text } of child) {
      output += text
      flush?.cancel()
      flush = $.clock.after(QUIET_MS, () => {
        const report = readReport(watcher, output)
        if (report === undefined) return
        output = ''
        void deliver($, run, report)
      })
    }
    flush?.cancel()
    if (!slot.isWatching) return undefined
    // A report printed just before the exit is delivered now, before the status line says it exited.
    const report = readReport(watcher, output)
    if (report !== undefined) await deliver($, run, report)
    $.ui.toast(`overwatch: ${commandLine(watcher)} exited`)
  } catch (error) {
    flush?.cancel()
    if (!slot.isWatching) return undefined
    $.ui.log(`overwatch: ${String(error)}`, { to: 'debug' })
    isStarted = false
    output += String(error)
  } finally {
    slot.kill = undefined
  }
  return { isStarted, startedAt, endedAt: await $.clock.now(), output }
}

async function readOverride($: EngineInterface, cwd: string): Promise<Override> {
  return $.fs
    .read(`${cwd}/${OVERRIDE_PATH}`)
    .then(text => JSON.parse(text) as Override)
    .catch(() => ({}))
}

/** The project's test watcher: the first whose marker it has, or its override's own. */
async function findWatcher($: EngineInterface, cwd: string, override: Override): Promise<Watcher | undefined> {
  for (const watcher of WATCHERS) {
    if (await $.fs.exists(`${cwd}/${watcher.marker}`)) return applyOverride(watcher, override)
  }
  return overrideWatcher(override)
}

/** Whether `name` is an executable in a directory on PATH. */
async function isOnPath($: EngineInterface, name: string): Promise<boolean> {
  const path = (await $.env.get('PATH').catch(() => undefined)) ?? ''
  for (const dir of path.split(':')) {
    if (dir !== '' && (await $.fs.exists(`${dir}/${name}`).catch(() => false))) return true
  }
  return false
}

/** A checker runs in any project, as long as its executable is installed. */
async function findChecker($: EngineInterface, checker: Watcher): Promise<Watcher | undefined> {
  return (await isOnPath($, checker.marker)) ? checker : undefined
}

/** This slot's watcher, read afresh; undefined while it waits out a retry or overwatch is off. */
async function lookFor($: EngineInterface, slot: Slot, cwd: string): Promise<Watcher | undefined> {
  if (slot.retryAt > 0 && (await $.clock.now()) < slot.retryAt) return undefined
  const override = await readOverride($, cwd)
  if (override.enabled === false) return undefined
  return slot.checker === undefined ? findWatcher($, cwd, override) : findChecker($, slot.checker)
}

/**
 * Starts the slot's watcher unless one runs or a check is in flight, reading the
 * marker and the override afresh, so a project scaffolded mid-session gets its
 * watcher. One that exits is restarted, see `restart`.
 */
async function ensureWatching($: EngineInterface, state: State, slot: Slot) {
  const { cwd, epoch } = state
  if (cwd === undefined || slot.isWatching) return
  if (slot.isChecking) {
    slot.isRecheckDue = true
    return
  }
  slot.isChecking = true
  slot.isRecheckDue = false
  const watcher = await lookFor($, slot, cwd).finally(() => {
    slot.isChecking = false
  })
  if (slot.isWatching || state.epoch !== epoch) return
  if (watcher === undefined) {
    if (slot.isRecheckDue) await ensureWatching($, state, slot)
    return
  }
  slot.isWatching = true
  slot.retryAt = 0
  const ending = await watch($, { state, slot, watcher, cwd })
  if (ending === undefined || state.epoch !== epoch) return
  await restart($, state, slot, watcher, ending)
}

/**
 * After a watcher ends of itself: one that ran RETRY_MS or longer restarts at
 * once; a quick exit waits RETRY_MS, doubling with each one in a row, until
 * GIVE_UP_AFTER of them, when only a turn starts it again, still RETRY_MS
 * apart. The status line says it is down and the agent is told, woken only
 * once overwatch gives up, since until then the watcher comes back on its own.
 */
async function restart($: EngineInterface, state: State, slot: Slot, watcher: Watcher, ending: Ending) {
  const { epoch } = state
  const { isStarted, startedAt, endedAt, output } = ending
  const isQuick = !isStarted || endedAt - startedAt < RETRY_MS
  slot.quickExits = isQuick ? slot.quickExits + 1 : 0
  slot.isWatching = false
  const what = isStarted ? `${commandLine(watcher)} exited` : `could not start ${commandLine(watcher)}`
  if (slot.quickExits >= GIVE_UP_AFTER) {
    slot.retryAt = endedAt + RETRY_MS
    const status = `${what} ${slot.quickExits} times in a row; retrying at the first turn after ${RETRY_MS / 1000}s`
    setStatus($, state, slot, `overwatch ${watcher.name}: ${status}`)
    if (slot.quickExits === GIVE_UP_AFTER) await tell($, state, gaveUpMessage(watcher, slot.quickExits, RETRY_MS, output), true)
    return
  }
  const delay = isQuick ? RETRY_MS * 2 ** (slot.quickExits - 1) : 0
  slot.retryAt = endedAt + delay
  setStatus($, state, slot, `overwatch ${watcher.name}: ${what}, restarting ${delay === 0 ? 'now' : `in ${delay / 1000}s`}`)
  if (delay === 0) void ensureWatching($, state, slot)
  else
    $.clock.after(delay, () => {
      if (state.epoch === epoch) void ensureWatching($, state, slot)
    })
  await tell($, state, exitMessage(watcher, delay), false)
}

const slot = (checker?: Watcher): Slot => ({
  checker,
  isChecking: false,
  isRecheckDue: false,
  isWatching: false,
  retryAt: 0,
  quickExits: 0,
  kill: undefined,
  changed: undefined,
  wasFailing: false,
  status: undefined,
})

function ensureAll($: EngineInterface, state: State) {
  for (const each of state.slots) void ensureWatching($, state, each)
}

export const register: Register = on => {
  const state: State = {
    cwd: undefined,
    epoch: 0,
    isTurnRunning: false,
    isPromptQueued: false,
    slots: [slot(), ...CHECKERS.map(checker => slot(checker))],
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive) return started
    state.cwd = e.cwd
    ensureAll($, state)
    return started
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (EDITING_TOOLS.has(e.tool)) for (const each of state.slots) each.changed?.()
    return result
  })

  on('turn.start', ($, e, next) => {
    state.isTurnRunning = true
    state.isPromptQueued = false
    ensureAll($, state)
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) state.isTurnRunning = false
    ensureAll($, state)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') return next(e)
    state.cwd = undefined
    state.epoch += 1
    const slots = state.slots.map(each => {
      each.isWatching = false
      each.changed = undefined
      each.status = undefined
      return each.kill?.()
    })
    await Promise.all(slots)
    $.ui.status(undefined)
    return next(e)
  })
}
