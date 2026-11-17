import { expect, test } from 'claude-code/testing'
import { WARNINGS, start, tcrProject } from './fixtures/tcr'
import { inSession, edit, told, START_MS, SETTLE_MS, END_MS, DECIDE_MS, JUDGE_MS, OFFLINE } from './fixtures/tcr-session'

test('an edit that keeps the checks green is committed as a checkpoint', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: example.py'])
    expect(project.workspace.reverted).toEqual([])
  })
})

test('an edit that adds a failure is reverted and the agent is told which failure and which files', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await edit($, project, ['example.py', 'extra.py'], 'f1')
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([['example.py', 'extra.py']])
    const reverted = project.prompts.filter(text => text.includes('TCR reverted'))
    expect(reverted.length).toBe(1)
    expect(reverted[0]).toContain('29 warnings')
    expect(reverted[0]).toContain('`example.py`')
    expect(reverted[0]).toContain('`extra.py`')
    expect(project.prompts.filter(text => text.includes('failed after the latest change'))).toEqual([])
  })
})

test('a watcher that stays silent for an edit does not hold the edit: its own run judges it', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['README.md'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: README.md'])
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f2')
    expect(project.workspace.reverted).toEqual([['example.py']])
  }, { silentWatcher: true })
})

test('a failure the session started with is left alone', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: example.py'])
    expect(project.workspace.reverted).toEqual([])
  }, { initial: WARNINGS })
})

test('a failure that returns after a revert is reverted and told again', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f1')
    await $.turn.start({ text: project.prompts[0] ?? '', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f2')
    expect(project.workspace.reverted.length).toBe(2)
    expect(told(project).filter(text => text.includes('TCR reverted')).length).toBe(2)
  })
})

test('a tool that changes no file is never judged, a checkpoint or a revert, whatever its name', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await $.tool.call({ tool: 'Bash', command: 'git status' })
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.oneShots).toEqual([])
    expect(project.workspace.asked).not.toContain('checkpoint')
    expect(project.workspace.asked).not.toContain('revert')
  })
})

test('a tool that changes no file while an edit waits does not judge it again', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(300)
    await $.tool.call({ tool: 'Bash', command: 'git status' })
    await project.clock.advance(300)
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
    expect(project.workspace.oneShots).toEqual(['zanity'])
  })
})

test('two edits made before the first is judged are judged once, together', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(100)
    project.willChange(['b.py'], 'f2')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/b.py' })
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.commits).toEqual(['tcr: a.py, b.py'])
    expect(project.workspace.oneShots).toEqual(['zanity'])
  })
})

test('an edit made while the first is being judged cancels that judgement', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(JUDGE_MS + 100)
    project.willChange(['b.py'], 'f2')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/b.py' })
    await project.clock.advance(SETTLE_MS + 400)
    expect(project.workspace.commits).toEqual(['tcr: a.py, b.py'])
  }, { judgeDelayMs: 300 })
})

test('each new edit makes the judgement wait again until the files are quiet', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(300)
    project.willChange(['b.py'], 'f2')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/b.py' })
    await project.clock.advance(300)
    expect(project.workspace.oneShots).toEqual([])
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.commits).toEqual(['tcr: a.py, b.py'])
  })
})

test('a judgement started before a newer edit is never read as that edit\'s', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(550)
    project.setReport(WARNINGS)
    project.willChange(['b.py'], 'f2')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/b.py' })
    await project.clock.advance(1900)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([['a.py', 'b.py']])
  }, { judgeDelayMs: 300 })
})

test('a watcher report that arrives after the agent\'s edit never stands for the edit being judged', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.willChange(['example.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/example.py' })
    project.setReport(WARNINGS)
    await project.clock.advance(SETTLE_MS + JUDGE_MS + END_MS)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([['example.py']])
  })
})

test('files that change while the checks judge the edit are acted on by nothing', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    project.willChange(['example.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/example.py' })
    await project.clock.advance(JUDGE_MS + 100)
    project.workspace.fingerprint = 'someone-else'
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
  }, { judgeDelayMs: 500 })
})

test('TCR does not start on a dirty tree and nothing is reverted', async ($, on) => {
  const project = tcrProject(on)
  project.workspace.dirty = ['mine.py']
  project.workspace.fingerprint = 'mine'
  try {
    await $.session.start(start)
    await project.clock.advance(START_MS)
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).some(text => text.includes('TCR is unavailable'))).toBe(true)
  } finally {
    const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
    await project.clock.advance(END_MS)
    await ending
  }
})

test('files that change at a tool that does not edit pause TCR until the next turn start', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.willChange(['mine.py'], 'mine')
    await $.tool.call({ tool: 'Read', file_path: '/repo/mine.py' })
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.reverted).toEqual([])
    expect(project.workspace.commits).toEqual([])
    project.workspace.dirty = []
    project.workspace.committed = project.workspace.fingerprint
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    await edit($, project, ['again.py'], 'f2')
    expect(project.workspace.reverted).toEqual([['again.py']])
  })
})

test('a person\'s change seen at a tool that does not edit, while an edit waits, is never committed or reverted as the agent\'s', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.willChange(['agent1.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/agent1.py' })
    project.willChange(['person.py'], 'p1')
    await $.tool.call({ tool: 'Read', file_path: '/repo/person.py' })
    project.willChange(['agent2.py'], 'f2')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/agent2.py' })
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.reverted).toEqual([])
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.dirty).toEqual(['agent1.py', 'person.py', 'agent2.py'])
  })
})

test('a failed checkpoint commit pauses TCR and reverts nothing', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.workspace.refusal = 'the checkpoint commit failed and its changes are left staged: refused'
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.commits).toEqual([])
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('left staged'))).toBe(true)
    project.setReport(WARNINGS)
    await edit($, project, ['again.py'], 'f2')
    expect(project.workspace.reverted).toEqual([])
  })
})

test('a check that cannot run here neither commits nor reverts, and the agent is told', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(OFFLINE)
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
    expect(told(project).some(text => text.includes('these checks cannot run in this environment'))).toBe(true)
    expect(told(project).some(text => text.includes('TCR left the latest change uncommitted'))).toBe(true)
  })
})

test('the upstream check is not judged and never causes a revert', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: example.py'])
    expect(project.workspace.oneShots).toEqual(['zanity'])
  }, { withUpstream: true })
})

test('with inherited findings set to block, an edit that leaves one failing is neither committed nor reverted', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
  }, { initial: WARNINGS, settings: { mode: 'tcr', gate: { inherited: 'block' } } })
})

test('without the mode nothing is judged, committed, reverted or asked of git', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.asked).toEqual([])
    expect(project.workspace.oneShots).toEqual([])
    expect(project.workspace.commits).toEqual([])
  }, { settings: {} })
})

test('an unknown mode is told to the user and nothing is committed or reverted', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f1')
    expect(project.toasts.some(text => text.includes('mode') && text.includes('tcr'))).toBe(true)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
  }, { settings: { mode: 'fast' } })
})
