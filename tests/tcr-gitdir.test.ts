import type { EngineInterface } from 'claude-code'
import { expect } from 'claude-code/testing'
import { branchOf, commitOf, isCommitted } from '../hooks/project'
import { AFTER_MOVE, BEFORE_MOVE } from './fixtures/tcr-move'
import { inSession, told, SETTLE_MS, longTest } from './fixtures/tcr-session'

const POINTERS_TO_THE_ROOT = ['gitdir: /', 'gitdir: ../..', 'gitdir: /..', 'gitdir: /repo/../..']

/** An engine whose files are `files` and nothing else, as the plugin reads a repository's git directory. */
function engineReading(files: ReadonlyMap<string, string>): EngineInterface {
  const read = async (path: string) => {
    const text = files.get(path)
    if (text === undefined) throw new Error(`no such file: ${path}`)
    return text
  }
  return { fs: { read }, env: { get: async () => undefined }, clock: { after: () => ({ cancel: () => undefined }) } } as unknown as EngineInterface
}

for (const pointer of POINTERS_TO_THE_ROOT) {
  const root = new Map([['/repo/.git', `${pointer}\n`], ['/HEAD', 'ref: refs/heads/main\n'], ['/logs/HEAD', `${BEFORE_MOVE} ${AFTER_MOVE} Dev <dev@example.com> 1700000001 +0000\tcommit: break\n`]])

  longTest(`a .git file that points to the filesystem's root (${pointer}) names no branch, no commit and no move, and reading them does not fail`, async () => {
    const engine = engineReading(root)
    await expect(branchOf(engine, '/repo')).resolves.toBeUndefined()
    await expect(commitOf(engine, '/repo')).resolves.toBeUndefined()
    await expect(isCommitted(engine, '/repo', BEFORE_MOVE, AFTER_MOVE)).resolves.toBe(false)
  })

  longTest(`a .git file that points to the filesystem's root (${pointer}) leaves TCR on with no branch to name, and the plugin does not fail`, async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(SETTLE_MS)
      expect(told(project).some(text => text.includes('TCR is on'))).toBe(true)
      expect(told(project).some(text => text.includes('TCR checkpoints land on'))).toBe(false)
    }, { prepare: workspace => { workspace.files.set('/repo/.git', `${pointer}\n`).set('/HEAD', 'ref: refs/heads/main\n') } })
  })
}

const LINKED_HEAD = new Map([
  ['/repo/.git', 'gitdir: /main/.git/worktrees/repo\n'],
  ['/main/.git/worktrees/repo/HEAD', 'ref: refs/heads/main\n'],
  ['/main/.git/worktrees/repo/commondir', '../..\n'],
  ['/main/.git/refs/heads/main', `${AFTER_MOVE}\n`],
  ['/main/.git/worktrees/repo/logs/HEAD', `${BEFORE_MOVE} ${AFTER_MOVE} Dev <dev@example.com> 1700000001 +0000\tcommit: break\n`],
])

longTest('a worktree\'s .git file leads to its own HEAD, to the refs of the directory its commondir names, and to its own reflog', async () => {
  const engine = engineReading(LINKED_HEAD)
  await expect(branchOf(engine, '/repo')).resolves.toBe('main')
  await expect(commitOf(engine, '/repo')).resolves.toBe(AFTER_MOVE)
  await expect(isCommitted(engine, '/repo', BEFORE_MOVE, AFTER_MOVE)).resolves.toBe(true)
})
