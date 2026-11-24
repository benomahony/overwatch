import { expect } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { CommandError, announceScale, announceUnreadable, limitOf, runCheck } from '../hooks/tcr'
import { WARNINGS, start, tcrProject } from './fixtures/tcr'
import { edit, told, SETTLE_MS, END_MS, DECIDE_MS, longTest } from './fixtures/tcr-session'

const REFUSED_ENVIRONMENT = 'the environment is closed to this plugin'
const DEFAULT_LIMIT_MS = 1000
const announcedIn = () => new Set<string>()

function hostWhoseEnvironmentFails(failure: Error, toasts: string[]): EngineInterface {
  return { env: { get: async () => { throw failure } }, ui: { toast: (text: string) => { toasts.push(text) } } } as unknown as EngineInterface
}

longTest('an environment that cannot be read as an expected failure keeps every limit at its default length and tells the user once', async () => {
  const toasts: string[] = []
  const engine = hostWhoseEnvironmentFails(new CommandError(REFUSED_ENVIRONMENT), toasts)
  await expect(limitOf(engine, DEFAULT_LIMIT_MS)).resolves.toBe(DEFAULT_LIMIT_MS)
  const announced = announcedIn()
  await announceScale(engine, announced)
  await announceScale(engine, announced)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain(REFUSED_ENVIRONMENT)
  expect(toasts[0]).toContain('OVERWATCH_TCR_TIMEOUT_SCALE could not be read')
  expect(toasts[0]).toContain('every TCR limit keeps its default length')
})

function hostWhoseRefusalChanges(toasts: string[]): EngineInterface {
  let reads = 0
  return { env: { get: async () => { reads += 1; throw new CommandError(`${REFUSED_ENVIRONMENT} for the ${reads}th time`) } }, ui: { toast: (text: string) => { toasts.push(text) } } } as unknown as EngineInterface
}

longTest('a variable whose refusal reads differently each time is told once for each session, by the name of the variable', async () => {
  const toasts: string[] = []
  const engine = hostWhoseRefusalChanges(toasts)
  const announced = announcedIn()
  for (let round = 0; round < 3; round += 1) {
    await announceScale(engine, announced)
    await announceUnreadable(engine, announced)
  }
  expect(toasts.filter(text => text.includes('OVERWATCH_TCR_TIMEOUT_SCALE could not be read')).length).toBe(1)
  expect(toasts.filter(text => text.includes('PATH could not be read')).length).toBe(1)
  expect(toasts.filter(text => text.includes('HOME could not be read')).length).toBe(1)
})

longTest('a refusal of the host, which names itself a HooksError, is an expected failure of the environment read as a CommandError is', async () => {
  const refusal = new Error(REFUSED_ENVIRONMENT)
  refusal.name = 'HooksError'
  const toasts: string[] = []
  const engine = hostWhoseEnvironmentFails(refusal, toasts)
  await expect(limitOf(engine, DEFAULT_LIMIT_MS)).resolves.toBe(DEFAULT_LIMIT_MS)
  await announceScale(engine, announcedIn())
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain(REFUSED_ENVIRONMENT)
})

longTest('a bug while the environment is read is not hidden behind the default limit', async () => {
  const bug = new TypeError('a bug in the plugin')
  const toasts: string[] = []
  const engine = hostWhoseEnvironmentFails(bug, toasts)
  await expect(limitOf(engine, DEFAULT_LIMIT_MS)).rejects.toBe(bug)
  await expect(announceScale(engine, announcedIn())).rejects.toBe(bug)
  expect(toasts).toEqual([])
})

const ENVIRONMENT_NOTICE = 'OVERWATCH_TCR_TIMEOUT_SCALE could not be read'

/** A host answers a refused read of the environment with an error of its own, not with the CommandError of a failed command. */
longTest('an environment the host refuses to read keeps the default limits, tells the user once, and TCR still reverts a new failure and tells the agent', async ($, on) => {
  const project = tcrProject(on, { scaleRead: { deny: REFUSED_ENVIRONMENT } })
  await $.session.start(start)
  await project.clock.advance(SETTLE_MS)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await project.clock.advance(DECIDE_MS)
  project.setReport(WARNINGS)
  await edit($, project, ['a.py'], 'f1')
  await $.turn.start({ text: 'again', turnId: 't2' })
  await project.clock.advance(SETTLE_MS)
  expect(project.workspace.reverted).toEqual([['a.py']])
  expect(told(project).filter(text => text.includes('TCR reverted') && text.includes('29 warnings')).length).toBe(1)
  expect(told(project).filter(text => text.includes('unexpected error'))).toEqual([])
  expect(project.toasts.filter(text => text.includes(ENVIRONMENT_NOTICE)).length).toBe(1)
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await project.clock.advance(END_MS)
  await ending
})

longTest('an environment the host refuses to read does not stop the checks from telling a new failure when TCR is off', async ($, on) => {
  const project = tcrProject(on, { scaleRead: { deny: REFUSED_ENVIRONMENT }, settings: {} })
  await $.session.start(start)
  await project.clock.advance(SETTLE_MS)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await project.clock.advance(DECIDE_MS)
  project.setReport(WARNINGS)
  await edit($, project, ['a.py'], 'f1')
  expect(told(project).filter(text => text.includes('29 warnings')).length).toBe(1)
  expect(told(project).filter(text => text.includes('unexpected error'))).toEqual([])
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await project.clock.advance(END_MS)
  await ending
})

const TICK_REAL_MS = 5
const STOP_REFUSED_AT_LIMIT = 'the host refused to stop the check at its limit'

longTest('a check that cannot be stopped when it outlasts its limit has the rejection of that stop handled, and written to the debug log', async () => {
  const logs: string[] = []
  const refused = Promise.reject(new Error(STOP_REFUSED_AT_LIMIT))
  let isHandled = false
  const attach = refused.then.bind(refused)
  Object.defineProperty(refused, 'then', { value: (onFulfilled: Parameters<typeof attach>[0], onRejected: Parameters<typeof attach>[1]) => { isHandled = true; return attach(onFulfilled, onRejected) } })
  const child = {
    return: () => refused,
    result: Promise.resolve({ code: 0, signal: null }),
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<{ done: true; value: undefined }>(resolve => setTimeout(() => resolve({ done: true, value: undefined }), TICK_REAL_MS)) }),
  }
  const engine = {
    env: { get: async () => undefined },
    clock: { after: (_ms: number, callback: () => void) => { void Promise.resolve().then(callback); return { cancel: () => undefined } } },
    process: { spawn: () => child },
    ui: { log: (text: string) => { logs.push(text) } },
  } as unknown as EngineInterface
  const watcher = { name: 'zanity', marker: 'zanity', argv: ['zanity'] } as never
  const report = await runCheck(engine, watcher, { cwd: '/repo' }, new Set())
  await new Promise(resolve => setTimeout(resolve, TICK_REAL_MS * 2))
  expect(report).toBeUndefined()
  expect(isHandled).toBe(true)
  expect(logs.filter(text => text.includes(STOP_REFUSED_AT_LIMIT)).length).toBe(1)
})

const RESUMED = { reason: 'resume' as const, sessionId: 's1', resume: { id: 's1' } }

longTest('a session the host resumes is not told again that the environment could not be read', async ($, on) => {
  const project = tcrProject(on, { scaleRead: { deny: REFUSED_ENVIRONMENT } })
  await $.session.start(start)
  await project.clock.advance(SETTLE_MS)
  const ending = $.session.end(RESUMED)
  await project.clock.advance(END_MS)
  await ending
  await $.session.start(start)
  await project.clock.advance(SETTLE_MS)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await project.clock.advance(DECIDE_MS)
  expect(project.toasts.filter(text => text.includes(ENVIRONMENT_NOTICE)).length).toBe(1)
  const last = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await project.clock.advance(END_MS)
  await last
})

longTest('a project that does not use TCR is not told that every TCR limit keeps its default length', async ($, on) => {
  const project = tcrProject(on, { scaleRead: { deny: REFUSED_ENVIRONMENT }, settings: {} })
  await $.session.start(start)
  await project.clock.advance(SETTLE_MS)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await project.clock.advance(DECIDE_MS)
  expect(project.toasts.filter(text => text.includes('TCR limit'))).toEqual([])
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await project.clock.advance(END_MS)
  await ending
})

longTest('a PATH the host refuses is told as that, to the user and to the agent, and not as a project with no checks', async ($, on) => {
  const project = tcrProject(on, { scaleRead: { deny: REFUSED_ENVIRONMENT, names: ['PATH'] } })
  await $.session.start(start)
  await project.clock.advance(SETTLE_MS)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await project.clock.advance(DECIDE_MS)
  await edit($, project, ['a.py'], 'f1')
  const agent = told(project).join('\n')
  expect(project.toasts.filter(text => text.includes('PATH could not be read') && text.includes('may not find the checks')).length).toBe(1)
  expect(project.toasts.filter(text => text.includes('TCR limit'))).toEqual([])
  expect(agent).toContain('PATH could not be read')
  expect(agent).not.toContain('no checks are configured')
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await project.clock.advance(END_MS)
  await ending
})

longTest('a HOME the host refuses is told to the user as that, naming HOME and not the limits of TCR', async ($, on) => {
  const project = tcrProject(on, { scaleRead: { deny: REFUSED_ENVIRONMENT, names: ['HOME'] } })
  await $.session.start(start)
  await project.clock.advance(SETTLE_MS)
  expect(project.toasts.filter(text => text.includes('HOME could not be read') && text.includes('not saved')).length).toBe(1)
  expect(project.toasts.filter(text => text.includes('TCR limit'))).toEqual([])
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await project.clock.advance(END_MS)
  await ending
})
