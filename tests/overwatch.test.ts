import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { CHECKERS, WATCHERS, environmentIn, failureMessage, hasRegression, readReport, statusLine } from '../hooks/watchers'

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
  await $.session.start(start)
  await clock.advance(2000)
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
  expect(statuses).toContain('overwatch zig ✗ 3/5 steps succeeded (1 failed); 2/3 tests passed (1 failed): root.test.basic add functionality')
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
  await $.turn.start({ text: 'refactor', turnId: 't1' })
  await $.session.start(start)
  await clock.advance(2000)
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
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
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
  expect(statuses).toContain(`overwatch zig: ${ZIG_WATCH.join(' ')} exited, restarting now`)
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
  return { clock, attempts: () => attempts, prompts, statuses }
}

test('a watcher that keeps exiting backs off, then gives up and wakes the agent', async ($, on) => {
  const { clock, attempts, prompts, statuses } = quickExitWatcher(on)
  await $.session.start(start)
  await clock.advance(1000)
  expect(attempts()).toBe(1)
  expect(statuses.at(-1)).toBe(`overwatch zig: could not start ${ZIG_WATCH.join(' ')}, restarting in 30s`)
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
    while (looking.length > 0) {
      looking.splice(0).forEach(resolve => resolve())
      await clock.settle()
    }
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
  await $.session.start(start)
  await clock.advance(2000)
  expect(sorted(spawned)).toEqual([['zanity', 'check', '.', '--watch', '--no-color'], ZIG_WATCH])
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('`zanity check . --watch --no-color` failed after the latest change: zanity: 0 errors, 1 warning in 1/1 file.')
  expect(statuses.at(-1)).toBe(
    'overwatch zig ✓ 4/4 steps succeeded; 48/48 tests passed · overwatch zanity ✗ 0 errors, 1 warning in 1/1 file.',
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

test('the zig summary line decides pass or fail', () => {
  expect(readReport(zig, FAILING)?.isFailed).toBe(true)
  expect(readReport(zig, PASSING)?.isFailed).toBe(false)
  expect(readReport(zig, 'test\n+- compile test')).toBeUndefined()
})

test('a pyproject.toml project runs pytest under a watcher', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[][] = []
  const prompts: string[] = []
  project(on, { files: ['pyproject.toml', 'usr/bin/uv'], output: PYTEST_PASSING, spawned, then: { clock, output: PYTEST_FAILING } })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start(start)
  await clock.advance(3000)
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
  const green = statuses.indexOf('overwatch python ✓ 3 passed in 0.01s')
  const watching = statuses.findIndex(text => text?.includes(': starting uv run'))
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
    'overwatch python ✗ 1 failed, 2 passed in 0.03s: tests/test_add.py::test_add',
  )
  expect(statusLine(zig, readReport(zig, PASSING)!)).toBe('overwatch zig ✓ 4/4 steps succeeded; 48/48 tests passed')
  expect(statusLine(zig, readReport(zig, FAILING)!)).toBe(
    'overwatch zig ✗ 3/5 steps succeeded (1 failed); 2/3 tests passed (1 failed): root.test.basic add functionality',
  )
})

const watcherNamed = (name: string, marker?: string) =>
  WATCHERS.find(watcher => watcher.name === name && (marker === undefined || watcher.marker === marker))!

const VITEST_FAILING = `
 ❯ calc.test.js (2 tests | 1 failed) 4ms
   × adds 4ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  calc.test.js > adds
AssertionError: expected 10 to be 11 // Object.is equality
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Start at  17:00:40
   Duration  99ms
 FAIL  Tests failed. Watching for file changes...
`

const VITEST_BROKEN = `
 FAIL  calc.test.js [ calc.test.js ]
Error: Failed to parse source for import analysis because the content contains invalid JS syntax.
 Test Files  1 failed (1)
      Tests  no tests
 FAIL  Tests failed. Watching for file changes...
`

const JEST_FAILING = `FAIL ./calc.test.js
  ● adds
    expect(received).toBe(expected) // Object.is equality
Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 passed, 2 total
Ran all test suites.
`

const BUN_FAILING = `calc.test.ts:
error: expect(received).toBe(expected)
(fail) adds [0.53ms]

 1 pass
 1 fail
 1 expect() calls
Ran 2 tests across 1 file. [18.00ms]
`

const DENO_FAILING = `\x1b[0m\x1b[38;5;245mrunning 2 tests from ./calc_test.ts\x1b[0m
adds ... \x1b[0m\x1b[31mFAILED\x1b[0m \x1b[0m\x1b[38;5;245m(0ms)\x1b[0m
 ERRORS
adds \x1b[0m\x1b[38;5;245m=> ./calc_test.ts:1:6\x1b[0m
error: Error: 3 + 7 = 10
 FAILURES
adds \x1b[0m\x1b[38;5;245m=> ./calc_test.ts:1:6\x1b[0m
\x1b[0m\x1b[31mFAILED\x1b[0m | 1 passed | 1 failed \x1b[0m\x1b[38;5;245m(2ms)\x1b[0m
error: Test failed
\x1b[0m\x1b[38;5;12mWatcher\x1b[0m Test failed. Restarting on file change...
`

const DENO_BROKEN = `error: The module's source code could not be parsed: Expected ';', '}' or <eof> at file:///p/calc_test.ts:3:8
Watcher Test failed. Restarting on file change...
`

const GOTESTSUM_FAILING = `=== Failed
=== FAIL: . TestAdd (0.00s)
    calc_test.go:3: Add(3, 7) = 10

DONE 2 tests, 1 failure in 0.184s
`

const GO_FAILING = `--- FAIL: TestAdd (0.00s)
    calc_test.go:3: Add(3, 7) = 10
FAIL
FAIL	example.com/calc	0.343s
FAIL
`

const GO_BROKEN = `# example.com/calc
./calc_test.go:5:1: expected declaration, found syntax
FAIL	example.com/calc [setup failed]
`

const CARGO_FAILING = `running 2 tests
test tests::ok ... ok
test tests::adds ... FAILED

failures:
    tests::adds

test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`

const CARGO_BROKEN = `   Compiling calc v0.1.0 (/repo)
error[E0308]: mismatched types
 --> src/lib.rs:8:26
  |
8 | pub fn broken() -> u32 { "x" }
  |                    ---   ^^^ expected \`u32\`, found \`&str\`

For more information about this error, try \`rustc --explain E0308\`.
error: could not compile \`calc\` (lib) due to 1 previous error
error: could not compile \`calc\` (lib test) due to 1 previous error
`

const readResult = (watcher: (typeof WATCHERS)[number], output: string, code?: number) => {
  const report = readReport(watcher, output, code)!
  return [statusLine(watcher, report), report.failures]
}

test('JavaScript runners report what failed', () => {
  expect(readResult(watcherNamed('vitest'), VITEST_FAILING)).toEqual(['overwatch vitest ✗ 1 failed (1): calc.test.js > adds', ['calc.test.js > adds']])
  expect(readResult(watcherNamed('vitest'), VITEST_BROKEN)[1]).toEqual(['calc.test.js [ calc.test.js ]'])
  expect(readReport(watcherNamed('vitest'), ' Test Files  1 passed (1)\n')?.isFailed).toBe(false)
  expect(readResult(watcherNamed('jest'), JEST_FAILING)).toEqual(['overwatch jest ✗ 1 failed, 1 total: ./calc.test.js +1 more', ['./calc.test.js', 'adds']])
  expect(readResult(watcherNamed('bun'), BUN_FAILING)).toEqual(['overwatch bun ✗ 1 fail: adds', ['adds']])
  expect(readReport(watcherNamed('bun'), ' 2 pass\n 0 fail\n')?.isFailed).toBe(false)
  expect(readResult(watcherNamed('deno'), DENO_FAILING)).toEqual(['overwatch deno ✗ 1 passed | 1 failed (2ms): adds => ./calc_test.ts:1:6', ['adds => ./calc_test.ts:1:6']])
  expect(readReport(watcherNamed('deno'), DENO_BROKEN)?.isFailed).toBe(true)
  expect(readReport(watcherNamed('deno'), 'ok | 2 passed | 0 failed (2ms)\nWatcher Test finished. Restarting on file change...\n')?.summary).toBe(
    'ok | 2 passed | 0 failed (2ms)',
  )
})

test('Go runners report what failed', () => {
  const gotestsum = WATCHERS.find(watcher => watcher.requires === 'gotestsum')!
  expect(readResult(gotestsum, GOTESTSUM_FAILING)).toEqual(['overwatch go ✗ 2 tests, 1 failure in 0.184s: . TestAdd', ['. TestAdd']])
  const go = WATCHERS.find(watcher => watcher.name === 'go' && watcher.requires === undefined)!
  expect(readReport(go, GO_FAILING)).toBeUndefined()
  expect(readResult(go, GO_FAILING, 1)).toEqual(['overwatch go ✗ 1 failed: TestAdd', ['TestAdd']])
  expect(readResult(go, GO_BROKEN, 1)[1]).toEqual(['./calc_test.go:5:1: expected declaration, found syntax'])
  expect(readResult(go, 'ok  \texample.com/calc\t0.2s\n', 0)).toEqual(['overwatch go ✓ passed', []])
})

test('Rust reports compile and test failures', () => {
  expect(readResult(watcherNamed('rust'), CARGO_FAILING, 101)).toEqual(['overwatch rust ✗ 1 failed: tests::adds', ['tests::adds']])
  expect(readResult(watcherNamed('rust'), CARGO_BROKEN, 101)).toEqual([
    'overwatch rust ✗ 1 failed: error[E0308]: mismatched types',
    ['error[E0308]: mismatched types'],
  ])
})

test('a failure names only what is new since the session started, and where its full output is', () => {
  const go = { ...WATCHERS.find(watcher => watcher.name === 'go' && watcher.requires === undefined)!, dir: 'services/api' }
  const report = readReport(go, `--- FAIL: TestOld (0.00s)\n${GO_FAILING}`, 1)!
  expect(failureMessage(go, report, ['TestOld'], '/home/me/.cache/overwatch/logs/go.log').split('\n')).toEqual([
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
  on('process.spawn', async function* ($, e) {
    run.spawned.push([...e.argv])
    const text = run.output[e.argv[0]!]
    if (text !== undefined) yield { stream: 'stdout' as const, text }
    return { value: { code: run.code ?? 1, signal: null } }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
}

/** Slots look for their watchers side by side, so the order they start in is not fixed. */
const sorted = (argvs: string[][]) => [...argvs].sort((a, b) => a.join(' ').localeCompare(b.join(' ')))

const SUBPROJECT_TREE: Record<string, string[]> = {
  '/repo': ['services/', 'tools/', 'node_modules/', '.git/', 'README.md'],
  '/repo/services': ['api/', 'web/'],
  '/repo/services/api': ['go.mod', 'main.go'],
  '/repo/services/web': ['package.json', 'bun.lock'],
  '/repo/tools': ['Cargo.toml', 'nested/'],
  '/repo/tools/nested': ['Cargo.toml'],
  '/repo/node_modules': ['left-pad/'],
  '/repo/node_modules/left-pad': ['go.mod'],
}

const treeEntry = (name: string) => ({
  name: name.replace(/\/$/, ''),
  kind: name.endsWith('/') ? ('dir' as const) : ('file' as const),
  size: 0,
  mtimeMs: 0,
  isLink: false,
})

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
  expect(statuses.at(-1)).toContain('overwatch go services/api ✗ 1 failed: TestAdd')
  expect(statuses.at(-1)).toContain('overwatch rust tools ✓ passed')
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
    'overwatch zig ✓ 4/4 steps succeeded; 48/48 tests passed · overwatch go ✗ 1 failed: TestAdd · overwatch rust ✗ 1 failed: tests::adds',
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


test('a summary-only legacy backlog guards count increases and permits reductions', () => {
  const baseline = { summary: '10000 errors and 20 warnings', isFailed: true, text: '', failures: [] }
  expect(hasRegression({ ...baseline, summary: '9999 errors and 20 warnings' }, baseline)).toBe(false)
  expect(hasRegression({ ...baseline, summary: '10001 errors and 20 warnings' }, baseline)).toBe(true)
  expect(hasRegression({ ...baseline, summary: '9999 errors and 21 warnings' }, baseline)).toBe(true)
})
