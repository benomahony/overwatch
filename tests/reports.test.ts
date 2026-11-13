import { expect, mock, test } from 'claude-code/testing'
import { CHECKERS, WATCHERS, environmentIn, failureMessage, hasRegression, readReport, statusLine } from '../hooks/watchers'
import { GO_FAILING, sorted } from './fixtures/watchers'
import { FAILING, PASSING, ZIG_WATCH, turnHooks } from './fixtures/session'
import { start, ended } from './fixtures/gating'

const zig = WATCHERS[0]!
const python = WATCHERS[1]!

const zanity = CHECKERS[0]!

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
  expect(sorted(spawned)).toEqual([['zanity', 'check', '.', '--watch', '--no-color', '--plain'], ZIG_WATCH])
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('`zanity check . --watch --no-color --plain` failed after the latest change: zanity: 0 errors, 1 warning in 1/1 file.')
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
