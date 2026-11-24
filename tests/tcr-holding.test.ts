import { expect } from 'claude-code/testing'
import { CLEAN, WARNINGS, ZIG_GREEN, ZIG_RED, start } from './fixtures/tcr'
import { inSession, edit, during, personWrites, told, SETTLE_MS, DECIDE_MS, JUDGE_MS, WORSE, longTest } from './fixtures/tcr-session'
import { LINKED_LAYOUTS, PLAIN, commit, onMain, onMainIn, pull } from './fixtures/tcr-move'
import { QUIET_MS } from '../hooks/delivery'
import { readTcrSettings } from '../hooks/tcr-settings'

longTest('a held edit that is still what the files hold at the next turn start resumes TCR, and the next edit commits it too',  async ($, on) => {
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

longTest('an edit that the revert itself wiped is told with the revert and not settled over', async ($, on) => {
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
    expect(told(project).some(text => text.includes('TCR is unavailable'))).toBe(true)
  }, { commandDelayMs: 300 })
})

longTest('a held edit that the files no longer are at the next turn start does not resume TCR',  async ($, on) => {
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

longTest('a held edit is not resumed at the next turn start after someone else moved HEAD, since its baselines are gone',  async ($, on) => {
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

longTest('an edit made in the step that also moved HEAD is neither committed, held nor reverted, whatever the checks say', async ($, on) => {
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

for (const [kind, layout] of Object.entries({ 'plain repository': PLAIN, ...LINKED_LAYOUTS })) {
  longTest(`a failure that comes with a commit of the agent in a ${kind}, which TCR leaves unjudged, is told by the checks instead`, async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(DECIDE_MS)
      project.setReport(WARNINGS)
      commit(project, layout)
      await $.tool.call({ tool: 'Bash', command: 'echo warn >> a.py && git commit -qam break' })
      await project.clock.advance(SETTLE_MS)
      expect(project.workspace.commits).toEqual([])
      expect(project.workspace.reverted).toEqual([])
      expect(told(project).filter(text => text.includes('TCR reverted') || text.includes('TCR held'))).toEqual([])
      expect(told(project).some(text => text.includes('failed after') && text.includes('29 warnings'))).toBe(true)
    }, { prepare: onMainIn(layout) })
  })
}

longTest('a check that outlives its limit neither commits nor reverts the edit, which is held', async ($, on) => {
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

longTest('a held edit resumes at the next turn start whenever any one check is held, though another check passes',  async ($, on) => {
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

longTest('the checkpoint is asked to commit only the files that were judged', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.flags.filter(flags => flags.includes('--expect'))).toEqual([['--expect', 'f1']])
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
  })
})

longTest('files that change after the judgement and before the commit are not committed unjudged', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    during(project, 'checkpoint', 1, () => personWrites(project))
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.commits).toEqual([])
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('while TCR was committing, reverting'))).toBe(true)
  })
})

longTest('a checkpoint answer that says the files changed and also names a commit is reported and pauses TCR', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.workspace.rawCheckpoint = { commit: 'c'.repeat(40), refused: [], changed: true }
    await edit($, project, ['a.py'], 'f1')
    expect(told(project).some(text => text.includes('TCR is unavailable'))).toBe(true)
  })
})

longTest('a held edit does not resume TCR while another obstacle stands in its way',  async ($, on) => {
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

longTest('a check held for want of an earlier result stays held when it fails worse, and is never reverted for it',  async ($, on) => {
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

longTest('a held check that passes is judged by that pass: a failure after it is new and reverts',  async ($, on) => {
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
  ['a host limit of no time', { hostLimitSeconds: 0 }, "field 'tcr.hostLimitSeconds' is 0, not a finite number of seconds above zero"],
  ['a host limit that is no number', { hostLimitSeconds: true }, "field 'tcr.hostLimitSeconds' is True, not a finite number of seconds above zero"],
  ['a save setting that is no boolean', { saveReverted: 'yes' }, "field 'tcr.saveReverted' is 'yes', not a boolean; set it to true or false"],
]

for (const [what, tcr, wording] of BAD_SETTINGS) {
  longTest(`${what} in the settings of TCR pauses it with the Python hook's wording and commits nothing`, async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(DECIDE_MS)
      await edit($, project, ['a.py'], 'f1')
      expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes(`.overwatch.json ${wording}`))).toBe(true)
      expect(project.workspace.commits).toEqual([])
    }, { settings: { mode: 'tcr', tcr } })
  })
}

const TOO_LARGE_FOR_A_FLOAT = 1e999

longTest('a host limit that no finite number holds is refused with the engine\'s words, which write infinity as inf', () => {
  expect(TOO_LARGE_FOR_A_FLOAT).toBe(Number.POSITIVE_INFINITY)
  const refusal = (hostLimitSeconds: number) => { try { readTcrSettings({ mode: 'tcr', tcr: { hostLimitSeconds } }) } catch (error) { return String(error) } return 'accepted' }
  expect(refusal(TOO_LARGE_FOR_A_FLOAT)).toContain("field 'tcr.hostLimitSeconds' is inf, not a finite number of seconds above zero")
  expect(refusal(-TOO_LARGE_FOR_A_FLOAT)).toContain("field 'tcr.hostLimitSeconds' is -inf, not a finite number of seconds above zero")
  expect(refusal(1)).toBe('accepted')
})

const PYTHON_SPACES = [0x9, 0xa, 0xb, 0xc, 0xd, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]
const BYTE_ORDER_MARK = 0xfeff

longTest('an entry to allow that holds only the characters Python strips is refused, and one with the byte order mark is accepted, as the engine reads them', () => {
  const accepted = (entry: string) => { try { readTcrSettings({ mode: 'tcr', tcr: { allow: [entry] } }) } catch { return false } return true }
  const refused = PYTHON_SPACES.filter(point => accepted(String.fromCodePoint(point)))
  expect({ acceptedSpaces: refused, byteOrderMark: accepted(String.fromCodePoint(BYTE_ORDER_MARK)), padded: accepted(`${String.fromCodePoint(0x85)}.env${String.fromCodePoint(0x1c)}`), wildcards: accepted(`${String.fromCodePoint(0x1f)}*/${String.fromCodePoint(0x1f)}`) }).toEqual({ acceptedSpaces: [], byteOrderMark: true, padded: true, wildcards: false })
})

longTest('a tcr setting that is no object is reported with the fields it may hold', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).some(text => text.includes("field 'tcr' is [1], not an object; give it saveReverted, hostLimitSeconds, allow"))).toBe(true)
  }, { settings: { mode: 'tcr', tcr: [1] } })
})

longTest('every field TCR knows, set to a valid value, leaves it running', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
  }, { settings: { mode: 'tcr', tcr: { saveReverted: false, hostLimitSeconds: 30, allow: ['.env', 'fixtures/*'] } } })
})

longTest('a checker installed on the machine rather than in the project counts as a check', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.oneShots).toEqual(['zanity'])
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
  })
})

longTest('a held check that passes in an edit reverted for another check is not judged by that pass afterwards',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await edit($, project, ['a.py'], 'f1')
    expect(told(project).some(text => text.includes('TCR held the edit: zanity failed and has no earlier result'))).toBe(true)
    project.setReport(CLEAN)
    project.setZigReport(ZIG_RED)
    await edit($, project, ['b.py'], 'f2')
    expect(project.workspace.reverted).toEqual([['a.py', 'b.py']])
    project.setZigReport(ZIG_GREEN)
    await edit($, project, ['c.py'], 'f3')
    expect(project.workspace.reverted).toEqual([['a.py', 'b.py']])
    expect(told(project).filter(text => text.includes('TCR held the edit: zanity failed and has no earlier result')).length).toBe(2)
  }, { mute: true, withZig: true, initial: WARNINGS })
})

longTest('a held check that passes in an edit whose checkpoint TCR stopped for a change of the files is still held afterwards',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await edit($, project, ['a.py'], 'f1')
    project.setReport(CLEAN)
    during(project, 'checkpoint', 1, () => personWrites(project))
    await edit($, project, ['b.py'], 'f2')
    expect(project.workspace.commits).toEqual([])
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('while TCR was committing, reverting'))).toBe(true)
    project.workspace.dirty = []
    project.workspace.committed = project.workspace.fingerprint
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    project.setReport(WARNINGS)
    await edit($, project, ['c.py'], 'f3')
    expect(project.workspace.reverted).toEqual([])
    expect(told(project).filter(text => text.includes('TCR held the edit: zanity failed and has no earlier result')).length).toBe(2)
  }, { mute: true })
})

longTest('a read that never answers while a second edit is judged ends at the limit of a read, which leaves the held edit in a tree the next turn start finds unclean', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).some(text => text.includes('TCR held the edit: zanity failed and has no earlier result'))).toBe(true)
    during(project, 'fingerprint', 3, () => { project.workspace.settingsDelayMs = 5000 })
    project.willChange(['b.py'], 'f2')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/b.py' })
    await project.clock.advance(4000)
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes("a read of the project's files took longer than"))).toBe(true)
    project.workspace.settingsDelayMs = 0
    project.setReport(CLEAN)
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).filter(text => text.includes('uncommitted changes')).length).toBe(1)
    expect(told(project).filter(text => text.includes('TCR is unavailable')).length).toBe(2)
  }, { mute: true, env: { OVERWATCH_TCR_TIMEOUT_SCALE: '0.004' } })
})

longTest('a held edit that inherited failures keep from being committed is still the held edit at the next turn start',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await edit($, project, ['a.py'], 'f1')
    expect(told(project).some(text => text.includes('TCR held the edit: zanity failed and has no earlier result'))).toBe(true)
    project.setReport(CLEAN)
    await edit($, project, ['b.py'], 'f2')
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).filter(text => text.includes('uncommitted changes'))).toEqual([])
    expect(told(project).filter(text => text.includes('TCR is unavailable'))).toEqual([])
  }, { mute: true, withZig: true, zigInitial: ZIG_RED, settings: { mode: 'tcr', gate: { inherited: 'block' } } })
})

longTest('the edit that is held while a turn start still decides leaves that decision with TCR on', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(QUIET_MS)
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).some(text => text.includes('TCR held the edit: zanity failed and has no earlier result'))).toBe(true)
    expect(told(project).filter(text => text.includes('TCR is unavailable'))).toEqual([])
  }, { mute: true, reasonDelayMs: 300, judgeDelayMs: 100 })
})
