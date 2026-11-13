import { expect, mock, test } from 'claude-code/testing'
import { assert } from '../hooks/assert'
import { bringsInFiles } from '../hooks/gating'
import { COMMANDS as commands } from './fixtures/git-commands'

const start = { cwd: '/repo', surface: 'terminal' as const, isInteractive: true }

const BEFORE = 'a'.repeat(40)
const AFTER = 'b'.repeat(40)
const NO_COMMIT = '0'.repeat(40)
const COMMIT_ID = /^[0-9a-f]{40}$/
const HEAD_LOG = '/repo/.git/logs/HEAD'
const SETTLE_MS = 1000

function reflogEntry(before: string, after: string, at: number, subject: string): string {
  assert(COMMIT_ID.test(before) && COMMIT_ID.test(after), `a reflog entry from ${before} to ${after} needs two commit ids`)
  assert(subject !== '' && !subject.includes('\n'), `the reflog subject ${JSON.stringify(subject)} must be one non-empty line`)
  return `${before} ${after} Dev <dev@example.com> ${at} +0000\t${subject}\n`
}

function moveHead(git: Map<string, string>, subject: string) {
  assert(subject !== '', `a HEAD move needs the subject git writes in the reflog, not ${JSON.stringify(subject)}`)
  git.set('/repo/.git/refs/heads/main', `${AFTER}\n`)
  git.set(HEAD_LOG, reflogEntry(NO_COMMIT, BEFORE, 1700000000, 'commit (initial): start') + reflogEntry(BEFORE, AFTER, 1700000001, subject))
  assert(git.get(HEAD_LOG)!.endsWith(`\t${subject}\n`), `the reflog does not end with ${subject}; write one entry per move`)
}

const COMMIT_STEP = 'echo fail > result && git commit -qam break'

async function breakInOneStep($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1], subject: string, command = COMMIT_STEP) {
  const clock = mock.clock(on)
  const prompts: string[] = []
  const git = new Map([['/repo/.git/HEAD', 'ref: refs/heads/main\n'], ['/repo/.git/packed-refs', `${BEFORE} refs/heads/main\n`]])
  let result = { code: 0, output: 'ok  \tpkg\t0.1s\n' }
  mock.env(on, { PATH: '/usr/bin' })
  on('fs.read', ($, e) => (git.has(e.path) ? { value: git.get(e.path)! } : { deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: ['/repo/.git', '/repo/go.mod'].includes(e.path) }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: result.output }
    return { value: { code: result.code, signal: null } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.call', () => {
    result = { code: 1, output: '--- FAIL: TestBroken (0.00s)\nFAIL\n' }
    moveHead(git, subject)
    return { result: 'ok' }
  })
  on('prompt.submit', ($, e) => { prompts.push(e.text); return { text: e.text } })
  await $.session.start(start)
  await clock.advance(SETTLE_MS)
  await $.tool.call({ tool: 'Bash', command })
  await clock.advance(SETTLE_MS)
  assert(git.get(HEAD_LOG)?.endsWith(`\t${subject}\n`), `the step left no ${subject} entry in the reflog; moveHead must run in the tool call`)
  assert(prompts.length <= 1, `${prompts.length} prompts for one step; the guard asks at most once`)
  return prompts
}

test('an edit committed in the same step as the check breaks is a new failure that wakes the agent', async ($, on) => {
  const prompts = await breakInOneStep($, on, 'commit: break')
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('TestBroken')
})

test('a move that is no commit still takes a fresh baseline in the same step', async ($, on) => {
  const prompts = await breakInOneStep($, on, 'pull: Fast-forward')
  expect(prompts).toEqual([])
})

test('a squash merge committed in the same step takes a fresh baseline, since it brings in files', async ($, on) => {
  const prompts = await breakInOneStep($, on, 'commit: squash upstream', 'git merge --squash upstream && git commit -m squash')
  expect(prompts).toEqual([])
})

test('a commit message that names a merge is still only a commit', async ($, on) => {
  const prompts = await breakInOneStep($, on, 'commit: merge fix', 'git commit -qam "merge fix"')
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('TestBroken')
})

test('git commands that bring in files are told from commits', () => {
  const groups = Object.keys(commands)
  assert(groups.length === 3 && ['bringing', 'commits', 'unseen'].every(group => groups.includes(group)), `the corpus has ${groups}; keep bringing, commits and unseen`)
  for (const command of commands.bringing) expect(bringsInFiles(command)).toBe(true)
  for (const command of [...commands.commits, ...commands.unseen]) expect(bringsInFiles(command)).toBe(false)
})

test('a commit message that names a git operation is still only a commit', async ($, on) => {
  const prompts = await breakInOneStep($, on, 'commit: Fix git pull handling', 'git commit -qam "Fix git pull handling"')
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('TestBroken')
})

test('a squash merge inside bash -c takes a fresh baseline', async ($, on) => {
  const prompts = await breakInOneStep($, on, 'commit: squash upstream', 'bash -lc "git merge --squash upstream && git commit -m squash"')
  expect(prompts).toEqual([])
})

test('a squash merge in a subshell takes a fresh baseline', async ($, on) => {
  const prompts = await breakInOneStep($, on, 'commit: squash upstream', '(git merge --squash upstream && git commit -m squash)')
  expect(prompts).toEqual([])
})
