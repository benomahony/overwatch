import { expect } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { BUG_LOG, CommandError } from '../hooks/tcr'
import { cancelJudgement } from '../hooks/pausing'
import { initialState } from '../hooks/state'
import { WARNINGS, ZIG_RED, start } from './fixtures/tcr'
import { inSession, edit, told, toldPlain, SETTLE_MS, START_MS, END_MS, DECIDE_MS, JUDGE_MS, longTest } from './fixtures/tcr-session'

for (const [mode, wording] of [['foo', "field 'mode' is 'foo'; the only mode is 'tcr'"], [true, "field 'mode' is True; the only mode is 'tcr'"], [['tcr'], "field 'mode' is ['tcr']; the only mode is 'tcr'"]] as const) {
  longTest(`a mode of ${JSON.stringify(mode)} is reported in the Python hook's wording`, async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(SETTLE_MS)
      expect(project.toasts.some(text => text.includes(`.overwatch.json ${wording}`))).toBe(true)
      expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes(`.overwatch.json ${wording}`))).toBe(true)
    }, { settings: { mode } })
  })
}

longTest('a new failure in any one check reverts the edit', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setZigReport(ZIG_RED)
    await edit($, project, ['b.py'], 'f2')
    expect(project.workspace.reverted).toEqual([['b.py']])
    expect(project.workspace.commits).toEqual([])
  }, { withZig: true })
})

longTest('an edit is committed only when every check judges it green',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
    expect(project.workspace.oneShots.sort()).toEqual(['zanity', 'zig'])
  }, { withZig: true })
})

longTest('an edit made while the decision is being made pauses TCR instead of being settled unseen', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(1)
    project.willChange(['a.py'], 'f1')
    const call = $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(SETTLE_MS)
    await call
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('while TCR was committing, reverting or deciding'))).toBe(true)
  }, { reasonDelayMs: 100 })
})

longTest('a failure with nothing to restore is told as a failure and reverts nothing', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.willChange([], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(SETTLE_MS + END_MS)
    expect(project.workspace.reverted).toEqual([])
    expect(told(project).filter(text => text.includes('TCR reverted'))).toEqual([])
    expect(told(project).some(text => text.includes('29 warnings'))).toBe(true)
    expect(told(project).some(text => text.includes('TCR left the latest change uncommitted and unreverted') && text.includes('but no file differs from the latest checkpoint, so there is nothing to revert'))).toBe(true)
    expect(project.workspace.asked.filter(each => each === 'revert').length).toBe(1)
  })
})

longTest('a revert is told to the agent in the running turn even after another message in that turn', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.willChange(['a.py'], 'f1')
    project.workspace.refusal = 'the checkpoint commit failed and its changes are left staged: refused'
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(SETTLE_MS)
    expect(project.appended().filter(text => text.includes('TCR is unavailable')).length).toBe(1)
    project.workspace.refusal = undefined
    project.workspace.dirty = []
    project.workspace.committed = project.workspace.fingerprint
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(DECIDE_MS)
    project.setReport('zanity: 0 errors and 3 warnings in 1 of 1 files\n')
    await edit($, project, ['example.py'], 'f2')
    expect(project.workspace.reverted).toEqual([['example.py']])
    expect(project.appended().filter(text => text.includes('TCR reverted')).length).toBe(1)
  })
})

longTest('a check with a baseline command is run to its end and judged by its exit code', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['a.rs'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: a.rs'])
    project.setRustCode(1)
    await edit($, project, ['b.rs'], 'f2')
    expect(project.workspace.reverted).toEqual([['b.rs']])
    expect(told(project).some(text => text.includes('TCR reverted') && text.includes('cargo test'))).toBe(true)
  }, { withRust: true, withoutChecks: true })
})

longTest('a check with a baseline command that outlives its limit neither commits nor reverts the edit, whatever it printed', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setRustCode(1)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    await edit($, project, ['a.rs'], 'f1')
    await project.clock.advance(1500)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
    expect(told(project).some(text => text.includes('gave no result to judge by'))).toBe(true)
  }, { withRust: true, withoutChecks: true, hang: 'baseline', env: { OVERWATCH_TCR_TIMEOUT_SCALE: '0.002' } })
})

longTest('an edit undone before it is judged is not judged', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(100)
    project.workspace.dirty = []
    project.workspace.fingerprint = 'clean'
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.oneShots).toEqual([])
    expect(project.workspace.commits).toEqual([])
  })
})

longTest('a failure with no earlier result of its check to compare with is held and told, not reverted', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.reverted).toEqual([])
    expect(project.workspace.commits).toEqual([])
    expect(told(project).some(text => text.includes('overwatch: TCR held the edit: zanity failed and has no earlier result to compare with'))).toBe(true)
  }, { mute: true })
})

longTest('a green edit is committed even when its check has no earlier result', async ($, on) => {
  await inSession({ $, on }, async project => {
    await edit($, project, ['a.py'], 'f1')
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
  }, { mute: true })
})

longTest('a message of overwatch that is not about TCR still reaches the agent in a turn that TCR already told', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(1500)
    expect(project.appended().some(text => text.includes('TCR is on'))).toBe(true)
    await project.clock.advance(1500)
    expect(project.appended().some(text => text.includes('exited, so build failures are not reported'))).toBe(true)
  }, { watcherEndsAfterTicks: 4 })
})

const MALFORMED_GATE = { mode: 'tcr', gate: { protected_actions: 'x' } }

longTest('the message about a gate that cannot be used still reaches the agent in a turn that another message of overwatch told already', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(3000)
    expect(project.appended().some(text => text.includes('exited, so build failures are not reported'))).toBe(true)
    project.setSettings(MALFORMED_GATE)
    await edit($, project, ['a.py'], 'f1')
    expect(toldPlain(project).filter(text => text.includes('gate.protected_actions must be an array')).length).toBe(1)
  }, { watcherEndsAfterTicks: 4 })
})

longTest('an edit made while the checkpoint is being committed pauses TCR and says so', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(JUDGE_MS + 100)
    project.willChange(['b.py'], 'f2')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/b.py' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('while TCR was committing'))).toBe(true)
    expect(project.workspace.oneShots).toEqual(['zanity'])
  }, { commandDelayMs: 300 })
})

longTest('a limit: an edit that begins while the revert is running pauses TCR, and the notice blames files changed outside the agent\'s edits, since the revert had already reset them', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(JUDGE_MS + 100)
    project.willChange(['b.py'], 'f2')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/b.py' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('files changed outside the agent'))).toBe(true)
    expect(told(project).filter(text => text.includes('TCR reverted')).length).toBe(1)
  }, { commandDelayMs: 300 })
})

longTest('taking the mode away while the checks run stops the judgement and tells the agent TCR is off', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(JUDGE_MS)
    project.setSettings({})
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
    expect(told(project).some(text => text.includes('TCR is off'))).toBe(true)
  }, { judgeDelayMs: 300 })
})

longTest('taking the mode away between two tools tells the agent TCR is off and judges nothing more', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setSettings({})
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(SETTLE_MS)
    expect(project.workspace.oneShots).toEqual([])
    expect(told(project).some(text => text.includes('TCR is off'))).toBe(true)
  })
})

longTest('an invalid mode set while TCR runs is reported and TCR does not act', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setSettings({ mode: 'fast' })
    project.setReport(WARNINGS)
    await edit($, project, ['a.py'], 'f1')
    expect(project.toasts.some(text => text.includes('mode') && text.includes('fast'))).toBe(true)
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('mode'))).toBe(true)
    expect(project.workspace.reverted).toEqual([])
    expect(project.workspace.commits).toEqual([])
  })
})

longTest('a setting of TCR that is no true or false is reported and TCR does not start', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(SETTLE_MS)
    expect(project.toasts.some(text => text.includes('tcr.saveReverted'))).toBe(true)
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('tcr.saveReverted'))).toBe(true)
  }, { settings: { mode: 'tcr', tcr: { saveReverted: 'yes' } } })
})

longTest('a project without checks says TCR is unavailable because no checks are configured', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    await edit($, project, ['example.py'], 'f1')
    expect(told(project).some(text => text.includes('overwatch: TCR is unavailable: no checks are configured'))).toBe(true)
    expect(project.workspace.commits).toEqual([])
  }, { withoutChecks: true })
})

const PATH_READ_MS = 5000

longTest('a read of PATH that answers after the session resumed pauses nothing in the new session', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.workspace.pathDelayMs = PATH_READ_MS
    await edit($, project, ['example.py'], 'f1')
    project.workspace.pathDelayMs = 0
    const ending = $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
    await project.clock.advance(END_MS)
    await ending
    await $.session.start(start)
    await project.clock.advance(START_MS)
    await $.turn.start({ text: 'again', turnId: 't2' })
    await project.clock.advance(PATH_READ_MS)
    await $.turn.start({ text: 'third', turnId: 't3' })
    await project.clock.advance(SETTLE_MS)
    expect(toldPlain(project).some(text => text.includes('TCR is unavailable') && text.includes('uncommitted'))).toBe(true)
    expect(toldPlain(project).filter(text => text.includes('no checks are configured'))).toEqual([])
  }, { withoutChecks: true, isPathDelayable: true })
})

longTest('a check that writes files names them in the reason TCR is unavailable', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    await edit($, project, ['example.py'], 'f1')
    expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('the check zanity wrote files (`coverage.xml`)'))).toBe(true)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
  }, { checkWrites: ['coverage.xml'] })
})

longTest('a revert keeps the content in a ref by default and names how to get it back', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f1')
    const reverted = told(project).filter(text => text.includes('TCR reverted'))
    expect(reverted.length).toBe(1)
    expect(reverted[0]).toContain('refs/overwatch/tcr/1')
    expect(reverted[0]).toContain('git checkout refs/overwatch/tcr/1 -- .')
    expect(reverted[0]).not.toContain('is gone')
    expect(project.workspace.flags.filter(flags => flags.includes('--no-save-ref'))).toEqual([])
  })
})

longTest('a revert names no command for a staged version when the saved ref holds none', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f1')
    const reverted = told(project).filter(text => text.includes('TCR reverted'))
    expect(reverted.length).toBe(1)
    expect(reverted[0]).not.toContain('^2')
  })
})

longTest('a revert names the command for the staged version when the saved ref also holds one', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f1')
    const reverted = told(project).filter(text => text.includes('TCR reverted'))
    expect(reverted.length).toBe(1)
    expect(reverted[0]).toContain('git checkout refs/overwatch/tcr/1 -- .')
    expect(reverted[0]).toContain('git checkout refs/overwatch/tcr/1^2 -- .')
  }, { prepare: workspace => { workspace.staged = true } })
})

longTest('a revert with saveReverted off keeps no copy, says the content is gone and tells the command so', async ($, on) => {
  await inSession({ $, on }, async project => {
    project.setReport(WARNINGS)
    await edit($, project, ['example.py'], 'f1')
    const reverted = told(project).filter(text => text.includes('TCR reverted'))
    expect(reverted.length).toBe(1)
    expect(reverted[0]).toContain('is gone')
    expect(reverted[0]).not.toContain('git checkout')
    expect(project.workspace.flags.filter(flags => flags.includes('--no-save-ref')).length).toBe(1)
  }, { settings: { mode: 'tcr', tcr: { saveReverted: false } } })
})

const STOP_REFUSED = 'the host cannot stop the check'
const TELLING_FAILED = 'the host refused the notice of a check that could not be stopped'
const BUG_ON_STOP = 'a bug in the plugin while a check was stopped'

for (const [kind, failure, isBug] of [['an expected failure', new CommandError(STOP_REFUSED), false], ['a bug of the plugin', new TypeError(BUG_ON_STOP), true]] as const) {
  longTest(`a check that cannot be stopped, for ${kind}, is told once to the user and the agent, and the cancel still ends`, async () => {
    const [toasts, logs] = [[] as string[], [] as string[]]
    const engine = { ui: { toast: (text: string) => { toasts.push(text) }, log: (text: string) => { logs.push(text) } }, clock: { after: () => ({ cancel: () => undefined }) } } as unknown as EngineInterface
    const state = initialState()
    const stopped: string[] = []
    state.tcrKills.add(async () => { throw failure })
    state.tcrKills.add(async () => { stopped.push('second') })
    await cancelJudgement(engine, state)
    expect(stopped).toEqual(['second'])
    expect(state.tcrKills.size).toBe(0)
    expect(toasts.filter(text => text.includes('a check could not be stopped and may keep running') && text.includes(failure.message)).length).toBe(1)
    expect(state.outbox.get(`tcr:unstopped:${failure.message}`)?.text).toContain(`a check could not be stopped and may keep running: ${failure.message}`)
    expect(logs.some(text => text.includes(BUG_ON_STOP))).toBe(isBug)
  })
}

function stubbedEngine(toasts: string[], logs: { text: string; to: unknown }[], toast: (text: string) => void = text => { toasts.push(text) }) {
  return { ui: { toast, log: (text: string, options: { to?: unknown }) => { logs.push({ text, to: options?.to }) } }, clock: { after: () => ({ cancel: () => undefined }) } } as unknown as EngineInterface
}

longTest('a check whose stop failed after its session ended tells nothing to the next session, and a bug in that stop is still logged', async () => {
  const [toasts, logs] = [[] as string[], [] as { text: string; to: unknown }[]]
  const state = initialState()
  let fail: (error: Error) => void = () => undefined
  state.tcrKills.add(() => new Promise((_, reject) => { fail = reject }))
  const cancelling = cancelJudgement(stubbedEngine(toasts, logs), state)
  state.epoch += 1
  fail(new TypeError(BUG_ON_STOP))
  await cancelling
  expect(toasts).toEqual([])
  expect([...state.outbox.keys()]).toEqual([])
  expect(logs.filter(({ text }) => text.includes(BUG_ON_STOP)).length).toBe(1)
})

longTest('two checks that could not be stopped for different reasons are each told to the agent and the user', async () => {
  const [toasts, logs] = [[] as string[], [] as { text: string; to: unknown }[]]
  const state = initialState()
  const engine = stubbedEngine(toasts, logs)
  state.tcrKills.add(async () => { throw new CommandError('check A is stuck') })
  await cancelJudgement(engine, state)
  state.tcrKills.add(async () => { throw new CommandError('check B is stuck') })
  await cancelJudgement(engine, state)
  expect(toasts.length).toBe(2)
  const waiting = [...state.outbox.values()].map(message => message.text)
  expect(waiting.filter(text => text.includes('check A is stuck')).length).toBe(1)
  expect(waiting.filter(text => text.includes('check B is stuck')).length).toBe(1)
})

longTest('an error while the stop of a check is told does not reject the cancel, and is written to the log of the plugin\'s bugs', async () => {
  const [toasts, logs] = [[] as string[], [] as { text: string; to: unknown }[]]
  const state = initialState()
  const engine = stubbedEngine(toasts, logs, () => { throw new Error(TELLING_FAILED) })
  state.tcrKills.add(async () => { throw new CommandError(STOP_REFUSED) })
  await expect(cancelJudgement(engine, state)).resolves.toBeUndefined()
  expect(logs.filter(({ text, to }) => text.includes(TELLING_FAILED) && to === BUG_LOG).length).toBe(1)
})

const RUNNING_FOR_MS = 600
const CANCEL_TAKES_MS = 100
const CHECKS_STOPPED = 1

longTest('a newer edit stops the check that is judging the older one, which the cancel reaches through the stops the check run registered', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(RUNNING_FOR_MS)
    expect(project.workspace.stopped).toEqual([])
    project.willChange(['a.py'], 'f2')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(CANCEL_TAKES_MS)
    expect(project.workspace.stopped.length).toBe(CHECKS_STOPPED)
  }, { hang: 'check' })
})
