import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { assert } from '../hooks/assert'
import { PASSING, project, ZIG_WATCH, turnHooks } from './fixtures/session'
import { start, ended } from './fixtures/gating'

const quickExitWatcher = (on: On) => {
  const clock = mock.clock(on)
  let attempts = 0
  const prompts: string[] = []
  const statuses: (string | undefined)[] = []
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: e.path.endsWith('/build.zig') || e.path === '/repo/.git' }))
  on('process.spawn', async function* () {
    attempts += 1
    throw new Error('zig: command not found')
  })
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.write', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.status', ($, e, next) => {
    statuses.push(e.text)
    return next(e)
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  turnHooks(on)
  assert(attempts === 0, `the watcher was tried ${attempts} times before the session started`)
  assert(prompts.length === 0 && statuses.length === 0, `prompts ${prompts} or statuses ${statuses} arrived before the session started`)
  return { clock, attempts: () => attempts, prompts, statuses }
}

test('a marker created mid-session starts its watcher on the next turn', async ($, on) => {
  const clock = mock.clock(on)
  const files: string[] = []
  const spawned: string[][] = []
  project(on, { files, output: PASSING, spawned })
  turnHooks(on)
  await $.session.start(start)
  await $.turn.start({ text: 'uv init', turnId: 't1' })
  await clock.advance(1000)
  expect(spawned).toEqual([])
  files.push('build.zig')
  await $.turn.start({ text: 'go on', turnId: 't2' })
  await clock.advance(1000)
  expect(spawned).toEqual([ZIG_WATCH])
})

test('a marker created during a turn starts its watcher as the turn completes', async ($, on) => {
  const clock = mock.clock(on)
  const files: string[] = []
  const spawned: string[][] = []
  project(on, { files, output: PASSING, spawned })
  turnHooks(on)
  await $.session.start(start)
  await $.turn.start({ text: 'zig init', turnId: 't1' })
  files.push('build.zig')
  await $.turn.complete(ended)
  await clock.advance(1000)
  expect(spawned).toEqual([ZIG_WATCH])
})

test('a watcher that exits is restarted at once, and the agent told', async ($, on) => {
  const clock = mock.clock(on)
  const session = mock.session(on)
  const spawned: string[][] = []
  const statuses: (string | undefined)[] = []
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: e.path.endsWith('/build.zig') || e.path === '/repo/.git' }))
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    yield { stream: 'stderr' as const, text: PASSING }
    await clock.sleep(60_000)
    return { value: { code: 1, signal: null } }
  })
  on('ui.status', ($, e, next) => {
    statuses.push(e.text)
    return next(e)
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  turnHooks(on)
  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(1000)
  expect(spawned.length).toBe(1)
  await clock.advance(59_500)
  expect(spawned).toEqual([ZIG_WATCH, ZIG_WATCH])
  expect(statuses).toContain(`zig: ${ZIG_WATCH.join(' ')} exited, restarting now`)
  const texts = session.appended().map(row => JSON.stringify(row.message.content))
  expect(texts.some(text => text.includes('exited, so build failures are not reported until it restarts now'))).toBe(true)
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await clock.advance(60_000)
  await ending
})

test('a running watcher restarts once when its program moves on PATH, and not while it stays', async ($, on) => {
  const clock = mock.clock(on)
  const started: string[] = []
  const statuses: (string | undefined)[] = []
  let zig = '/nix/store/zig-0.18.0/bin/zig'
  mock.env(on, { PATH: '/usr/bin' })
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: ['/repo/.git', '/repo/build.zig', '/usr/bin/zig'].includes(e.path) }))
  on('fs.stat', ($, e) => {
    const isZig = e.path === '/usr/bin/zig'
    return { value: { kind: isZig ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: isZig, realPath: isZig ? zig : e.path } }
  })
  on('process.spawn', async function* () {
    started.push(zig)
    yield { stream: 'stderr' as const, text: PASSING }
    // Keeps running, printing blank lines, until it is stopped, which takes effect at a yield.
    for (let second = 0; second < 3600; second++) {
      await clock.sleep(1000)
      yield { stream: 'stderr' as const, text: '\n' }
    }
    return { value: { code: 0, signal: null } }
  })
  on('ui.status', ($, e, next) => {
    statuses.push(e.text)
    return next(e)
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  turnHooks(on)
  await $.session.start(start)
  await clock.advance(1000)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(1000)
  expect(started).toEqual(['/nix/store/zig-0.18.0/bin/zig'])
  zig = '/nix/store/zig-0.17.0/bin/zig'
  await $.turn.start({ text: 'go on', turnId: 't2' })
  await clock.advance(1000)
  expect(started).toEqual(['/nix/store/zig-0.18.0/bin/zig', '/nix/store/zig-0.17.0/bin/zig'])
  expect(statuses).toContain('zig: zig is now /nix/store/zig-0.17.0/bin/zig, restarting')
  await $.turn.start({ text: 'and on', turnId: 't3' })
  await clock.advance(1000)
  expect(started.length).toBe(2)
})

test('a watcher that keeps exiting backs off, then gives up and wakes the agent', async ($, on) => {
  const { clock, attempts, prompts, statuses } = quickExitWatcher(on)
  await $.session.start(start)
  await clock.advance(1000)
  expect(attempts()).toBe(1)
  expect(statuses.at(-1)).toBe(`zig: could not start ${ZIG_WATCH.join(' ')}, restarting in 30s`)
  await clock.advance(28_000)
  expect(attempts()).toBe(1)
  await clock.advance(2000)
  expect(attempts()).toBe(2)
  expect(statuses.at(-1)).toContain('restarting in 60s')
  await clock.advance(58_000)
  expect(attempts()).toBe(2)
  await clock.advance(2000)
  expect(attempts()).toBe(3)
  expect(statuses.at(-1)).toContain('3 times in a row; retrying at the first turn after 30s')
  expect(prompts[0]).toContain('stopped restarting it on its own')
  expect(prompts[0]).toContain('What it printed last: `/home/me/.cache/overwatch/logs/zig-repo.log`')
})

test('a watcher given up on retries only on a later turn', async ($, on) => {
  const { clock, attempts, prompts } = quickExitWatcher(on)
  await $.session.start(start)
  await clock.advance(91_000)
  expect(attempts()).toBe(3)
  await clock.advance(600_000)
  expect(attempts()).toBe(3)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(1000)
  expect(attempts()).toBe(4)
  expect(prompts.length).toBe(1)
  await $.turn.start({ text: 'go', turnId: 't2' })
  await clock.advance(1000)
  expect(attempts()).toBe(4)
})

test('enabled: false keeps the watcher off, read afresh at each turn', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[][] = []
  let override = { enabled: false }
  on('fs.read', ($, e) => (e.path === '/repo/.overwatch.json' ? { value: JSON.stringify(override) } : { deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: e.path.endsWith('/build.zig') || e.path === '/repo/.git' }))
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    await clock.sleep(600_000)
    return { value: { code: 0, signal: null } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  turnHooks(on)
  await $.session.start(start)
  for (const turnId of ['t1', 't2', 't3']) {
    await $.turn.start({ text: 'go', turnId })
    await $.turn.complete({ ...ended, turnId })
    await clock.advance(40_000)
  }
  expect(spawned).toEqual([])
  override = { enabled: true }
  await $.turn.start({ text: 'go', turnId: 't4' })
  await clock.advance(1000)
  expect(spawned).toEqual([ZIG_WATCH])
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await clock.advance(600_000)
  await ending
})

test('a turn that starts while the session is still looking spawns one watcher', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[][] = []
  on('fs.read', () => ({ deny: 'no such file' }))
  const looking: (() => void)[] = []
  on('fs.exists', async ($, e) => {
    await new Promise<void>(resolve => looking.push(resolve))
    return { value: e.path.endsWith('/build.zig') || e.path === '/repo/.git' }
  })
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    await clock.sleep(600_000)
    return { value: { code: 0, signal: null } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  turnHooks(on)
  /** Answers every look in flight, and the looks those lead to, until none is left. */
  const answerAll = async () => {
    let rounds = 0
    while (looking.length > 0) {
      assert(rounds < 100, `looks still in flight after ${rounds} rounds; a look must not lead to looks forever`)
      looking.splice(0).forEach(resolve => resolve())
      await clock.settle()
      rounds += 1
    }
    assert(looking.length === 0, `${looking.length} looks are left unanswered`)
  }
  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(ended)
  await clock.settle()
  const firstLooks = looking.length
  expect(firstLooks).toBeGreaterThan(0)
  looking.splice(0).forEach(resolve => resolve())
  await $.turn.start({ text: 'go', turnId: 't2' })
  await clock.advance(1000)
  await answerAll()
  await clock.advance(1000)
  expect(spawned).toEqual([ZIG_WATCH])
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await clock.advance(600_000)
  await answerAll()
  await ending
})

test('the session ending stops the watcher and any restart', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[][] = []
  const statuses: (string | undefined)[] = []
  project(on, { files: ['build.zig'], output: PASSING, spawned })
  on('ui.status', ($, e, next) => {
    statuses.push(e.text)
    return next(e)
  })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  turnHooks(on)
  await $.session.start(start)
  await clock.advance(1000)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await clock.advance(60_000)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(1000)
  expect(spawned).toEqual([ZIG_WATCH])
  expect(statuses.at(-1)).toBeUndefined()
})

test('a resumed session starts watching again at once', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[][] = []
  project(on, { files: ['build.zig'], output: PASSING, spawned })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('ui.status', () => ({ value: undefined }))
  turnHooks(on)
  await $.session.start(start)
  await clock.advance(1000)
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
  await clock.advance(1000)
  expect(spawned).toEqual([ZIG_WATCH, ZIG_WATCH])
})
