import { expect, mock, test } from 'claude-code/testing'
import { commandLine, hasRegression } from '../hooks/watchers'
import { watcherNamed } from './fixtures/watchers'
import { start } from './fixtures/gating'

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
