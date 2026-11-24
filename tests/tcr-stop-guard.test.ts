import { expect } from 'claude-code/testing'
import { WARNINGS, ended } from './fixtures/tcr'
import { commit, onMain } from './fixtures/tcr-move'
import { inSession, longTest, toldPlain, DECIDE_MS, SETTLE_MS } from './fixtures/tcr-session'

const GUARD = 'this action is guarded while relevant checks fail'
const FAILURE = '29 warnings'
const STOP_WHILE_JUDGED_MS = [700, 900]

for (const delay of STOP_WHILE_JUDGED_MS) {
  longTest(`a turn that completes ${delay}ms after an edit that adds a failure hears the revert once, and no guard about the failure the revert removed`, async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(DECIDE_MS)
      project.setReport(WARNINGS)
      project.willChange(['a.py'], 'f1')
      await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
      await project.clock.advance(delay)
      const stop = await $.turn.complete({ ...ended, turnId: 't1' })
      await project.clock.advance(SETTLE_MS)
      expect(project.workspace.reverted).toEqual([['a.py']])
      expect(stop).toEqual({ text: '' })
      expect(toldPlain(project).filter(text => text.includes(GUARD))).toEqual([])
      expect(toldPlain(project).filter(text => text.includes('TCR reverted') && text.includes(FAILURE)).length).toBe(1)
      expect(toldPlain(project).filter(text => text.includes(FAILURE)).length).toBe(1)
    })
  })
}

longTest('with inherited findings set to block, a turn that completes in TCR is still held for the inherited failure, which TCR does not judge', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    const stop = await $.turn.complete({ ...ended, turnId: 't1' })
    expect(stop.text).toContain(GUARD)
    expect(stop.text).toContain(FAILURE)
  }, { initial: WARNINGS, settings: { mode: 'tcr', gate: { inherited: 'block' } } })
})

longTest('a new commit upstream, which TCR never judges, still holds the end of a turn', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setUpstreamReport('new upstream commit 1084b40 three\norigin/main has 1 new commit; pull and rebase\n')
    await project.clock.advance(SETTLE_MS)
    const stop = await $.turn.complete({ ...ended, turnId: 't1' })
    expect(stop.text).toContain(GUARD)
    expect(stop.text).toContain('origin/main has 1 new commit')
  }, { withUpstream: true })
})

longTest('a turn that completes after the agent committed its own edit is held for a failure the checks report, which TCR left to them', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    commit(project)
    await $.tool.call({ tool: 'Bash', command: 'git commit --allow-empty -m x' })
    await project.clock.advance(SETTLE_MS)
    project.setReport(WARNINGS)
    await project.clock.advance(SETTLE_MS)
    const stop = await $.turn.complete({ ...ended, turnId: 't1' })
    expect(stop.text).toContain(GUARD)
    expect(stop.text).toContain(FAILURE)
  }, { prepare: onMain })
})

const CHECK_TICK_MS = 500
const PROTECTED_EDIT = { tool: 'Edit', file_path: '/repo/a.py' }

longTest('a protected tool is denied while a new failure stands that TCR tells, though the guard of the end of a turn says nothing of it', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await project.clock.advance(CHECK_TICK_MS + SETTLE_MS)
    const denied = (await $.tool.call(PROTECTED_EDIT)) as { deny?: string }
    expect(denied.deny).toContain(GUARD)
    expect(denied.deny).toContain(FAILURE)
    const stop = await $.turn.complete({ ...ended, turnId: 't1' })
    expect(stop).toEqual({ text: '' })
  }, { settings: { mode: 'tcr', gate: { protected_actions: [{ tool: 'Edit' }] } } })
})
