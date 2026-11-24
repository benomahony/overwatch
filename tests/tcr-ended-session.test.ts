import { expect } from 'claude-code/testing'
import { ReadTimeout, realPath } from '../hooks/project'
import { holdOffAfterRead } from '../hooks/toolchain'
import { noteHead } from '../hooks/checkpoint-head'
import { noteFilesBefore } from '../hooks/judgement'
import { rebaselineOnMove, stop } from '../hooks/register'
import { TCR_ACTIVE } from '../hooks/tcr'
import { initialState, liveWatcher } from '../hooks/state'
import { CHECKERS, type Watcher } from '../hooks/watchers'
import { WARNINGS, start, tcrProject, type Workspace } from './fixtures/tcr'
import { inSession, told, toldPlain, DECIDE_MS, START_MS, STEP_MS as STEP, longTest, type On, type Project } from './fixtures/tcr-session'

const SETTLED_MS = 1500
const SESSION_END_MS = 50
const CHANGED = 'files changed while TCR was committing'
const NOT_READ = 'git could not read the files'
const REVERT_FAILED = 'the revert in /repo failed after it began to discard the work: git clean failed'
const TCR_ON = 'TCR is on'
const SESSIONS = 2
const REVERT_OPENINGS = ['TCR tried to revert', 'TCR reverted']
const SAVED_REF = 'refs/overwatch/tcr/1'
const ENDED_REVERT_TOAST = `overwatch: a TCR revert was running when its session ended. A copy of the files it may have discarded is saved in ${SAVED_REF}.`

type Window = { name: string; command: 'checkpoint' | 'revert'; hold: { command: string; nth: number }; stale: string; whenEnded: Partial<Workspace>; arrange: (project: Project) => void; atRelease?: (project: Project, isReleased: boolean) => void; saves: number }

const FINGERPRINTS_BEFORE_THE_ACT = 4
const PERSON_COMMITTED = { dirty: [], fingerprint: 'clean' }
const PERSON_CLEANED = { dirty: [] }
const nothing = () => undefined
const WINDOWS: Window[] = [
  { name: 'the files compared before a checkpoint', command: 'checkpoint', hold: { command: 'fingerprint', nth: FINGERPRINTS_BEFORE_THE_ACT }, stale: CHANGED, whenEnded: PERSON_COMMITTED, arrange: nothing, saves: 0 },
  { name: 'the checkpoint command', command: 'checkpoint', hold: { command: 'checkpoint', nth: 1 }, stale: CHANGED, whenEnded: PERSON_COMMITTED, arrange: nothing, saves: 0 },
  { name: 'the files compared after a checkpoint', command: 'checkpoint', hold: { command: 'fingerprint', nth: FINGERPRINTS_BEFORE_THE_ACT + 1 }, stale: CHANGED, whenEnded: PERSON_COMMITTED, arrange: nothing, saves: 0 },
  { name: 'the revert command', command: 'revert', hold: { command: 'revert', nth: 1 }, stale: CHANGED, whenEnded: PERSON_COMMITTED, arrange: nothing, saves: 0 },
  { name: 'the revert command that answers a saved revert', command: 'revert', hold: { command: 'revert', nth: 1 }, stale: CHANGED, whenEnded: PERSON_COMMITTED, arrange: nothing, atRelease: (project, isReleased) => { if (!isReleased) Object.assign(project.workspace, { dirty: ['a.py'], fingerprint: 'f1' }) }, saves: 1 },
  { name: 'the revert command that fails after it began', command: 'revert', hold: { command: 'revert', nth: 1 }, stale: REVERT_FAILED, whenEnded: PERSON_CLEANED, arrange: project => { project.workspace.revertIncomplete = { error: REVERT_FAILED, resets: false, outcome: 'failed' } }, saves: 1 },
  { name: 'the files inspected after a revert', command: 'revert', hold: { command: 'fingerprint', nth: FINGERPRINTS_BEFORE_THE_ACT + 1 }, stale: CHANGED, whenEnded: PERSON_COMMITTED, arrange: nothing, saves: 1 },
  { name: 'the files that cannot be inspected after a revert', command: 'revert', hold: { command: 'fingerprint', nth: FINGERPRINTS_BEFORE_THE_ACT + 1 }, stale: NOT_READ, whenEnded: PERSON_CLEANED, arrange: nothing, atRelease: (project, isReleased) => { project.workspace.fingerprintError = isReleased ? undefined : NOT_READ }, saves: 1 },
]

const askedOf = (project: Project, command: string) => project.workspace.asked.filter(each => each === command).length

for (const { name, command, hold, stale, whenEnded, arrange, atRelease, saves } of WINDOWS) {
  longTest(`${name} that answers after its session ended tells the next session nothing, and a revert tells the user where its work is saved`, async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(DECIDE_MS)
      if (command === 'revert') project.setReport(WARNINGS)
      const nth = askedOf(project, hold.command) + hold.nth
      let release = () => undefined
      project.workspace.holds[`${hold.command}#${nth}`] = new Promise<void>(resolve => { release = resolve })
      arrange(project)
      project.willChange(['a.py'], 'f1')
      await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
      for (let step = 0; step < SETTLED_MS / STEP && askedOf(project, hold.command) < nth; step += 1) await project.clock.advance(STEP)
      expect(askedOf(project, hold.command)).toBe(nth)
      const ending = $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
      await project.clock.advance(SESSION_END_MS)
      await ending
      Object.assign(project.workspace, whenEnded)
      await $.session.start(start)
      await project.clock.advance(START_MS)
      await $.turn.start({ text: 'new session turn', turnId: 't3' })
      await project.clock.advance(START_MS)
      await $.tool.call({ tool: 'Read', file_path: '/repo/b.py' })
      expect(toldPlain(project).filter(text => text.includes(TCR_ON)).length).toBe(SESSIONS)
      atRelease?.(project, false)
      release()
      await project.clock.advance(STEP)
      atRelease?.(project, true)
      await project.clock.advance(SETTLED_MS)
      await $.tool.call({ tool: 'Read', file_path: '/repo/b.py' })
      expect(toldPlain(project).filter(text => text.includes(stale))).toEqual([])
      if (command === 'revert') {
        expect(toldPlain(project).filter(text => REVERT_OPENINGS.some(opening => text.includes(opening)))).toEqual([])
        expect(project.workspace.saved.length).toBe(saves)
        expect(project.toasts.filter(toast => toast.includes(ENDED_REVERT_TOAST)).length).toBe(saves)
      }
    })
  })
}

longTest('a read that fails after its session ended leaves the watcher of the next session watching', async () => {
  const state = initialState()
  const live = liveWatcher('zanity:/repo', '/repo')
  state.liveWatchers.push(live)
  const oldEpoch = state.epoch
  state.epoch += 1
  live.isWatching = true
  const zanity = CHECKERS.find(({ name }) => name === 'zanity') as Watcher
  const $ = { clock: { now: async () => 0 }, ui: { status: () => undefined, log: () => undefined, toast: () => undefined } } as never
  await holdOffAfterRead($, state, { live, watcher: zanity, epoch: oldEpoch }, new ReadTimeout('slow'))
  expect(live.isWatching).toBe(true)
})

const NEVER_MS = 10_000_000
const SCALED_LIMITS = { OVERWATCH_TCR_TIMEOUT_SCALE: '0.004' }
const READ_LIMIT_MS = 80
const AFTER_LIMIT_MS = 2 * READ_LIMIT_MS
const PROGRAM_PATH = '/usr/bin/zanity'
const ASKS_OF_NO_CALL = Number.POSITIVE_INFINITY
const UNEXPECTED = 'unexpected error'
const TOOK_LONGER = 'took longer'

function lastAskOfRound(on: On, state: { asked: number; stallAt: number; stalled: number }): On {
  return ((name: string, handler: (host: unknown, event: { path?: string }) => unknown) => {
    if (name !== 'fs.exists') return on(name as never, handler as never)
    return on(name as never, ((host: unknown, event: { path?: string }) => {
      if (event.path !== PROGRAM_PATH) return handler(host, event)
      state.asked += 1
      if (state.asked !== state.stallAt) return handler(host, event)
      state.stalled += 1
      return new Promise(() => undefined)
    }) as never)
  }) as On
}

longTest('a read of the program path that outlasts its limit while a watcher runs stops TCR with the limit and no unexpected error', async ($, on) => {
  const state = { asked: 0, stallAt: ASKS_OF_NO_CALL, stalled: 0 }
  const project = tcrProject(lastAskOfRound(on, state), { env: SCALED_LIMITS })
  await $.session.start(start)
  await project.clock.advance(START_MS)
  await $.turn.start({ text: 'one', turnId: 't1' })
  await project.clock.advance(START_MS)
  const before = state.asked
  await $.turn.start({ text: 'two', turnId: 't2' })
  await project.clock.advance(START_MS)
  const perRound = state.asked - before
  state.stallAt = state.asked + perRound
  await $.turn.start({ text: 'three', turnId: 't3' })
  await project.clock.advance(START_MS + AFTER_LIMIT_MS)
  expect(state.stalled).toBe(1)
  expect(told(project).some(text => text.includes(UNEXPECTED))).toBe(false)
  expect(told(project).some(text => text.includes(TOOK_LONGER))).toBe(true)
})

longTest('a read of where a path leads that outlasts its limit is not taken for the path itself', async () => {
  const expired = { after: (_ms: number, run: () => void) => { run(); return { cancel: () => undefined } } }
  const $ = { env: { get: async () => undefined }, clock: expired, fs: { stat: () => new Promise(() => undefined) } } as never
  const outcome = await realPath($, PROGRAM_PATH).then(() => undefined, (error: unknown) => error)
  expect(outcome).toBeInstanceOf(ReadTimeout)
})

const OLD_STALL = { dir: '/repo', at: 0, error: new ReadTimeout('a read of the project\'s files took longer than 20s') }

function quietHost() {
  return { ui: { status: () => undefined, log: () => undefined, toast: () => undefined }, clock: { now: async () => 0, after: () => ({ cancel: () => undefined }) } } as never
}

longTest('the end of a session forgets the policy it told', async () => {
  const state = initialState()
  state.policyTold = 'the gate in .overwatch.json cannot be used'
  await stop(quietHost(), state)
  expect(state.policyTold).toBeUndefined()
})

longTest('the end of a session forgets a stalled look for the repository', async () => {
  const state = initialState()
  state.rootStall = OLD_STALL
  await stop(quietHost(), state)
  expect(state.rootStall).toBeUndefined()
})

longTest('a comparison of the files that outlasts its limit after its session ended pauses nothing of the next session', async () => {
  const state = initialState()
  state.cwd = '/repo'
  state.tcr = { status: TCR_ACTIVE, settled: 'f0', seen: 'f0', unjudged: false, held: undefined }
  const timers: (() => void)[] = []
  const $ = {
    env: { get: async () => undefined },
    clock: { now: async () => 0, after: (_ms: number, run: () => void) => { timers.push(run); return { cancel: () => undefined } } },
    fs: { stat: () => new Promise(() => undefined), exists: () => new Promise(() => undefined) },
    ui: { status: () => undefined, log: () => undefined, toast: () => undefined },
  } as never
  const comparing = noteFilesBefore($, state)
  await new Promise(resolve => setTimeout(resolve, 0))
  state.epoch += 1
  state.tcr = { status: TCR_ACTIVE, settled: 'f1', seen: 'f1', unjudged: false, held: undefined }
  timers[0]?.()
  await comparing
  expect(state.tcr.status).toBe(TCR_ACTIVE)
  expect(state.outbox.size).toBe(0)
})

const COMMIT = 'a'.repeat(40)

function hostWithHead() {
  const read = async (path: string) => (path === '/repo/.git/HEAD' ? COMMIT : Promise.reject(new Error('no such file')))
  return { env: { get: async () => undefined }, clock: { now: async () => 0, after: () => ({ cancel: () => undefined }) }, fs: { read, stat: () => Promise.reject(new Error('no such path')) }, ui: { status: () => undefined, log: () => undefined, toast: () => undefined } } as never
}

longTest('the commit a checkpoint made is noted for its session', async () => {
  const state = initialState()
  await noteHead(hostWithHead(), state, { root: '/repo', epoch: state.epoch })
  expect(state.head).toBe(COMMIT)
})

longTest('the commit a checkpoint made after its session ended is not noted for the next session', async () => {
  const state = initialState()
  const ended = state.epoch
  state.epoch += 1
  await noteHead(hostWithHead(), state, { root: '/repo', epoch: ended })
  expect(state.head).toBeUndefined()
})

longTest('a read for the note of a move of HEAD that outlasts its limit after its session ended and the next one turned TCR on neither fails nor pauses the next session', async () => {
  const state = initialState()
  state.cwd = '/repo'
  const timers: (() => void)[] = []
  const $ = {
    env: { get: async () => undefined },
    clock: { now: async () => 0, after: (_ms: number, run: () => void) => { timers.push(run); return { cancel: () => undefined } } },
    fs: { stat: () => new Promise(() => undefined), exists: () => new Promise(() => undefined) },
    ui: { status: () => undefined, log: () => undefined, toast: () => undefined },
  } as never
  const noting = rebaselineOnMove($, state)
  await new Promise(resolve => setTimeout(resolve, 0))
  state.epoch += 1
  state.tcr = { status: TCR_ACTIVE, settled: 'f1', seen: 'f1', unjudged: false, held: undefined }
  timers[0]?.()
  expect(await noting).toBe('none')
  expect(state.tcr.status).toBe(TCR_ACTIVE)
  expect(state.outbox.size).toBe(0)
})

const UNEXPECTED_ERROR = 'overwatch hit an unexpected error'
const LATE_MESSAGE = { text: 'overwatch: TCR reverted the latest change', isWaking: true, kind: 'tcr' as const }

longTest('a message that the work of an ended session queues while its end waits for that work is dropped, so that the next session starts afresh', async () => {
  const state = initialState()
  const live = liveWatcher('zanity:/repo', '/repo')
  live.kill = async () => { state.outbox.set('late', LATE_MESSAGE) }
  state.liveWatchers.push(live)
  await stop(quietHost(), state)
  expect(state.outbox.size).toBe(0)
})

longTest('an error while a session ends does not fail the end of the session, and the log of the host holds the error', async ($, on) => {
  let isFailing = false
  const failingCwd = ((name: string, handler: (host: unknown, event: unknown) => unknown) => {
    if (name !== 'session.cwd') return on(name as never, handler as never)
    return on(name as never, ((host: unknown, event: unknown) => {
      if (isFailing) throw new Error('the host cannot name the directory')
      return handler(host, event)
    }) as never)
  }) as On
  const project = tcrProject(failingCwd)
  await $.session.start(start)
  await project.clock.advance(START_MS)
  isFailing = true
  const ending = $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
  await project.clock.advance(SESSION_END_MS)
  await expect(ending).resolves.toBeDefined()
  expect(project.workspace.logged.filter(line => line.includes(UNEXPECTED_ERROR)).length).toBe(1)
  await $.turn.start({ text: 'after the end', turnId: 't2' })
  await project.clock.advance(START_MS)
  expect(toldPlain(project).filter(text => text.includes(UNEXPECTED_ERROR)).length).toBe(1)
  expect(project.toasts.filter(toast => toast.includes(UNEXPECTED_ERROR))).toEqual([])
})

type Gate = { isArmed: boolean; wait: Promise<void> }

function readingTheClockAfter(on: On, gate: Gate): On {
  return ((name: string, handler: (host: unknown, event: unknown) => unknown) => {
    if (name !== 'clock.now') return on(name as never, handler as never)
    return on(name as never, (async (host: unknown, event: unknown) => {
      if (gate.isArmed) await gate.wait
      return handler(host, event)
    }) as never)
  }) as On
}

longTest('a search of a session that ended while it read the clock starts no watcher in the next', async ($, on) => {
  let open = () => undefined
  const gate = { isArmed: true, wait: new Promise<void>(resolve => { open = resolve }) }
  const project = tcrProject(readingTheClockAfter(on, gate))
  await $.session.start(start)
  await project.clock.advance(START_MS)
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await project.clock.advance(SESSION_END_MS)
  await ending
  gate.isArmed = false
  open()
  await project.clock.advance(SETTLED_MS)
  expect([...project.workspace.started]).toEqual([])
})

longTest('a search that reads the clock late starts the watcher of its own session', async ($, on) => {
  let open = () => undefined
  const gate = { isArmed: true, wait: new Promise<void>(resolve => { open = resolve }) }
  const project = tcrProject(readingTheClockAfter(on, gate))
  await $.session.start(start)
  await project.clock.advance(START_MS)
  gate.isArmed = false
  open()
  await project.clock.advance(SETTLED_MS)
  expect([...project.workspace.started]).toEqual(['zanity'])
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await project.clock.advance(SESSION_END_MS)
  await ending
})
