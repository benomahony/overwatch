import { expect } from 'claude-code/testing'
import { background } from '../hooks/boundary'
import { noteBranch } from '../hooks/deciding'
import { ReadTimeout } from '../hooks/project'
import { rebaselineOnMove, searchAll } from '../hooks/register'
import { TCR_ACTIVE } from '../hooks/tcr'
import { holdOffAfterRead } from '../hooks/toolchain'
import { initialState, liveWatcher, type State } from '../hooks/state'
import { CHECKERS, type Watcher } from '../hooks/watchers'
import { turnOfEventLoop } from './fixtures/event-loop'
import { longTest } from './fixtures/tcr-session'

const SLOW = 'a read of the project\'s files took longer than its limit'
const UNEXPECTED = 'overwatch hit an unexpected error'
const NO_FILE_ERROR = 'TypeError'
const BUG = 'a bug in the look for the repository'
const SETTLE_TICKS = 5

type Site = { name: string; isLookForRepositoryTripped: boolean; run: ($: never, state: State) => Promise<unknown> }

const SITES: Site[] = [
  { name: 'the search for the checks (findIn)', isLookForRepositoryTripped: true, run: ($, state) => searchAll($, state) },
  { name: 'the look for the branch (noteBranch)', isLookForRepositoryTripped: false, run: ($, state) => noteBranch($, state, '/repo') },
  { name: 'the look for the move of HEAD (rebaselineOnMove)', isLookForRepositoryTripped: false, run: ($, state) => rebaselineOnMove($, state) },
]

/** A host whose repository exists and whose every read of a file gives `answer`: a failure that is thrown, or a value no file holds, which only a bug of the plugin can trip on. It records what the plugin wrote to the log. */
function failingHost(answer: Error | null, isRepositoryTripped: boolean) {
  const logs: { message: string; to: string | undefined }[] = []
  const $ = {
    env: { get: async () => '/usr/bin' },
    clock: { after: () => ({ cancel: () => undefined }), now: async () => 0 },
    ui: { log: (message: string, options?: { to?: string }) => { logs.push({ message, to: options?.to }) }, status: () => undefined },
    fs: { exists: async (path: string) => { if (isRepositoryTripped) throw new TypeError(BUG); return path === '/repo/.git' }, stat: () => Promise.reject(new Error('no stat')), list: async () => [], read: async () => { if (answer !== null) throw answer; return null } },
  } as never
  return { $, logs }
}

async function played({ run, isLookForRepositoryTripped }: Site, answer: Error | null) {
  const state = initialState()
  state.cwd = '/repo'
  state.tcr = { status: TCR_ACTIVE, settled: undefined, seen: undefined, unjudged: false, held: undefined }
  const host = failingHost(answer, answer === null && isLookForRepositoryTripped)
  background(host.$, state, () => run(host.$, state))
  for (let tick = 0; tick < SETTLE_TICKS; tick += 1) await turnOfEventLoop()
  const waiting = [...state.outbox.entries()].map(([key, { text }]) => `${key}: ${text}`)
  return { waiting, logged: host.logs.filter(({ to }) => to === 'transcript').length, isPaused: state.tcr.status !== TCR_ACTIVE }
}

for (const site of SITES) {
  longTest(`a value no file holds in a read of ${site.name} is told as an unexpected error and written to the transcript, not taken for a failed read`, async () => {
    const left = await played(site, null)
    expect({ isTold: left.waiting.some(text => text.includes(`${UNEXPECTED}: ${NO_FILE_ERROR}`)), logged: left.logged, isPaused: left.isPaused }).toEqual({ isTold: true, logged: 1, isPaused: true })
  })

  longTest(`a read of ${site.name} that outlasts its limit is told once with its own words, as an expected failure`, async () => {
    const left = await played(site, new ReadTimeout(SLOW))
    expect({ told: left.waiting.filter(text => text.includes(SLOW)).length, unexpected: left.waiting.filter(text => text.includes(UNEXPECTED)).length, logged: left.logged, isPaused: left.isPaused }).toEqual({ told: 1, unexpected: 0, logged: 0, isPaused: true })
  })
}

const zanity = CHECKERS.find(({ name }) => name === 'zanity') as Watcher

async function heldOff(error: Error) {
  const state = initialState()
  state.tcr = { status: TCR_ACTIVE, settled: undefined, seen: undefined, unjudged: false, held: undefined }
  const live = liveWatcher('zanity:/repo', '/repo')
  state.liveWatchers.push(live)
  const thrown = await holdOffAfterRead(failingHost(null, false).$, state, { live, watcher: zanity, epoch: state.epoch }, error).then(() => undefined, (caught: unknown) => caught)
  return { thrown: thrown === undefined ? undefined : String(thrown), isPaused: state.tcr.status !== TCR_ACTIVE, told: [...state.outbox.values()].map(({ text }) => text) }
}

longTest('a bug where a watcher starts goes on and pauses nothing, while a read that outlasts its limit pauses TCR with its own words (holdOffAfterRead)', async () => {
  const bug = await heldOff(new TypeError('a bug where a watcher starts'))
  expect({ thrown: bug.thrown, isPaused: bug.isPaused }).toEqual({ thrown: 'TypeError: a bug where a watcher starts', isPaused: false })
  const slow = await heldOff(new ReadTimeout(SLOW))
  expect({ thrown: slow.thrown, isPaused: slow.isPaused, told: slow.told.filter(text => text.includes(SLOW)).length }).toEqual({ thrown: undefined, isPaused: true, told: 1 })
})
