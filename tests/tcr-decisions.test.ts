import { expect } from 'claude-code/testing'
import { OUTSIDE_CHANGE } from '../hooks/tcr'
import { WARNINGS, ended, start, tcrProject } from './fixtures/tcr'
import { inSession, edit, told, toldPlain, START_MS, SETTLE_MS, END_MS, DECIDE_MS, JUDGE_MS, OFFLINE, WORSE, longTest } from './fixtures/tcr-session'

const OFFLINE_ELSEWHERE_LINE = 'dns error: failed to lookup address for other.example'
const OFFLINE_ELSEWHERE = `${OFFLINE_ELSEWHERE_LINE}\nzanity: 1 error, 0 warnings in 1 of 1 files\n`

longTest('an edit that keeps the checks green is committed as a checkpoint', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: example.py'])
    expect(project.workspace.reverted).toEqual([])
  })
})

longTest('an edit that adds a failure is reverted and the agent is told which failure and which files', async ($, on) => {
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

longTest('a watcher that stays silent for an edit does not hold the edit: its own run judges it',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['README.md'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: README.md'])
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f2')
    expect(project.workspace.reverted).toEqual([['example.py']])
  }, { silentWatcher: true })
})

longTest('a failure the session started with is left alone', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: example.py'])
    expect(project.workspace.reverted).toEqual([])
  }, { initial: WARNINGS })
})

longTest('a failure that returns after a revert is reverted and told again', async ($, on) => {
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

longTest('a tool that changes no file is never judged, a checkpoint or a revert, whatever its name',  async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await $.tool.call({ tool: 'Bash', command: 'git status' })
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.oneShots).toEqual([])
    expect(project.workspace.asked).not.toContain('checkpoint')
    expect(project.workspace.asked).not.toContain('revert')
  })
})

longTest('a tool that changes no file while an edit waits does not judge it again', async ($, on) => {
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

longTest('two edits made before the first is judged are judged once, together', async ($, on) => {
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

longTest('an edit made while the first is being judged cancels that judgement', async ($, on) => {
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

longTest('each new edit makes the judgement wait again until the files are quiet',  async ($, on) => {
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

longTest('a judgement started before a newer edit is never read as that edit\'s', async ($, on) => {
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

longTest('a watcher report that arrives after the agent\'s edit never stands for the edit being judged',  async ($, on) => {
  await inSession({ $, on }, async project => {
    project.willChange(['example.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/example.py' })
    project.setReport(WARNINGS)
    await project.clock.advance(SETTLE_MS + JUDGE_MS + END_MS)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([['example.py']])
  })
})

longTest('files that change while the checks judge the edit are acted on by nothing', async ($, on) => {
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

longTest('TCR does not start on a dirty tree and nothing is reverted',  async ($, on) => {
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

longTest('files that change at a tool that does not edit pause TCR until the next turn start', async ($, on) => {
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

const WATCHER_OUTPUT_IGNORED = '.coverage'
const WATCHER_OUTPUT_NOT_IGNORED = 'snapshots/page.snap'

longTest('a rerun of a watcher that writes a file git ignores pauses nothing, and the next edit is judged', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.willChange([WATCHER_OUTPUT_IGNORED], 'ignored-write')
    await $.tool.call({ tool: 'Read', file_path: '/repo/a.py' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).filter(text => text.includes('TCR is unavailable'))).toEqual([])
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
  }, { prepare: workspace => { workspace.ignored = [WATCHER_OUTPUT_IGNORED] } })
})

longTest('a rerun of a watcher that writes a file git does not ignore pauses TCR, names the file and says to add the output to .gitignore', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.willChange([WATCHER_OUTPUT_NOT_IGNORED], 'written')
    await $.tool.call({ tool: 'Read', file_path: '/repo/a.py' })
    await project.clock.advance(SETTLE_MS)
    const said = toldPlain(project).filter(text => text.includes('TCR is unavailable'))
    expect(said.length).toBe(1)
    expect(said[0]).toContain(`the files that differ from the last checkpoint are \`${WATCHER_OUTPUT_NOT_IGNORED}\``)
    expect(said[0]).toContain('add its output to .gitignore, and run git rm --cached on a file that git tracks')
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.commits).toEqual([])
  })
})

longTest('a change of the files that git lists no file for pauses TCR with the reason alone, and names no files', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.workspace.fingerprint = 'changed with no file listed'
    await $.tool.call({ tool: 'Read', file_path: '/repo/a.py' })
    await project.clock.advance(SETTLE_MS)
    const said = toldPlain(project).filter(text => text.includes('TCR is unavailable'))
    expect(said.length).toBe(1)
    expect(said[0]).toContain(OUTSIDE_CHANGE)
    expect(said[0]).not.toContain('the files that differ')
    expect(said[0]).not.toContain('.gitignore')
  })
})

longTest('a person\'s change seen at a tool that does not edit, while an edit waits, is never committed or reverted as the agent\'s', async ($, on) => {
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

longTest('a failed checkpoint commit pauses TCR and reverts nothing',  async ($, on) => {
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

longTest('a check that cannot run here neither commits nor reverts, and the agent is told', async ($, on) => {
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

longTest('a TCR notice sent in a turn that was told already brings no other waiting message with it',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(OFFLINE)
    await edit($, project, ['example.py'], 'f1')
    expect(told(project).filter(text => text.includes('these checks cannot run in this environment')).length).toBe(1)
    project.setReport(OFFLINE_ELSEWHERE)
    await edit($, project, ['example.py'], 'f2')
    expect(told(project).filter(text => text.includes('TCR left the latest change uncommitted')).length).toBe(2)
    expect(told(project).some(text => text.includes(OFFLINE_ELSEWHERE_LINE))).toBe(false)
    await $.turn.complete({ ...ended, turnId: 't1' })
    await $.turn.start({ text: 'next', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).some(text => text.includes(OFFLINE_ELSEWHERE_LINE))).toBe(true)
  })
})

longTest('the upstream check is not judged and never causes a revert',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: example.py'])
    expect(project.workspace.oneShots).toEqual(['zanity'])
  }, { withUpstream: true })
})

longTest('new upstream commits are told to the agent though TCR never judges the upstream check', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setUpstreamReport('new upstream commit 1084b40 three\norigin/main has 1 new commit; pull and rebase\n')
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
    expect(project.workspace.oneShots).toEqual([])
    expect(told(project).some(text => text.includes('origin/main has 1 new commit; pull and rebase'))).toBe(true)
  }, { withUpstream: true })
})

longTest('with inherited findings set to block, an edit that leaves one failing is neither committed nor reverted', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
  }, { initial: WARNINGS, settings: { mode: 'tcr', gate: { inherited: 'block' } } })
})

const MALFORMED_BLOCKING_GATE = { mode: 'tcr', gate: { inherited: 'block', protected_actions: 'x' } }

longTest('with a malformed gate, an edit that leaves an inherited finding failing is neither committed nor reverted, and the agent is told once', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
    expect(toldPlain(project).filter(text => text.includes('gate.protected_actions must be an array')).length).toBe(1)
  }, { initial: WARNINGS, settings: MALFORMED_BLOCKING_GATE })
})

longTest('with a malformed gate, an edit that adds a failure is not reverted',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['a.py'], 'f1')
    project.setReport(WORSE)
    await project.clock.advance(SETTLE_MS)
    await edit($, project, ['b.py'], 'f2')
    expect(project.workspace.reverted).toEqual([])
  }, { initial: WARNINGS, settings: MALFORMED_BLOCKING_GATE })
})

longTest('without the mode nothing is judged, committed, reverted or asked of git', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f1')
    expect(project.workspace.asked).toEqual([])
    expect(project.workspace.oneShots).toEqual([])
    expect(project.workspace.commits).toEqual([])
  }, { settings: {} })
})

longTest('an unknown mode is told to the user and nothing is committed or reverted', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f1')
    expect(project.toasts.some(text => text.includes('mode') && text.includes('tcr'))).toBe(true)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
  }, { settings: { mode: 'fast' } })
})

longTest('a prompt sent while an edit waits for its checks leaves TCR on, and the edit is committed', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await $.turn.start({ text: 'and also this', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).filter(text => text.includes('TCR is unavailable'))).toEqual([])
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
  })
})

longTest('a prompt sent while the checks of an edit run leaves TCR on, and the edit is judged by them',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(JUDGE_MS + DECIDE_MS)
    await $.turn.start({ text: 'and also this', turnId: 't2' })
    await project.clock.advance(SETTLE_MS * 2)
    expect(told(project).filter(text => text.includes('TCR is unavailable'))).toEqual([])
    expect(project.workspace.reverted).toEqual([['a.py']])
  }, { judgeDelayMs: 600 })
})

longTest('an edit made before the checks are found is judged once they are, and TCR does not say it has none', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(SETTLE_MS * 3)
    expect(told(project).filter(text => text.includes('no checks are configured'))).toEqual([])
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
  }, { findDelayMs: 2000 })
})
