import { expect, test } from 'claude-code/testing'
import { CLEAN, WARNINGS, start } from './fixtures/tcr'
import { inSession, edit, during, personWrites, told, SETTLE_MS, DECIDE_MS, JUDGE_MS, WORSE } from './fixtures/tcr-session'
import { onMain, pull } from './fixtures/tcr-move'

test('a held edit that is still what the files hold at the next turn start resumes TCR, and the next edit commits it too', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.commits).toEqual([])
    expect(told(project).some(text => text.includes('TCR held the edit'))).toBe(true)
    project.setReport(CLEAN)
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    await $.turn.start({ text: 'once more', turnId: 't3' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).filter(text => text.includes('TCR is unavailable'))).toEqual([])
    await edit($, project, ['b.py'], 'f2')
    expect(project.workspace.commits).toEqual(['tcr: a.py, b.py'])
  }, { mute: true })
})

test('an edit that the revert itself wiped is told with the revert and not settled over', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.workspace.hooks['revert#1:after'] = () => {
      project.workspace.dirty = []
      project.workspace.fingerprint = project.workspace.committed
    }
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(JUDGE_MS + 100)
    project.willChange(['b.py'], 'f2')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/b.py' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).filter(text => text.includes('TCR reverted')).length).toBe(1)
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('while TCR was committing, reverting'))).toBe(true)
  }, { commandDelayMs: 300 })
})

test('a held edit that the files no longer are at the next turn start does not resume TCR', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await edit($, project, ['a.py'], 'f1')
    project.setReport(CLEAN)
    personWrites(project)
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('uncommitted changes'))).toBe(true)
    await edit($, project, ['b.py'], 'f2')
    expect(project.workspace.commits).toEqual([])
  }, { mute: true })
})

test('a held edit is not resumed at the next turn start after someone else moved HEAD, since its baselines are gone', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await edit($, project, ['a.py'], 'f1')
    expect(told(project).some(text => text.includes('TCR held the edit'))).toBe(true)
    pull(project)
    await $.tool.call({ tool: 'Bash', command: 'git pull' })
    project.setReport(CLEAN)
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('uncommitted changes'))).toBe(true)
    await edit($, project, ['b.py'], 'f2')
    expect(project.workspace.commits).toEqual([])
  }, { mute: true, prepare: onMain })
})

test('an edit made in the step that also moved HEAD is neither committed, held nor reverted, whatever the checks say', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.willChange(['a.py'], 'f1')
    pull(project)
    await $.tool.call({ tool: 'Bash', command: 'git pull' })
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
    expect(told(project).filter(text => text.includes('TCR reverted') || text.includes('TCR held'))).toEqual([])
  }, { mute: true, prepare: onMain })
})

test('a check that outlives its limit neither commits nor reverts the edit, which is held', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await edit($, project, ['a.py'], 'f1')
    await project.clock.advance(1500)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
    expect(told(project).some(text => text.includes('gave no result to judge by'))).toBe(true)
  }, { env: { OVERWATCH_TCR_TIMEOUT_SCALE: '0.002' }, hang: 'check' })
})

test('a held edit resumes at the next turn start whenever any one check is held, though another check passes', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.commits).toEqual([])
    project.setReport(CLEAN)
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).filter(text => text.includes('TCR is unavailable'))).toEqual([])
    await edit($, project, ['b.py'], 'f2')
    expect(project.workspace.commits).toEqual(['tcr: a.py, b.py'])
  }, { mute: true, withZig: true })
})

test('the checkpoint is asked to commit only the files that were judged', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.flags.filter(flags => flags.includes('--expect'))).toEqual([['--expect', 'f1']])
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
  })
})

test('files that change after the judgement and before the commit are not committed unjudged', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    during(project, 'checkpoint', 1, () => personWrites(project))
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.commits).toEqual([])
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('while TCR was committing, reverting'))).toBe(true)
  })
})

test('a checkpoint answer that says the files changed and also names a commit is reported and pauses TCR', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.workspace.rawCheckpoint = { commit: 'c'.repeat(40), refused: [], changed: true }
    await edit($, project, ['a.py'], 'f1')
    expect(told(project).some(text => text.includes('TCR is unavailable'))).toBe(true)
  })
})

test('a held edit does not resume TCR while another obstacle stands in its way', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await edit($, project, ['a.py'], 'f1')
    project.workspace.reasonOverride = 'HEAD is detached, so a checkpoint would belong to no branch'
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('HEAD is detached'))).toBe(true)
  }, { mute: true })
})

test('a check held for want of an earlier result stays held when it fails worse, and is never reverted for it', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await edit($, project, ['a.py'], 'f1')
    project.unmute()
    await project.clock.advance(1000)
    project.setReport(WORSE)
    await edit($, project, ['b.py'], 'f2')
    expect(project.workspace.reverted).toEqual([])
    expect(project.workspace.commits).toEqual([])
    expect(told(project).filter(text => text.includes('TCR held the edit: zanity failed and has no earlier result')).length).toBeGreaterThan(0)
  }, { mute: true })
})

test('a held check that passes is judged by that pass: a failure after it is new and reverts', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await edit($, project, ['a.py'], 'f1')
    project.setReport(CLEAN)
    await edit($, project, ['b.py'], 'f2')
    expect(project.workspace.commits).toEqual(['tcr: a.py, b.py'])
    project.setReport(WARNINGS)
    await edit($, project, ['c.py'], 'f3')
    expect(project.workspace.reverted).toEqual([['c.py']])
  }, { mute: true })
})

const BAD_SETTINGS: [string, Record<string, unknown>, string][] = [
  ['an empty path to allow', { allow: ['ok', ''] }, "field 'tcr.allow' is ['ok', ''], not a list of paths or globs that name files; an entry may not be empty or only wildcards"],
  ['a blank path to allow', { allow: ['  '] }, "field 'tcr.allow' is ['  '], not a list of paths or globs that name files; an entry may not be empty or only wildcards"],
  ['a path to allow of only wildcards', { allow: ['**/*'] }, "field 'tcr.allow' is ['**/*'], not a list of paths or globs that name files; an entry may not be empty or only wildcards"],
  ['a path to allow of only wildcards that match one character', { allow: ['?[]'] }, "field 'tcr.allow' is ['?[]'], not a list of paths or globs that name files; an entry may not be empty or only wildcards"],
  ['paths to allow that are no list', { allow: '.env' }, "field 'tcr.allow' is '.env', not a list of paths or globs that name files; an entry may not be empty or only wildcards"],
  ['a path to allow that is no text', { allow: [7] }, "field 'tcr.allow' is [7], not a list of paths or globs that name files; an entry may not be empty or only wildcards"],
  ['a field TCR does not know', { saveReverted: true, bogus: 1 }, "field 'tcr' has unknown fields ['bogus']; use saveReverted, hostLimitSeconds, allow"],
  ['a host limit of no time', { hostLimitSeconds: 0 }, "field 'tcr.hostLimitSeconds' is 0, not a positive number of seconds"],
  ['a host limit that is no number', { hostLimitSeconds: true }, "field 'tcr.hostLimitSeconds' is True, not a positive number of seconds"],
  ['a save setting that is no boolean', { saveReverted: 'yes' }, "field 'tcr.saveReverted' is 'yes', not a boolean; set it to true or false"],
]

for (const [what, tcr, wording] of BAD_SETTINGS) {
  test(`${what} in the settings of TCR pauses it with the Python hook's wording and commits nothing`, async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(DECIDE_MS)
      await edit($, project, ['a.py'], 'f1')
      expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes(`.overwatch.json ${wording}`))).toBe(true)
      expect(project.workspace.commits).toEqual([])
    }, { settings: { mode: 'tcr', tcr } })
  })
}

test('a tcr setting that is no object is reported with the fields it may hold', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).some(text => text.includes("field 'tcr' is [1], not an object; give it saveReverted, hostLimitSeconds, allow"))).toBe(true)
  }, { settings: { mode: 'tcr', tcr: [1] } })
})

test('every field TCR knows, set to a valid value, leaves it running', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
  }, { settings: { mode: 'tcr', tcr: { saveReverted: false, hostLimitSeconds: 30, allow: ['.env', 'fixtures/*'] } } })
})

test('a checker installed on the machine rather than in the project counts as a check', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.oneShots).toEqual(['zanity'])
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
  })
})
