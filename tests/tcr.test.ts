import { expect, mock, test } from 'claude-code/testing'

const start = { cwd: '/tcr', surface: 'terminal' as const, isInteractive: true }
const SETTLE_MS = 1000
const PASSING = { code: 0, output: 'ok  \tpkg\t0.1s\n' }
const FAILING = { code: 1, output: '--- FAIL: TestBroken (0.00s)\nFAIL\n' }

test('tcr commits a green edit and reverts a red one', async ($, on) => {
  const clock = mock.clock(on)
  const prompts: string[] = []
  const git: string[] = []
  let result = PASSING
  const files = new Map([['/tcr/.git/HEAD', 'ref: refs/heads/main\n'], ['/tcr/.git/packed-refs', `${'a'.repeat(40)} refs/heads/main\n`], ['/tcr/.overwatch.json', '{"mode": "tcr"}']])
  mock.env(on, { PATH: '/usr/bin' })
  on('fs.read', ($, e) => (files.has(e.path) ? { value: files.get(e.path)! } : { deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: ['/tcr/.git', '/tcr/go.mod'].includes(e.path) }))
  on('process.spawn', async function* ($, e) {
    if (e.argv[0] === 'git') git.push(e.argv.join(' '))
    if (e.argv[1] === 'reset') result = PASSING
    else yield { stream: 'stdout' as const, text: result.output }
    return { value: { code: e.argv[0] === 'git' ? 0 : result.code, signal: null } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.submit', ($, e) => { prompts.push(e.text); return { text: e.text } })
  await $.session.start(start)
  await clock.advance(SETTLE_MS)
  await $.tool.call({ tool: 'Edit', command: '' })
  await clock.advance(SETTLE_MS)
  expect(git).toEqual(['git add -A', 'git commit -qm tcr'])
  result = FAILING
  await $.tool.call({ tool: 'Edit', command: '' })
  await clock.advance(SETTLE_MS)
  expect(git.slice(2)).toEqual(['git reset --hard -q', 'git clean -fdq'])
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('TestBroken')
  expect(prompts[0]).toContain('TCR reverted')
})
