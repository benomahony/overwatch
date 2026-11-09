import { expect, mock, test } from 'claude-code/testing'
import { treeEntry } from './fixtures/watchers'
import { FAILING, PASSING, project, turnHooks, commands } from './fixtures/session'
import { start } from './fixtures/gating'

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
