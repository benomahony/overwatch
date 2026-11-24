import { expect } from 'claude-code/testing'
import { ReadTimeout, STALLED_MS, rootOf, type RootStall, type StallMemory } from '../hooks/project'
import { projectPolicy } from '../hooks/completion'
import { initialState } from '../hooks/state'
import { turnOfEventLoop } from './fixtures/event-loop'
import { longTest } from './fixtures/tcr-session'

const NEVER = new Promise<never>(() => undefined)

/** A host whose look for `.git` never answers in the directories `stalled` names, and answers true in `/repo`, `/other` and `/flapping` otherwise. */
function hostOf(stalled: Set<string>) {
  let now = 0
  let asked = 0
  const $ = {
    env: { get: async () => undefined },
    clock: {
      now: async () => now,
      after: (_ms: number, run: () => void) => { let isCancelled = false; void turnOfEventLoop().then(() => { if (!isCancelled) run() }); return { cancel: () => { isCancelled = true } } },
    },
    fs: {
      stat: async (path: string) => ({ realPath: path }),
      exists: async (path: string) => { asked += 1; return stalled.has(path.replace(/\/\.git$/, '')) ? NEVER : true },
    },
  } as never
  return { $, asked: () => asked, passes: (ms: number) => { now += ms } }
}

longTest('a look that outlasted its limit fails at once for the same directory, with the words that say it was not tried', async () => {
  const host = hostOf(new Set(['/repo']))
  const memory: { rootStall: RootStall | undefined } = { rootStall: undefined }
  await expect(rootOf(host.$, '/repo', memory)).rejects.toBeInstanceOf(ReadTimeout)
  const askedBefore = host.asked()
  await expect(rootOf(host.$, '/repo', memory)).rejects.toThrow('was not tried')
  expect(host.asked()).toBe(askedBefore)
})

longTest('a stall of one directory does not fail the look for another', async () => {
  const host = hostOf(new Set(['/repo']))
  const memory: { rootStall: RootStall | undefined } = { rootStall: undefined }
  await expect(rootOf(host.$, '/repo', memory)).rejects.toBeInstanceOf(ReadTimeout)
  expect(await rootOf(host.$, '/other', memory)).toBe('/other')
})

longTest('a look that succeeds forgets the stall, so a read that flaps is not held as stalled', async () => {
  const stalled = new Set(['/flapping'])
  const host = hostOf(stalled)
  const memory: { rootStall: RootStall | undefined } = { rootStall: undefined }
  await expect(rootOf(host.$, '/flapping', memory)).rejects.toBeInstanceOf(ReadTimeout)
  host.passes(STALLED_MS)
  stalled.clear()
  expect(await rootOf(host.$, '/flapping', memory)).toBe('/flapping')
  expect(memory.rootStall).toBeUndefined()
})

longTest('a stall is forgotten once the time it is remembered has passed, so the next look asks the host again', async () => {
  const host = hostOf(new Set(['/repo']))
  const memory: { rootStall: RootStall | undefined } = { rootStall: undefined }
  await expect(rootOf(host.$, '/repo', memory)).rejects.toBeInstanceOf(ReadTimeout)
  host.passes(STALLED_MS)
  const askedBefore = host.asked()
  await expect(rootOf(host.$, '/repo', memory)).rejects.not.toThrow('was not tried')
  expect(host.asked()).toBeGreaterThan(askedBefore)
})

longTest('the read of the gate does not ask the host again for a directory whose look outlasted its limit, because it shares the memory of the session', async () => {
  const host = hostOf(new Set(['/repo']))
  const state = initialState()
  state.cwd = '/repo'
  await projectPolicy(host.$, state)
  const askedBefore = host.asked()
  await projectPolicy(host.$, state)
  expect({ asked: host.asked() - askedBefore, remembered: state.rootStall?.dir }).toEqual({ asked: 0, remembered: '/repo' })
})

longTest('the read of the gate for another directory asks the host, though the session remembers a stall of the first', async () => {
  const host = hostOf(new Set(['/repo']))
  const state = initialState()
  state.cwd = '/repo'
  await projectPolicy(host.$, state)
  state.cwd = '/other'
  const askedBefore = host.asked()
  await projectPolicy(host.$, state)
  expect(host.asked()).toBeGreaterThan(askedBefore)
})

longTest('the session forgets a stall once the read of the gate succeeds', async () => {
  const stalled = new Set(['/repo'])
  const host = hostOf(stalled)
  const state = initialState()
  state.cwd = '/repo'
  await projectPolicy(host.$, state)
  host.passes(STALLED_MS)
  stalled.clear()
  await projectPolicy(host.$, state)
  expect(state.rootStall).toBeUndefined()
})

longTest('a look of a session that ended, which finds the repository after the next session recorded a stall, leaves that stall as it is', async () => {
  const host = hostOf(new Set())
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => { release = resolve })
  const slow = { ...(host.$ as object), fs: { stat: async (path: string) => ({ realPath: path }), exists: async () => { await held; return true } } } as never
  const memory: StallMemory = { rootStall: undefined, epoch: 0 }
  const looking = rootOf(slow, '/repo', memory)
  const recorded: RootStall = { dir: '/repo', at: 0, error: new ReadTimeout('a read of the next session took longer than 20s') }
  memory.epoch = 1
  memory.rootStall = recorded
  release()
  expect(await looking).toBe('/repo')
  expect(memory.rootStall).toBe(recorded)
})
