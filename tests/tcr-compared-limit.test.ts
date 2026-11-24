import { expect } from 'claude-code/testing'
import { WARNINGS } from './fixtures/tcr'
import { beginEdit, inSession, toldPlain, DECIDE_MS, SETTLE_MS, longTest } from './fixtures/tcr-session'

const COMPARISON_LIMIT_MS = 20_000
const NEVER_MS = 3_600_000
const SHORT_MS = 1
const PAUSE_OPENING = "overwatch: TCR is unavailable: a read of the project's files took longer than 20s"

longTest('a read of the settings that never answers before an editing tool does not hold the tools of the batch past one limit, and TCR stops once',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.workspace.settingsDelayMs = NEVER_MS
    project.workspace.isSettingsDelayOnce = true
    const first = beginEdit($, project, ['a.py'], 'f1')
    const second = beginEdit($, project, ['b.py'], 'f2')
    first.end()
    second.end()
    await project.clock.advance(COMPARISON_LIMIT_MS - SHORT_MS)
    expect(project.workspace.dirty).toEqual([])
    await project.clock.advance(SHORT_MS * 2)
    await project.clock.advance(SETTLE_MS)
    await Promise.all([first.done, second.done])
    expect([...project.workspace.dirty, ...project.workspace.commits, ...project.workspace.reverted.flat()].some(name => name.includes('a.py'))).toBe(true)
    expect(toldPlain(project).filter(text => text.startsWith(PAUSE_OPENING)).length).toBe(1)
  })
})
