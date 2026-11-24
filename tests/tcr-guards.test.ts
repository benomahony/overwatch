import { expect } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { CHECK_TIMEOUT_MS, COMMAND_LIMITS_MS, JUDGEMENT_LIMIT_MS, OUTSIDE_CHANGE, stateOf } from '../hooks/tcr'
import { changedWhileJudging } from '../hooks/judgement'
import { CLEAN, WARNINGS } from './fixtures/tcr'
import { inSession, edit, during, personWrites, told, SETTLE_MS, DECIDE_MS, longTest } from './fixtures/tcr-session'

const NEVER_MS = 10_000_000
const WRITE_LIMIT_MS = 1200
const SLOW = { OVERWATCH_TCR_TIMEOUT_SCALE: '0.005' }

const CAN_WRITE_FILES = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task', 'Agent', 'Skill', 'SlashCommand', 'mcp__files__write_file']
const JUDGED_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']

longTest('a checkpoint that was refused pauses TCR, names each file with its rule, and commits and reverts nothing',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.workspace.refused = [{ path: '.env', rule: 'secret file name' }, { path: 'big.bin', rule: 'larger than 5 MB' }]
    await edit($, project, ['.env', 'big.bin'], 'f1')
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
    const said = told(project).filter(text => text.includes('TCR is unavailable') && text.includes('the checkpoint would commit'))
    expect(said.length).toBe(1)
    expect(said[0]).toContain('.env (secret file name)')
    expect(said[0]).toContain('big.bin (larger than 5 MB)')
    expect(said[0]).toContain('`tcr.allow` in .overwatch.json, or to .gitignore, and run git rm --cached on a file that git tracks, and commit the pending edit yourself')
    expect(said[0]).toContain('nothing was committed or reverted')
  })
})

longTest('a refusal that found a line of a file names the file and the line, as the Python hook does', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.workspace.refused = [{ path: 'src/a.py', rule: 'AWS access key', line: 12 }, { path: '.env', rule: 'secret file name', line: null }]
    await edit($, project, ['src/a.py', '.env'], 'f1')
    const said = told(project).filter(text => text.includes('the checkpoint would commit'))
    expect(said.length).toBe(1)
    expect(said[0]).toContain('`src/a.py:12 (AWS access key)`, `.env (secret file name)`')
  })
})

longTest('a refusal whose line is no line number is reported and pauses TCR', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.workspace.refused = [{ path: 'a.py', rule: 'AWS access key', line: 0 }]
    await edit($, project, ['a.py'], 'f1')
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('it must say'))).toBe(true)
  })
})

longTest('TCR resumes at the next turn start once the refused file is allowed or ignored',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.workspace.refused = [{ path: '.env', rule: 'secret file name' }]
    await edit($, project, ['.env'], 'f1')
    project.workspace.refused = []
    project.workspace.dirty = []
    project.workspace.committed = project.workspace.fingerprint
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(DECIDE_MS)
    await edit($, project, ['example.py'], 'f2')
    expect(project.workspace.commits).toEqual(['tcr: example.py'])
  })
})

longTest('a checkpoint answer that also lists no refusal is a plain commit', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.workspace.isNewShape = true
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: example.py'])
  })
})

longTest('a checkpoint answer whose commit is no sha is reported and pauses TCR',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.workspace.rawCheckpoint = { commit: 7 }
    await edit($, project, ['example.py'], 'f1')
    await project.clock.advance(SETTLE_MS)
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('it must say'))).toBe(true)
    expect(project.workspace.commits).toEqual([])
  })
})

longTest('a tcr setting that leaves saveReverted out still keeps the copy of what a revert removes', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f1')
    expect(told(project).some(text => text.includes('git checkout refs/overwatch/tcr/1 -- .'))).toBe(true)
    expect(project.workspace.flags.filter(flags => flags.includes('--no-save-ref'))).toEqual([])
  }, { settings: { mode: 'tcr', tcr: { allow: ['fixture.bin'] } } })
})

longTest('a checkpoint answer that is neither shape is reported and pauses TCR',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.workspace.refused = [{ path: 7 as unknown as string, rule: 'x' }]
    await edit($, project, ['example.py'], 'f1')
    await project.clock.advance(SETTLE_MS)
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('it must say'))).toBe(true)
  })
})

longTest('a slow question to the checkpoint command makes TCR unavailable and says why', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(1500)
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('took longer than'))).toBe(true)
  }, { env: SLOW, hang: 'reason' })
})

longTest('a slow fingerprint makes TCR unavailable instead of failing silently', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(1500)
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('took longer than'))).toBe(true)
  }, { env: SLOW, hang: 'fingerprint' })
})

longTest('a fingerprint that is too slow at a tool makes TCR unavailable and says why',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.workspace.hang = 'fingerprint'
    const call = $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(1500)
    await call
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('took longer than'))).toBe(true)
  }, { env: SLOW })
})

longTest('a check that runs past its limit holds the edit and the agent is told', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    await edit($, project, ['example.py'], 'f1')
    await project.clock.advance(1500)
    expect(project.workspace.commits).toEqual([])
    expect(told(project).some(text => text.includes('TCR left the latest change uncommitted') && text.includes('gave no result to judge by'))).toBe(true)
  }, { env: { OVERWATCH_TCR_TIMEOUT_SCALE: '0.002' }, hang: 'check' })
})

longTest('the limit of a whole judgement is longer than its slowest check and its slowest commit or revert together', () => {
  const questions = 5 * COMMAND_LIMITS_MS.fingerprint
  expect(JUDGEMENT_LIMIT_MS).toBeGreaterThanOrEqual(CHECK_TIMEOUT_MS + Math.max(COMMAND_LIMITS_MS.checkpoint, COMMAND_LIMITS_MS.revert) + questions)
  expect(JUDGEMENT_LIMIT_MS).toBeGreaterThan(CHECK_TIMEOUT_MS + COMMAND_LIMITS_MS.checkpoint)
})

longTest('a slow check and a slow commit, each within its own limit, are not stopped as one judgement that took too long',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(8000)
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
    expect(told(project).some(text => text.includes('took longer'))).toBe(false)
  }, { env: { OVERWATCH_TCR_TIMEOUT_SCALE: '0.01' }, judgeDelayMs: 5000, commandDelayMs: 1000 })
})

longTest('a settings read that never answers while an edit is judged ends at the limit of a read, which pauses TCR and commits nothing', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    project.workspace.settingsDelayMs = NEVER_MS
    await project.clock.advance(7000)
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes("a read of the project's files took longer than"))).toBe(true)
    expect(project.workspace.commits).toEqual([])
  }, { env: { OVERWATCH_TCR_TIMEOUT_SCALE: '0.004' } })
})

longTest('a revert whose log write never answers is told at once without the log, and the judgement is not stopped for taking too long', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.workspace.writeDelayMs = NEVER_MS
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(7000)
    expect(project.workspace.reverted).toEqual([['a.py']])
    expect(told(project).filter(text => text.includes('TCR reverted the latest change')).length).toBe(1)
    expect(told(project).some(text => text.includes('took longer than'))).toBe(false)
    expect(project.workspace.commits).toEqual([])
  }, { env: { OVERWATCH_TCR_TIMEOUT_SCALE: '0.004', HOME: '/home/me' } })
})

longTest('the notice of a revert does not wait for the write of its log', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.workspace.writeDelayMs = NEVER_MS
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(WRITE_LIMIT_MS)
    expect(told(project).filter(text => text.includes('TCR reverted the latest change')).length).toBe(1)
  }, { env: { OVERWATCH_TCR_TIMEOUT_SCALE: '0.04', HOME: '/home/me' } })
})

longTest('a branch named main gets a notice once, at the start of TCR',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(SETTLE_MS)
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).filter(text => text.includes('overwatch: TCR checkpoints land on main')).length).toBe(1)
  }, { branch: 'main' })
})

longTest('a branch with another name gets no notice', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).some(text => text.includes('TCR checkpoints land on'))).toBe(false)
  }, { branch: 'feature' })
})

const LINKED_GIT_DIRECTORIES = [
  { kind: 'worktree', pointer: 'gitdir: /home/me/main/.git/worktrees/repo', head: '/home/me/main/.git/worktrees/repo/HEAD' },
  { kind: 'submodule', pointer: 'gitdir: ../.git/modules/repo', head: '/.git/modules/repo/HEAD' },
]

for (const { kind, pointer, head } of LINKED_GIT_DIRECTORIES) {
  longTest(`a branch named main in a ${kind}, whose .git is a file, gets the notice`, async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(SETTLE_MS)
      expect(told(project).filter(text => text.includes('overwatch: TCR checkpoints land on main')).length).toBe(1)
    }, { prepare: workspace => { workspace.files.set('/repo/.git', `${pointer}\n`).set(head, 'ref: refs/heads/main\n') } })
  })
}

for (const tool of CAN_WRITE_FILES) {
  longTest(`a file written at ${tool} is judged or makes TCR unavailable, and is never settled unseen`, async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(DECIDE_MS)
      project.willChange(['written.py'], 'f1')
      await $.tool.call({ tool, file_path: '/repo/written.py' })
      await project.clock.advance(SETTLE_MS)
      const isJudged = JUDGED_TOOLS.includes(tool)
      expect(project.workspace.commits).toEqual(isJudged ? ['tcr: written.py'] : [])
      expect(told(project).some(text => text.includes('TCR is unavailable'))).toBe(!isJudged)
    })
  })
}

longTest('a project without checks commits nothing', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(CLEAN)
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.commits).toEqual([])
  }, { withoutChecks: true })
})

longTest('a revert that fails with a file left behind pauses TCR with what the command said and reverts nothing more', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.workspace.revertError = "the revert in /repo left ['late.py']; restore them by hand"
    await edit($, project, ['a.py'], 'f1')
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes("left ['late.py']; restore them by hand"))).toBe(true)
    expect(project.workspace.asked.filter(each => each === 'revert').length).toBe(1)
    expect(told(project).filter(text => text.includes('TCR reverted'))).toEqual([])
  })
})

longTest('files that change just before the revert are not reverted: TCR stops and asks no revert', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    during(project, 'fingerprint', 4, () => personWrites(project))
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.asked).not.toContain('revert')
    expect(project.workspace.reverted).toEqual([])
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('while TCR was committing, reverting'))).toBe(true)
  })
})

longTest('files that change just before the checkpoint are not committed: TCR stops and asks no checkpoint', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    during(project, 'fingerprint', 4, () => personWrites(project))
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.asked).not.toContain('checkpoint')
    expect(project.workspace.commits).toEqual([])
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('while TCR was committing, reverting'))).toBe(true)
  })
})

longTest('a file that lands as the revert finishes is told to the agent with the revert, and TCR stops', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.workspace.hooks['revert#1:after'] = () => personWrites(project)
    await edit($, project, ['a.py'], 'f1')
    expect(told(project).filter(text => text.includes('TCR reverted')).length).toBe(1)
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('while TCR was committing, reverting'))).toBe(true)
    expect(project.workspace.asked.filter(each => each === 'revert').length).toBe(1)
  })
})

longTest('a file that lands as the checkpoint finishes stops TCR instead of settling it unseen', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.workspace.hooks['checkpoint#1:after'] = () => personWrites(project)
    await edit($, project, ['a.py'], 'f1')
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('while TCR was committing, reverting'))).toBe(true)
  })
})

longTest('a revert whose aftermath cannot be read is still told with the ref that holds what it removed, and TCR stops', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.workspace.hooks['revert#1:after'] = () => { project.workspace.fingerprintError = 'git could not read the tree' }
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.saved).toEqual(['refs/overwatch/tcr/1'])
    const reverted = told(project).filter(text => text.includes('TCR reverted'))
    expect(reverted.length).toBe(1)
    expect(reverted[0]).toContain('refs/overwatch/tcr/1')
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('git could not read the tree'))).toBe(true)
  })
})

longTest('a revert that answers it could not inspect the files afterwards is told with its ref, and TCR stops with the reason', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.workspace.revertUnavailable = 'git could not read the saved ref'
    await edit($, project, ['a.py'], 'f1')
    const reverted = told(project).filter(text => text.includes('TCR reverted'))
    expect(reverted.length).toBe(1)
    expect(reverted[0]).toContain('refs/overwatch/tcr/1')
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('git could not read the saved ref'))).toBe(true)
  })
})

longTest('a bug that is no failure of the checkpoint command is not turned into the reason TCR is unavailable', async () => {
  const bug = new TypeError('a bug in the plugin')
  const engine = { env: { get: async () => undefined }, process: { spawn: () => { throw bug } } } as unknown as EngineInterface
  await expect(stateOf(engine, '/repo')).rejects.toBe(bug)
})

longTest('a revert says which submodules it left alone and does not stop TCR for the changes inside them', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.workspace.submodules = ['libs']
    await edit($, project, ['a.py'], 'f1')
    const reverted = told(project).filter(text => text.includes('TCR reverted'))
    expect(reverted.length).toBe(1)
    expect(reverted[0]).toContain('Restored: `a.py`. The files inside the submodules `libs` were not restored and still hold changes.')
    expect(told(project).filter(text => text.includes('TCR is unavailable'))).toEqual([])
  })
})

longTest('a bug while naming the files a check wrote is not hidden behind the generic reason', async () => {
  const bug = new TypeError('a bug in the plugin')
  const engine = { env: { get: async () => undefined }, process: { spawn: () => { throw bug } } } as unknown as EngineInterface
  await expect(changedWhileJudging(engine, '/repo', [], ['zanity'])).rejects.toBe(bug)
})

longTest('files git cannot list after the checks ran are reported as a change from outside, not as a failure', async () => {
  const child = { return: async () => undefined, result: Promise.resolve({ code: 0 }), [Symbol.asyncIterator]() { throw new Error('git could not start') } }
  const engine = { env: { get: async () => undefined }, clock: { after: () => ({ cancel: () => undefined }) }, process: { spawn: () => child } } as unknown as EngineInterface
  await expect(changedWhileJudging(engine, '/repo', [], ['zanity'])).resolves.toBe(OUTSIDE_CHANGE)
})

longTest('a checkpoint command that dies without printing is reported with its exit code', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('checkpoint.py reason') && text.includes('not JSON'))).toBe(true)
    expect(told(project).some(text => text.includes('exited 1'))).toBe(true)
  }, { prepare: workspace => { workspace.crash = { command: 'reason', code: 1 } } })
})
