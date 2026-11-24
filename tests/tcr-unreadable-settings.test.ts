import type { EngineInterface } from 'claude-code'
import { expect } from 'claude-code/testing'
import { projectPolicy } from '../hooks/completion'
import { initialState } from '../hooks/state'
import { WARNINGS, ended } from './fixtures/tcr'
import { inSession, toldPlain, DECIDE_MS, SETTLE_MS, longTest } from './fixtures/tcr-session'

const NEVER_PLAYED_MS = 600_000
const READ_LIMIT = 'a read of the project\'s files took longer than 20s'
const SETTINGS_READ_FAILS = '.overwatch.json exists and could not be read'
const SHELL_CALL = { tool: 'Bash', command: 'make' }
const TOOLS = [{ tool: 'Read', file_path: '/repo/a.py' }, SHELL_CALL, { tool: 'Edit', file_path: '/repo/a.py' }]

const FIFO_TOOLS_PLAYED = 'a pipe nothing writes to'

longTest(`${FIFO_TOOLS_PLAYED} where the settings are: every tool runs, the turn ends, and the agent is told once`,  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await project.clock.advance(SETTLE_MS)
    project.workspace.settingsAnswers = 0
    for (const call of TOOLS) {
      const running = $.tool.call(call)
      await project.clock.advance(NEVER_PLAYED_MS)
      expect(await running).not.toHaveProperty('deny')
    }
    const stopping = $.turn.complete(ended)
    await project.clock.advance(NEVER_PLAYED_MS)
    expect(await stopping).toEqual({ text: ended.answer })
    expect(toldPlain(project).filter(text => text.startsWith(`overwatch: ${READ_LIMIT}`)).length).toBe(1)
  }, { settings: {} })
})

const UNREADABLE = ['EACCES: permission denied', 'EISDIR: illegal operation on a directory']

/** An engine whose settings file exists and cannot be read. */
function engineDenying(reason: string): EngineInterface {
  const files = {
    exists: async () => true,
    stat: async () => ({}),
    read: async () => { throw new Error(reason) },
  }
  const clock = { after: () => ({ cancel: () => undefined }) }
  return { fs: files, clock, env: { get: async () => undefined } } as unknown as EngineInterface
}

for (const reason of UNREADABLE) {
  longTest(`settings that exist and cannot be read (${reason}) hold nothing, and the agent is told once, with no unexpected error`, async () => {
    const state = initialState()
    state.cwd = '/repo'
    const engine = engineDenying(reason)
    await expect(projectPolicy(engine, state)).resolves.toBeUndefined()
    await expect(projectPolicy(engine, state)).resolves.toBeUndefined()
    expect([...state.outbox.keys()]).toEqual(['gate:policy'])
    const text = state.outbox.get('gate:policy')?.text ?? ''
    expect(text).toContain(`${SETTINGS_READ_FAILS}: Error: ${reason}`)
    expect(text).not.toContain('unexpected error')
  })
}

const BUG = 'a bug of the plugin'

longTest('a bug of the plugin where the gate decides: the tool runs, the turn ends, and the agent is told and the host logs it',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await project.clock.advance(SETTLE_MS)
    project.workspace.existsBug = new Error(BUG)
    const running = $.tool.call(SHELL_CALL)
    await project.clock.advance(SETTLE_MS)
    expect(await running).not.toHaveProperty('deny')
    project.workspace.existsBug = new Error(BUG)
    const stopping = $.turn.complete(ended)
    await project.clock.advance(SETTLE_MS)
    expect(await stopping).toEqual({ text: ended.answer })
    expect(toldPlain(project).some(text => text.includes('overwatch hit an unexpected error'))).toBe(true)
    expect(project.workspace.logged.some(line => line.includes('overwatch hit an unexpected error'))).toBe(true)
  }, { settings: {} })
})

const UNEXPECTED = 'overwatch hit an unexpected error'

longTest('a bug of the plugin where the end of a turn is decided: the turn is over, so the agent is woken with a prompt that tells of the bug', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await project.clock.advance(SETTLE_MS)
    project.workspace.existsBug = new Error(BUG)
    const stopping = $.turn.complete(ended)
    await project.clock.advance(SETTLE_MS)
    await stopping
    expect(project.prompts.some(text => text.includes(UNEXPECTED))).toBe(true)
  }, { settings: {} })
})

longTest('a bug of the plugin where the end of a turn is decided, with TCR on: the turn is over, so the agent is woken with a prompt that tells of the bug', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    await project.clock.advance(SETTLE_MS)
    project.workspace.existsBug = new Error(BUG)
    const stopping = $.turn.complete(ended)
    await project.clock.advance(SETTLE_MS)
    await stopping
    expect(project.prompts.some(text => text.includes(UNEXPECTED))).toBe(true)
  }, { initial: WARNINGS })
})
