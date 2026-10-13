import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { WATCHERS, readReport } from '../hooks/watchers'

const zig = WATCHERS[0]!

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

const project = (on: On, files: readonly string[], output: string, spawned: string[][]) => {
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
  project(on, ['build.zig'], FAILING, spawned)
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
  project(on, ['build.zig'], FAILING, [])
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
  project(on, ['build.zig'], PASSING, [])
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
  project(on, [], FAILING, spawned)
  await $.session.start(start)
  await clock.advance(1000)
  expect(spawned).toEqual([])
})

test('the zig summary line decides pass or fail', () => {
  expect(readReport(zig, FAILING)?.isFailed).toBe(true)
  expect(readReport(zig, PASSING)?.isFailed).toBe(false)
  expect(readReport(zig, 'test\n+- compile test')).toBeUndefined()
})
