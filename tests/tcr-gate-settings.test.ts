import { expect } from 'claude-code/testing'
import { CLEAN, WARNINGS, ended } from './fixtures/tcr'
import { edit, inSession, toldPlain, DECIDE_MS, SETTLE_MS, longTest } from './fixtures/tcr-session'

const OVERRIDE = '.overwatch.json'

type Case = { name: string; gate: unknown; says: string }

/** A gate the Python engine refuses with a message, which the plugin tells the agent in the same words. */
const CASES: Case[] = [
  { name: 'inherited is no known word', gate: { inherited: 'bogus' }, says: `gate.inherited must be one of ('allow', 'block'), not bogus; fix it in ${OVERRIDE}` },
  { name: 'protected_actions is no list', gate: { protected_actions: 'x' }, says: `gate.protected_actions must be an array, not x; fix it in ${OVERRIDE}` },
  { name: 'a command that is no regular expression', gate: { protected_actions: [{ tool: 'Edit', command: '(' }] }, says: "Edit's command ( is not a valid regular expression (" },
  { name: 'an action that names no tool', gate: { protected_actions: [{ command: 'x' }] }, says: `a protected action must name a tool, not None; set its tool in ${OVERRIDE}` },
  { name: 'checks that are no list', gate: { protected_actions: [{ tool: 'Edit', checks: 'zanity' }] }, says: `Edit's checks must be an array of check names, not zanity; fix them in ${OVERRIDE}` },
  { name: 'an action that is no object', gate: { protected_actions: [5] }, says: `gate.protected_actions entry 5 must be an object with a tool; fix it in ${OVERRIDE}` },
  { name: 'a gate that is no object', gate: 'x', says: `gate must be an object, not x; fix it in ${OVERRIDE}` },
]

for (const each of CASES) {
  for (const isTcr of [false, true]) {
    longTest(`${each.name}${isTcr ? ' with TCR on' : ''}: the agent is told as the Python engine tells it, and the tool and the turn go on, and TCR does nothing`,  async ($, on) => {
      const settings = { ...(isTcr ? { mode: 'tcr' } : {}), gate: each.gate }
      await inSession({ $, on }, async project => {
        await $.turn.start({ text: 'go', turnId: 't1' })
        await project.clock.advance(DECIDE_MS)
        project.setReport(isTcr ? CLEAN : WARNINGS)
        await project.clock.advance(SETTLE_MS)
        await edit($, project, ['a.py'], 'f1')
        if (isTcr) expect(project.workspace.commits).toEqual([])
        else expect(project.workspace.dirty).toEqual(['a.py'])
        const stop = await $.turn.complete(ended)
        expect(stop).toEqual({ text: ended.answer })
        expect(toldPlain(project).filter(text => text.includes(`overwatch: ${each.says}`)).length).toBeGreaterThan(0)
      }, { settings })
    })
  }
}

const GATE_UNUSABLE = 'overwatch: TCR is unavailable: the gate in .overwatch.json cannot be used; fix the file, or the gate setting that the gate message names if it names one, and commit any files that changed. Nothing is committed or reverted until it can start again at the start of a turn.'
const MALFORMED_GATE = { inherited: 'bogus' }

longTest('a gate that cannot be used with TCR on stops TCR with a notice, told once, and TCR starts again at a turn start once the gate is fixed and the files are committed',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(CLEAN)
    await project.clock.advance(SETTLE_MS)
    await edit($, project, ['a.py'], 'f1')
    await edit($, project, ['b.py'], 'f2')
    expect(project.workspace.commits).toEqual([])
    expect(toldPlain(project).filter(text => text.includes(GATE_UNUSABLE)).length).toBe(1)
    project.setSettings({ mode: 'tcr' })
    project.workspace.dirty = []
    project.workspace.fingerprint = project.workspace.committed
    await $.turn.complete(ended)
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(DECIDE_MS)
    await edit($, project, ['c.py'], 'f3')
    expect(project.workspace.commits).toEqual(['tcr: c.py'])
  }, { settings: { mode: 'tcr', gate: MALFORMED_GATE } })
})

const TCR_IS_ON = 'overwatch: TCR is on'
const TURNS = 3

longTest('a gate that stays malformed across turns, with the files committed between them, tells that TCR is unavailable once, never that it is on, and says what to fix and commit',  async ($, on) => {
  await inSession({ $, on }, async project => {
    for (let turn = 1; turn <= TURNS; turn += 1) {
      await $.turn.start({ text: `turn ${turn}`, turnId: `t${turn}` })
      await project.clock.advance(DECIDE_MS)
      project.setReport(CLEAN)
      await project.clock.advance(SETTLE_MS)
      await edit($, project, [`${turn}.py`], `f${turn}`)
      project.workspace.dirty = []
      project.workspace.fingerprint = project.workspace.committed
      await $.turn.complete(ended)
    }
    const told = toldPlain(project)
    expect(told.filter(text => text.includes(TCR_IS_ON)).length).toBe(0)
    expect(told.filter(text => text.includes(GATE_UNUSABLE)).length).toBe(1)
    expect(project.workspace.commits).toEqual([])
  }, { settings: { mode: 'tcr', gate: MALFORMED_GATE } })
})

longTest('a gate that becomes malformed during a turn stops TCR at the next edit with the notice, which leaves the edit uncommitted', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(CLEAN)
    await project.clock.advance(SETTLE_MS)
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
    project.setSettings({ mode: 'tcr', gate: MALFORMED_GATE })
    await edit($, project, ['b.py'], 'f2')
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
    expect(project.workspace.dirty).toEqual(['b.py'])
    expect(toldPlain(project).filter(text => text.includes(GATE_UNUSABLE)).length).toBe(1)
  }, { settings: { mode: 'tcr' } })
})

longTest('a gate that becomes malformed between an edit and its judgement stops TCR before the checks judge it', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(CLEAN)
    await project.clock.advance(SETTLE_MS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    project.setSettings({ mode: 'tcr', gate: 'x' })
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.dirty).toEqual(['a.py'])
    expect(toldPlain(project).filter(text => text.includes(GATE_UNUSABLE)).length).toBe(1)
  }, { settings: { mode: 'tcr' } })
})

longTest('a gate that was good in the turn before and is malformed at a turn start stops TCR at that start, before any edit, and the edit that follows is neither committed nor reverted', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'first', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(CLEAN)
    await project.clock.advance(SETTLE_MS)
    await $.turn.complete(ended)
    project.setSettings({ mode: 'tcr', gate: MALFORMED_GATE })
    await $.turn.start({ text: 'second', turnId: 't2' })
    await project.clock.advance(DECIDE_MS)
    await project.clock.advance(SETTLE_MS)
    expect(toldPlain(project).filter(text => text.includes(GATE_UNUSABLE)).length).toBe(1)
    project.setReport(WARNINGS)
    await edit($, project, ['a.py'], 'f1')
    expect({ commits: project.workspace.commits, reverted: project.workspace.reverted }).toEqual({ commits: [], reverted: [] })
  })
})
