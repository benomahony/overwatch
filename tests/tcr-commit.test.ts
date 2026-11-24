import { expect } from 'claude-code/testing'
import { WARNINGS } from './fixtures/tcr'
import { commit, onMain } from './fixtures/tcr-move'
import { inSession, told, SETTLE_MS, DECIDE_MS, longTest } from './fixtures/tcr-session'

longTest('a regression in a step that commits one file and leaves another dirty is told once, by the revert and not also by the checks',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.willChange(['b.py'], 'f1')
    commit(project)
    await $.tool.call({ tool: 'Bash', command: 'echo x >> a.py && git commit -qam break a.py' })
    await project.clock.advance(SETTLE_MS * 5)
    expect(project.workspace.reverted).toEqual([['b.py']])
    expect(told(project).filter(text => text.includes('TCR reverted')).length).toBe(1)
    expect(told(project).filter(text => text.includes('failed after'))).toEqual([])
  }, { prepare: onMain, judgeDelayMs: 3000 })
})
