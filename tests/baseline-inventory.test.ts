import { expect } from 'claude-code/testing'
import { baselineInventory } from '../hooks/delivery'
import { initialState, liveWatcher } from '../hooks/state'
import type { Report } from '../hooks/watchers'
import { turnOfEventLoop } from './fixtures/event-loop'
import { longTest } from './fixtures/tcr-session'

const SETTLE_TICKS = 5
const MOST_LIMITS = 20
const REPOSITORY = '/repo'
const LIVE_KEY = `zanity:${REPOSITORY}`
const WATCHER = { name: 'zanity', marker: 'zanity', argv: ['zanity', 'check'], dir: REPOSITORY }
const FAILED: Report = { summary: 'zanity: 0 errors and 3 warnings in 1 of 1 files', isFailed: true, text: 'zanity: 0 errors and 3 warnings in 1 of 1 files\n', failures: ['a.py:1 w'] }

const never = () => new Promise<never>(() => undefined)

/** The host with a cache directory in which a write answers, except one of `unanswered` files, which never does, as a write to a pipe nothing reads does not. */
function hostOf(unanswered: (path: string) => boolean) {
  const timers: (() => void)[] = []
  const written: string[] = []
  const $ = {
    env: { get: async (name: string) => (name === 'HOME' ? '/home/me' : undefined) },
    clock: { after: (_ms: number, run: () => void) => { timers.push(run); return { cancel: () => undefined } } },
    fs: { write: (path: string) => (unanswered(path) ? never() : Promise.resolve().then(() => { written.push(path) })) },
  }
  const runLimits = async () => {
    for (let tick = 0; tick < SETTLE_TICKS; tick += 1) await turnOfEventLoop()
    for (const run of timers.splice(0)) run()
  }
  return { $: $ as never, runLimits, written }
}

async function inventoryOf(unanswered: (path: string) => boolean) {
  const { $, runLimits, written } = hostOf(unanswered)
  const state = initialState()
  const live = liveWatcher(LIVE_KEY, REPOSITORY)
  live.isWatching = true
  let isDone = false
  const running = baselineInventory($, { state, live, watcher: WATCHER as never, cwd: REPOSITORY, epoch: state.epoch }, FAILED).then(() => { isDone = true })
  for (let round = 0; round < MOST_LIMITS && !isDone; round += 1) await runLimits()
  if (isDone) await running
  return { isDone, told: state.outbox.has(`${LIVE_KEY}:baseline`), written }
}

longTest('the inventory of an inherited backlog is written and told when both writes answer', async () => {
  const { isDone, told, written } = await inventoryOf(() => false)
  expect({ isDone, told, files: written.length }).toEqual({ isDone: true, told: true, files: 2 })
})

longTest('the inventory of an inherited backlog whose second write never answers ends at the read limit and tells nothing', async () => {
  const { isDone, told } = await inventoryOf(path => path.endsWith('.json'))
  expect({ isDone, told }).toEqual({ isDone: true, told: false })
})
