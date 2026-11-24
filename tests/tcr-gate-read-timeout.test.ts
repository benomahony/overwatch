import { expect } from 'claude-code/testing'
import { WARNINGS, ended, start, tcrProject } from './fixtures/tcr'
import { SETTLE_MS, START_MS, STEP_MS, toldPlain, longTest, takes, type On } from './fixtures/tcr-session'

const GUARDED_ONLY = { gate: { protected_actions: [{ tool: 'Edit' }] } }
const SCALED_LIMITS = { OVERWATCH_TCR_TIMEOUT_SCALE: '0.004' }
const NEVER_MS = 10_000_000
const REPOSITORY_MARKER = '/repo/.git'
const LIMIT_NOTICE = "a read of the project's files took longer than"
const UNEXPECTED = 'overwatch hit an unexpected error'
const EDITS = 3
const READ_LIMIT_MS = 80
const STALLED_MS = 10_000
const PROMPTLY_MS = 2 * STEP_MS

/** The hooks registrar with each look for the repository's marker unanswered for ever while `isStalled` says so. */
function stallingRepository(on: On, isStalled: () => boolean, wait: () => Promise<unknown>): On {
  return ((name: string, handler: (host: unknown, event: { path?: string }) => unknown) => {
    if (name !== 'fs.exists') return on(name as never, handler as never)
    return on(name as never, ((host: unknown, event: { path?: string }) => (isStalled() && event.path === REPOSITORY_MARKER ? wait() : handler(host, event))) as never)
  }) as On
}

longTest('a look for the repository that never answers is told once as an expected failure and delays one call, and each tool runs and the turn ends',  async ($, on) => {
  let isStalled = false
  const project = tcrProject(stallingRepository(on, () => isStalled, () => project.clock.sleep(NEVER_MS)), { settings: GUARDED_ONLY, env: SCALED_LIMITS })
  await $.session.start(start)
  await project.clock.advance(START_MS)
  await $.turn.start({ text: 'go', turnId: 't1' })
  project.setReport(WARNINGS)
  await project.clock.advance(SETTLE_MS)
  isStalled = true
  const delays: number[] = []
  for (let edit = 0; edit < EDITS; edit += 1) {
    project.willChange([`${edit}.py`], `f${edit}`)
    delays.push(await takes(project, $.tool.call({ tool: 'Edit', file_path: `/repo/${edit}.py` })))
  }
  await project.clock.advance(SETTLE_MS)
  delays.push(await takes(project, $.turn.complete(ended)))
  await project.clock.advance(SETTLE_MS)
  expect(delays[0]).toBeGreaterThanOrEqual(READ_LIMIT_MS)
  expect(delays.slice(1).every(delay => delay <= PROMPTLY_MS)).toBe(true)
  expect(project.workspace.dirty.length).toBe(EDITS)
  const told = toldPlain(project)
  expect(told.filter(text => text.includes(LIMIT_NOTICE)).length).toBe(1)
  expect(told.filter(text => text.includes(UNEXPECTED)).length).toBe(0)
  expect(project.workspace.logged.filter(line => line.includes(UNEXPECTED)).length).toBe(0)
})

longTest('a gate that could not be read because a look for the repository never answered guards again once the look answers',  async ($, on) => {
  let isStalled = false
  const project = tcrProject(stallingRepository(on, () => isStalled, () => project.clock.sleep(NEVER_MS)), { settings: GUARDED_ONLY, env: SCALED_LIMITS })
  await $.session.start(start)
  await project.clock.advance(START_MS)
  await $.turn.start({ text: 'go', turnId: 't1' })
  project.setReport(WARNINGS)
  await project.clock.advance(SETTLE_MS)
  isStalled = true
  project.willChange(['first.py'], 'f1')
  await takes(project, $.tool.call({ tool: 'Edit', file_path: '/repo/first.py' }))
  isStalled = false
  await project.clock.advance(STALLED_MS)
  project.willChange(['second.py'], 'f2')
  await takes(project, $.tool.call({ tool: 'Edit', file_path: '/repo/second.py' }).catch(() => undefined))
  expect(project.workspace.dirty).toEqual(['first.py'])
})
