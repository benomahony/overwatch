import { expect } from 'claude-code/testing'
import { WARNINGS, ended } from './fixtures/tcr'
import { inSession, edit, personWrites, longTest, toldPlain, WORSE, DECIDE_MS, END_MS, SETTLE_MS } from './fixtures/tcr-session'

const FAILURE = '29 warnings'
const WORSE_FAILURE = '31 warnings'
const CHECK_TICK_MS = 500
const RESULT_MS = 400

type Engine = Parameters<Parameters<typeof longTest>[1]>[0]
type Project = Parameters<Parameters<typeof inSession>[1]>[0]

/** The checks report a failure with no tool of the agent, and then print nothing more. */
async function failsOutside($: Engine, project: Project) {
  await $.turn.start({ text: 'go', turnId: 't1' })
  await project.clock.advance(DECIDE_MS)
  project.setReport(WARNINGS)
  await project.clock.advance(CHECK_TICK_MS + SETTLE_MS)
  project.workspace.silent = true
}

for (const tool of [{ tool: 'Read', file_path: '/repo/a.py' }, { tool: 'Bash', command: 'ls' }] as const) {
  longTest(`a failure of a change outside is told once at a next turn start though the agent ran ${tool.tool} in between, which changed no file`, async ($, on) => {
    await inSession({ $, on }, async project => {
      await failsOutside($, project)
      await $.tool.call(tool)
      await project.clock.advance(SETTLE_MS)
      await $.turn.start({ text: 'again', turnId: 't2' })
      await project.clock.advance(SETTLE_MS)
      await $.turn.start({ text: 'third', turnId: 't3' })
      await project.clock.advance(SETTLE_MS)
      expect(toldPlain(project).filter(text => text.includes(FAILURE)).length).toBe(1)
    })
  })
}

longTest('a turn that completes while a failure of a change outside is kept is not told that failure, and the next turn start tells it once', async ($, on) => {
  await inSession({ $, on }, async project => {
    await failsOutside($, project)
    const stop = await $.turn.complete({ ...ended, turnId: 't1' })
    await project.clock.advance(SETTLE_MS)
    expect(stop).toEqual({ text: '' })
    expect(toldPlain(project).filter(text => text.includes(FAILURE))).toEqual([])
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    expect(toldPlain(project).filter(text => text.includes(FAILURE)).length).toBe(1)
  })
})

longTest('limit: an edit of the agent that follows a failure of a change outside is reverted for that failure, which the notice names as the cause', async ($, on) => {
  await inSession({ $, on }, async project => {
    await failsOutside($, project)
    project.workspace.silent = false
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.reverted).toEqual([['a.py']])
    const notices = toldPlain(project).filter(text => text.includes('TCR reverted the latest change because') && text.includes(FAILURE))
    expect(notices.length).toBe(1)
  })
})

longTest('limit: a /clear does nothing in the plugin, so its watchers keep running and a failure told before it is not told again', async ($, on) => {
  await inSession({ $, on }, async project => {
    await failsOutside($, project)
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    expect(toldPlain(project).filter(text => text.includes(FAILURE)).length).toBe(1)
    const clearing = $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await project.clock.advance(END_MS)
    await clearing
    project.workspace.silent = false
    project.setReport(WORSE)
    await project.clock.advance(CHECK_TICK_MS + SETTLE_MS)
    await $.turn.start({ text: 'after the clear', turnId: 't3' })
    await project.clock.advance(SETTLE_MS)
    await $.tool.call({ tool: 'Read', file_path: '/repo/a.py' })
    await project.clock.advance(SETTLE_MS)
    expect(toldPlain(project).filter(text => text.includes(FAILURE)).length).toBe(1)
    expect(toldPlain(project).filter(text => text.includes(WORSE_FAILURE)).length).toBe(1)
  })
})

longTest('limit: a failure the checks report after TCR committed an edit green is not told at the end of the turn, and the next turn start tells it once', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
    project.setReport(WARNINGS)
    await project.clock.advance(CHECK_TICK_MS + SETTLE_MS)
    project.workspace.silent = true
    const stop = await $.turn.complete({ ...ended, turnId: 't1' })
    await project.clock.advance(SETTLE_MS)
    expect(stop).toEqual({ text: '' })
    expect(toldPlain(project).filter(text => text.includes(FAILURE))).toEqual([])
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    expect(toldPlain(project).filter(text => text.includes(FAILURE)).length).toBe(1)
  })
})

const GUARD = 'this action is guarded while relevant checks fail'

longTest('limit: a failure that TCR does not judge, which the guard told when the turn completed, reaches the agent as the message of the check one turn start later than it would without the guard', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    personWrites(project)
    await $.tool.call({ tool: 'Read', file_path: '/repo/person.py' })
    await project.clock.advance(SETTLE_MS)
    project.setReport(WARNINGS)
    await project.clock.advance(CHECK_TICK_MS + RESULT_MS)
    const stop = await $.turn.complete({ ...ended, turnId: 't1' })
    project.workspace.silent = true
    expect(stop.text).toContain(GUARD)
    const checkMessages = () => toldPlain(project).filter(text => text.includes(FAILURE) && !text.includes(GUARD)).length
    await $.turn.start({ text: stop.text ?? '', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    expect(checkMessages()).toBe(0)
    await $.turn.start({ text: 'next', turnId: 't3' })
    await project.clock.advance(SETTLE_MS)
    expect(checkMessages()).toBe(1)
  })
})
