import { expect } from 'claude-code/testing'
import { CLEAN, WARNINGS } from './fixtures/tcr'
import { inSession, toldPlain, DECIDE_MS, SETTLE_MS, longTest } from './fixtures/tcr-session'

const NEVER_PLAYED_MS = 600_000
const LIMIT_NOTICE = 'a read of the project\'s files took longer than 20s'
const GUARDED_EDIT = { mode: 'tcr', gate: { protected_actions: [{ tool: 'Edit' }] } }

longTest('a read of the settings that never answers after a tool ran does not keep the tool call from returning, and pauses TCR once',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(CLEAN)
    project.workspace.settingsAnswers = 1
    project.willChange(['a.py'], 'f1')
    const call = $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(NEVER_PLAYED_MS)
    await expect(call).resolves.toBeDefined()
    expect(toldPlain(project).filter(text => text.includes(`TCR is unavailable: ${LIMIT_NOTICE}`)).length).toBe(1)
    expect(project.workspace.commits).toEqual([])
  })
})

longTest('a read of the settings that never answers before a guarded tool does not keep the tool call from returning, which runs, and the agent is told',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await project.clock.advance(SETTLE_MS)
    project.workspace.settingsAnswers = 0
    project.willChange(['a.py'], 'f1')
    const call = $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(NEVER_PLAYED_MS)
    await expect(call).resolves.toBeDefined()
    expect(project.workspace.dirty).toEqual(['a.py'])
    expect(toldPlain(project).some(text => text.includes(LIMIT_NOTICE))).toBe(true)
  }, { settings: GUARDED_EDIT })
})
