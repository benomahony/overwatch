import { expect } from 'claude-code/testing'
import { WARNINGS, ended, type Workspace } from './fixtures/tcr'
import { inSession, edit, told, DECIDE_MS, SETTLE_MS, longTest } from './fixtures/tcr-session'

const TIMEOUT_ENV = { OVERWATCH_TCR_TIMEOUT_SCALE: '0.002' }
const KEEPS_NOTHING = { mode: 'tcr', tcr: { saveReverted: false } }
const LATER_STEP = 'the revert in /repo failed after it began to discard the work: git clean failed'
const UNREADABLE = 'git could not read the tree'

/**
 * One way a revert fails, which `fails` says the command itself does, as against a revert that worked and a later call that failed, and `isUnnamed` that it names no ref for the copy it saved, so the notice says how to find it. `isReported` says whether the command printed
 * how the reset ended, which is all the plugin claims a revert by: with no such answer it makes no claim, however the revert went. `isUnreadable` says git cannot list the files afterwards, and `isWritten` that a person wrote before it does.
 */
type Fault = { name: string; arrange: (workspace: Workspace) => void; settings?: Record<string, unknown>; hang?: 'revert'; isReported: boolean; fails: boolean; isUnnamed?: boolean; isWritten?: boolean; isUnreadable?: boolean }

const failsAfter = (workspace: Workspace) => { workspace.hooks['revert#1:after'] = () => { workspace.fingerprintError = UNREADABLE } }
const writesAfter = (workspace: Workspace) => { workspace.hooks['revert#1:after'] = () => { workspace.dirty = [...workspace.dirty, 'person.py']; workspace.fingerprint = 'person' } }

const FAULTS: Fault[] = [
  { name: 'a step after the reset failed', arrange: workspace => { workspace.revertIncomplete = { error: LATER_STEP, resets: true } }, isReported: true, fails: true },
  { name: 'git refused the reset', arrange: workspace => { workspace.revertIncomplete = { error: LATER_STEP, resets: false } }, isReported: true, fails: true },
  { name: 'a step after the reset failed and no copy is kept', arrange: workspace => { workspace.revertIncomplete = { error: LATER_STEP, resets: true } }, settings: KEEPS_NOTHING, isReported: true, fails: true },
  { name: 'git refused the reset and no copy is kept', arrange: workspace => { workspace.revertIncomplete = { error: LATER_STEP, resets: false } }, settings: KEEPS_NOTHING, isReported: true, fails: true },
  { name: 'a bug made the revert fail after the reset', arrange: workspace => { workspace.revertIncomplete = { error: 'injected', resets: true, asBug: true } }, isReported: false, fails: true, isUnnamed: true },
  { name: 'a bug made the revert fail before the reset', arrange: workspace => { workspace.revertIncomplete = { error: 'injected', resets: false, asBug: true } }, isReported: false, fails: true, isUnnamed: true },
  { name: 'a step after the reset failed and the files cannot be read', arrange: workspace => { workspace.revertIncomplete = { error: LATER_STEP, resets: true }; failsAfter(workspace) }, isReported: true, isUnreadable: true, fails: true },
  { name: 'git refused the reset and the files cannot be read', arrange: workspace => { workspace.revertIncomplete = { error: LATER_STEP, resets: false }; failsAfter(workspace) }, isReported: true, isUnreadable: true, fails: true },
  { name: 'the command died without an answer', arrange: workspace => { workspace.crash = { command: 'revert', code: 1 } }, isReported: false, fails: true, isUnnamed: true },
  { name: 'the command ran past its limit', arrange: () => undefined, hang: 'revert', isReported: false, fails: true, isUnnamed: true },
  { name: 'a step after the reset failed and a person wrote before the files were read again', arrange: workspace => { workspace.revertIncomplete = { error: LATER_STEP, resets: true }; writesAfter(workspace) }, isReported: true, fails: true, isWritten: true },
  { name: 'git refused the reset and a person wrote before the files were read again', arrange: workspace => { workspace.revertIncomplete = { error: LATER_STEP, resets: false }; writesAfter(workspace) }, isReported: true, fails: true, isWritten: true },
  { name: 'a bug made the revert fail before the reset and a person wrote before the files were read again', arrange: workspace => { workspace.revertIncomplete = { error: 'injected', resets: false, asBug: true }; writesAfter(workspace) }, isReported: false, fails: true, isUnnamed: true, isWritten: true },
  { name: 'the revert worked and the files cannot be read afterwards', arrange: failsAfter, isReported: true, isUnreadable: true, fails: false },
  { name: 'the revert worked and git could not inspect the files, as it answers', arrange: workspace => { workspace.revertUnavailable = UNREADABLE }, isReported: true, fails: false },
]

const RESTORED_LIST = /Restored: (.*?)`\. /

/**
 * The plugin's own class check of a revert that fails: for each failure of the command and of the calls after it, the notice
 * says TCR reverted if and only if the files were reset and could be read again, names every ref that saved the work, TCR
 * is unavailable, and the next turn start turns it on only for a clean tree.
 */
for (const fault of FAULTS) {
  longTest(`${fault.name}: TCR says it reverted only when the files were reset, names the saved ref, and resumes only on a clean tree`,  async ($, on) => {
    await inSession({ $, on }, async project => {
      const { workspace } = project
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(DECIDE_MS)
      project.setReport(WARNINGS)
      fault.arrange(workspace)
      await edit($, project, ['a.py'], 'f1')
      const texts = told(project)
      const isReset = workspace.reverted.length > 0
      const isClaimable = fault.isReported && isReset
      const claims = texts.filter(text => text.includes('TCR reverted')).length
      expect({ fault: fault.name, claims }).toEqual({ fault: fault.name, claims: isClaimable ? 1 : 0 })
      const tried = texts.filter(text => text.includes('TCR tried to revert')).length
      expect({ fault: fault.name, tried }).toEqual({ fault: fault.name, tried: fault.fails && !isClaimable ? 1 : 0 })
      const unrevertedText = texts.find(text => text.includes('TCR tried to revert'))
      if (unrevertedText !== undefined) {
        expect(unrevertedText).not.toContain('The files are unchanged')
        expect(unrevertedText).toContain(fault.isUnreadable ? 'Git could not list the files now.' : '`git status` shows the present state.')
        expect(unrevertedText.includes('git failed')).toBe(fault.isReported)
      }
      for (const claim of texts.filter(text => text.includes('TCR reverted'))) expect(RESTORED_LIST.exec(claim)?.[1]).not.toContain('person.py')
      if (fault.isUnnamed) expect(texts.some(text => text.includes('git for-each-ref refs/overwatch/reverted'))).toBe(true)
      for (const ref of workspace.saved) expect(texts.some(text => text.includes(ref))).toBe(true)
      expect(texts.some(text => text.includes('TCR is unavailable'))).toBe(true)
      expect(workspace.asked.filter(each => each === 'revert').length).toBe(1)
      workspace.fingerprintError = undefined
      workspace.revertIncomplete = undefined
      const before = texts.filter(text => text.includes('TCR is on')).length
      await $.turn.start({ text: 'again', turnId: 't2' })
      await project.clock.advance(SETTLE_MS)
      const resumed = told(project).filter(text => text.includes('TCR is on')).length > before
      expect({ fault: fault.name, resumed }).toEqual({ fault: fault.name, resumed: workspace.dirty.length === 0 })
    }, { settings: fault.settings, hang: fault.hang, env: fault.hang === undefined ? {} : TIMEOUT_ENV })
  })
}

longTest('a limit: a revert that failed after the reset says nothing of the staged version in its ref or of the submodules it left alone', async ($, on) => {
  await inSession({ $, on }, async project => {
    const { workspace } = project
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    workspace.revertIncomplete = { error: LATER_STEP, resets: true }
    workspace.staged = true
    workspace.submodules = ['libs']
    await edit($, project, ['a.py'], 'f1')
    const reverted = told(project).filter(text => text.includes('TCR reverted'))
    expect(reverted.length).toBe(1)
    expect(reverted[0]).toContain('refs/overwatch/tcr/1')
    expect(reverted[0]).not.toContain('^2')
    expect(reverted[0]).not.toContain('submodules')
  })
})

const STALE_REPORT = 'after a change made outside this session'

for (const [name, revertIncomplete] of [['a revert that worked', undefined], ['a revert that failed after it reset the files', { error: LATER_STEP, resets: true }]] as const) {
  longTest(`${name} leaves no message about the failure that caused it, which the files no longer have`,  async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(DECIDE_MS)
      project.setReport(WARNINGS)
      project.workspace.revertIncomplete = revertIncomplete
      await edit($, project, ['a.py'], 'f1')
      await project.clock.advance(SETTLE_MS)
      expect(project.workspace.reverted).toEqual([['a.py']])
      expect(told(project).filter(text => text.includes(STALE_REPORT))).toEqual([])
    })
  })
}

longTest('a revert that failed without resetting the files keeps the failure, so the turn is not completed over it',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.workspace.revertIncomplete = { error: LATER_STEP, resets: false }
    await edit($, project, ['a.py'], 'f1')
    await project.clock.advance(SETTLE_MS)
    const completed = await $.turn.complete({ ...ended })
    expect(project.workspace.reverted).toEqual([])
    expect(completed.text).toContain('this action is guarded while relevant checks fail')
  })
})
