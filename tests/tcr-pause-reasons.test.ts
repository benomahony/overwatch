import { expect } from 'claude-code/testing'
import { WARNINGS } from './fixtures/tcr'
import { inSession, edit, toldPlain, DECIDE_MS, longTest } from './fixtures/tcr-session'

const FAILED_EXIT = 1
const TCR_MODE_NAME = 'tcr'
const UNDECIDED_NAME = 'undecided'
const REASONS = ['active', TCR_MODE_NAME, UNDECIDED_NAME, 'git']

for (const reason of REASONS) {
  longTest(`a revert that fails with the error text ${reason} pauses TCR, which tells the agent and reverts nothing more`,  async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(DECIDE_MS)
      project.setReport(WARNINGS)
      project.workspace.revertPrints = () => ({ code: FAILED_EXIT, text: JSON.stringify({ error: reason, saved: null, reset: 'failed' }) })
      await edit($, project, ['a.py'], 'f1')
      expect(toldPlain(project).some(text => text.includes(`overwatch: TCR is unavailable: ${reason}.`))).toBe(true)
      project.workspace.revertPrints = undefined
      await edit($, project, ['b.py'], 'f2')
      expect(project.workspace.asked.filter(each => each === 'revert').length).toBe(1)
    })
  })
}
