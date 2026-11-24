import { expect, test } from 'claude-code/testing'
import { CLEAN, WARNINGS, tcrProject } from './fixtures/tcr'
import { NET_TEST_MS, sweep } from './fixtures/tcr-net'
import { LONG_TEST_MS, SETTLE_MS, START_MS, toldPlain, type Engine, type Project } from './fixtures/tcr-session'

const GUARDED_ONLY = { gate: { protected_actions: [{ tool: 'Edit' }] } }
const PARTS = 3
const RESUME = { reason: 'resume' as const, sessionId: 's1', resume: { id: 's1' } }
const RESTART_MS = 600
const TICK_MS = 1300
const WATCHER_THAT_CANNOT_START = 'process.spawn'
const GUARDED_EDIT = { tool: 'Edit', file_path: '/repo/a.py' }
const EXIT_NOTICE = 'exited, so build failures are not reported'

type Answer = { deniedBefore: boolean; deniedAfter: boolean; isTold: boolean }

/** The agent's guarded edit is denied while a check the session broke fails, the session resumes in place with the host's step `throwAt` throwing, the project is clean again, and the agent breaks the check once more: the guarded edit must be denied as before. */
async function resumed($: Engine, project: Project): Promise<Answer> {
  const { injection } = project.workspace
  const target = injection.throwAt
  injection.isArmed = false
  injection.throwAt = undefined
  injection.steps.length = 0
  await project.clock.advance(SETTLE_MS)
  const deniedBefore = 'deny' in ((await $.tool.call(GUARDED_EDIT)) as object)
  project.setReport(CLEAN)
  injection.throwAt = target
  injection.isArmed = true
  const toldBefore = toldPlain(project).length
  const ending = $.session.end(RESUME).catch(() => undefined)
  await project.clock.advance(RESTART_MS)
  await ending
  injection.isArmed = false
  await $.turn.start({ text: 'again', turnId: 't2' })
  await project.clock.advance(START_MS)
  project.setReport(WARNINGS)
  await project.clock.advance(TICK_MS)
  const deniedAfter = 'deny' in ((await $.tool.call(GUARDED_EDIT)) as object)
  const isTold = toldPlain(project).slice(toldBefore).some(text => text.includes(EXIT_NOTICE))
  return { deniedBefore, deniedAfter, isTold }
}

for (let index = 0; index < PARTS; index += 1) {
  test(`a session resumed in place with the host throwing at any step still denies a guarded edit while a check it broke fails (part ${index + 1} of ${PARTS})`, { timeoutMs: NET_TEST_MS + LONG_TEST_MS }, async ($, on) => {
    const project = tcrProject(on, { settings: GUARDED_ONLY })
    const failing: string[] = []
    const steps = await sweep({ $, project, entry: current => resumed($, current), share: { index, of: PARTS }, steps: 19 }, (run, { throwAt }) => {
      const answer = run.result as Answer
      const isWatcherThatCannotStart = throwAt !== undefined && run.steps[throwAt - 1] === WATCHER_THAT_CANNOT_START
      if (!answer.deniedBefore || (!answer.deniedAfter && !isWatcherThatCannotStart) || (isWatcherThatCannotStart && !answer.isTold)) failing.push(`${throwAt ?? 'plain'}:${run.steps[(throwAt ?? 0) - 1] ?? ''}:${JSON.stringify(answer)}`)
    })
    expect({ steps, failing }).toEqual({ steps, failing: [] })
  })
}
