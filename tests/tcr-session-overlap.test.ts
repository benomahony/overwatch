import { expect, test } from 'claude-code/testing'
import { start, tcrProject } from './fixtures/tcr'
import { edit, toldPlain, END_MS, START_MS } from './fixtures/tcr-session'
import { FIRST_GAP_MS, LAST_GAP_MS, MIDDLE_GAP_MS, ON_NOTICE, RESUME, OVERLAP_TIMEOUT_MS, SLOW_SEARCH_MS, endSession, expected, playOverlap, resumingElsewhere } from './fixtures/tcr-overlap'

const SLOW_SEARCH_GAPS_MS = [0, 1, 20, 150]
const SAMPLE_GAPS_MS = [FIRST_GAP_MS, MIDDLE_GAP_MS, LAST_GAP_MS]

test('a session that starts before the end of the last returns is told TCR is on, once, and its first edit is committed, in the first, a middle and the last gap of 0 to 150 ms', { timeoutMs: OVERLAP_TIMEOUT_MS }, async ($, on) => {
  const project = tcrProject(resumingElsewhere(on))
  const seen = []
  for (const gapMs of SAMPLE_GAPS_MS) {
    seen.push(await playOverlap($, project, { gapMs, windowMs: START_MS }))
    await endSession($, project)
  }
  expect(seen).toEqual(SAMPLE_GAPS_MS.map(expected))
})

test('the same holds while the search of the old session is slow, so that the new session decides TCR before the old one ends', { timeoutMs: OVERLAP_TIMEOUT_MS }, async ($, on) => {
  const project = tcrProject(resumingElsewhere(on), { findDelayMs: SLOW_SEARCH_MS })
  const seen = []
  for (const gapMs of SLOW_SEARCH_GAPS_MS) {
    seen.push(await playOverlap($, project, { gapMs, windowMs: SLOW_SEARCH_MS + START_MS }))
    await endSession($, project)
  }
  expect(seen).toEqual(SLOW_SEARCH_GAPS_MS.map(expected))
})

test('a session that starts after the end of the last returned is told TCR is on, once, and its first edit is committed', { timeoutMs: OVERLAP_TIMEOUT_MS }, async ($, on) => {
  const project = tcrProject(on)
  await $.session.start(start)
  await project.clock.advance(START_MS)
  const ending = $.session.end(RESUME)
  await project.clock.advance(END_MS)
  await ending
  const before = toldPlain(project).length
  await $.session.start(start)
  await project.clock.advance(START_MS)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await project.clock.advance(START_MS)
  const toldBeforeTheEdit = toldPlain(project).slice(before)
  await edit($, project, ['a.py'], 'f1')
  expect({ toldBeforeTheEdit, told: toldPlain(project).slice(before), logged: project.workspace.logged, commits: project.workspace.commits }).toEqual({ toldBeforeTheEdit: [ON_NOTICE], told: [ON_NOTICE], logged: [], commits: ['tcr: a.py'] })
})
