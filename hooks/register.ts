import type { EngineInterface, Register, Timer } from 'claude-code'
import {
  OVERRIDE_PATH,
  WATCHERS,
  applyOverride,
  commandLine,
  failureMessage,
  readReport,
  recoveryMessage,
  statusLine,
  type Override,
  type Report,
  type Watcher,
} from './watchers'

const QUIET_MS = 400

type State = {
  stop: (() => Promise<unknown>) | undefined
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

/** Runs the whole suite once and reports it, so the watcher starts from a known result. */
async function runBaseline($: EngineInterface, state: State, watcher: Watcher, argv: readonly string[], cwd: string) {
  const child = $.process.spawn({ argv, cwd })
  state.stop = () => child.return({ code: null, signal: null })
  $.ui.status(`overwatch ${watcher.name}: running the full suite with ${commandLine(watcher, argv)}`)
  let output = ''
  for await (const { text } of child) output += text
  const report = readReport(watcher, output)
  if (report === undefined) {
    $.ui.log(`overwatch: ${commandLine(watcher, argv)} gave no summary:\n${output}`, { to: 'debug' })
    return
  }
  await deliver($, state, watcher, report)
}

async function watch($: EngineInterface, state: State, watcher: Watcher, cwd: string) {
  if (watcher.baseline !== undefined && watcher.baseline.length > 0) {
    try {
      await runBaseline($, state, watcher, watcher.baseline, cwd)
    } catch (error) {
      $.ui.log(`overwatch: ${String(error)}`, { to: 'debug' })
    }
    if (state.stop === undefined) return
  }
  const child = $.process.spawn({ argv: watcher.argv, cwd })
  state.stop = () => child.return({ code: null, signal: null })
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
  return undefined
}

export const register: Register = on => {
  const state: State = { stop: undefined, isTurnRunning: false, isPromptQueued: false, wasFailing: false }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive || state.stop !== undefined) return started
    const watcher = await findWatcher($, e.cwd)
    if (watcher !== undefined) void watch($, state, watcher, e.cwd)
    return started
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
    await state.stop?.()
    state.stop = undefined
    $.ui.status(undefined)
    return next(e)
  })
}
