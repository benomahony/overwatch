import { expect, mock, test } from 'claude-code/testing'
import { CARGO_FAILING, GO_FAILING, SUBPROJECT_TREE, sorted, treeEntry } from './fixtures/watchers'
import { PASSING, ZIG_WATCH, commands } from './fixtures/session'
import { start } from './fixtures/gating'

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
