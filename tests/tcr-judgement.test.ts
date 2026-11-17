import { expect, test } from 'claude-code/testing'
import { CLEAN, WARNINGS } from './fixtures/tcr'
import { inSession, edit, during, personWrites, told, SETTLE_MS, DECIDE_MS } from './fixtures/tcr-session'

test('an edit held for a check that gave no result resumes at the next turn start while the files are still that edit', async ($, on) => {
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

test('a held edit whose contents changed while its size and time did not does not resume TCR', async ($, on) => {
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

test('the revert is asked to restore only the files that were judged', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.flags.filter(flags => flags.includes('--expect'))).toEqual([['--expect', 'f1']])
    expect(project.workspace.reverted).toEqual([['a.py']])
  })
})

test('a file a person writes just before the revert is not reverted, and TCR stops', async ($, on) => {
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

test('the revert message names both files of a staged rename as they are', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await edit($, project, ['R  new_name.py\0old_name.py'], 'f1')
    const reverted = project.prompts.filter(text => text.includes('TCR reverted'))
    expect(reverted.length).toBe(1)
    expect(reverted[0]).toContain('`new_name.py`')
    expect(reverted[0]).toContain('`old_name.py`')
  })
})

