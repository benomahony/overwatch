import { expect, test } from 'claude-code/testing'
import { inSession, toldPlain, DECIDE_MS, SEARCH_TEST_MS } from './fixtures/tcr-session'

const SLOW_SEARCH_MS = 5000
const SEARCH_ENDS_MS = 2000
const PAST_THE_LIMIT_MS = 4000
const LIMIT_NOTICE = "a read of the project's files took longer than"

test('an edit made while the reads of the search for the checks never answer is told that a read took longer than its limit, never that no checks are configured, and nothing is committed or reverted', { timeoutMs: SEARCH_TEST_MS }, async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(PAST_THE_LIMIT_MS)
    const told = toldPlain(project)
    expect(told.some(text => text.includes('TCR is unavailable') && text.includes(LIMIT_NOTICE))).toBe(true)
    expect(told.some(text => text.includes('no checks are configured'))).toBe(false)
    expect(project.workspace.commits).toEqual([])
    expect(project.workspace.reverted).toEqual([])
    await project.clock.advance(SEARCH_ENDS_MS)
  }, { findDelayMs: SLOW_SEARCH_MS, env: { OVERWATCH_TCR_TIMEOUT_SCALE: '0.004' } })
})
