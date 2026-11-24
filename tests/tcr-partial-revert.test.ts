import { expect } from 'claude-code/testing'
import { WARNINGS, ended } from './fixtures/tcr'
import { inSession, edit, told, toldPlain, DECIDE_MS, SETTLE_MS, longTest, type Project } from './fixtures/tcr-session'

const REFUSED = 'the revert in /repo failed after it began to discard the work: git clean failed'
const STILL_CHANGED = 'Still changed'
const STEP_MS = 10
const UNRESTORED_NAMES = ['new.py', 'we`ird.py']
const LISTED = new Map([['new.py', '`new.py`'], ['we`ird.py', '`we\\x60ird.py`']])

async function failsRevertLeaving(project: Project, leaves: string[]) {
  await project.clock.advance(DECIDE_MS)
  project.setReport(WARNINGS)
  project.workspace.revertIncomplete = { error: REFUSED, resets: true, leaves }
}

for (const names of [['new.py'], UNRESTORED_NAMES]) {
  longTest(`a revert that failed after it reset a.py and left ${names.join(' and ')} says which files are still changed, and the turn is not completed over the failure`,  async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await failsRevertLeaving(project, names)
      project.willChange(['a.py', ...names], 'f1')
      await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
      while (!told(project).some(text => text.includes('TCR reverted'))) await project.clock.advance(STEP_MS)
      const completed = await $.turn.complete({ ...ended })
      expect(completed.text).toContain('this action is guarded while relevant checks fail')
      await project.clock.advance(SETTLE_MS)
      const reverted = toldPlain(project).filter(text => text.includes('TCR reverted'))
      expect(reverted).toHaveLength(1)
      expect(reverted[0]).toContain('Restored: `a.py`.')
      expect(reverted[0]).toContain(`${STILL_CHANGED}: ${names.map(name => LISTED.get(name)).join(', ')}.`)
    })
  })
}

longTest('a revert that failed after it reset every file says nothing is still changed, and the turn is completed',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await failsRevertLeaving(project, [])
    await edit($, project, ['a.py'], 'f1')
    await project.clock.advance(SETTLE_MS)
    const reverted = told(project).filter(text => text.includes('TCR reverted'))
    expect(reverted).toHaveLength(1)
    expect(reverted[0]).not.toContain(STILL_CHANGED)
    const completed = await $.turn.complete({ ...ended })
    expect(completed.text).not.toContain('this action is guarded while relevant checks fail')
  })
})
