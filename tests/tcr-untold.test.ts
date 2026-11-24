import { expect } from 'claude-code/testing'
import { CLEAN, WARNINGS } from './fixtures/tcr'
import { commit, onMain, pull } from './fixtures/tcr-move'
import { inSession, edit, personWrites, told, toldPlain, SETTLE_MS, DECIDE_MS, OFFLINE, WORSE, longTest } from './fixtures/tcr-session'
import { QUIET_MS } from '../hooks/delivery'

const FAILING_CHECK_STILL_RUNNING_MS = 3000
const TICK_OF_THE_WATCHER_MS = 500
const TICKS_FOR_THE_REPORT = 2

longTest('a failure the checks reported while TCR waited to judge the edit is told by them when TCR then stops without judging it', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    project.unmute()
    await project.clock.advance(TICK_OF_THE_WATCHER_MS)
    project.workspace.silent = true
    await project.clock.advance(QUIET_MS + DECIDE_MS)
    project.willChange(['mine.py'], 'mine')
    await $.tool.call({ tool: 'Read', file_path: '/repo/mine.py' })
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.reverted).toEqual([])
    expect(told(project).filter(text => text.includes('TCR is unavailable')).length).toBe(1)
    expect(told(project).filter(text => text.includes('29 warnings')).length).toBe(1)
  }, { mute: true, judgeDelayMs: FAILING_CHECK_STILL_RUNNING_MS })
})

const AFTER_THE_TICK_MS = 250
const AFTER_THE_JUDGEMENT_MS = FAILING_CHECK_STILL_RUNNING_MS + SETTLE_MS

longTest('a failure that TCR told by a revert is not told again by the checks when TCR stops after it', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WORSE)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(AFTER_THE_TICK_MS)
    project.workspace.silent = true
    await project.clock.advance(AFTER_THE_JUDGEMENT_MS)
    expect(project.workspace.reverted).toEqual([['a.py']])
    project.willChange(['mine.py'], 'mine')
    await $.tool.call({ tool: 'Read', file_path: '/repo/mine.py' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).filter(text => text.includes('TCR is unavailable')).length).toBe(1)
    expect(told(project).filter(text => text.includes('31 warnings')).length).toBe(1)
  }, { initial: WARNINGS, judgeDelayMs: FAILING_CHECK_STILL_RUNNING_MS })
})

longTest('a failure that the checks reported, and the judgement of the edit did not find, is not told when TCR stops after it committed the edit', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(AFTER_THE_TICK_MS)
    project.workspace.silent = true
    project.setReport(CLEAN)
    await project.clock.advance(AFTER_THE_JUDGEMENT_MS)
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
    project.willChange(['mine.py'], 'mine')
    await $.tool.call({ tool: 'Read', file_path: '/repo/mine.py' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).filter(text => text.includes('TCR is unavailable')).length).toBe(1)
    expect(told(project).filter(text => text.includes('29 warnings'))).toEqual([])
  }, { judgeDelayMs: FAILING_CHECK_STILL_RUNNING_MS })
})

longTest('with inherited findings set to block, a new failure beside an inherited one is reverted and told by TCR, once', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WORSE)
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.reverted).toEqual([['a.py']])
    expect(told(project).filter(text => text.includes('TCR reverted') && text.includes('31 warnings')).length).toBe(1)
    expect(told(project).filter(text => text.includes('31 warnings')).length).toBe(1)
  }, { initial: WARNINGS, settings: { mode: 'tcr', gate: { inherited: 'block' } } })
})

const REVERT_REFUSED = 'git refused the reset'
const CHECK_GIVES_UP_SCALE = { OVERWATCH_TCR_TIMEOUT_SCALE: '0.002' }

longTest('a failure that TCR told by a revert that failed is not told again by the checks when TCR stops after it', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WORSE)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(AFTER_THE_TICK_MS)
    project.workspace.silent = true
    await project.clock.advance(AFTER_THE_JUDGEMENT_MS)
    expect(told(project).filter(text => text.includes('TCR tried to revert')).length).toBe(1)
    expect(told(project).filter(text => text.includes('failed after'))).toEqual([])
  }, { initial: WARNINGS, judgeDelayMs: FAILING_CHECK_STILL_RUNNING_MS, prepare: workspace => { workspace.revertIncomplete = { error: REVERT_REFUSED, resets: false } } })
})

longTest('a failure the checks report while an edit is held for a check that gave no result is told by the checks, and so is each later one', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await edit($, project, ['a.py'], 'f1')
    await project.clock.advance(SETTLE_MS)
    expect(told(project).filter(text => text.includes('gave no result to judge by')).length).toBe(1)
    expect(told(project).filter(text => text.includes('29 warnings')).length).toBe(1)
    expect(project.workspace.reverted).toEqual([])
  }, { hang: 'check', env: CHECK_GIVES_UP_SCALE })
})

const TURN_STARTS_IN_BETWEEN = [false, true]

for (const newTurn of TURN_STARTS_IN_BETWEEN) {
  longTest(`a failure the checks report after the agent's own commit took the edit is told once, when a new turn started in between: ${newTurn}`, async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(DECIDE_MS)
      commit(project)
      await $.tool.call({ tool: 'Bash', command: 'git commit --allow-empty -m x' })
      await project.clock.advance(SETTLE_MS)
      if (newTurn) {
        await $.turn.start({ text: 'again', turnId: 't2' })
        await project.clock.advance(SETTLE_MS)
      }
      project.setReport(WARNINGS)
      project.unmute()
      await project.clock.advance(SETTLE_MS * 2)
      await $.turn.start({ text: 'third', turnId: 't3' })
      await project.clock.advance(SETTLE_MS)
      await $.tool.call({ tool: 'Read', file_path: '/repo/a.py' })
      await project.clock.advance(SETTLE_MS)
      expect(toldPlain(project).filter(text => text.includes('29 warnings')).length).toBe(1)
    }, { mute: true, prepare: onMain })
  })

  longTest(`a failure the checks report after TCR held an edit for a check that gave no result is told once, when a new turn started in between: ${newTurn}`, async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(DECIDE_MS)
      project.setReport(WARNINGS)
      await edit($, project, ['a.py'], 'f1')
      await project.clock.advance(SETTLE_MS)
      if (newTurn) {
        await $.turn.start({ text: 'again', turnId: 't2' })
        await project.clock.advance(SETTLE_MS)
      }
      project.setReport(WORSE)
      await project.clock.advance(SETTLE_MS * 2)
      await $.turn.start({ text: 'third', turnId: 't3' })
      await project.clock.advance(SETTLE_MS)
      await $.tool.call({ tool: 'Read', file_path: '/repo/a.py' })
      await project.clock.advance(SETTLE_MS)
      expect(toldPlain(project).filter(text => text.includes('31 warnings')).length).toBe(1)
    }, { hang: 'check', env: CHECK_GIVES_UP_SCALE })
  })
}

longTest('a failure the checks report after a person changed a file is told once, though TCR stops for the change only after it', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    personWrites(project)
    project.setReport(WARNINGS)
    await project.clock.advance(SETTLE_MS * 2)
    project.workspace.silent = true
    await project.clock.advance(SETTLE_MS)
    await $.tool.call({ tool: 'Read', file_path: '/repo/person.py' })
    await project.clock.advance(SETTLE_MS)
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(SETTLE_MS)
    expect(toldPlain(project).filter(text => text.includes('29 warnings')).length).toBe(1)
  })
})

longTest('a failure that a later edit already fixed is not told as the failure after the latest change when TCR stops for a change outside', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    project.unmute()
    await project.clock.advance(TICKS_FOR_THE_REPORT * TICK_OF_THE_WATCHER_MS)
    project.workspace.silent = true
    await project.clock.advance(TICK_OF_THE_WATCHER_MS)
    project.setReport(CLEAN)
    project.willChange(['a.py'], 'f2')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    personWrites(project, 'person')
    await $.tool.call({ tool: 'Read', file_path: '/repo/a.py' })
    await project.clock.advance(SETTLE_MS * 4)
    expect(toldPlain(project).filter(text => text.includes('29 warnings'))).toEqual([])
  }, { mute: true, judgeDelayMs: FAILING_CHECK_STILL_RUNNING_MS })
})

const MINE = 'mine.py'

for (const isPulled of [true, false]) {
  longTest(`a failure TCR was left to tell is told when a new turn starts after the edit it followed, but not when a pull moved HEAD in between, since the move makes the failures inherited: pulled ${isPulled}`, async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(DECIDE_MS)
      project.setReport(WARNINGS)
      project.willChange(['a.py'], 'f1')
      await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
      project.unmute()
      await project.clock.advance(TICK_OF_THE_WATCHER_MS)
      project.workspace.silent = true
      if (isPulled) pull(project)
      await $.turn.start({ text: 'again', turnId: 't2' })
      await project.clock.advance(DECIDE_MS / 2)
      project.willChange([MINE], 'mine')
      await $.tool.call({ tool: 'Read', file_path: `/repo/${MINE}` })
      await project.clock.advance(SETTLE_MS * 5)
      expect(toldPlain(project).filter(text => text.includes('29 warnings')).length).toBe(isPulled ? 0 : 1)
      expect(project.workspace.reverted).toEqual([])
    }, { mute: true, judgeDelayMs: FAILING_CHECK_STILL_RUNNING_MS, prepare: onMain })
  })
}

const GIVES_UP_AT_ONCE = { OVERWATCH_TCR_TIMEOUT_SCALE: '0.002' }
const FAILURE_THAT_TCR_TOLD = 'TCR held the edit'
const CHECK_STILL_RUNNING_UNDER_THE_LIMIT_MS = 1000

longTest('a failure the checks reported while an edit waited, which TCR then held and named as the failure of a check with no earlier result, is told by that hold and not again by the checks when TCR stops', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    await edit($, project, ['a.py'], 'f1')
    await project.clock.advance(SETTLE_MS)
    project.workspace.hang = undefined
    project.setReport(WARNINGS)
    project.willChange(['a.py'], 'f2')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(TICKS_FOR_THE_REPORT * TICK_OF_THE_WATCHER_MS)
    project.workspace.silent = true
    await project.clock.advance(SETTLE_MS * 2)
    personWrites(project)
    await $.tool.call({ tool: 'Read', file_path: '/repo/person.py' })
    await project.clock.advance(SETTLE_MS)
    expect(toldPlain(project).filter(text => text.includes(FAILURE_THAT_TCR_TOLD)).length).toBe(1)
    expect(toldPlain(project).filter(text => text.includes('29 warnings'))).toEqual([])
  }, { hang: 'check', env: GIVES_UP_AT_ONCE, judgeDelayMs: CHECK_STILL_RUNNING_UNDER_THE_LIMIT_MS })
})

longTest('a failure worse than the inherited one that the checks reported while an edit waited, which TCR then judged by its own run as the inherited one and left held, is not told by the checks when TCR stops', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WORSE)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(AFTER_THE_TICK_MS)
    project.workspace.silent = true
    project.setReport(WARNINGS)
    await project.clock.advance(AFTER_THE_JUDGEMENT_MS)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
    personWrites(project)
    await $.tool.call({ tool: 'Read', file_path: '/repo/person.py' })
    await project.clock.advance(SETTLE_MS)
    expect(toldPlain(project).filter(text => text.includes('31 warnings'))).toEqual([])
  }, { initial: WARNINGS, judgeDelayMs: FAILING_CHECK_STILL_RUNNING_MS, settings: { mode: 'tcr', gate: { inherited: 'block' } } })
})

longTest('a failure the checks reported while an edit waited is not told when a step that moved HEAD left that edit unjudged and TCR stops after it', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    project.unmute()
    await project.clock.advance(TICKS_FOR_THE_REPORT * TICK_OF_THE_WATCHER_MS)
    project.workspace.silent = true
    await project.clock.advance(TICK_OF_THE_WATCHER_MS)
    pull(project)
    await $.tool.call({ tool: 'Bash', command: 'git pull' })
    personWrites(project)
    await $.tool.call({ tool: 'Read', file_path: '/repo/person.py' })
    await project.clock.advance(SETTLE_MS)
    expect(toldPlain(project).filter(text => text.includes('29 warnings'))).toEqual([])
  }, { mute: true, judgeDelayMs: FAILING_CHECK_STILL_RUNNING_MS, prepare: onMain })
})

longTest('a failure the checks reported, which a later result of an environment error replaced, is not told as the current result when TCR stops', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(TICKS_FOR_THE_REPORT * TICK_OF_THE_WATCHER_MS)
    project.setReport(OFFLINE)
    await project.clock.advance(TICKS_FOR_THE_REPORT * TICK_OF_THE_WATCHER_MS)
    project.workspace.silent = true
    await project.clock.advance(TICK_OF_THE_WATCHER_MS)
    personWrites(project)
    await $.tool.call({ tool: 'Read', file_path: '/repo/person.py' })
    await project.clock.advance(SETTLE_MS)
    expect(toldPlain(project).filter(text => text.includes('29 warnings'))).toEqual([])
    expect(toldPlain(project).filter(text => text.includes('dns error')).length).toBe(1)
  }, { judgeDelayMs: FAILING_CHECK_STILL_RUNNING_MS * 2 })
})

longTest('a failure the checks reported while an edit waited is told when the settings no longer say TCR runs', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(TICKS_FOR_THE_REPORT * TICK_OF_THE_WATCHER_MS)
    project.workspace.silent = true
    await project.clock.advance(TICK_OF_THE_WATCHER_MS)
    project.setSettings({})
    await $.tool.call({ tool: 'Read', file_path: '/repo/a.py' })
    await project.clock.advance(SETTLE_MS)
    expect(toldPlain(project).filter(text => text.includes('TCR is off')).length).toBe(1)
    expect(toldPlain(project).filter(text => text.includes('29 warnings')).length).toBe(1)
  }, { judgeDelayMs: FAILING_CHECK_STILL_RUNNING_MS })
})

longTest('a failure the checks reported while an edit waited is told once TCR holds that edit for a check that gave no result, though the checks print nothing more', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(AFTER_THE_TICK_MS)
    project.workspace.silent = true
    await project.clock.advance(SETTLE_MS * 3)
    expect(toldPlain(project).filter(text => text.includes('gave no result to judge by')).length).toBe(1)
    expect(toldPlain(project).filter(text => text.includes('29 warnings')).length).toBe(1)
  }, { hang: 'check', env: GIVES_UP_AT_ONCE })
})

longTest('an edit after the agent\'s own commit is judged by TCR again, which tells its failure, and the checks do not tell it as well', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    commit(project)
    await $.tool.call({ tool: 'Bash', command: 'git commit --allow-empty -m x' })
    await project.clock.advance(SETTLE_MS)
    project.setReport(WARNINGS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(AFTER_THE_JUDGEMENT_MS)
    expect(project.workspace.reverted).toEqual([['a.py']])
    expect(toldPlain(project).filter(text => text.includes('29 warnings')).length).toBe(1)
  }, { judgeDelayMs: FAILING_CHECK_STILL_RUNNING_MS, prepare: onMain })
})
