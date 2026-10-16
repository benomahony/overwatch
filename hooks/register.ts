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

/** Tools whose call may change the project's files; a watcher that is no long-running command reruns after each. */
const EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])

type State = {
  isWatching: boolean
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

async function watch($: EngineInterface, state: State, watcher: Watcher, cwd: string) {
  if (watcher.baseline !== undefined && watcher.baseline.length > 0) {
    $.ui.status(`overwatch ${watcher.name}: running the full suite with ${commandLine(watcher, watcher.baseline)}`)
    await runOnce($, state, watcher, watcher.baseline, cwd)
    if (!state.isWatching) return
  }
  if (watcher.argv === undefined) {
    if (watcher.baseline !== undefined) rerunOnChange($, state, watcher, watcher.baseline, cwd)
    return
  }
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
    $.ui.toast(`overwatch: ${commandLine(watcher)} exited`)
  } catch (error) {
    $.ui.status(`overwatch ${watcher.name}: could not start ${commandLine(watcher)}`)
    $.ui.log(`overwatch: ${String(error)}`, { to: 'debug' })
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

export const register: Register = on => {
  const state: State = {
    isWatching: false,
    kill: undefined,
    changed: undefined,
    isTurnRunning: false,
    isPromptQueued: false,
    wasFailing: false,
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive || state.isWatching) return started
    const watcher = await findWatcher($, e.cwd)
    if (watcher === undefined || state.isWatching) return started
    state.isWatching = true
    void watch($, state, watcher, e.cwd)
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
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) state.isTurnRunning = false
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') return next(e)
    state.isWatching = false
    state.changed = undefined
    await state.kill?.()
    $.ui.status(undefined)
    return next(e)
  })
}
