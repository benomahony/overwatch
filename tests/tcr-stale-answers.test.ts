import { expect } from 'claude-code/testing'
import { endMainTurn } from '../hooks/completion'
import { initialState, liveWatcher } from '../hooks/state'
import { CLEAN, WARNINGS, start } from './fixtures/tcr'
import { during, inSession, longTest, personWrites, toldPlain, DECIDE_MS, SETTLE_MS, START_MS, STEP_MS, type Project } from './fixtures/tcr-session'

const TCR_ON = 'TCR is on'
const SESSIONS = 2
const SESSION_END_MS = 50
const FINGERPRINT_AFTER_THE_CHECKS = 3
const SETTINGS_READS_BEFORE_THE_POLICY = 1
const READ_LIMIT = "a read of the project's files took longer than"
const SCALE_OF_LIMITS = '0.2'
const PAST_THE_READ_LIMIT_MS = 3000
const ACTS = ['checkpoint', 'revert']
const HELD = 'TCR held the edit'
const UNAVAILABLE = 'TCR is unavailable'

type Case = {
  name: string
  arm: (project: Project, gate: Promise<unknown>) => void
  outlasts?: boolean
  changeOf: (project: Project) => unknown
  idle: unknown
  isMute?: boolean
}

/** The files compared once the checks ran: the third comparison of the edit begins, and the plugin's next read of what the case holds waits for `gate`. */
function armAtTheFingerprintAfterTheChecks(project: Project, arm: () => void) {
  during(project, 'fingerprint', FINGERPRINT_AFTER_THE_CHECKS, arm)
}

const CASES: Case[] = [
  {
    name: 'the project settings read for the gate after the checks ran, which the new session found unchanged',
    arm: (project, gate) => armAtTheFingerprintAfterTheChecks(project, () => { project.workspace.holds[`settings#${project.workspace.reads.settings + 1 + SETTINGS_READS_BEFORE_THE_POLICY}`] = gate }),
    isMute: true,
    changeOf: project => ({ held: toldPlain(project).filter(text => text.includes(HELD)), unavailable: toldPlain(project).filter(text => text.includes(UNAVAILABLE)), asked: project.workspace.asked.filter(command => ACTS.includes(command)), commits: project.workspace.commits, reverted: project.workspace.reverted }),
    idle: { held: [], unavailable: [], asked: [], commits: [], reverted: [] },
  },
  {
    name: 'the files listed after the checks changed them',
    arm: (project, gate) => armAtTheFingerprintAfterTheChecks(project, () => {
      personWrites(project)
      project.workspace.holds[`status#${project.workspace.reads.status + 1}`] = gate
    }),
    changeOf: project => toldPlain(project).filter(text => text.includes(UNAVAILABLE)),
    idle: [],
  },
  {
    name: 'the settings read after the checks ran, which outlasted its limit',
    arm: (project, gate) => armAtTheFingerprintAfterTheChecks(project, () => { project.workspace.holds[`settings#${project.workspace.reads.settings + 1}`] = gate }),
    changeOf: project => ({ unavailable: toldPlain(project).filter(text => text.includes(UNAVAILABLE)), toasts: project.toasts.filter(text => text.includes(READ_LIMIT)) }),
    idle: { unavailable: [], toasts: [] },
    outlasts: true,
  },
]

for (const { name, arm, outlasts, changeOf, idle, isMute } of CASES) {
  longTest(`${name}, answers after its session ended and changes nothing of the next session`, async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(DECIDE_MS)
      project.setReport(isMute ? WARNINGS : CLEAN)
      let release = () => undefined
      arm(project, new Promise<void>(resolve => { release = resolve }))
      project.willChange(['a.py'], 'f1')
      await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
      await project.clock.advance(SETTLE_MS)
      const ending = $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
      await project.clock.advance(SESSION_END_MS)
      await ending
      Object.assign(project.workspace, { dirty: [], fingerprint: 'clean' })
      await $.session.start(start)
      await project.clock.advance(START_MS)
      await $.turn.start({ text: 'new session turn', turnId: 't3' })
      await project.clock.advance(START_MS)
      await $.tool.call({ tool: 'Read', file_path: '/repo/b.py' })
      expect(toldPlain(project).filter(text => text.includes(TCR_ON)).length).toBe(SESSIONS)
      expect(changeOf(project)).toEqual(idle)
      if (!outlasts) release()
      await project.clock.advance(STEP_MS)
      if (outlasts) await project.clock.advance(PAST_THE_READ_LIMIT_MS)
      await project.clock.advance(SETTLE_MS)
      await $.tool.call({ tool: 'Read', file_path: '/repo/b.py' })
      expect(changeOf(project)).toEqual(idle)
      release()
    }, { mute: isMute === true, env: { OVERWATCH_TCR_TIMEOUT_SCALE: SCALE_OF_LIMITS } })
  })
}

const CORRECTION_OPENING = 'overwatch: this action is guarded while relevant checks fail.'

/** A session whose check fails worse than it did, and a host whose answer to the correction ends that session and begins the next. */
function failingSession() {
  const state = initialState()
  const live = liveWatcher('zanity:/repo', '/repo')
  live.watcher = { name: 'zanity', marker: 'zanity', baseline: ['zanity'] } as never
  live.baseline = { summary: 'zanity: 0 errors', isFailed: false, text: '', failures: [] }
  live.report = { summary: 'zanity: 1 error', isFailed: true, text: 'output', failures: ['rule'] }
  state.liveWatchers.push(live)
  state.isTurnRunning = true
  const logged: string[] = []
  const toasts: string[] = []
  const $ = {
    prompt: { submit: async () => { state.epoch += 1; state.isPromptQueued = false; state.isTurnRunning = false } },
    ui: { log: (text: string) => { logged.push(text) }, toast: (text: string) => { toasts.push(text) } },
  } as never
  return { state, $, logged, toasts }
}

longTest('a session that ends while the correction of a failing check is submitted gives that correction and no notice of a bug', async () => {
  const { state, $, logged, toasts } = failingSession()
  const reason = await endMainTurn($, state, true)
  expect({ opening: reason?.slice(0, CORRECTION_OPENING.length), logged, toasts }).toEqual({ opening: CORRECTION_OPENING, logged: [], toasts: [] })
})

longTest('a turn that completes while its session ends over the read of the gate leaves the turn the next session began running', async () => {
  const state = initialState()
  state.cwd = '/repo'
  const live = liveWatcher('zanity:/repo', '/repo')
  live.watcher = { name: 'zanity', marker: 'zanity', baseline: ['zanity'] } as never
  const failing = { summary: 'zanity: 1 error', isFailed: true, text: 'output', failures: ['rule'] }
  live.baseline = failing
  live.report = failing
  state.liveWatchers.push(live)
  const $ = {
    env: { get: async () => undefined },
    clock: { after: () => ({ cancel: () => undefined }), now: async () => 0 },
    fs: {
      stat: async () => ({ realPath: '/repo' }),
      exists: async () => true,
      read: async () => { state.epoch += 1; state.isTurnRunning = true; return '{}' },
    },
    ui: { log: () => undefined, toast: () => undefined },
  } as never
  expect(await endMainTurn($, state, true)).toBeUndefined()
  expect(state.isTurnRunning).toBe(true)
})

longTest('the files listed for a pause over a change outside answer after their session ended, and change nothing of the next session', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    personWrites(project)
    let release = () => undefined
    project.workspace.holds[`status#${project.workspace.reads.status + 1}`] = new Promise<void>(resolve => { release = resolve })
    const reading = $.tool.call({ tool: 'Read', file_path: '/repo/person.py' })
    await project.clock.advance(SETTLE_MS)
    const ending = $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
    await project.clock.advance(SESSION_END_MS)
    await ending
    Object.assign(project.workspace, { dirty: [], fingerprint: 'clean' })
    await $.session.start(start)
    await project.clock.advance(START_MS)
    await $.turn.start({ text: 'new session turn', turnId: 't3' })
    await project.clock.advance(START_MS)
    release()
    await reading
    await project.clock.advance(SETTLE_MS)
    await $.tool.call({ tool: 'Read', file_path: '/repo/b.py' })
    expect(toldPlain(project).filter(text => text.includes(UNAVAILABLE))).toEqual([])
    expect(toldPlain(project).filter(text => text.includes(TCR_ON)).length).toBe(SESSIONS)
  })
})
