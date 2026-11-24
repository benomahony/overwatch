import { expect, test } from 'claude-code/testing'
import { WARNINGS, start, tcrProject } from './fixtures/tcr'
import { ended } from './fixtures/gating'
import { END_MS, LONG_TEST_MS, SETTLE_MS, START_MS, WORSE, longTest } from './fixtures/tcr-session'
import { NET_TEST_MS, sweep } from './fixtures/tcr-net'

const FAILURE_TOLD = ['failed after the latest change', 'failed and has no earlier result']

/**
 * The class check of what an editing tool call marks: the host throws at each step the plugin makes after the call
 * ran, and in every run a check whose first result comes after the edit is read against the edit, so that its failure
 * is told. An error that skips the marks would let that first result stand as the baseline, and the failure goes unsaid.
 */
test('a throw of the host at any step after an editing tool ran still marks the checks as edited: the failure that the first result after the edit holds is told', { timeoutMs: NET_TEST_MS + LONG_TEST_MS }, async ($, on) => {
  const project = tcrProject(on, { mute: true })
  const steps = await sweep({
    steps: 12,
    $,
    project,
    entry: async current => {
      const { injection } = current.workspace
      injection.isArmed = false
      await current.clock.advance(SETTLE_MS)
      current.willChange(['a.py'], 'f1')
      injection.isArmed = true
      await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
      injection.isArmed = false
      current.setReport(WARNINGS)
      current.unmute()
      await current.clock.advance(SETTLE_MS)
    },
  }, (run, { throwAt }) => {
    const label = { throwAt, step: throwAt === undefined ? undefined : run.steps[throwAt - 1] }
    expect({ ...label, isTold: run.told.some(text => FAILURE_TOLD.some(words => text.includes(words))) }).toEqual({ ...label, isTold: true })
  })
  expect(steps).toBeGreaterThan(0)
})

const REPORTED_MS = 710
const GUARD = 'this action is guarded while relevant checks fail'

/**
 * An editing tool in the turn of a correction marks the session as edited since the correction, so that a failure
 * that changed after the edit is corrected again; without the mark the correction of the first failure stands.
 */
longTest('an editing tool in the turn of a correction marks the session as edited since it: a failure that changed after the edit is corrected again', async ($, on) => {
  const project = tcrProject(on, { settings: {} })
  await $.session.start(start)
  await project.clock.advance(START_MS)
  project.setReport(WARNINGS)
  await project.clock.advance(REPORTED_MS)
  await $.turn.start({ text: 'finish', turnId: 't1' })
  await $.turn.complete(ended)
  const [correction = ''] = project.prompts.filter(text => text.includes(GUARD))
  expect(correction).toContain('29 warnings')
  await $.turn.start({ text: correction, turnId: 't2' })
  project.willChange(['a.py'], 'f1')
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
  project.setReport(WORSE)
  await project.clock.advance(REPORTED_MS)
  await $.turn.complete(ended)
  expect(project.prompts.filter(text => text.includes(GUARD)).map(text => (text.includes('31 warnings') ? 'second' : 'first'))).toEqual(['first', 'second'])
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await project.clock.advance(END_MS)
  await ending
})
