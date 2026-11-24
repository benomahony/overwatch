import { expect } from 'claude-code/testing'
import { WARNINGS, ended } from './fixtures/tcr'
import { inSession, edit, beginEdit, during, personWrites, told, SETTLE_MS, DECIDE_MS, FINGERPRINT_MS, longTest } from './fixtures/tcr-session'

const SLOW_DECISION_MS = 300
const OUTSIDE = 'files changed outside the agent'

for (const [verdict, report] of [['green', undefined], ['red', WARNINGS]] as const) {
  longTest(`a person's file written while an edit waits, before a prompt arrives, is neither committed nor reverted with the next ${verdict} edit`, async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(DECIDE_MS)
      if (report !== undefined) project.setReport(report)
      project.willChange(['a.py'], 'f1')
      await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
      personWrites(project)
      await $.turn.start({ text: 'and also this', turnId: 't2' })
      await project.clock.advance(DECIDE_MS)
      project.willChange(['b.py'], 'f2')
      await $.tool.call({ tool: 'Edit', file_path: '/repo/b.py' })
      await project.clock.advance(SETTLE_MS)
      expect(project.workspace.commits).toEqual([])
      expect(project.workspace.reverted).toEqual([])
      expect(project.workspace.dirty).toEqual(['a.py', 'person.py', 'b.py'])
    })
  })
}

longTest('a person\'s file written between two edits of the agent, before the second begins, is neither committed nor reverted with it', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    personWrites(project)
    project.willChange(['b.py'], 'f2')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/b.py' })
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
    expect(told(project).some(text => text.includes(OUTSIDE))).toBe(true)
  })
})

longTest('a person\'s file written since the last edit, before two editing tools begin together, is neither committed nor reverted with them',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(SETTLE_MS)
    const settled = beginEdit($, project, ['a.py'], 'f1')
    await project.clock.advance(FINGERPRINT_MS)
    settled.end()
    await project.clock.advance(SETTLE_MS)
    await settled.done
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
    personWrites(project)
    const first = beginEdit($, project, ['b.py'], 'f2')
    const second = beginEdit($, project, ['c.py'], 'f3')
    await project.clock.advance(FINGERPRINT_MS)
    first.end()
    second.end()
    await project.clock.advance(SETTLE_MS)
    await Promise.all([first.done, second.done])
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
    expect(told(project).some(text => text.includes(OUTSIDE))).toBe(true)
  }, { fingerprintDelayMs: FINGERPRINT_MS })
})

longTest('a limit: a person\'s file written while an editing tool runs cannot be told from the tool\'s own write and goes with the agent\'s checkpoint', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    const running = beginEdit($, project, ['b.py'], 'f2')
    await project.clock.advance(0)
    personWrites(project)
    running.end()
    await running.done
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.commits).toEqual(['tcr: person.py, b.py'])
  })
})

longTest('an edit whose fingerprint is as long as the settled one is still told apart by its value, judged and committed', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    await edit($, project, ['a.py'], 'dirty')
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
  })
})

longTest('a person\'s file whose fingerprint is as long as the agent\'s, seen at a tool that does not edit, is still never committed with the agent\'s edit', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.willChange(['agent1.py'], 'first')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/agent1.py' })
    project.willChange(['person.py'], 'other')
    await $.tool.call({ tool: 'Read', file_path: '/repo/person.py' })
    project.willChange(['agent2.py'], 'third')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/agent2.py' })
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
  })
})

for (const [verdict, report] of [['green', undefined], ['red', WARNINGS]] as const) {
  longTest(`a person's file written while an edit waits is neither committed nor reverted when the agent's next edit begins while the turn start decides, with a ${verdict} check`, async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(SLOW_DECISION_MS + DECIDE_MS)
      if (report !== undefined) project.setReport(report)
      project.willChange(['a.py'], 'f1')
      await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
      personWrites(project)
      await $.turn.start({ text: 'and also this', turnId: 't2' })
      const second = beginEdit($, project, ['b.py'], 'f2')
      await project.clock.advance(0)
      await project.clock.advance(SLOW_DECISION_MS)
      second.end()
      await second.done
      await project.clock.advance(SETTLE_MS)
      expect(project.workspace.commits).toEqual([])
      expect(project.workspace.reverted).toEqual([])
      expect(told(project).some(text => text.includes(OUTSIDE))).toBe(true)
    }, { reasonDelayMs: SLOW_DECISION_MS })
  })
}

longTest('a person\'s file that the first comparison of a turn start finds while an edit waits, with a fingerprint as long as the edit\'s, stops TCR before the checks run', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.willChange(['a.py'], 'first')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    during(project, 'fingerprint', 1, () => personWrites(project, 'other'))
    await $.turn.start({ text: 'and also this', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.oneShots).toEqual([])
    expect(project.workspace.commits).toEqual([])
    expect(told(project).some(text => text.includes(OUTSIDE))).toBe(true)
  })
})

longTest('an editing tool call the host never ends stops counting when its turn completes, so the guard for a person\'s file works again', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    beginEdit($, project, ['c.py'], 'f3')
    await project.clock.advance(0)
    await $.turn.complete(ended)
    personWrites(project)
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(DECIDE_MS)
    project.willChange(['b.py'], 'f2')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/b.py' })
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
  })
})

longTest('a person\'s file whose fingerprint is as long as the agent\'s edit left, found at a turn start while the edit waits, stops TCR before the checks run', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.willChange(['a.py'], 'first')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    personWrites(project, 'other')
    await $.turn.start({ text: 'and also this', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.oneShots).toEqual([])
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
  })
})

longTest('a non-editing tool after the agent\'s pending edit does not pause TCR, and the edit is then committed', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await $.tool.call({ tool: 'Read', file_path: '/repo/a.py' })
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
    expect(told(project).some(text => text.includes(OUTSIDE))).toBe(false)
  })
})
