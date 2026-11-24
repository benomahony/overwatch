import { expect, test } from 'claude-code/testing'
import { guarded, runBoth, tellUnexpected } from '../hooks/boundary'
import { stopForGate } from '../hooks/pausing'
import { revertTcr, stopOverlong } from '../hooks/judgement'
import { HAND_RETRIES, schedule, send } from '../hooks/delivery'
import { initialTcr, TCR_ACTIVE } from '../hooks/tcr'
import type { Judged, State } from '../hooks/state'
import { tcrProject } from './fixtures/tcr'
import { edit, longTest, LONG_TEST_MS, type Project } from './fixtures/tcr-session'
import { FAILED_EXIT, NET_TEST_MS, WORKED_EXIT, expectToldOfRevert, play, type Printed } from './fixtures/tcr-net'
import { turnOfEventLoop } from './fixtures/event-loop'

const EDIT = { root: '/repo', files: 'f1', saveReverted: true }
const SAVED_REF = 'refs/overwatch/reverted/1'
const LIMIT_MS = 3000
const SETTLE_TICKS = 20
const SUMMARY_THAT_IS_NO_TEXT = 7
const WAKING_TCR_MESSAGE = { text: 'overwatch: TCR reverted the latest change', isWaking: true, kind: 'tcr' as const }

/** What the checkpoint command and git print, by the command asked, as a process the host spawns. */
type Answers = { revert?: string; fingerprint?: string; stuckAfterRevert?: boolean; whenReverting?: () => void; whenFingerprinting?: () => void; bugAfterRevert?: boolean }

const spawned = (text: string) => ({
  [Symbol.asyncIterator]: async function* () { yield { stream: 'stdout', text } },
  result: Promise.resolve({ code: 0 }),
  return: async () => ({ done: true }),
})

const stuck = () => ({
  [Symbol.asyncIterator]: async function* () { await new Promise(() => undefined) },
  result: new Promise(() => undefined),
  return: async () => ({ done: true }),
})

function hostOf(answers: Answers, log: string[] = [], toasts: string[] = []) {
  let isReverted = false
  const $ = {
    env: { get: async () => undefined },
    clock: { after: () => ({ cancel: () => undefined }) },
    ui: { log: (text: string) => { log.push(text) }, toast: (text: string) => { toasts.push(text) }, status: () => undefined },
    fs: { write: async () => undefined },
    process: {
      spawn: ({ argv }: { argv: string[] }) => {
        if (argv[0] === 'git') return spawned('')
        const command = argv[2]
        if (command === 'revert') { isReverted = true; answers.whenReverting?.() }
        if (command === 'fingerprint') answers.whenFingerprinting?.()
        if (command === 'fingerprint' && isReverted && answers.bugAfterRevert) throw new TypeError('a bug of the host')
        if (command === 'fingerprint' && isReverted && answers.stuckAfterRevert) return stuck()
        if (command === 'revert') return spawned(answers.revert ?? JSON.stringify({ reverted: true, reset: 'done', saved: SAVED_REF }))
        return spawned(answers.fingerprint ?? JSON.stringify({ fingerprint: 'f1', content: 'c' }))
      },
    },
  }
  return $ as never
}

function stateOf(): State {
  const tcr = { ...initialTcr(), status: TCR_ACTIVE, settled: 'clean', seen: 'f1', unjudged: true }
  return { epoch: 0, tcr, tcrTicket: 1, tcrHeld: new Set<string>(), tcrKills: new Set(), tcrTimer: undefined, outbox: new Map(), liveWatchers: [], flushing: undefined, isTurnRunning: false, isPromptQueued: false, isToldThisTurn: false } as unknown as State
}

const failing = (summary: string): Judged[] => [{
  live: { key: 'zanity', dir: '/repo', baseline: undefined, watcher: { name: 'zanity', marker: 'zanity', baseline: ['zanity'] } },
  report: { summary, isFailed: true, text: 'output', failures: [] },
} as unknown as Judged]

const settled = async () => { for (let tick = 0; tick < SETTLE_TICKS; tick += 1) await turnOfEventLoop() }

const waiting = (state: State) => [...state.outbox.values()].map(({ text }) => text)

longTest('a bug in building the notice of a revert that was asked still tells the agent TCR tried to revert, and pauses TCR', async () => {
  const state = stateOf()
  const log: string[] = []
  await expect(revertTcr(hostOf({}, log), state, EDIT, failing(SUMMARY_THAT_IS_NO_TEXT as never))).rejects.toThrow('a line is number, not text')
  expect(waiting(state).filter(text => text.includes('TCR tried to revert'))).toHaveLength(1)
  expect(state.tcr.status).not.toBe(TCR_ACTIVE)
})

longTest('a judgement stopped at its limit while a revert was asked says so, with the ref that holds the work', async () => {
  const state = stateOf()
  const started = { epoch: 0, tcr: state.tcr, ticket: 1 }
  const host = hostOf({ stuckAfterRevert: true })
  void revertTcr(host, state, EDIT, failing('failed'))
  await settled()
  await stopOverlong(host, state, { started, root: '/repo' }, LIMIT_MS)
  expect(waiting(state).join('\n')).toContain(`took longer than 3s; a revert was asked; the work is saved in ${SAVED_REF}`)
})

longTest('a judgement stopped at its limit with a held edit keeps the edit held', async () => {
  const state = stateOf()
  state.tcrHeld.add('zanity')
  const started = { epoch: 0, tcr: state.tcr, ticket: 1 }
  await stopOverlong(hostOf({}), state, { started, root: '/repo' }, LIMIT_MS)
  expect(state.tcr.held).toBe('f1:c')
})

longTest('a notice the host does not take is kept for the next try', async () => {
  const state = stateOf()
  state.isTurnRunning = true
  state.outbox.set('tcr:revert', WAKING_TCR_MESSAGE)
  let attempts = 0
  const $ = { session: { append: async () => { attempts += 1; if (attempts === 1) throw new Error('the host refused') } }, ui: { log: () => undefined } } as never
  await expect(send($, state)).rejects.toThrow('the host refused')
  expect([...state.outbox.keys()]).toEqual(['tcr:revert'])
  await send($, state)
  expect(attempts).toBe(2)
  expect(state.outbox.size).toBe(0)
})

/** A host whose append fails `failures` times, then takes the message; the timers the plugin asks for wait in `timers`. */
function refusing(failures: number) {
  const taken: string[] = []
  const timers: (() => void)[] = []
  let attempts = 0
  const $ = {
    session: { append: async ({ message }: { message: { content: { text: string }[] } }) => { attempts += 1; if (attempts <= failures) throw new Error('the host refused'); taken.push(message.content[0]?.text ?? '') } },
    clock: { after: (_ms: number, run: () => void) => { timers.push(run); return { cancel: () => undefined } }, sleep: async () => undefined },
    ui: { log: () => undefined },
  } as never
  return { $, taken, attempts: () => attempts, timers }
}

longTest('a notice the host refuses once, with nothing else queued after it, reaches the agent without another message', async () => {
  const state = stateOf()
  state.isTurnRunning = true
  state.outbox.set('tcr:revert', WAKING_TCR_MESSAGE)
  const host = refusing(1)
  schedule(host.$, state)
  for (const run of host.timers.splice(0)) run()
  await settled()
  expect(host.taken.length).toBe(1)
  expect(state.outbox.size).toBe(0)
})

longTest('a host that refuses a notice for ever is asked once more and then left alone', async () => {
  const state = stateOf()
  state.isTurnRunning = true
  state.outbox.set('tcr:revert', WAKING_TCR_MESSAGE)
  const host = refusing(Number.POSITIVE_INFINITY)
  schedule(host.$, state)
  for (let round = 0; round < HAND_RETRIES + 3; round += 1) {
    for (const run of host.timers.splice(0)) run()
    await settled()
  }
  expect({ attempts: host.attempts(), waiting: state.outbox.size, timers: host.timers.length }).toEqual({ attempts: HAND_RETRIES + 1, waiting: 1, timers: 0 })
})

const FAILED_REVERT = JSON.stringify({ error: 'git clean failed', saved: SAVED_REF, reset: 'failed' })

longTest('a revert that breaks after its session ended, and breaks again as it is told, queues no notice for the next session and pauses nothing of it, and tells the user the ref', async () => {
  const state = stateOf()
  const toasts: string[] = []
  const newSession = () => {
    state.epoch += 1
    state.tcr = { ...initialTcr(), status: TCR_ACTIVE, settled: 'f9', seen: 'f9', unjudged: false }
  }
  const host = hostOf({ revert: FAILED_REVERT, bugAfterRevert: true, whenReverting: newSession }, [], toasts)
  await expect(revertTcr(host, state, EDIT, failing('failed'))).rejects.toThrow('a bug of the host')
  expect(waiting(state)).toEqual([])
  expect(state.tcr.status).toBe(TCR_ACTIVE)
  expect(toasts.filter(text => text.includes(SAVED_REF)).length).toBe(1)
})

longTest('a revert that breaks after its command was asked, run through the boundary of its entry, tells the agent in the notice of the revert alone, with no second notice of the error', async () => {
  const state = stateOf()
  const host = hostOf({ revert: FAILED_REVERT, bugAfterRevert: true })
  await expect(guarded(host, state, () => revertTcr(host, state, EDIT, failing('failed')))).rejects.toThrow('a bug of the host')
  expect([...state.outbox.keys()]).toEqual(['tcr:revert:1', 'tcr:state'])
})

longTest('a revert that breaks as it is told, in the session that asked it, queues the notice and pauses TCR', async () => {
  const state = stateOf()
  const log: string[] = []
  const host = hostOf({ revert: FAILED_REVERT, bugAfterRevert: true }, log)
  await expect(revertTcr(host, state, EDIT, failing('failed'))).rejects.toThrow('a bug of the host')
  expect(waiting(state).filter(text => text.includes('TCR tried to revert')).length).toBe(1)
  expect(state.tcr.status).not.toBe(TCR_ACTIVE)
  expect(log.filter(line => line.includes('a bug of the host') && line.includes('while telling the revert as one whose reset is not known'))).toHaveLength(1)
})

longTest('a notice the host refuses is not offered again once the session ended while the plugin waited to try again', async () => {
  const state = stateOf()
  state.isTurnRunning = true
  state.outbox.set('tcr:revert', WAKING_TCR_MESSAGE)
  const timers: (() => void)[] = []
  let attempts = 0
  const $ = {
    session: { append: async () => { attempts += 1; throw new Error('the host refused') } },
    clock: { after: (_ms: number, run: () => void) => { timers.push(run); return { cancel: () => undefined } }, sleep: async () => { state.epoch += 1 } },
    ui: { log: () => undefined },
  } as never
  schedule($, state)
  for (const run of timers.splice(0)) run()
  await settled()
  expect(attempts).toBe(1)
})

const unexpectedOf = (state: State) => [...state.outbox.values()].map(({ text }) => text).filter(text => text.includes('unexpected error'))

longTest('when the part that runs first and the part that runs after it both throw, the agent is told of both', async () => {
  const state = stateOf()
  const both = guarded(hostOf({}), state, () => runBoth(hostOf({}), state, { before: async () => { throw new Error('first') }, after: async () => { throw new Error('second') } }))
  await expect(both).rejects.toThrow('Error: first; and then Error: second')
  expect(unexpectedOf(state)).toEqual(['overwatch hit an unexpected error: AggregateError: Error: first; and then Error: second; TCR is paused'])
})

longTest('when only the part that runs first throws, its error goes on, and the part after it ran', async () => {
  const state = stateOf()
  let hasRun = false
  await expect(runBoth(hostOf({}), state, { before: async () => { throw new Error('first') }, after: async () => { hasRun = true } })).rejects.toThrow('first')
  expect({ hasRun, told: unexpectedOf(state) }).toEqual({ hasRun: true, told: [] })
})

longTest('when only the part that runs after throws, its error goes on, and nothing is told of the first', async () => {
  const state = stateOf()
  await expect(runBoth(hostOf({}), state, { before: async () => undefined, after: async () => { throw new Error('second') } })).rejects.toThrow('second')
  expect(unexpectedOf(state)).toEqual([])
})

const FAILING_REVERT = JSON.stringify({ reverted: true, reset: 'done', saved: SAVED_REF, error: 'it broke' })
const MOST_REVERT_NOTICES = 5

longTest('a revert command that fails after it began pauses TCR with the failure it gave, and does not throw', async () => {
  const state = stateOf()
  await revertTcr(hostOf({ revert: FAILING_REVERT }), state, EDIT, failing('failed'))
  expect({ isActive: state.tcr.status === TCR_ACTIVE, told: waiting(state).filter(text => text.includes('it broke')).length > 0 }).toEqual({ isActive: false, told: true })
})

longTest('the notice of a revert that failed after it began counts the copy it saved, past the notices that wait each on its own', async () => {
  const state = stateOf()
  for (let attempt = 0; attempt <= MOST_REVERT_NOTICES; attempt += 1) {
    state.tcr = { ...initialTcr(), status: TCR_ACTIVE, settled: 'clean', seen: 'f1', unjudged: true }
    await revertTcr(hostOf({ revert: FAILING_REVERT }), state, EDIT, failing('failed'))
  }
  expect(waiting(state).filter(text => text.includes('1 of them saved a copy'))).toHaveLength(1)
})

const PLUGIN_BUG = 'a bug of the plugin'
const TOLD_AS_A_BUG = `overwatch hit an unexpected error: TypeError: ${PLUGIN_BUG}`
const OLD_SESSION = 1
const NEW_SESSION = 2

longTest('an error that reaches the entry of a session that ended is shown to the user as a toast, and tells the session that follows nothing and stops nothing of it', async () => {
  const state = stateOf()
  state.epoch = NEW_SESSION
  const toasts: string[] = []
  const text = tellUnexpected(hostOf({}, [], toasts), state, new TypeError(PLUGIN_BUG), OLD_SESSION)
  expect({ text, toasts, waiting: waiting(state), isActive: state.tcr.status === TCR_ACTIVE }).toEqual({ text: TOLD_AS_A_BUG, toasts: [`${TOLD_AS_A_BUG}, in a session that had ended`], waiting: [], isActive: true })
})

const ORDERS = [
  { name: 'then', sessions: [OLD_SESSION, NEW_SESSION, NEW_SESSION] },
  { name: 'after the entry of the session that follows, and then', sessions: [NEW_SESSION, OLD_SESSION, NEW_SESSION] },
]

for (const { name, sessions } of ORDERS) {
  longTest(`an error that reaches the entry of a session that ended ${name} the entry of the session that follows is shown as a toast once, and tells the new session once and pauses its TCR`, async () => {
    const state = stateOf()
    state.epoch = NEW_SESSION
    const toasts: string[] = []
    const host = hostOf({}, [], toasts)
    const error = new TypeError(PLUGIN_BUG)
    for (const session of sessions) tellUnexpected(host, state, error, session)
    expect({ toasts: toasts.length, told: unexpectedOf(state), isActive: state.tcr.status === TCR_ACTIVE }).toEqual({ toasts: 1, told: [`${TOLD_AS_A_BUG}; TCR is paused`], isActive: false })
  })
}

longTest('a search that began in a session that ended and fails with a bug of the plugin while the judgement of the next session waits for it tells the next session and pauses its TCR', async () => {
  const state = stateOf()
  state.epoch = NEW_SESSION
  const toasts: string[] = []
  const host = hostOf({}, [], toasts)
  const search = Promise.reject(new TypeError(PLUGIN_BUG))
  state.discovering = search.then(() => undefined)
  const oldEntry = guarded(host, state, () => state.discovering, OLD_SESSION).catch(() => undefined)
  const newEntry = guarded(host, state, () => state.discovering, NEW_SESSION).catch(() => undefined)
  await Promise.all([oldEntry, newEntry])
  expect({ toasts: toasts.length, told: unexpectedOf(state), isActive: state.tcr.status === TCR_ACTIVE }).toEqual({ toasts: 1, told: [`${TOLD_AS_A_BUG}; TCR is paused`], isActive: false })
})

longTest('an error that an entry throws after a newer session began is shown to the user as a toast, and tells the newer session nothing and stops nothing of it', async () => {
  const state = stateOf()
  const toasts: string[] = []
  const host = hostOf({}, [], toasts)
  const entry = guarded(host, state, async () => {
    state.epoch = NEW_SESSION
    throw new TypeError(PLUGIN_BUG)
  })
  await expect(entry).rejects.toThrow(PLUGIN_BUG)
  expect({ toasts, told: unexpectedOf(state), isActive: state.tcr.status === TCR_ACTIVE }).toEqual({ toasts: [`${TOLD_AS_A_BUG}, in a session that had ended`], told: [], isActive: true })
})

longTest('a gate that cannot be used, found while the files of a held edit are compared as the session ends, stops nothing of the session that follows', async () => {
  const state = stateOf()
  state.tcrHeld.add('zanity')
  const newSession = () => {
    state.epoch += 1
    state.tcr = { ...initialTcr(), status: TCR_ACTIVE, settled: 'f9', seen: 'f9', unjudged: false }
  }
  await stopForGate(hostOf({ whenFingerprinting: newSession }), state, { root: '/repo' })
  expect({ isActive: state.tcr.status === TCR_ACTIVE, waiting: waiting(state) }).toEqual({ isActive: true, waiting: [] })
})

longTest('a gate that cannot be used, found while the files of a held edit are compared, stops TCR and records the files of the edit', async () => {
  const state = stateOf()
  state.tcrHeld.add('zanity')
  await stopForGate(hostOf({}), state, { root: '/repo' })
  expect({ isActive: state.tcr.status === TCR_ACTIVE, held: state.tcr.held, told: waiting(state).length }).toEqual({ isActive: false, held: 'f1:c', told: 1 })
})

const HUGE_CHARACTERS = 1_000_000
const REPLACEMENT = '�'

const printing = (code: number, over: Record<string, unknown>): Printed => answer => ({ code, text: JSON.stringify({ ...answer, ...over }) })

/** An answer of the revert command, how many steps the plugin makes after it spawned the command, and whether the plugin can learn the ref from it and whether it fails the revert by design. */
type Shape = { name: string; steps: number; opening: 'done' | 'tried'; as?: Record<string, unknown>; prints?: Printed; names: boolean; isFailing: boolean }

const SHAPES: Shape[] = [
  { name: 'an answer that is right', steps: 4, opening: 'done', names: true, isFailing: false },
  { name: 'a JSON array and exit 0', steps: 4, opening: 'tried', prints: () => ({ code: WORKED_EXIT, text: '[]' }), names: false, isFailing: true },
  { name: 'a JSON array and exit 1', steps: 4, opening: 'tried', prints: () => ({ code: FAILED_EXIT, text: '[]' }), names: false, isFailing: true },
  { name: 'exit 0 with an error field', steps: 4, opening: 'done', prints: printing(WORKED_EXIT, { error: 'it broke' }), names: true, isFailing: true },
  { name: 'exit 1 with an empty ref', steps: 4, opening: 'done', prints: printing(FAILED_EXIT, { error: 'it broke', saved: '' }), names: false, isFailing: true },
  { name: 'exit 1 with the ref as a number', steps: 4, opening: 'done', prints: printing(FAILED_EXIT, { error: 'it broke', saved: 7 }), names: false, isFailing: true },
  { name: 'reverted given as text', steps: 4, opening: 'done', as: { reverted: 'true' }, names: true, isFailing: true },
  { name: 'reverted false with a done reset and a ref', steps: 4, opening: 'done', as: { reverted: false }, names: true, isFailing: true },
  { name: 'empty output', steps: 3, opening: 'tried', prints: () => ({ code: WORKED_EXIT, text: '' }), names: false, isFailing: true },
  { name: 'two lines of JSON', steps: 4, opening: 'tried', prints: answer => ({ code: WORKED_EXIT, text: `${JSON.stringify(answer)}\n${JSON.stringify(answer)}\n` }), names: false, isFailing: true },
  { name: 'output that is no UTF-8 text', steps: 4, opening: 'tried', prints: () => ({ code: FAILED_EXIT, text: `${REPLACEMENT}${REPLACEMENT}{` }), names: false, isFailing: true },
  { name: 'output of a million characters', steps: 4, opening: 'tried', prints: () => ({ code: FAILED_EXIT, text: 'x'.repeat(HUGE_CHARACTERS) }), names: false, isFailing: true },
]

const prepared = (shape: Shape) => (project: Project) => {
  project.workspace.revertAs = shape.as
  project.workspace.revertPrints = shape.prints
}

/**
 * The class check of the revert path for host throws, which `steppingSpawn` turns into failures of the command, so that the
 * plugin's own boundary, `revertTcr`, is pinned by the tests above: for each answer the command can print, the host throws at each step the plugin makes
 * after it spawned the revert command, and in every run the tree was reverted, the agent is told a revert with the ref it
 * could learn, TCR is paused, and nothing but the thrown error is left unhandled, at most once.
 */
for (const shape of SHAPES) {
  test(`${shape.name}: host throws during revert are told as failures of the command, at any step after it was spawned: the agent is told of the revert, and TCR is paused`, { timeoutMs: NET_TEST_MS + LONG_TEST_MS }, async ($, on) => {
    const project = tcrProject(on)
    const entry = (current: Project) => edit($, current, ['a.py'], 'f1')
    const base = { $, project, prepare: prepared(shape), entry }
    const plain = await play({ ...base, throwAt: undefined })
    expectToldOfRevert(plain, { throwAt: undefined, names: shape.names, isFailing: shape.isFailing, opening: shape.opening })
    expect({ shape: shape.name, reverted: plain.project.workspace.reverted.length, isSpawned: Number.isFinite(plain.revertStep) }).toEqual({ shape: shape.name, reverted: 1, isSpawned: true })
    const stepsAfterTheRevert = plain.steps.length - plain.revertStep
    expect({ shape: shape.name, stepsAfterTheRevert }).toEqual({ shape: shape.name, stepsAfterTheRevert: shape.steps })
    let played = 0
    for (let throwAt = plain.revertStep + 1; throwAt <= plain.steps.length; throwAt += 1) {
      expectToldOfRevert(await play({ ...base, throwAt }), { throwAt, names: shape.names, isFailing: shape.isFailing, opening: shape.opening })
      played += 1
    }
    expect({ shape: shape.name, played }).toEqual({ shape: shape.name, played: stepsAfterTheRevert })
  })
}
