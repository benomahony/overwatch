import { expect } from 'claude-code/testing'
import { CHANGED_WHILE_ACTING } from '../hooks/pausing'
import { CLEAN, WARNINGS } from './fixtures/tcr'
import { inSession, edit, beginEdit, during, personWrites, told, SETTLE_MS, DECIDE_MS, longTest } from './fixtures/tcr-session'

longTest('an edit held for a check that gave no result resumes at the next turn start while the files are still that edit',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    await edit($, project, ['a.py'], 'f1')
    await project.clock.advance(1500)
    expect(told(project).some(text => text.includes('gave no result to judge by'))).toBe(true)
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).filter(text => text.includes('TCR is unavailable'))).toEqual([])
  }, { env: { OVERWATCH_TCR_TIMEOUT_SCALE: '0.002' }, hang: 'check' })
})

longTest('a held edit whose contents changed while its size and time did not does not resume TCR',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await edit($, project, ['a.py'], 'f1')
    project.setReport(CLEAN)
    project.workspace.content = 'rewritten by a person'
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('uncommitted changes'))).toBe(true)
  }, { mute: true })
})

longTest('the revert is asked to restore only the files that were judged', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.flags.filter(flags => flags.includes('--expect'))).toEqual([['--expect', 'f1']])
    expect(project.workspace.reverted).toEqual([['a.py']])
  })
})

longTest('a file a person writes just before the revert is not reverted, and TCR stops', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    during(project, 'revert', 1, () => personWrites(project))
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.reverted).toEqual([])
    expect(project.workspace.dirty).toContain('person.py')
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('while TCR was committing, reverting'))).toBe(true)
  })
})

longTest('the revert message names both files of a staged rename as they are', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await edit($, project, ['R  new_name.py\0old_name.py'], 'f1')
    const reverted = project.prompts.filter(text => text.includes('TCR reverted'))
    expect(reverted.length).toBe(1)
    expect(reverted[0]).toContain('`new_name.py`')
    expect(reverted[0]).toContain('`old_name.py`')
  })
})

longTest('an edit of the agent that lands while the turn start decides is judged with the edit that waited, and TCR stays on', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.willChange(['first.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/first.py' })
    const second = beginEdit($, project, ['second.py'], 'f2')
    await project.clock.advance(0)
    const starting = $.turn.start({ text: 'again', turnId: 't2' })
    second.end()
    await starting
    await second.done
    await project.clock.advance(SETTLE_MS)
    expect(told(project).filter(text => text.includes('TCR is unavailable'))).toEqual([])
    expect(project.workspace.commits).toEqual(['tcr: first.py, second.py'])
  })
})

longTest('the first edit of a turn that lands while the turn start decides whether TCR can run stops TCR until the next turn start, with nothing committed or reverted', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.willChange(['first.py'], 'f1')
    const starting = $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'Edit', file_path: '/repo/first.py' })
    await starting
    await project.clock.advance(SETTLE_MS)
    expect(told(project).filter(text => text.includes('TCR is unavailable') && text.includes(CHANGED_WHILE_ACTING)).length).toBe(1)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
  })
})


const UNCLEAN = 'the working tree has uncommitted changes that a revert would discard'

async function firstEditBeforeTheDecision($: Parameters<typeof edit>[0], project: Parameters<typeof edit>[1]) {
  project.willChange(['first.py'], 'f1')
  const starting = $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/first.py' })
  await starting
  await project.clock.advance(SETTLE_MS)
}

longTest('after the first edit of a turn landed before the turn start decided, a later edit and the next turn start leave the tree uncommitted, and the notice says why',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await firstEditBeforeTheDecision($, project)
    await edit($, project, ['second.py'], 'f2')
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    await edit($, project, ['third.py'], 'f3')
    expect(project.workspace.dirty).toEqual(['first.py', 'second.py', 'third.py'])
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
    expect(told(project).filter(text => text.includes('TCR is unavailable') && text.includes(UNCLEAN)).length).toBeGreaterThan(0)
  })
})

longTest('after the first edit of a turn landed before the turn start decided, TCR is back at the next turn start once the person committed the tree',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await firstEditBeforeTheDecision($, project)
    Object.assign(project.workspace, { dirty: [], fingerprint: 'clean', committed: 'clean' })
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    await edit($, project, ['second.py'], 'f2')
    expect(project.workspace.commits).toEqual(['tcr: second.py'])
  })
})
