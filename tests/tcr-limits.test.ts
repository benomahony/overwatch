import { expect } from 'claude-code/testing'
import { COMMAND_LIMITS_MS } from '../hooks/tcr'
import { WARNINGS, ended } from './fixtures/tcr'
import { inSession, edit, beginEdit, beginShell, during, personWrites, told, SETTLE_MS, DECIDE_MS, END_MS, FINGERPRINT_MS, longTest } from './fixtures/tcr-session'

const OUTSIDE = 'files changed outside the agent'
const SUBAGENT = 'subagent-1'
const SCALE = 0.002
const FINGERPRINT_LIMIT_MS = COMMAND_LIMITS_MS.fingerprint * SCALE

longTest('a limit: an editing tool that begins while TCR\'s own revert runs finds the files changed, and the notice blames files changed outside the agent\'s edits', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    let second: ReturnType<typeof beginEdit> | undefined
    during(project, 'revert', 1, () => { second = beginEdit($, project, ['b.py'], 'f2') })
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.reverted).toEqual([['a.py']])
    expect(told(project).some(text => text.includes(OUTSIDE))).toBe(true)
    second?.end()
    await second?.done
  })
})

for (const [kind, tool] of [['an editing tool', 'Edit'], ['a shell command', 'Bash']] as const) {
  longTest(`a limit: a person's file written while ${kind} runs goes with the agent's checkpoint`, async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(DECIDE_MS)
      const running = tool === 'Bash' ? beginShell($, project, ['a.py'], 'f1') : beginEdit($, project, ['a.py'], 'f1')
      await project.clock.advance(0)
      personWrites(project)
      running.end()
      await running.done
      await project.clock.advance(SETTLE_MS)
      expect(project.workspace.commits).toEqual(['tcr: person.py, a.py'])
    })
  })
}

longTest('a limit: a person\'s file written while two editing tools run at once goes with the agent\'s checkpoint', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    const first = beginEdit($, project, ['a.py'], 'f1')
    await project.clock.advance(0)
    const second = beginEdit($, project, ['b.py'], 'f2')
    await project.clock.advance(0)
    personWrites(project)
    first.end()
    second.end()
    await Promise.all([first.done, second.done])
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.commits).toHaveLength(1)
    expect(project.workspace.commits[0]).toContain('person.py')
  })
})

longTest('a person\'s file written while an editing tool compares the files, with a second editing tool joined, is found by the comparison and goes with neither',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS + FINGERPRINT_MS)
    const first = beginEdit($, project, ['a.py'], 'f1')
    await project.clock.advance(0)
    const second = beginEdit($, project, ['b.py'], 'f2')
    await project.clock.advance(0)
    personWrites(project)
    await project.clock.advance(FINGERPRINT_MS)
    first.end()
    second.end()
    await project.clock.advance(SETTLE_MS)
    await Promise.all([first.done, second.done])
    expect(project.workspace.commits).toEqual([])
    expect(told(project).some(text => text.includes(OUTSIDE))).toBe(true)
  }, { fingerprintDelayMs: FINGERPRINT_MS })
})

longTest('two editing tools that begin together, the second ready to write at once, are judged and committed together, since the second waits for the comparison and does not change what it reads',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(SETTLE_MS)
    const first = beginEdit($, project, ['a.py'], 'f1')
    const second = beginEdit($, project, ['b.py'], 'f2')
    second.end()
    await project.clock.advance(FINGERPRINT_MS)
    first.end()
    await project.clock.advance(SETTLE_MS)
    await Promise.all([first.done, second.done])
    expect(project.workspace.commits).toEqual(['tcr: b.py, a.py'])
    expect(told(project).some(text => text.includes(OUTSIDE))).toBe(false)
  }, { fingerprintDelayMs: FINGERPRINT_MS })
})

longTest('a limit: a person\'s file written right after the comparison read the files, with a second editing tool joined, goes with the agent\'s checkpoint',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(SETTLE_MS)
    const asked = project.workspace.asked.filter(each => each === 'fingerprint').length
    project.workspace.hooks[`fingerprint#${asked + 1}:after`] = () => personWrites(project)
    const first = beginEdit($, project, ['a.py'], 'f1')
    const second = beginEdit($, project, ['b.py'], 'f2')
    await project.clock.advance(FINGERPRINT_MS)
    first.end()
    second.end()
    await project.clock.advance(SETTLE_MS)
    await Promise.all([first.done, second.done])
    expect(project.workspace.commits).toEqual(['tcr: person.py, a.py, b.py'])
  }, { fingerprintDelayMs: FINGERPRINT_MS })
})

longTest('a comparison of the files that fails with a bug still lets the editing tools of the batch run, tells the agent, and stops TCR, which then commits neither edit',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(SETTLE_MS)
    project.workspace.existsBug = new TypeError('a bug in the plugin')
    const first = beginEdit($, project, ['a.py'], 'f1')
    const second = beginEdit($, project, ['b.py'], 'f2')
    first.end()
    second.end()
    await project.clock.advance(FINGERPRINT_MS)
    await project.clock.advance(SETTLE_MS)
    await Promise.all([first.done, second.done])
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.dirty.sort()).toEqual(['a.py', 'b.py'])
    expect(told(project).some(text => text.includes('overwatch hit an unexpected error: HooksError: no implementation for fs.exists; TCR is paused'))).toBe(true)
  }, { fingerprintDelayMs: FINGERPRINT_MS })
})

longTest('a comparison of the files that runs past its limit does not keep the editing tools of a batch from running, nor make either wait longer than that one limit',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(SETTLE_MS)
    project.workspace.hang = 'fingerprint'
    const first = beginEdit($, project, ['a.py'], 'f1')
    const second = beginEdit($, project, ['b.py'], 'f2')
    first.end()
    second.end()
    await project.clock.advance(FINGERPRINT_LIMIT_MS + 1)
    expect(project.workspace.dirty).toEqual(['a.py', 'b.py'])
    project.workspace.hang = undefined
    await project.clock.advance(SETTLE_MS)
    await Promise.all([first.done, second.done])
    expect(told(project).some(text => text.includes('took longer than'))).toBe(true)
  }, { env: { OVERWATCH_TCR_TIMEOUT_SCALE: String(SCALE) } })
})

longTest('a limit: an editing tool call the host never ends keeps the later editing tools of the turn from comparing the files, so a person\'s file goes with the agent\'s checkpoint', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    const never = beginEdit($, project, ['c.py'], 'f3')
    await project.clock.advance(0)
    personWrites(project)
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: person.py, a.py'])
    expect(told(project).some(text => text.includes(OUTSIDE))).toBe(false)
    never.end()
    await project.clock.advance(SETTLE_MS)
    await never.done
  })
})

longTest('an editing tool that begins while another runs does not compare the files, which the running one may have written', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    const first = beginEdit($, project, ['a.py'], 'f1')
    await project.clock.advance(0)
    Object.assign(project.workspace, { dirty: ['a.py'], fingerprint: 'half' })
    const second = beginEdit($, project, ['b.py'], 'f2')
    await project.clock.advance(0)
    first.end()
    second.end()
    await Promise.all([first.done, second.done])
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.commits).toEqual(['tcr: a.py, b.py'])
  })
})

longTest('the completion of a subagent\'s turn leaves the main agent\'s running editing tool counted', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    beginEdit($, project, ['c.py'], 'f3')
    await project.clock.advance(0)
    await $.turn.complete({ ...ended, agentId: SUBAGENT })
    personWrites(project)
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: person.py, a.py'])
  })
})

longTest('a session that ends and resumes forgets the editing tool call the host never ended, so the guard for a person\'s file works again', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    await edit($, project, ['a.py'], 'f1')
    beginEdit($, project, ['c.py'], 'f3')
    await project.clock.advance(0)
    const ending = $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
    await project.clock.advance(END_MS)
    await ending
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(DECIDE_MS)
    personWrites(project)
    await edit($, project, ['b.py'], 'f2')
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
    expect(told(project).some(text => text.includes(OUTSIDE))).toBe(true)
  })
})

longTest('an editing tool that begins alone is not stopped by the write of another that began while it compared the files', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS + FINGERPRINT_MS)
    const first = beginEdit($, project, ['a.py'], 'f1')
    await project.clock.advance(0)
    project.willChange(['b.py'], 'f2')
    const second = $.tool.call({ tool: 'Edit', file_path: '/repo/b.py' })
    await project.clock.advance(FINGERPRINT_MS)
    first.end()
    await project.clock.advance(SETTLE_MS)
    await Promise.all([first.done, second])
    expect(told(project).some(text => text.includes(OUTSIDE))).toBe(false)
    expect(project.workspace.commits).toEqual(['tcr: b.py, a.py'])
  }, { fingerprintDelayMs: FINGERPRINT_MS })
})
