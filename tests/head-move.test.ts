import { expect, mock, type TestBody } from 'claude-code/testing'
import { assert } from '../hooks/assert'
import { bringsInFiles } from '../hooks/gating'
import { COMMANDS as commands } from './fixtures/git-commands'
import { longTest } from './fixtures/tcr-session'

const start = { cwd: '/repo', surface: 'terminal' as const, isInteractive: true }

const BEFORE = 'a'.repeat(40)
const AFTER = 'b'.repeat(40)
const NO_COMMIT = '0'.repeat(40)
const COMMIT_ID = /^[0-9a-f]{40}$/
const SETTLE_MS = 1000

function reflogEntry(before: string, after: string, at: number, subject: string): string {
  assert(COMMIT_ID.test(before) && COMMIT_ID.test(after), `a reflog entry from ${before} to ${after} needs two commit ids`)
  assert(subject !== '' && !subject.includes('\n'), `the reflog subject ${JSON.stringify(subject)} must be one non-empty line`)
  return `${before} ${after} Dev <dev@example.com> ${at} +0000\t${subject}\n`
}

/** Where git keeps what the repository at /repo reads: its own directory, and the one its refs live in, which differ in a worktree. */
type Layout = { pointer?: string; own: string; common: string; commondir?: string }

const PLAIN: Layout = { own: '/repo/.git', common: '/repo/.git' }
const LINKED_LAYOUTS: Record<string, Layout> = {
  worktree: { pointer: 'gitdir: /main/.git/worktrees/repo', own: '/main/.git/worktrees/repo', common: '/main/.git', commondir: '../..' },
  submodule: { pointer: 'gitdir: ../.git/modules/repo', own: '/.git/modules/repo', common: '/.git/modules/repo' },
}

function moveHead(git: Map<string, string>, subject: string, layout: Layout = PLAIN) {
  assert(subject !== '', `a HEAD move needs the subject git writes in the reflog, not ${JSON.stringify(subject)}`)
  git.set(`${layout.common}/refs/heads/main`, `${AFTER}\n`)
  const log = `${layout.own}/logs/HEAD`
  git.set(log, reflogEntry(NO_COMMIT, BEFORE, 1700000000, 'commit (initial): start') + reflogEntry(BEFORE, AFTER, 1700000001, subject))
  assert(git.get(log)!.endsWith(`\t${subject}\n`), `the reflog does not end with ${subject}; write one entry per move`)
}

const COMMIT_STEP = 'echo fail > result && git commit -qam break'

async function breakInOneStep($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], subject: string, { command = COMMIT_STEP, layout = PLAIN }: { command?: string; layout?: Layout } = {}) {
  const clock = mock.clock(on)
  const prompts: string[] = []
  const git = new Map([[`${layout.own}/HEAD`, 'ref: refs/heads/main\n'], [`${layout.common}/packed-refs`, `${BEFORE} refs/heads/main\n`]])
  if (layout.pointer !== undefined) git.set('/repo/.git', `${layout.pointer}\n`)
  if (layout.commondir !== undefined) git.set(`${layout.own}/commondir`, `${layout.commondir}\n`)
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
    moveHead(git, subject, layout)
    return { result: 'ok' }
  })
  on('prompt.submit', ($, e) => { prompts.push(e.text); return { text: e.text } })
  await $.session.start(start)
  await clock.advance(SETTLE_MS)
  await $.tool.call({ tool: 'Bash', command })
  await clock.advance(SETTLE_MS)
  assert(git.get(`${layout.own}/logs/HEAD`)?.endsWith(`\t${subject}\n`), `the step left no ${subject} entry in the reflog; moveHead must run in the tool call`)
  assert(prompts.length <= 1, `${prompts.length} prompts for one step; the guard asks at most once`)
  return prompts
}

longTest('an edit committed in the same step as the check breaks is a new failure that wakes the agent', async ($, on) => {
  const prompts = await breakInOneStep($, on, 'commit: break')
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('TestBroken')
})

longTest('a move that is no commit still takes a fresh baseline in the same step', async ($, on) => {
  const prompts = await breakInOneStep($, on, 'pull: Fast-forward')
  expect(prompts).toEqual([])
})

longTest('a squash merge committed in the same step takes a fresh baseline, since it brings in files', async ($, on) => {
  const prompts = await breakInOneStep($, on, 'commit: squash upstream', { command: 'git merge --squash upstream && git commit -m squash' })
  expect(prompts).toEqual([])
})

longTest('a commit message that names a merge is still only a commit', async ($, on) => {
  const prompts = await breakInOneStep($, on, 'commit: merge fix', { command: 'git commit -qam "merge fix"' })
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('TestBroken')
})

longTest('git commands that bring in files are told from commits', () => {
  const groups = Object.keys(commands)
  assert(groups.length === 3 && ['bringing', 'commits', 'unseen'].every(group => groups.includes(group)), `the corpus has ${groups}; keep bringing, commits and unseen`)
  for (const command of commands.bringing) expect(bringsInFiles(command)).toBe(true)
  for (const command of [...commands.commits, ...commands.unseen]) expect(bringsInFiles(command)).toBe(false)
})

longTest('a commit message that names a git operation is still only a commit', async ($, on) => {
  const prompts = await breakInOneStep($, on, 'commit: Fix git pull handling', { command: 'git commit -qam "Fix git pull handling"' })
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('TestBroken')
})

longTest('a squash merge inside bash -c takes a fresh baseline', async ($, on) => {
  const prompts = await breakInOneStep($, on, 'commit: squash upstream', { command: 'bash -lc "git merge --squash upstream && git commit -m squash"' })
  expect(prompts).toEqual([])
})

longTest('a squash merge in a subshell takes a fresh baseline', async ($, on) => {
  const prompts = await breakInOneStep($, on, 'commit: squash upstream', { command: '(git merge --squash upstream && git commit -m squash)' })
  expect(prompts).toEqual([])
})

for (const [kind, layout] of Object.entries(LINKED_LAYOUTS)) {
  longTest(`a pull in a ${kind}, whose .git is a file, takes a fresh baseline in the same step`, async ($, on) => {
    const prompts = await breakInOneStep($, on, 'pull: Fast-forward', { command: 'git pull', layout })
    expect(prompts).toEqual([])
  })

  longTest(`an edit committed in the same step as the check breaks, in a ${kind}, is a new failure that wakes the agent`, async ($, on) => {
    const prompts = await breakInOneStep($, on, 'commit: break', { layout })
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain('TestBroken')
  })
}
