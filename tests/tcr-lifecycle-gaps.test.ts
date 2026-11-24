import { expect } from 'claude-code/testing'
import { decideTcr } from '../hooks/judgement'
import { pauseOnExpected } from '../hooks/pausing'
import { ReadTimeout, rootOf } from '../hooks/project'
import { rebaselineOnMove, searchAll } from '../hooks/register'
import { announceScale, judgementLimitOf, limitOf, TCR_ACTIVE } from '../hooks/tcr'
import { initialState } from '../hooks/state'
import { turnOfEventLoop } from './fixtures/event-loop'
import { start, tcrProject } from './fixtures/tcr'
import { inSession, beginEdit, personWrites, told, toldPlain, DECIDE_MS, SETTLE_MS, START_MS, longTest, type On } from './fixtures/tcr-session'

const NEVER_MS = 10_000_000
const SCALED_LIMITS = { OVERWATCH_TCR_TIMEOUT_SCALE: '0.004' }
const AFTER_LIMIT_MS = 1900
const REPOSITORY_MARKER = '/repo/.git'
const TOOK_LONGER = 'took longer'
const OUTSIDE_THE_EDITS = 'files changed outside the agent'

function stallingRepository(on: On, wait: () => Promise<unknown>): On {
  return ((name: string, handler: (host: unknown, event: { path?: string }) => unknown) => {
    if (name !== 'fs.exists') return on(name as never, handler as never)
    return on(name as never, ((host: unknown, event: { path?: string }) => (event.path === REPOSITORY_MARKER ? wait() : handler(host, event))) as never)
  }) as On
}

longTest('a look for the repository that outlasts its limit at the start of a session and a turn tells the agent and the log what stopped TCR', async ($, on) => {
  const project = tcrProject(stallingRepository(on, () => project.clock.sleep(NEVER_MS)), { env: SCALED_LIMITS })
  await $.session.start(start)
  await project.clock.advance(START_MS)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await project.clock.advance(AFTER_LIMIT_MS)
  expect(toldPlain(project).some(text => text.includes(TOOK_LONGER))).toBe(true)
})

longTest('a read that finishes while an editing tool runs does not take the tool\'s partial write for a person\'s', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    const running = beginEdit($, project, ['b.py'], 'f2')
    await project.clock.advance(0)
    personWrites(project, 'partial-write-of-running-tool')
    await $.tool.call({ tool: 'Read', file_path: '/repo/a.py' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).some(text => text.includes(OUTSIDE_THE_EDITS))).toBe(false)
    running.end()
    await running.done
    await project.clock.advance(SETTLE_MS)
  })
})

const REASON_OF_A_STALL = TOOK_LONGER

function hostWhoseReadsOutlastTheirLimit() {
  const expired = { after: (_ms: number, run: () => void) => { run(); return { cancel: () => undefined } }, now: async () => 0 }
  const never = () => new Promise<never>(() => undefined)
  return { env: { get: async () => undefined }, clock: expired, fs: { stat: never, exists: never, read: never }, ui: { status: () => undefined, log: () => undefined, toast: () => undefined } } as never
}

function stateInRepository() {
  const state = initialState()
  state.cwd = '/repo'
  return state
}

const UNSURE = 'cannot tell whether this project uses TCR'

const reasonOf = (state: ReturnType<typeof initialState>) => (typeof state.tcr.status === 'object' ? state.tcr.status.reason : String(state.tcr.status))

longTest('the decision about TCR whose look for the repository outlasts its limit stops TCR with the limit', async () => {
  const state = stateInRepository()
  await decideTcr(hostWhoseReadsOutlastTheirLimit(), state)
  expect(reasonOf(state)).toContain(REASON_OF_A_STALL)
})

longTest('the note of a move of HEAD whose look for the repository outlasts its limit stops TCR with the limit', async () => {
  const state = stateInRepository()
  await rebaselineOnMove(hostWhoseReadsOutlastTheirLimit(), state)
  expect(reasonOf(state)).toContain(REASON_OF_A_STALL)
})

longTest('the search for watchers whose look for the repository outlasts its limit stops TCR with the limit', async () => {
  const state = stateInRepository()
  await searchAll(hostWhoseReadsOutlastTheirLimit(), state)
  expect(reasonOf(state)).toContain(REASON_OF_A_STALL)
})

longTest('a failed read stops TCR that is not decided yet, since the read cannot tell whether it runs', () => {
  const state = initialState()
  pauseOnExpected(hostWhoseReadsOutlastTheirLimit(), state, new ReadTimeout('a read took longer than 20s'), state.epoch)
  expect(reasonOf(state)).toContain(REASON_OF_A_STALL)
})

longTest('a failed read of a session that ended stops nothing of the next session', () => {
  const state = initialState()
  const ended = state.epoch
  state.epoch += 1
  pauseOnExpected(hostWhoseReadsOutlastTheirLimit(), state, new ReadTimeout('a read took longer than 20s'), ended)
  expect(state.tcr.status).toBeUndefined()
})

const SCALE_TOAST = 'every TCR limit is multiplied by'

const toastsOf = (project: { toasts: string[] }) => project.toasts.filter(toast => toast.includes(SCALE_TOAST))

longTest('a session whose environment scales the limits tells the user so', async ($, on) => {
  const project = tcrProject(on, { env: { OVERWATCH_TCR_TIMEOUT_SCALE: '0.5' } })
  await $.session.start(start)
  await project.clock.advance(START_MS)
  expect(toastsOf(project).length).toBe(1)
  expect(toastsOf(project)[0]).toContain('0.5')
})

longTest('a session whose environment leaves the limits as they are, or holds no number above zero, tells the user nothing', async ($, on) => {
  const project = tcrProject(on, { env: { OVERWATCH_TCR_TIMEOUT_SCALE: 'many' } })
  await $.session.start(start)
  await project.clock.advance(START_MS)
  expect(toastsOf(project)).toEqual([])
})

const SCALES_THAT_SHOW_A_TOAST: [string, string][] = [['1e308', 'multiplied by 2147483647,'], ['1e-308', 'multiplied by 1e-308,'], ['0.5', 'multiplied by 0.5,']]
const SCALES_THAT_SHOW_NONE = ['NaN', 'Infinity', '-Infinity', '0', '-1', '-1e308', '']

for (const [scale, words] of SCALES_THAT_SHOW_A_TOAST) {
  longTest(`a scale of ${scale} shows one notice that names it as it is used, and tells the agent of no error`, async ($, on) => {
    const project = tcrProject(on, { env: { OVERWATCH_TCR_TIMEOUT_SCALE: scale } })
    await $.session.start(start)
    await project.clock.advance(START_MS)
    expect({ toasts: toastsOf(project).length, named: toastsOf(project).every(toast => toast.includes(words)), told: toldPlain(project).filter(text => text.includes('unexpected error')), logged: project.workspace.logged }).toEqual({ toasts: 1, named: true, told: [], logged: [] })
  })
}

for (const scale of SCALES_THAT_SHOW_NONE) {
  longTest(`a scale of ${JSON.stringify(scale)} changes no limit, shows no notice, and tells the agent of no error`, async ($, on) => {
    const project = tcrProject(on, { env: { OVERWATCH_TCR_TIMEOUT_SCALE: scale } })
    await $.session.start(start)
    await project.clock.advance(START_MS)
    expect({ toasts: toastsOf(project), told: toldPlain(project).filter(text => text.includes('unexpected error')), logged: project.workspace.logged }).toEqual({ toasts: [], told: [], logged: [] })
  })
}

const ASK_THAT_NOTES_THE_FILES = 2
const ASK_THAT_NOTES_THE_MOVE_OF_HEAD = 3

/** The hooks of a host whose search for the repository fails at two asks in a row, the ones the plugin makes after an editing tool ran, once `count.armed` is set; the host reports each failure as the same error of its own, so that two of them in the text tell two failures. */
function throwingAfterTheTool(on: On, count: { armed: boolean; asks: number }): On {
  return ((name: string, handler: (host: unknown, event: { path?: string }) => unknown) => {
    if (name !== 'fs.exists') return on(name as never, handler as never)
    return on(name as never, ((host: unknown, event: { path?: string }) => {
      if (count.armed && event.path === REPOSITORY_MARKER) {
        count.asks += 1
        if (count.asks === ASK_THAT_NOTES_THE_FILES) throw new Error('first')
        if (count.asks === ASK_THAT_NOTES_THE_MOVE_OF_HEAD) throw new Error('second')
      }
      return handler(host, event)
    }) as never)
  }) as On
}

longTest('an editing tool whose note of the files and whose step after it both throw tells the agent of both errors, and the tool returns its result', async ($, on) => {
  const count = { armed: false, asks: 0 }
  const project = tcrProject(throwingAfterTheTool(on, count))
  await $.session.start(start)
  await project.clock.advance(START_MS)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await project.clock.advance(SETTLE_MS)
  count.armed = true
  const result = await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
  count.armed = false
  await project.clock.advance(SETTLE_MS)
  expect({ asks: count.asks, result, told: toldPlain(project).filter(text => text.includes('unexpected error')).map(text => text.replace(/\n[\s\S]*/, '')) }).toEqual({ asks: ASK_THAT_NOTES_THE_MOVE_OF_HEAD, result: { result: 'ok' }, told: ['overwatch hit an unexpected error: AggregateError: HooksError: no implementation for fs.exists; and then HooksError: no implementation for fs.exists; TCR is paused'] })
})

const LOOKS_BEGUN_TOGETHER = 2
const TURNS_FOR_A_LOOK_TO_ASK = 10

longTest('a limit: two looks for the same directory that begin together are not joined, so each asks and each waits its own limit', async () => {
  let asked = 0
  const never = () => new Promise<never>(() => undefined)
  const $ = { env: { get: async () => undefined }, clock: { now: async () => 0, after: () => ({ cancel: () => undefined }) }, fs: { stat: async () => ({ realPath: '/repo' }), exists: () => { asked += 1; return never() } } } as never
  const memory = { rootStall: undefined }
  void rootOf($, '/repo', memory)
  void rootOf($, '/repo', memory)
  for (let turn = 0; turn < TURNS_FOR_A_LOOK_TO_ASK; turn += 1) await turnOfEventLoop()
  expect(asked).toBe(LOOKS_BEGUN_TOGETHER)
})

const PLUGIN_BUG = 'a bug of the plugin after the tool ran'
const TOLD_AS_A_BUG = 'overwatch hit an unexpected error'

longTest('a bug of the plugin after a tool ran does not reject the call that already ran, and tells the agent and the host', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.workspace.existsBug = new Error(PLUGIN_BUG)
    const outcome = await $.tool.call({ tool: 'Read', file_path: '/repo/a.py' }).then(() => 'resolved', () => 'rejected')
    await project.clock.advance(SETTLE_MS)
    expect(outcome).toBe('resolved')
    expect(toldPlain(project).some(text => text.includes(TOLD_AS_A_BUG))).toBe(true)
    expect(project.workspace.logged.some(line => line.includes(TOLD_AS_A_BUG))).toBe(true)
  })
})

function scaledHost(scale: string, toasts: string[] = []) {
  return { env: { get: async () => scale }, ui: { toast: (text: string) => { toasts.push(text) } } } as never
}

longTest('a limit: a scale of 1000000000 leaves no limit longer than 2147483647 milliseconds, the longest a timer waits', async () => {
  expect(await limitOf(scaledHost('1000000000'), 20_000)).toBe(2_147_483_647)
  expect(await judgementLimitOf(scaledHost('1000000000'))).toBe(2_147_483_647)
  expect(await limitOf(scaledHost('1700'), 20_000)).toBe(34_000_000)
  expect(await judgementLimitOf(scaledHost('5000'))).toBe(2_147_483_647)
  expect(await limitOf(scaledHost('2'), 20_000)).toBe(40_000)
})

longTest('a session whose scale would stretch a limit past the longest timer tells the user the scale and that cap', async () => {
  const toasts: string[] = []
  await announceScale(scaledHost('1000000000', toasts), new Set())
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('multiplied by 1000000000')
  expect(toasts[0]).toContain('none is longer than 2147483647ms')
})

longTest('a failed read that stops TCR not decided yet says that overwatch cannot tell whether the project uses TCR, and one that stops TCR that is on does not', () => {
  const undecided = initialState()
  pauseOnExpected(hostWhoseReadsOutlastTheirLimit(), undecided, new ReadTimeout('a read took longer than 20s'), undecided.epoch)
  expect(reasonOf(undecided)).toContain(UNSURE)
  const running = initialState()
  running.tcr = { status: TCR_ACTIVE, settled: 'f0', seen: 'f0', unjudged: false, held: undefined }
  pauseOnExpected(hostWhoseReadsOutlastTheirLimit(), running, new ReadTimeout('a read took longer than 20s'), running.epoch)
  expect(reasonOf(running)).not.toContain(UNSURE)
})

longTest('a session that is not interactive tells the user nothing of a scale, since it starts no TCR', async ($, on) => {
  const project = tcrProject(on, { env: { OVERWATCH_TCR_TIMEOUT_SCALE: '0.5' } })
  await $.session.start({ ...start, isInteractive: false })
  await project.clock.advance(START_MS)
  expect(toastsOf(project)).toEqual([])
})
