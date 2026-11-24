import { expect } from 'claude-code/testing'
import { projectPolicy } from '../hooks/completion'
import { noteBranch } from '../hooks/deciding'
import { activeSettings } from '../hooks/pausing'
import { ReadTimeout } from '../hooks/project'
import { rebaselineOnMove, searchAll } from '../hooks/register'
import { TCR_ACTIVE } from '../hooks/tcr'
import { initialState } from '../hooks/state'
import { longTest } from './fixtures/tcr-session'

const NEW_SESSION = 1

/** A host whose look for the repository fails with a read that outlasted its limit once `fail` is called. */
function slowHost() {
  let fail: () => void = () => undefined
  const failing = new Promise<void>(resolve => { fail = resolve })
  const $ = {
    env: { get: async () => '/usr/bin' },
    clock: { after: () => ({ cancel: () => undefined }), now: async () => 0 },
    ui: { log: () => undefined },
    fs: { exists: async () => { await failing; throw new ReadTimeout('a read of the project\'s files took longer than its limit') }, stat: () => Promise.reject(new Error('no stat')) },
  } as never
  return { $, fail }
}

function endSession(state: ReturnType<typeof initialState>) {
  state.epoch = NEW_SESSION
  state.outbox.clear()
  state.policyTold = undefined
  state.tcr = { status: TCR_ACTIVE, settled: undefined, seen: undefined, unjudged: false, held: undefined }
}

longTest('the gate message of a session that ended while its policy was read is not queued in the next (projectPolicy)', async () => {
  const state = initialState()
  state.cwd = '/repo'
  const host = slowHost()
  const reading = projectPolicy(host.$, state)
  endSession(state)
  host.fail()
  await reading
  expect({ outbox: [...state.outbox.keys()], told: state.policyTold }).toEqual({ outbox: [], told: undefined })
})

longTest('a search of a session that ended does not pause the TCR of the next with its error (searchAll)', async () => {
  const state = initialState()
  state.cwd = '/repo'
  const host = slowHost()
  const searching = searchAll(host.$, state)
  endSession(state)
  host.fail()
  await searching
  expect({ status: state.tcr.status, outbox: [...state.outbox.keys()] }).toEqual({ status: TCR_ACTIVE, outbox: [] })
})

const HEAD_ID = 'a'.repeat(40)

/** A host whose repository at /repo reads its HEAD only once `open` is called, and then holds HEAD_ID. */
function headHost() {
  let open: () => void = () => undefined
  const opened = new Promise<void>(resolve => { open = resolve })
  const $ = {
    env: { get: async () => '/usr/bin' },
    clock: { after: () => ({ cancel: () => undefined }), now: async () => 0 },
    ui: { log: () => undefined },
    fs: {
      exists: async () => true,
      stat: async () => ({ realPath: '/repo' }),
      read: async (path: string) => {
        if (path !== '/repo/.git/HEAD') throw new Error('no such file')
        await opened
        return HEAD_ID
      },
    },
  } as never
  return { $, open }
}

longTest('the commit a read found is noted for the session that asked, and for no later one (rebaselineOnMove)', async () => {
  const state = initialState()
  state.cwd = '/repo'
  const host = headHost()
  const reading = rebaselineOnMove(host.$, state)
  host.open()
  await reading
  expect(state.head).toBe(HEAD_ID)
})

longTest('the commit a read found after its session ended is not noted in the next (rebaselineOnMove)', async () => {
  const state = initialState()
  state.cwd = '/repo'
  const host = headHost()
  const reading = rebaselineOnMove(host.$, state)
  state.epoch = NEW_SESSION
  host.open()
  await reading
  expect(state.head).toBeUndefined()
})

/** A host whose files answer only once `open` is called: HEAD names the branch `main`, and the settings are an empty object. */
function branchHost() {
  let open: () => void = () => undefined
  const opened = new Promise<void>(resolve => { open = resolve })
  const $ = {
    env: { get: async () => undefined },
    clock: { after: () => ({ cancel: () => undefined }), now: async () => 0 },
    ui: { log: () => undefined, toast: () => undefined },
    fs: {
      exists: async () => false,
      read: async (path: string) => {
        await opened
        if (path.endsWith('/HEAD')) return 'ref: refs/heads/main\n'
        if (path.endsWith('/.overwatch.json')) return '{}'
        throw new Error('no such file')
      },
    },
  } as never
  return { $, open }
}

longTest('the branch a read found after its session ended is not told to the next (noteBranch)', async () => {
  const state = initialState()
  const host = branchHost()
  const noting = noteBranch(host.$, state, '/repo')
  state.epoch = NEW_SESSION
  host.open()
  await noting
  expect([...state.outbox.keys()]).toEqual([])
})

longTest('the branch a read found in its own session is told (noteBranch)', async () => {
  const state = initialState()
  const host = branchHost()
  const noting = noteBranch(host.$, state, '/repo')
  host.open()
  await noting
  expect([...state.outbox.keys()]).toEqual(['tcr:branch'])
})

longTest('the settings a read found after its session ended turn off and tell nothing in the next (activeSettings)', async () => {
  const state = initialState()
  state.tcr = { status: TCR_ACTIVE, settled: undefined, seen: undefined, unjudged: false, held: undefined }
  const host = branchHost()
  const reading = activeSettings(host.$, state, '/repo')
  endSession(state)
  host.open()
  expect(await reading).toBeUndefined()
  expect({ status: state.tcr.status, outbox: [...state.outbox.keys()] }).toEqual({ status: TCR_ACTIVE, outbox: [] })
})
