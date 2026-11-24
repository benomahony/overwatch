import { expect } from 'claude-code/testing'
import { bringsInFiles } from '../hooks/gating'
import { queueRevertNotice } from '../hooks/pausing'
import { schedule, send } from '../hooks/delivery'
import { scheduleJudgement } from '../hooks/judgement'
import { holdOffAfterRead } from '../hooks/toolchain'
import { ReadTimeout, rootOf, within } from '../hooks/project'
import { restart } from '../hooks/register'
import { revertNotice } from '../hooks/revert-slots'
import { safeLine, safeName } from '../hooks/safe-text'
import { ask, judgementLimitOf, runCheck, shortCommit } from '../hooks/tcr'
import { failingLine } from '../hooks/watchers'
import { initialState, liveWatcher } from '../hooks/state'
import { CHECKERS, type Watcher } from '../hooks/watchers'
import { turnOfEventLoop } from './fixtures/event-loop'
import { longTest } from './fixtures/tcr-session'

const FLUSH_MS = 1000
const READ_LIMIT_MS = 20_000
const CHUNK = { text: '{"commit":null,"refused":[],"changed":false}\n' }

/** A host whose clock only records the delays it is asked to wait, and whose processes end at once. */
function recordingHost() {
  const delays: number[] = []
  const spawned: string[][] = []
  const child = () => ({
    async *[Symbol.asyncIterator]() { yield CHUNK },
    result: Promise.resolve({ code: 0, signal: null }),
    return: async () => undefined,
  })
  const $ = {
    env: { get: async () => undefined },
    clock: { after: (ms: number, _run: () => void) => { delays.push(ms); return { cancel: () => undefined } }, now: async () => 0, sleep: async () => undefined },
    process: { spawn: ({ argv }: { argv: string[] }) => { spawned.push(argv); return child() } },
    fs: { stat: async () => ({ realPath: '/repo' }), exists: async () => false, read: async () => '' },
    ui: { status: () => undefined, log: () => undefined, toast: () => undefined },
  } as never
  return { $, delays, spawned }
}

const waits = (delays: number[]) => delays.filter(ms => ms >= FLUSH_MS && ms !== READ_LIMIT_MS)
const zanity = CHECKERS.find(({ name }) => name === 'zanity') as Watcher

longTest('a check is stopped after 540000 milliseconds', async () => {
  const host = recordingHost()
  await runCheck(host.$, zanity, { cwd: '/repo' }, new Set())
  expect(host.delays).toEqual([540_000])
})

longTest('a question to the checkpoint command about the files or the reason is stopped after 20000 milliseconds', async () => {
  for (const command of ['fingerprint', 'reason'] as const) {
    const host = recordingHost()
    await ask(host.$, '/repo', command)
    expect({ command, delays: host.delays }).toEqual({ command, delays: [20_000] })
  }
})

longTest('a checkpoint and a revert are stopped after 120000 milliseconds', async () => {
  for (const command of ['checkpoint', 'revert'] as const) {
    const host = recordingHost()
    await ask(host.$, '/repo', command).catch(() => undefined)
    expect({ command, delays: host.delays }).toEqual({ command, delays: [120_000] })
  }
})

longTest('a read of the project\'s files is stopped after 20000 milliseconds and says so in seconds', async () => {
  const delays: number[] = []
  let expire: () => void = () => undefined
  const $ = { env: { get: async () => undefined }, clock: { after: (ms: number, run: () => void) => { delays.push(ms); expire = run; return { cancel: () => undefined } } } } as never
  const reading = within($, () => new Promise<never>(() => undefined)).then(() => undefined, (error: unknown) => error)
  await turnOfEventLoop()
  expire()
  const error = await reading
  expect(delays).toEqual([20_000])
  expect(error).toBeInstanceOf(ReadTimeout)
  expect(String((error as Error).message)).toContain('took longer than 20s')
})

longTest('a whole judgement is stopped after 780000 milliseconds, which is the check, the slower command and six questions', async () => {
  expect(await judgementLimitOf(recordingHost().$)).toBe(780_000)
})

longTest('the judgement of an edit starts 400 milliseconds after it', () => {
  const host = recordingHost()
  const state = initialState()
  state.tcr = { status: 'active', settled: 'a', seen: 'b', unjudged: true, held: undefined }
  scheduleJudgement(host.$, state)
  expect(host.delays).toEqual([400])
})

longTest('a failing test is named up to ten times and the rest are counted', () => {
  const names = Array.from({ length: 12 }, (_, index) => `test${index}`)
  const [line] = failingLine(names)
  expect(line?.match(/`test\d+`/g)?.length).toBe(10)
  expect(line).toContain('and 2 more')
})

longTest('the reverts the agent is not told of are told one by one up to five, and the rest as a count', async () => {
  const state = initialState()
  state.isTurnRunning = true
  const taken: string[] = []
  const $ = { session: { append: async ({ message }: { message: { content: { text: string }[] } }) => { taken.push(message.content[0]?.text ?? '') } }, clock: { after: () => ({ cancel: () => undefined }), sleep: async () => undefined }, ui: { log: () => undefined } } as never
  const keys = Array.from({ length: 8 }, () => queueRevertNotice($, state, revertNotice('overwatch: TCR reverted the latest change', true)))
  expect(keys.slice(0, 5)).toEqual(['tcr:revert:1', 'tcr:revert:2', 'tcr:revert:3', 'tcr:revert:4', 'tcr:revert:5'])
  expect(keys.slice(5)).toEqual([undefined, undefined, undefined])
  await send($, state)
  expect(taken.join('').match(/reverted the latest change/g)?.length).toBe(5)
  expect(taken.join('')).toContain('3 more reverts or attempts after the first 5')
})

longTest('a message the host refuses is sent once more and then given up', async () => {
  const state = initialState()
  state.isTurnRunning = true
  let appends = 0
  const refusing = { session: { append: async () => { appends += 1; throw new Error('the host refused') } }, clock: { after: (_ms: number, run: () => void) => { setTimeout(run, 0); return { cancel: () => undefined } }, sleep: async () => undefined }, ui: { log: () => undefined } } as never
  state.outbox.set('tcr:state', { text: 'overwatch: TCR is on', isWaking: true, kind: 'tcr' })
  schedule(refusing, state)
  for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setTimeout(resolve, 0))
  expect(appends).toBe(2)
})

longTest('a watcher that ends within 30000 milliseconds of its start waits 30000, then 60000, and the third quick exit in a row gives up', async () => {
  const host = recordingHost()
  const state = initialState()
  const live = liveWatcher('zanity:/repo', '/repo')
  state.liveWatchers.push(live)
  live.watcher = zanity
  const quick = { isStarted: true, startedAt: 0, endedAt: 29_999, output: '' }
  await restart(host.$, { state, live, watcher: zanity, ending: quick })
  await restart(host.$, { state, live, watcher: zanity, ending: quick })
  expect(waits(host.delays)).toEqual([30_000, 60_000])
  await restart(host.$, { state, live, watcher: zanity, ending: quick })
  expect(waits(host.delays)).toEqual([30_000, 60_000])
  expect(live.retryAt).toBe(29_999 + 30_000)
  expect(live.quickExits).toBe(3)
})

longTest('a watcher that ran 30000 milliseconds restarts at once and counts no quick exit', async () => {
  const host = recordingHost()
  const state = initialState()
  const live = liveWatcher('zanity:/repo', '/repo')
  state.liveWatchers.push(live)
  live.watcher = zanity
  live.quickExits = 2
  await restart(host.$, { state, live, watcher: zanity, ending: { isStarted: true, startedAt: 0, endedAt: 30_000, output: '' } })
  expect(waits(host.delays)).toEqual([])
  expect(live.quickExits).toBe(0)
})

longTest('a watcher whose read failed waits 30000 milliseconds before it is tried again', async () => {
  const state = initialState()
  const live = liveWatcher('zanity:/repo', '/repo')
  state.liveWatchers.push(live)
  const $ = recordingHost().$
  await holdOffAfterRead($, state, { live, watcher: zanity, epoch: state.epoch }, new ReadTimeout('slow'))
  expect(live.retryAt).toBe(30_000)
})

longTest('a look for the repository that outlasted its limit is remembered for 10000 milliseconds', async () => {
  const stall = { dir: '/repo', at: 0, error: new ReadTimeout('a read took longer than 20s') }
  const asked: string[] = []
  const hostAt = (now: number) => ({ env: { get: async () => undefined }, clock: { now: async () => now, after: () => ({ cancel: () => undefined }) }, fs: { stat: async () => ({ realPath: '/repo' }), exists: async (path: string) => { asked.push(path); return true } } }) as never
  const remembered = await rootOf(hostAt(9_999), '/repo', { rootStall: stall }).then(() => 'asked', () => 'refused')
  const forgotten = await rootOf(hostAt(10_000), '/repo', { rootStall: stall }).then(() => 'asked', () => 'refused')
  expect([remembered, forgotten]).toEqual(['refused', 'asked'])
})

longTest('OVERWATCH_TCR_TIMEOUT_SCALE does not scale the 10000 milliseconds a stalled look is remembered', async () => {
  const stall = { dir: '/repo', at: 0, error: new ReadTimeout('a read took longer than 20s') }
  const hostAt = (now: number) => ({ env: { get: async () => '0.001' }, clock: { now: async () => now, after: () => ({ cancel: () => undefined }) }, fs: { stat: async () => ({ realPath: '/repo' }), exists: async () => true } }) as never
  const remembered = await rootOf(hostAt(9_999), '/repo', { rootStall: stall }).then(() => 'asked', () => 'refused')
  const forgotten = await rootOf(hostAt(10_000), '/repo', { rootStall: stall }).then(() => 'asked', () => 'refused')
  expect([remembered, forgotten]).toEqual(['refused', 'asked'])
})

longTest('a name is cut to 200 characters with three dots, and a line is not cut', () => {
  expect(safeName('n'.repeat(201))).toBe(`${'n'.repeat(197)}...`)
  expect(safeName('n'.repeat(200))).toBe('n'.repeat(200))
  expect(safeLine('n'.repeat(500)).length).toBe(500)
})

longTest('a character is written as an escape of two, four or eight hexadecimal digits by its code', () => {
  expect(safeName('\u0001')).toBe('\\x01')
  expect(safeName('\u007f')).toBe('\\x7f')
  expect(safeName('\u00a0')).toBe('\\xa0')
  expect(safeName('\u2028')).toBe('\\u2028')
  expect(safeName('\u202e')).toBe('\\u202e')
  expect(safeName('\u{e0041}')).toBe('\\U000e0041')
})

longTest('a commit is shortened to 7 characters', () => {
  expect(shortCommit('0123456789abcdef')).toBe('0123456')
})

longTest('a program that prints 25 lines is told by its first line, a marker and its last 20, each cut after 400 characters', async () => {
  const lines = Array.from({ length: 25 }, (_, index) => `line${index}`)
  lines[12] = 'x'.repeat(401)
  const $ = recordingHost().$ as unknown as { process: { spawn: () => unknown } }
  $.process.spawn = () => ({ async *[Symbol.asyncIterator]() { yield { text: `${lines.join('\n')}\n` } }, result: Promise.resolve({ code: 0, signal: null }), return: async () => undefined })
  const message = await ask($ as never, '/repo', 'fingerprint').then(() => '', (error: Error) => error.message)
  expect(message).toContain('line0')
  expect(message).toContain('line24')
  expect(message).toMatch(/line5\b/)
  expect(message).not.toMatch(/line4\b/)
  expect(message).not.toContain('x'.repeat(401))
})

longTest('a shell that holds a shell that holds a pull brings in files, and one more shell does not', () => {
  expect(bringsInFiles('git pull')).toBe(true)
  expect(bringsInFiles("sh -c 'git pull'")).toBe(true)
  expect(bringsInFiles(`sh -c "sh -c 'git pull'"`)).toBe(true)
  expect(bringsInFiles(`sh -c "sh -c \\"sh -c 'git pull'\\""`)).toBe(false)
})
