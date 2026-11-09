import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { assert } from '../hooks/assert'
import { CHECKERS, WATCHERS, commandLine, environmentIn, failureMessage, hasRegression, readReport, statusLine } from '../hooks/watchers'
import { CARGO_FAILING, GO_FAILING, SUBPROJECT_TREE, readResult, sorted, treeEntry, watcherNamed } from './fixtures/watchers'

const zig = WATCHERS[0]!
const python = WATCHERS[1]!
const zanity = CHECKERS[0]!

const FAILING = `test
+- run test 0 pass, 1 fail (1 total)
error: 'root.test.basic add functionality' failed:
       src/root.zig:17:5: 0x1049b466b in test.basic add functionality (test)
           try std.testing.expect(add(3, 7) == 11);

Build Summary: 3/5 steps succeeded (1 failed); 2/3 tests passed (1 failed)
test transitive failure
+- run test 0 pass, 1 fail (1 total)
`

const PASSING = `Build Summary: 4/4 steps succeeded; 48/48 tests passed
test success
+- run test 48 pass (48 total) 1s MaxRSS:52M
`

const PYTEST_FAILING = `============================= test session starts ==============================
collected 3 items

tests/test_add.py ..F                                                    [100%]

=================================== FAILURES ===================================
___________________________________ test_add ___________________________________

    def test_add():
>       assert add(3, 7) == 11
E       assert 10 == 11

tests/test_add.py:9: AssertionError
=========================== short test summary info ============================
FAILED tests/test_add.py::test_add - assert 10 == 11
========================= 1 failed, 2 passed in 0.03s ==========================
`

const PYTEST_PASSING = `============================= test session starts ==============================
collected 3 items

tests/test_add.py ...                                                    [100%]

============================== 3 passed in 0.01s ===============================
`

const PYTEST_COLLECTION_ERROR = `============================= test session starts ==============================
collected 0 items / 1 error

==================================== ERRORS ====================================
______________________ ERROR collecting tests/test_add.py ______________________
E   ModuleNotFoundError: No module named 'calc'
!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!
=============================== 1 error in 0.05s ===============================
`

/** A git repository with `files`, whose commands print `output`, and a second later `then.output` when given. */
type Project = {
  files: readonly string[]
  output: string
  spawned: string[][]
  then?: { clock: ReturnType<typeof mock.clock>; output: string }
}

const project = (on: On, { files, output, spawned, then }: Project) => {
  assert(files.every(file => file !== '' && !file.startsWith('/')), `project files ${files} must be names relative to /repo`)
  assert(spawned.length === 0, `project starts with ${spawned.length} commands already spawned; pass an empty list`)
  mock.env(on, { PATH: '/usr/bin' })
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: e.path === '/repo/.git' || files.some(file => e.path.endsWith(`/${file}`)) }))
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    yield { stream: 'stderr' as const, text: output }
    if (then !== undefined) {
      await then.clock.sleep(1000)
      yield { stream: 'stderr' as const, text: then.output }
    }
    return { value: { code: 0, signal: null } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
}

const start = { cwd: '/repo', surface: 'terminal' as const, isInteractive: true }

test('a failing build wakes an idle session with the failure', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[][] = []
  const prompts: string[] = []
  project(on, { files: ['build.zig'], output: PASSING, spawned, then: { clock, output: FAILING } })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start(start)
  await clock.advance(500)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/main.zig', old_string: 'a', new_string: 'b' })
  await clock.advance(1500)
  expect(spawned).toEqual([['zig', 'build', '-Doptimize=fast', 'test', '--watch']])
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Failing: `root.test.basic add functionality`.')
  expect(prompts[0]).not.toContain('try std.testing.expect')
})

test('a failure the project had when the session started is not reported', async ($, on) => {
  const clock = mock.clock(on)
  const session = mock.session(on)
  const prompts: string[] = []
  const statuses: (string | undefined)[] = []
  project(on, { files: ['build.zig'], output: FAILING, spawned: [] })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.status', ($, e, next) => {
    statuses.push(e.text)
    return next(e)
  })
  turnHooks(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.session.start(start)
  await clock.advance(1000)
  expect(prompts).toEqual([])
  expect(session.appended().filter(row => JSON.stringify(row.message.content).includes('failed'))).toEqual([])
  expect(statuses).toContain('zig ✗ 3/5 steps succeeded (1 failed); 2/3 tests passed (1 failed): root.test.basic add functionality')
})

test('a session outside a git repository watches nothing', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[][] = []
  mock.env(on, { PATH: '/usr/bin' })
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: ['/home/me/build.zig', '/home/me/pyproject.toml', '/usr/bin/uv'].includes(e.path) }))
  on('fs.list', () => ({ value: [] }))
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    return { value: { code: 1, signal: null } }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ ...start, cwd: '/home/me' })
  await $.tool.call({ tool: 'Edit', file_path: '/home/me/.zshrc', old_string: 'a', new_string: 'b' })
  await clock.advance(1000)
  expect(spawned).toEqual([])
})

test('the repository holding the session is watched, each directory once by its real path', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[][] = []
  const tree: Record<string, string[]> = { '/repo': ['api/', 'mirror/', 'Downloads/'], '/repo/api': ['go.mod'], '/repo/mirror': ['go.mod'], '/repo/Downloads': ['pyproject.toml'] }
  mock.env(on, { PATH: '/usr/bin' })
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: ['/repo/.git', '/usr/bin/uv'].includes(e.path) }))
  on('fs.list', ($, e) => ({ value: (tree[e.path] ?? []).map(treeEntry) }))
  on('fs.stat', ($, e) => {
    const realPath = e.path === '/repo/mirror' ? '/repo/api' : e.path
    return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath } }
  })
  commands(on, { spawned, output: {}, code: 0 })
  await $.session.start({ ...start, cwd: '/repo/src' })
  await clock.advance(1000)
  expect(spawned).toEqual([['go', 'test', './...']])
})

test('a failing build during a turn joins that turn', async ($, on) => {
  const clock = mock.clock(on)
  const session = mock.session(on)
  const prompts: string[] = []
  project(on, { files: ['build.zig'], output: PASSING, spawned: [], then: { clock, output: FAILING } })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.turn.start({ text: 'refactor', turnId: 't1' })
  await $.session.start(start)
  await clock.advance(500)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/main.zig', old_string: 'a', new_string: 'b' })
  await clock.advance(1500)
  expect(prompts).toEqual([])
  const texts = session.appended().map(row => JSON.stringify(row.message.content))
  expect(texts.some(text => text.includes('failed after the latest change'))).toBe(true)
})

test('a passing build stays quiet', async ($, on) => {
  const clock = mock.clock(on)
  const session = mock.session(on)
  const prompts: string[] = []
  project(on, { files: ['build.zig'], output: PASSING, spawned: [] })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await $.session.start(start)
  await clock.advance(1000)
  expect(prompts).toEqual([])
  expect(session.appended()).toEqual([])
})

test('a project with no watcher starts nothing', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[][] = []
  project(on, { files: [], output: FAILING, spawned })
  await $.session.start(start)
  await clock.advance(1000)
  expect(spawned).toEqual([])
})

test('a project with no watch command reruns its suite after each edit', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[][] = []
  const prompts: string[] = []
  const override = {
    name: 'plugin',
    baseline: ['claude', 'plugin', 'test', '.'],
    summary: '^ \\d+ fail$',
    failed: '^[1-9]\\d* fail$',
  }
  let output = ' 9 pass\n 0 fail\n'
  on('fs.read', ($, e) => (e.path === '/repo/.overwatch.json' ? { value: JSON.stringify(override) } : { deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: e.path === '/repo/.git' }))
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    yield { stream: 'stdout' as const, text: output }
    return { value: { code: 0, signal: null } }
  })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(start)
  await clock.advance(1000)
  expect(spawned).toEqual([override.baseline])
  expect(prompts).toEqual([])
  output = '(fail) adds [0.1ms]\n 8 pass\n 1 fail\n'
  await $.tool.call({ tool: 'Read', file_path: '/repo/hooks/register.ts' })
  await clock.advance(1000)
  expect(spawned.length).toBe(1)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/hooks/register.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/hooks/watchers.ts', content: '' })
  await clock.advance(1000)
  expect(spawned).toEqual([override.baseline, override.baseline])
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('failed after the latest change: 1 fail')
})

test('an edit made while the suite reruns stops that run and starts another', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[][] = []
  const prompts: string[] = []
  const override = { name: 'cargo', baseline: ['cargo', 'test'], summary: '^test result: .*$', failed: 'FAILED' }
  let output = 'test result: ok.\n'
  on('fs.read', ($, e) => (e.path === '/repo/.overwatch.json' ? { value: JSON.stringify(override) } : { deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: e.path === '/repo/.git' }))
  on('process.spawn', async function* ($, e) {
    spawned.splice(spawned.length, 0, [...e.argv])
    const text = output
    if (spawned.length > 1) await clock.sleep(10_000)
    yield { stream: 'stdout' as const, text }
    return { value: { code: 0, signal: null } }
  })
  on('prompt.submit', ($, e) => {
    prompts.splice(prompts.length, 0, e.text)
    return { text: e.text }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(start)
  await clock.advance(1000)
  output = 'test result: FAILED. stale\n'
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/lib.rs', old_string: 'a', new_string: 'b' })
  await clock.advance(1000)
  output = 'test result: FAILED. latest\n'
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/lib.rs', old_string: 'b', new_string: 'c' })
  await clock.advance(30_000)
  expect(spawned.length).toBe(3)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('latest')
  expect(prompts[0]).not.toContain('stale')
})

test('an edit made during the first full run is rechecked and its failures are not inherited', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[][] = []
  const prompts: string[] = []
  const override = { name: 'cargo', baseline: ['cargo', 'test'], summary: '^test result: .*$', failed: 'FAILED' }
  let output = 'test result: ok.\n'
  on('fs.read', ($, e) => (e.path === '/repo/.overwatch.json' ? { value: JSON.stringify(override) } : { deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: e.path === '/repo/.git' }))
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    if (spawned.length === 1) await clock.sleep(10_000)
    yield { stream: 'stdout' as const, text: output }
    return { value: { code: 0, signal: null } }
  })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(start)
  await clock.advance(1000)
  output = 'test result: FAILED. broken by the edit\n'
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/lib.rs', old_string: 'a', new_string: 'b' })
  await clock.advance(30_000)
  expect(spawned).toEqual([override.baseline, override.baseline])
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('broken by the edit')
})

test('an override with no command starts nothing in a project with no marker', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[][] = []
  on('fs.read', () => ({ value: JSON.stringify({ summary: '^ \\d+ fail$' }) }))
  on('fs.exists', () => ({ value: false }))
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    return { value: { code: 0, signal: null } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(start)
  await clock.advance(1000)
  expect(spawned).toEqual([])
})

const ZIG_WATCH = ['zig', 'build', '-Doptimize=fast', 'test', '--watch']

const turnHooks = (on: On) => {
  const starts = on('turn.start', ($, e) => ({ turnId: e.turnId }))
  const completes = on('turn.complete', ($, e) => ({ text: e.answer }))
  assert(starts !== completes, `turn.start and turn.complete share registration ${typeof starts}; register each hook on its own`)
  assert(typeof starts.catch === 'function' && typeof completes.catch === 'function', `turn hooks registered as ${typeof starts.catch}; on() must return a registration`)
}

const ended = { turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' as const }

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

const ZANITY_WARNINGS = `zanity: 0 errors, 1 warning in 1/1 file.
Next: fix these; saving a file checks again. Don't silence rules.

empty-block [warning] 1 in 1 file: Fill in the body, delete the block, or leave a comment saying why nothing happens here.
  a.py
    2:5 'while True' has an empty body.
zanity: watching for changes; save a file to check again, Ctrl-C to stop.
`

const ZANITY_CLEAN = `zanity: checked 1 file, no issues found.
zanity: watching for changes; save a file to check again, Ctrl-C to stop.
`

test('zanity on PATH runs beside the project watcher', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { PATH: '/usr/bin:/home/me/.local/bin' })
  const spawned: string[][] = []
  const prompts: string[] = []
  const statuses: (string | undefined)[] = []
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: ['/repo/.git', '/repo/build.zig', '/home/me/.local/bin/zanity'].includes(e.path) }))
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    yield { stream: 'stdout' as const, text: e.argv[0] === 'zanity' ? ZANITY_CLEAN : PASSING }
    if (e.argv[0] === 'zanity') {
      await clock.sleep(1000)
      yield { stream: 'stdout' as const, text: ZANITY_WARNINGS }
    }
    await clock.sleep(600_000)
    return { value: { code: 0, signal: null } }
  })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.status', ($, e, next) => {
    statuses.push(e.text)
    return next(e)
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start(start)
  await clock.advance(500)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/main.zig', old_string: 'a', new_string: 'b' })
  await clock.advance(1500)
  expect(sorted(spawned)).toEqual([['zanity', 'check', '.', '--watch', '--no-color'], ZIG_WATCH])
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('`zanity check . --watch --no-color` failed after the latest change: zanity: 0 errors, 1 warning in 1/1 file.')
  expect(statuses.at(-1)).toBe(
    'zig ✓ 4/4 steps succeeded; 48/48 tests passed · zanity ✗ 0 errors, 1 warning in 1/1 file.',
  )
})

test('zanity is not run when it is not on PATH', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { PATH: '/usr/bin' })
  const spawned: string[][] = []
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: ['/repo/.git', '/repo/build.zig', '/home/me/.local/bin/zanity'].includes(e.path) }))
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    yield { stream: 'stderr' as const, text: PASSING }
    return { value: { code: 0, signal: null } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(start)
  await clock.advance(1000)
  expect(spawned).toEqual([ZIG_WATCH])
})

test('a zanity warning fails, a clean check passes', () => {
  expect(readReport(zanity, ZANITY_WARNINGS)?.isFailed).toBe(true)
  expect(readReport(zanity, 'zanity: 2 errors, 0 warnings in 3/9 files.')?.isFailed).toBe(true)
  expect(readReport(zanity, 'zanity: 0 errors and 2 warnings in 2 of 9 files')?.isFailed).toBe(true)
  expect(readReport(zanity, ZANITY_CLEAN)?.isFailed).toBe(false)
  expect(readReport(zanity, 'zanity: checked 1 file, no issues found')?.isFailed).toBe(false)
  expect(readReport(zanity, 'zanity: watching for changes; save a file to check again, Ctrl-C to stop.')).toBeUndefined()
})

test('new upstream commits fail the git checker and name each commit', () => {
  const git = CHECKERS.find(checker => checker.name === 'git')!
  const behind = 'new upstream commit 1084b40 three\nnew upstream commit 6001fbe two things\norigin/main has 2 new commits; pull and rebase\n'
  expect(readReport(git, behind)).toMatchObject({ isFailed: true, failures: ['1084b40 three', '6001fbe two things'] })
  expect(statusLine(git, readReport(git, behind)!)).toBe('git ✗ origin/main has 2 new commits; pull and rebase: 1084b40 three +1 more')
  expect(readReport(git, 'new upstream commit 1084b40 three\norigin/main has 1 new commit; pull and rebase\n')?.isFailed).toBe(true)
  expect(readReport(git, 'up to date with origin/main\n')).toMatchObject({ isFailed: false, failures: [] })
  expect(readReport(git, 'no upstream to track\n')?.isFailed).toBe(false)
  expect(readReport(git, 'new upstream commit 1084b40 has 2 new commits; pull and rebase\n')).toBeUndefined()
  const before = readReport(git, 'new upstream commit 6001fbe two things\norigin/main has 1 new commit; pull and rebase\n')!
  expect(hasRegression(readReport(git, behind)!, before)).toBe(true)
  expect(hasRegression(before, before)).toBe(false)
})

test('the zig summary line decides pass or fail', () => {
  expect(readReport(zig, FAILING)?.isFailed).toBe(true)
  expect(readReport(zig, PASSING)?.isFailed).toBe(false)
  expect(readReport(zig, 'test\n+- compile test')).toBeUndefined()
})

test('a pyproject.toml project runs pytest under a watcher', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[][] = []
  const prompts: string[] = []
  mock.env(on, { PATH: '/usr/bin' })
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: ['/repo/.git', '/repo/pyproject.toml', '/usr/bin/uv'].includes(e.path) }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    yield { stream: 'stderr' as const, text: PYTEST_PASSING }
    if (e.argv.includes('ptw')) {
      await clock.sleep(1000)
      yield { stream: 'stderr' as const, text: PYTEST_FAILING }
    }
    return { value: { code: 0, signal: null } }
  })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start(start)
  await clock.advance(500)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/calc.py', old_string: 'a', new_string: 'b' })
  await clock.advance(2500)
  expect(spawned).toEqual([
    ['uv', 'run', '--with', 'pytest', '--with', 'pytest-testmon', 'pytest', '--testmon-noselect'],
    ['uv', 'run', '--with', 'pytest', '--with', 'pytest-watcher', '--with', 'pytest-testmon', 'ptw', '.', '--testmon'],
  ])
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Failing: `tests/test_add.py::test_add`.')
  expect(prompts[0]).not.toContain('assert 10 == 11')
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
})

test('the full suite runs green before the watcher starts', async ($, on) => {
  const clock = mock.clock(on)
  const statuses: (string | undefined)[] = []
  const spawned: string[][] = []
  mock.env(on, { PATH: '/usr/bin' })
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: ['/repo/.git', '/repo/pyproject.toml', '/usr/bin/uv'].includes(e.path) }))
  on('ui.status', ($, e, next) => {
    statuses.push(e.text)
    return next(e)
  })
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    const text = e.argv.includes('ptw') ? '=== no tests ran in 0.00s ===\n' : PYTEST_PASSING
    yield { stream: 'stdout' as const, text }
    return { value: { code: 0, signal: null } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start(start)
  await clock.advance(1000)
  expect(spawned.map(argv => argv.includes('ptw'))).toEqual([false, true])
  const green = statuses.indexOf('python ✓ 3 passed in 0.01s')
  const watching = statuses.findIndex(text => text?.includes(': starting'))
  expect(green).toBeGreaterThan(-1)
  expect(watching).toBeGreaterThan(green)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
})

test('the pytest summary line decides pass or fail', () => {
  expect(readReport(python, PYTEST_FAILING)?.isFailed).toBe(true)
  expect(readReport(python, PYTEST_COLLECTION_ERROR)?.isFailed).toBe(true)
  expect(readReport(python, PYTEST_PASSING)?.isFailed).toBe(false)
  expect(readReport(python, '=== no tests ran in 0.00s ===')?.isFailed).toBe(false)
  expect(readReport(python, '=== test session starts ===\ncollected 3 items')).toBeUndefined()
})

test('the status line drops the summary decoration and names the first failing test', () => {
  expect(statusLine(python, readReport(python, PYTEST_FAILING)!)).toBe(
    'python ✗ 1 failed, 2 passed in 0.03s: tests/test_add.py::test_add',
  )
  expect(statusLine(zig, readReport(zig, PASSING)!)).toBe('zig ✓ 4/4 steps succeeded; 48/48 tests passed')
  expect(statusLine(zig, readReport(zig, FAILING)!)).toBe(
    'zig ✗ 3/5 steps succeeded (1 failed); 2/3 tests passed (1 failed): root.test.basic add functionality',
  )
})

test('a failure names only what is new since the session started, and where its full output is', () => {
  const go = { ...WATCHERS.find(watcher => watcher.name === 'go' && watcher.requires === undefined)!, dir: 'services/api' }
  const report = readReport(go, `--- FAIL: TestOld (0.00s)\n${GO_FAILING}`, 1)!
  expect(failureMessage(go, report, { known: ['TestOld'], log: '/home/me/.cache/overwatch/logs/go.log' }).split('\n')).toEqual([
    'overwatch: `go test ./...` in `services/api` failed after the latest change: 2 failed',
    'Failing: `TestAdd`.',
    '1 more were already failing when the session started.',
    'Fix these new failures before finishing. Tools remain available while you investigate.',
    'Full output: `/home/me/.cache/overwatch/logs/go.log`',
  ])
})

test('a failure for want of a network, interpreter, wheel or key is an environment error', () => {
  expect(environmentIn('error: Failed to fetch: `https://pypi.internal/simple/acme/`\n  Caused by: dns error')).toBe(
    'error: Failed to fetch: `https://pypi.internal/simple/acme/`',
  )
  expect(environmentIn('error: Distribution `pydantic-core==2.27.2` can\'t be installed because it has no wheels for cp315')).toBeDefined()
  expect(environmentIn('error: The Python request from `.python-version` resolved to Python 3.11.9, which is incompatible')).toBeDefined()
  expect(environmentIn("E   KeyError: 'OPENAI_API_KEY'")).toBe("E   KeyError: 'OPENAI_API_KEY'")
  expect(environmentIn(PYTEST_FAILING)).toBeUndefined()
  expect(readReport(python, 'error: Failed to fetch: `https://pypi.internal/simple/acme/`', 2)?.environment).toBeDefined()
  expect(readReport(python, PYTEST_FAILING)?.environment).toBeUndefined()
})

test('an environment error is told once, in one summary, and never asks for a fix', async ($, on) => {
  const clock = mock.clock(on)
  const session = mock.session(on)
  const prompts: string[] = []
  mock.env(on, { PATH: '/usr/bin' })
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: ['/repo/.git', '/repo/pyproject.toml', '/usr/bin/uv'].includes(e.path) }))
  on('process.spawn', async function* () {
    yield { stream: 'stderr' as const, text: 'error: Failed to fetch: `https://pypi.internal/simple/acme/`\n  Caused by: dns error\n' }
    return { value: { code: 2, signal: null } }
  })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  turnHooks(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.session.start(start)
  await clock.advance(200_000)
  const texts = session.appended().map(row => JSON.stringify(row.message.content))
  expect(texts.length).toBe(1)
  expect(texts[0]).toContain('cannot run in this environment')
  expect(texts[0]).toContain('Failed to fetch')
  expect(texts[0]).not.toContain('Fix it')
  expect(prompts).toEqual([])
})

test('an identical failure is told once, and one message at most goes to a turn', async ($, on) => {
  const clock = mock.clock(on)
  const session = mock.session(on)
  const prompts: string[] = []
  const override = { name: 'cargo', baseline: ['cargo', 'test'], summary: '^test result: .*$', failed: 'FAILED' }
  let output = 'test result: ok.\n'
  on('fs.read', ($, e) => (e.path === '/repo/.overwatch.json' ? { value: JSON.stringify(override) } : { deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: e.path === '/repo/.git' }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: output }
    return { value: { code: 0, signal: null } }
  })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  turnHooks(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.session.start(start)
  await clock.advance(1000)
  output = 'test result: FAILED. in 0.01s\n'
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/lib.rs', old_string: 'a', new_string: 'b' })
  await clock.advance(1000)
  expect(session.appended().length).toBe(1)
  output = 'test result: FAILED. in 0.02s\n'
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/lib.rs', old_string: 'b', new_string: 'c' })
  await clock.advance(1000)
  expect(session.appended().length).toBe(1)
  output = 'test result: FAILED. other\n'
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(1000)
  expect(session.appended().length).toBe(1)
  expect(prompts).toEqual([])
  await $.turn.complete(ended)
  await clock.advance(1000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('test result: FAILED. other')
})

test('a one-shot run that gives no summary but exits nonzero fails', () => {
  expect(readReport(python, 'error: Failed to parse uv.lock', 2)?.summary).toBe('exited with code 2')
  expect(readReport(python, 'nothing to see', 0)).toBeUndefined()
})

/** A project whose commands exit with `code`, printing `output` for each by its executable. */
type Commands = { spawned: string[][]; output: Record<string, string>; code?: number }

const commands = (on: On, run: Commands) => {
  assert(run.spawned.length === 0, `commands start with ${run.spawned.length} already spawned; pass an empty list`)
  assert(Object.keys(run.output).every(name => name !== '' && !name.includes(' ')), `outputs ${Object.keys(run.output)} must be keyed by executable name`)
  on('process.spawn', async function* ($, e) {
    run.spawned.push([...e.argv])
    const text = run.output[e.argv[0]!]
    if (text !== undefined) yield { stream: 'stdout' as const, text }
    return { value: { code: run.code ?? 1, signal: null } }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
}

test('a language the root lacks is watched in each sub-project that has it', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[][] = []
  const statuses: (string | undefined)[] = []
  const prompts: string[] = []
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: e.path === '/repo/.git' }))
  on('fs.list', ($, e) => ({ value: (SUBPROJECT_TREE[e.path] ?? []).map(treeEntry) }))
  on('ui.status', ($, e, next) => {
    statuses.splice(statuses.length, 0, e.text)
    return next(e)
  })
  on('process.spawn', async function* ($, e) {
    spawned.splice(spawned.length, 0, [e.cwd ?? '', ...e.argv])
    if (e.argv[0] === 'go') yield { stream: 'stdout' as const, text: GO_FAILING }
    return { value: { code: e.argv[0] === 'go' ? 1 : 0, signal: null } }
  })
  on('prompt.submit', ($, e) => {
    prompts.splice(prompts.length, 0, e.text)
    return { text: e.text }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(start)
  await clock.advance(1000)
  expect(sorted(spawned)).toEqual([
    ['/repo/services/api', 'go', 'test', './...'],
    ['/repo/services/web', 'bun', 'test', '--watch'],
    ['/repo/tools', 'cargo', 'test'],
  ])
  expect(statuses.at(-1)).toContain('go services/api ✗ 1 failed: TestAdd')
  expect(statuses.at(-1)).toContain('rust tools ✓ passed')
  expect(prompts).toEqual([])
})

test('every language in a polyglot project gets its own watcher', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[][] = []
  const statuses: (string | undefined)[] = []
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: ['/repo/.git', '/repo/build.zig', '/repo/go.mod', '/repo/Cargo.toml'].includes(e.path) }))
  on('ui.status', ($, e, next) => {
    statuses.push(e.text)
    return next(e)
  })
  commands(on, { spawned, output: { zig: PASSING, go: GO_FAILING, cargo: CARGO_FAILING }, code: 1 })
  await $.session.start(start)
  await clock.advance(1000)
  expect(sorted(spawned)).toEqual([['cargo', 'test'], ['go', 'test', './...'], ZIG_WATCH])
  expect(statuses).toContain(
    'zig ✓ 4/4 steps succeeded; 48/48 tests passed · go ✗ 1 failed: TestAdd · rust ✗ 1 failed: tests::adds',
  )
})

test('a JS project runs the test runner it has installed, and only that one', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[][] = []
  on('fs.read', () => ({ deny: 'no such file' }))
  const files = ['/repo/.git', '/repo/package.json', '/repo/bun.lock', '/repo/node_modules/.bin/jest']
  on('fs.exists', ($, e) => ({ value: files.includes(e.path) }))
  commands(on, { spawned, output: {}, code: 0 })
  await $.session.start(start)
  await clock.advance(1000)
  expect(spawned).toEqual([['npx', '--no', '--', 'jest', '--watchAll']])
})

test('Go uses gotestsum’s watcher when it is on PATH, else reruns go test after edits', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[][] = []
  let path = '/usr/bin'
  on('env.get', ($, e) => ({ value: e.name === 'PATH' ? path : undefined }))
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: ['/repo/.git', '/repo/go.mod', '/home/me/go/bin/gotestsum'].includes(e.path) }))
  on('tool.call', () => ({ result: 'ok' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  commands(on, { spawned, output: { go: GO_FAILING }, code: 1 })
  await $.session.start(start)
  await clock.advance(1000)
  expect(spawned).toEqual([['go', 'test', './...']])
  await $.tool.call({ tool: 'Edit', file_path: '/repo/calc.go', old_string: 'a', new_string: 'b' })
  await clock.advance(1000)
  expect(spawned).toEqual([['go', 'test', './...'], ['go', 'test', './...']])
  path = '/usr/bin:/home/me/go/bin'
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  spawned.length = 0
  await $.session.start(start)
  await clock.advance(1000)
  expect(spawned.slice(0, 2)).toEqual([
    ['gotestsum', '--', './...'],
    ['gotestsum', '--watch'],
  ])
})


test('a large inherited backlog is saved for triage while only a new issue wakes the agent', async ($, on) => {
  const clock = mock.clock(on)
  const logs = new Map<string, string>()
  const prompts: string[] = []
  const names = Array.from({ length: 10_000 }, (_, index) => '--- FAIL: TestCase' + index + ' (0.00s)')
  let output = names.join('\n') + '\nFAIL\n'
  mock.env(on, { PATH: '/usr/bin', HOME: '/home/me' })
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: ['/repo/.git', '/repo/go.mod'].includes(e.path) }))
  on('fs.write', ($, e) => {
    logs.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: output }
    return { value: { code: 1, signal: null } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.submit', ($, e) => { prompts.push(e.text); return { text: e.text } })
  await $.session.start(start)
  await clock.advance(1000)
  const inventory = JSON.parse(logs.get('/home/me/.cache/overwatch/logs/go-repo.baseline.log.json')!)
  expect(inventory.checks[0].failures.length).toBe(10_000)
  expect(logs.get(inventory.checks[0].log)).toBe(output.trim())
  expect(prompts).toEqual([])
  output = names.join('\n') + '\n--- FAIL: TestNew (0.00s)\nFAIL\n'
  await $.tool.call({ tool: 'Edit', file_path: '/repo/calc.go', old_string: 'a', new_string: 'b' })
  await clock.advance(1000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('TestNew')
  expect(prompts[0]!.length).toBeLessThan(1000)
  expect(JSON.parse(logs.get('/home/me/.cache/overwatch/logs/go-repo.baseline.log.json')!).checks[0].failures.length).toBe(10_000)
})


test('a pull that moves HEAD takes a fresh baseline, so only the agent\'s own failures wake it', async ($, on) => {
  const clock = mock.clock(on)
  const prompts: string[] = []
  const git = new Map([['/repo/.git/HEAD', 'ref: refs/heads/main\n'], ['/repo/.git/packed-refs', `${'a'.repeat(40)} refs/heads/main\n`]])
  let output = '--- FAIL: TestOld (0.00s)\nFAIL\n'
  mock.env(on, { PATH: '/usr/bin' })
  on('fs.read', ($, e) => (git.has(e.path) ? { value: git.get(e.path)! } : { deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: ['/repo/.git', '/repo/go.mod'].includes(e.path) }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: output }
    return { value: { code: 1, signal: null } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.submit', ($, e) => { prompts.push(e.text); return { text: e.text } })
  await $.session.start(start)
  await clock.advance(1000)
  output = '--- FAIL: TestOld (0.00s)\n--- FAIL: TestPulled (0.00s)\nFAIL\n'
  git.set('/repo/.git/refs/heads/main', `${'b'.repeat(40)}\n`)
  await $.tool.call({ tool: 'Bash', command: 'git pull' })
  await clock.advance(1000)
  expect(prompts).toEqual([])
  output = '--- FAIL: TestOld (0.00s)\n--- FAIL: TestPulled (0.00s)\n--- FAIL: TestBroken (0.00s)\nFAIL\n'
  await $.tool.call({ tool: 'Edit', file_path: '/repo/calc.go', old_string: 'a', new_string: 'b' })
  await clock.advance(1000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('TestBroken')
  expect(prompts[0]).not.toContain('TestPulled')
  expect(prompts[0]).toContain('2 more were already failing when the session started.')
})

test('an edit committed in the same step keeps the baseline, so its failure wakes the agent', async ($, on) => {
  const clock = mock.clock(on)
  const prompts: string[] = []
  const git = new Map([['/repo/.git/HEAD', 'ref: refs/heads/main\n'], ['/repo/.git/packed-refs', `${'a'.repeat(40)} refs/heads/main\n`]])
  let output = '--- FAIL: TestOld (0.00s)\nFAIL\n'
  mock.env(on, { PATH: '/usr/bin' })
  on('fs.read', ($, e) => (git.has(e.path) ? { value: git.get(e.path)! } : { deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: ['/repo/.git', '/repo/go.mod'].includes(e.path) }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: output }
    return { value: { code: 1, signal: null } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.submit', ($, e) => { prompts.push(e.text); return { text: e.text } })
  await $.session.start(start)
  await clock.advance(1000)
  output = '--- FAIL: TestOld (0.00s)\n--- FAIL: TestBroken (0.00s)\nFAIL\n'
  git.set('/repo/.git/refs/heads/main', `${'b'.repeat(40)}\n`)
  git.set('/repo/.git/logs/HEAD', `${'a'.repeat(40)} ${'b'.repeat(40)} dev <dev@example.com> 1 +0000\tcommit: break\n`)
  await $.tool.call({ tool: 'Bash', command: 'echo fail > result && git commit -qam break' })
  await clock.advance(1000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('TestBroken')
})

test('a summary-only legacy backlog guards count increases and permits reductions', () => {
  const baseline = { summary: '10000 errors and 20 warnings', isFailed: true, text: '', failures: [] }
  expect(hasRegression({ ...baseline, summary: '9999 errors and 20 warnings' }, baseline)).toBe(false)
  expect(hasRegression({ ...baseline, summary: '10001 errors and 20 warnings' }, baseline)).toBe(true)
  expect(hasRegression({ ...baseline, summary: '9999 errors and 21 warnings' }, baseline)).toBe(true)
})

test('a summary with two failure counts compares each with its own', () => {
  const baseline = { summary: 'Build Summary: 3/5 steps succeeded (1 failed); 1/3 tests passed (2 failed)', isFailed: true, text: '', failures: [] }
  expect(hasRegression({ ...baseline, summary: 'Build Summary: 3/5 steps succeeded (2 failed); 1/3 tests passed (2 failed)' }, baseline)).toBe(true)
  expect(hasRegression({ ...baseline, summary: 'Build Summary: 4/5 steps succeeded (1 failed); 2/3 tests passed (1 failed)' }, baseline)).toBe(false)
})

test('a command line quotes an argument a shell would split', () => {
  const watcher = { ...watcherNamed('zig'), argv: ['zig', 'build', 'test', '-Dfilter=two words', 'say "hi"'] }
  expect(commandLine(watcher)).toBe('zig build test "-Dfilter=two words" "say \\"hi\\""')
})
