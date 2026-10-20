import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { CHECKERS, WATCHERS, readReport, statusLine } from '../hooks/watchers'

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

type Project = { files: readonly string[]; output: string; spawned: string[][] }

const project = (on: On, { files, output, spawned }: Project) => {
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: files.some(file => e.path.endsWith(`/${file}`)) }))
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    yield { stream: 'stderr' as const, text: output }
    return { value: { code: 0, signal: null } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
}

const start = { cwd: '/repo', surface: 'terminal' as const, isInteractive: true }

test('a failing build wakes an idle session with the failure', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[][] = []
  const prompts: string[] = []
  project(on, { files: ['build.zig'], output: FAILING, spawned })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await $.session.start(start)
  await clock.advance(1000)
  expect(spawned).toEqual([['zig', 'build', '-Doptimize=fast', 'test', '--watch']])
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain("'root.test.basic add functionality' failed")
})

test('a failing build during a turn joins that turn', async ($, on) => {
  const clock = mock.clock(on)
  const session = mock.session(on)
  const prompts: string[] = []
  project(on, { files: ['build.zig'], output: FAILING, spawned: [] })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  await $.turn.start({ text: 'refactor', turnId: 't1' })
  await $.session.start(start)
  await clock.advance(1000)
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
  on('fs.exists', () => ({ value: false }))
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
  expect(prompts[0]).toContain('(fail) adds')
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
  on('fs.exists', ($, e) => ({ value: e.path.endsWith('/build.zig') }))
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
})

test('a watcher that keeps exiting backs off, then gives up and wakes the agent', async ($, on) => {
  const clock = mock.clock(on)
  let attempts = 0
  const prompts: string[] = []
  const statuses: (string | undefined)[] = []
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: e.path.endsWith('/build.zig') }))
  on('process.spawn', async function* () {
    attempts += 1
    throw new Error('zig: command not found')
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
  turnHooks(on)
  await $.session.start(start)
  await clock.advance(1000)
  expect(attempts).toBe(1)
  expect(statuses.at(-1)).toBe(`overwatch zig: could not start ${ZIG_WATCH.join(' ')}, restarting in 30s`)
  await clock.advance(28_000)
  expect(attempts).toBe(1)
  await clock.advance(2000)
  expect(attempts).toBe(2)
  expect(statuses.at(-1)).toContain('restarting in 60s')
  await clock.advance(58_000)
  expect(attempts).toBe(2)
  await clock.advance(2000)
  expect(attempts).toBe(3)
  expect(statuses.at(-1)).toContain('3 times in a row; retrying at the first turn after 30s')
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('stopped restarting it on its own')
  expect(prompts[0]).toContain('What it printed last:')
  await clock.advance(600_000)
  expect(attempts).toBe(3)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(1000)
  expect(attempts).toBe(4)
  expect(prompts.length).toBe(1)
  await $.turn.start({ text: 'go', turnId: 't2' })
  await clock.advance(1000)
  expect(attempts).toBe(4)
})

test('enabled: false keeps the watcher off, read afresh at each turn', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[][] = []
  let override = { enabled: false }
  on('fs.read', ($, e) => (e.path === '/repo/.overwatch.json' ? { value: JSON.stringify(override) } : { deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: e.path.endsWith('/build.zig') }))
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    await clock.sleep(600_000)
    return { value: { code: 0, signal: null } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
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
})

test('a turn that starts while the session is still looking spawns one watcher', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[][] = []
  on('fs.read', () => ({ deny: 'no such file' }))
  const looking: (() => void)[] = []
  on('fs.exists', async ($, e) => {
    await new Promise<void>(resolve => looking.push(resolve))
    return { value: e.path.endsWith('/build.zig') }
  })
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    await clock.sleep(600_000)
    return { value: { code: 0, signal: null } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  turnHooks(on)
  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(ended)
  await clock.settle()
  expect(looking.length).toBe(1)
  looking.splice(0).forEach(resolve => resolve())
  await $.turn.start({ text: 'go', turnId: 't2' })
  await clock.advance(1000)
  looking.splice(0).forEach(resolve => resolve())
  await clock.advance(1000)
  expect(spawned).toEqual([ZIG_WATCH])
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
  on('fs.exists', ($, e) => ({ value: e.path === '/repo/build.zig' || e.path === '/home/me/.local/bin/zanity' }))
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    yield { stream: 'stdout' as const, text: e.argv[0] === 'zanity' ? ZANITY_WARNINGS : PASSING }
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
  await clock.advance(1000)
  expect(spawned).toEqual([ZIG_WATCH, ['zanity', 'check', '.', '--watch', '--no-color']])
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain("'while True' has an empty body")
  expect(statuses.at(-1)).toBe(
    'overwatch zig ✓ 4/4 steps succeeded; 48/48 tests passed · overwatch zanity ✗ 0 errors, 1 warning in 1/1 file.',
  )
})

test('zanity is not run when it is not on PATH', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { PATH: '/usr/bin' })
  const spawned: string[][] = []
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: e.path === '/repo/build.zig' || e.path === '/home/me/.local/bin/zanity' }))
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
  project(on, { files: ['pyproject.toml'], output: PYTEST_FAILING, spawned })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await $.session.start(start)
  await clock.advance(1000)
  expect(spawned).toEqual([
    ['uv', 'run', '--with', 'pytest', '--with', 'pytest-testmon', 'pytest', '--testmon-noselect'],
    ['uv', 'run', '--with', 'pytest', '--with', 'pytest-watcher', '--with', 'pytest-testmon', 'ptw', '.', '--testmon'],
  ])
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('assert 10 == 11')
})

test('the full suite runs green before the watcher starts', async ($, on) => {
  const clock = mock.clock(on)
  const statuses: (string | undefined)[] = []
  const spawned: string[][] = []
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: e.path.endsWith('/pyproject.toml') }))
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
  await $.session.start(start)
  await clock.advance(1000)
  expect(spawned.map(argv => argv.includes('ptw'))).toEqual([false, true])
  const green = statuses.indexOf('overwatch python ✓ 3 passed in 0.01s')
  const watching = statuses.findIndex(text => text?.includes(': starting uv run'))
  expect(green).toBeGreaterThan(-1)
  expect(watching).toBeGreaterThan(green)
})

test('the pytest summary line decides pass or fail', () => {
  expect(readReport(python, PYTEST_FAILING)?.isFailed).toBe(true)
  expect(readReport(python, PYTEST_COLLECTION_ERROR)?.isFailed).toBe(true)
  expect(readReport(python, PYTEST_PASSING)?.isFailed).toBe(false)
  expect(readReport(python, '=== no tests ran in 0.00s ===')?.isFailed).toBe(false)
  expect(readReport(python, '=== test session starts ===\ncollected 3 items')).toBeUndefined()
})

test('the status line drops the summary decoration', () => {
  expect(statusLine(python, readReport(python, PYTEST_FAILING)!)).toBe('overwatch python ✗ 1 failed, 2 passed in 0.03s')
  expect(statusLine(zig, readReport(zig, PASSING)!)).toBe('overwatch zig ✓ 4/4 steps succeeded; 48/48 tests passed')
})
