import { expect } from 'claude-code/testing'
import { deliver, schedule, tellRegression } from '../hooks/delivery'
import { keepPending } from '../hooks/deciding'
import { scheduleJudgement } from '../hooks/judgement'
import { within } from '../hooks/project'
import { TCR_ACTIVE, fingerprintOf, initialTcr, runCheck } from '../hooks/tcr'
import { whenQuiet } from '../hooks/quiet'
import { deliverExit, rerunOnChange, restart, runOnce, stop } from '../hooks/register'
import { initialState, liveWatcher, type LiveWatcher, type Run, type State } from '../hooks/state'
import { CHECKERS, readReport, type Watcher } from '../hooks/watchers'
import { turnOfEventLoop } from './fixtures/event-loop'
import { longTest } from './fixtures/tcr-session'

const WARNINGS = 'zanity: 0 errors and 29 warnings in 1 of 1 files\n'
const FIRST_SESSION = 0
const SECOND_SESSION = 1
const RETRY_LIMIT_REACHED = 2
const zanity = CHECKERS.find(({ name }) => name === 'zanity') as Watcher
const report = readReport(zanity, WARNINGS)
const passing = readReport(zanity, 'zanity: 0 errors and 0 warnings in 1 of 1 files\n')

type Timer = { delay: number; run: () => void; isCancelled: boolean }

/** A host that records the timers, the toasts, the processes started and the messages taken, and answers the rest with nothing. */
function hostOf(held: Promise<void> = Promise.resolve(), running: Promise<void> = Promise.resolve()) {
  const timers: Timer[] = []
  const toasts: string[] = []
  const spawned: string[][] = []
  const taken: string[] = []
  const child = { [Symbol.asyncIterator]: async function* () { await running; yield { stream: 'stdout', text: WARNINGS } }, result: Promise.resolve({ code: 0 }), return: async () => ({ done: true }) }
  const $ = {
    clock: { after: (delay: number, run: () => void) => { const timer = { delay, run, isCancelled: false }; timers.push(timer); return { cancel: () => { timer.isCancelled = true } } }, now: async () => 0, sleep: async () => undefined },
    ui: { log: () => undefined, toast: (text: string) => { toasts.push(text) }, status: () => undefined },
    env: { get: async () => { await held; return '/home' } },
    fs: { write: async () => undefined },
    session: { append: async ({ message }: { message: { content: { text: string }[] } }) => { taken.push(message.content[0]?.text ?? '') } },
    process: { spawn: ({ argv }: { argv: string[] }) => { spawned.push(argv); return child } },
  } as never
  return { $, timers, toasts, spawned, taken }
}

/** A state in its second session, holding a live that a run of the first session still holds, as the new session set it watching. */
function secondSession(): { state: State; live: LiveWatcher; old: Run } {
  const state = initialState()
  state.epoch = SECOND_SESSION
  const live = liveWatcher('zanity:/repo', '/repo')
  live.isWatching = true
  live.watcher = zanity
  state.liveWatchers.push(live)
  return { state, live, old: { state, live, watcher: zanity, cwd: '/repo', epoch: FIRST_SESSION } }
}

longTest('a result of a run of an earlier session changes nothing in the session after it (deliver)', async () => {
  const { $ } = hostOf()
  const { state, live, old } = secondSession()
  await deliver($, old, report as NonNullable<typeof report>)
  expect({ report: live.report, status: live.status, baseline: live.baseline, outbox: state.outbox.size }).toEqual({ report: undefined, status: undefined, baseline: undefined, outbox: 0 })
})

longTest('a result that takes its baseline while its session ends leaves the failing mark of the next session as it is (deliver)', async () => {
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => { release = resolve })
  const { $ } = hostOf(held)
  const { state, live, old } = secondSession()
  state.epoch = FIRST_SESSION
  const delivering = deliver($, old, report as NonNullable<typeof report>)
  await turnOfEventLoop()
  state.epoch = SECOND_SESSION
  live.wasFailing = true
  release()
  await delivering
  expect({ wasFailing: live.wasFailing, outbox: state.outbox.size }).toEqual({ wasFailing: true, outbox: 0 })
})

longTest('a run that ends after its session left no baseline and no report in the next (runOnce)', async () => {
  const host = hostOf()
  const { state, live, old } = secondSession()
  await runOnce(host.$, old, ['zanity'])
  expect({ spawned: host.spawned.length, report: live.report, baseline: live.baseline, outbox: state.outbox.size }).toEqual({ spawned: 1, report: undefined, baseline: undefined, outbox: 0 })
})

longTest('a run that ends after its watcher was stopped while it ran, in the same session, leaves no baseline and no report (runOnce)', async () => {
  let finish: () => void = () => undefined
  const host = hostOf(undefined, new Promise<void>(resolve => { finish = resolve }))
  const { state, live } = secondSession()
  const running = runOnce(host.$, { state, live, watcher: zanity, cwd: '/repo', epoch: SECOND_SESSION }, ['zanity'])
  live.isWatching = false
  finish()
  await running
  expect({ spawned: host.spawned.length, report: live.report, baseline: live.baseline, outbox: state.outbox.size }).toEqual({ spawned: 1, report: undefined, baseline: undefined, outbox: 0 })
})

longTest('the regression whose log was written after its session ended is not queued in the next (tellRegression)', async () => {
  let write: () => void = () => undefined
  const host = hostOf(new Promise<void>(resolve => { write = resolve }))
  const { state, live, old } = secondSession()
  state.epoch = FIRST_SESSION
  live.baseline = passing
  live.report = report
  live.origin = 'session'
  const telling = tellRegression(host.$, old, report)
  state.epoch = SECOND_SESSION
  write()
  await telling
  expect(state.outbox.size).toBe(0)
})

longTest('the exit of a watcher of an earlier session is not shown in the session after it (deliverExit)', async () => {
  const host = hostOf()
  const { live, old } = secondSession()
  await deliverExit(host.$, old, WARNINGS)
  expect({ toasts: host.toasts, report: live.report }).toEqual({ toasts: [], report: undefined })
})

longTest('the restart of a watcher of an earlier session tells nothing and waits for nothing (restart)', async () => {
  let release: () => void = () => undefined
  const host = hostOf(new Promise<void>(resolve => { release = resolve }))
  const { state, live } = secondSession()
  state.epoch = FIRST_SESSION
  live.quickExits = RETRY_LIMIT_REACHED
  const restarting = restart(host.$, { state, live, watcher: zanity, ending: { isStarted: true, startedAt: 0, endedAt: 1, output: WARNINGS } })
  state.epoch = SECOND_SESSION
  release()
  await restarting
  expect(state.outbox.size).toBe(0)
})

longTest('the timer that restarts a watcher does nothing once its session ended (restart)', async () => {
  const host = hostOf()
  const { state, live } = secondSession()
  state.epoch = FIRST_SESSION
  let restarted = 0
  state.onWatcherEnded = () => { restarted += 1 }
  await restart(host.$, { state, live, watcher: zanity, ending: { isStarted: true, startedAt: 0, endedAt: 1, output: WARNINGS } })
  state.epoch = SECOND_SESSION
  for (const timer of host.timers) timer.run()
  expect(restarted).toBe(0)
})

longTest('the rerun that a baseline run waits for does nothing once its session ended, with its timer left running (rerunOnChange)', async () => {
  const host = hostOf()
  const { state, live } = secondSession()
  state.epoch = FIRST_SESSION
  const run = { state, live, watcher: zanity, cwd: '/repo', epoch: FIRST_SESSION }
  rerunOnChange(host.$, run, ['zanity'])
  live.changed?.()
  state.epoch = SECOND_SESSION
  for (const timer of host.timers) timer.run()
  await turnOfEventLoop()
  expect(host.spawned.length).toBe(0)
})

longTest('the end of a session cancels the timer that flushes its messages (stop)', async () => {
  const host = hostOf()
  const state = initialState()
  schedule(host.$, state)
  await stop(host.$, state)
  expect(host.timers.map(timer => timer.isCancelled)).toEqual([true])
})

longTest('the end of a session cancels the quiet timer of each run (stop)', async () => {
  const host = hostOf()
  const { state, live } = secondSession()
  whenQuiet(host.$, { state, live, watcher: zanity, cwd: '/repo', epoch: SECOND_SESSION }, () => undefined)
  await stop(host.$, state)
  expect(host.timers.map(timer => timer.isCancelled)).toEqual([true])
})

longTest('the end of a session cancels the timer that starts the judgement of an edit (stop)', async () => {
  const host = hostOf()
  const state = initialState()
  state.tcr.unjudged = true
  scheduleJudgement(host.$, state)
  await stop(host.$, state)
  expect(host.timers.map(timer => timer.isCancelled)).toEqual([true])
})

longTest('a read of the project\'s files cancels its limit when it ends (within)', async () => {
  const host = hostOf()
  await within(host.$, async () => 1)
  expect(host.timers.map(timer => timer.isCancelled)).toEqual([true])
})

longTest('a question to the checkpoint command cancels its limit when it ends (runWithin)', async () => {
  const host = hostOf()
  const answer = { [Symbol.asyncIterator]: async function* () { yield { stream: 'stdout', text: JSON.stringify({ fingerprint: 'f1', content: 'c' }) } }, result: Promise.resolve({ code: 0 }), return: async () => ({ done: true }) }
  const $ = { ...(host.$ as object), process: { spawn: () => answer } } as never
  await fingerprintOf($, '/repo')
  expect(host.timers.length > 0 && host.timers.every(timer => timer.isCancelled)).toBe(true)
})

longTest('a check run for the judgement of an edit cancels its limit when it ends (runCheck)', async () => {
  const host = hostOf()
  await runCheck(host.$, zanity, { cwd: '/repo' }, new Set())
  expect(host.timers.length > 0 && host.timers.every(timer => timer.isCancelled)).toBe(true)
})

const EDIT_SEEN = 'f1'
const FILES_NOW = 'f2'

function waitingEdit() {
  const state = initialState()
  state.tcr = { ...initialTcr(), status: TCR_ACTIVE, settled: 'clean', seen: EDIT_SEEN, unjudged: true }
  return state
}

longTest('files that are no longer the edit that waits, with no editing tool running, stop TCR (keepPending)', async () => {
  const state = waitingEdit()
  keepPending(hostOf().$, state, { tcr: state.tcr, settled: FILES_NOW })
  expect(state.tcr.status).not.toBe(TCR_ACTIVE)
})

longTest('files that changed while an editing tool runs leave TCR on, since its own write may be what changed them (keepPending)', async () => {
  const state = waitingEdit()
  state.tcrEditing.add(Symbol('an editing tool'))
  keepPending(hostOf().$, state, { tcr: state.tcr, settled: FILES_NOW })
  expect(state.tcr.status).toBe(TCR_ACTIVE)
})
