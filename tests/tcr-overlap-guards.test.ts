import { expect, test } from 'claude-code/testing'
import { CLEAN, WARNINGS, start, tcrProject } from './fixtures/tcr'
import { END_MS, SETTLE_MS, START_MS } from './fixtures/tcr-session'
import { RESUME, OVERLAP_TIMEOUT_MS, SLOW_SEARCH_MS, endSession, expected, playOverlap, resumingElsewhere } from './fixtures/tcr-overlap'

const GAP_MS = 20
const GUARDED_ONLY = { gate: { protected_actions: [{ tool: 'Edit' }] } }

test('a session that starts while the end of the last waits for its search keeps its outbox, directory and TCR status: the agent is told TCR is on once and its first edit is committed', { timeoutMs: OVERLAP_TIMEOUT_MS }, async ($, on) => {
  const project = tcrProject(resumingElsewhere(on), { findDelayMs: SLOW_SEARCH_MS })
  expect(await playOverlap($, project, { gapMs: GAP_MS, windowMs: SLOW_SEARCH_MS + START_MS })).toEqual(expected(GAP_MS))
  await endSession($, project)
})

test('a session that starts after the end of the last already set its directory keeps the watchers that end started: the failure they report still denies a guarded edit', { timeoutMs: OVERLAP_TIMEOUT_MS }, async ($, on) => {
  const project = tcrProject(on, { settings: GUARDED_ONLY })
  project.setReport(CLEAN)
  await $.session.start(start)
  await project.clock.advance(START_MS)
  const ending = $.session.end(RESUME)
  await project.clock.advance(END_MS)
  await ending
  await project.clock.advance(START_MS)
  await $.session.start(start)
  await project.clock.advance(START_MS)
  project.setReport(WARNINGS)
  await project.clock.advance(SETTLE_MS)
  expect('deny' in ((await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })) as object)).toBe(true)
  await endSession($, project)
})
