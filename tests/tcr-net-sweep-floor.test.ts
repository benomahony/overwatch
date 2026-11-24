import { expect, test } from 'claude-code/testing'
import { tcrProject } from './fixtures/tcr'
import { LONG_TEST_MS, SETTLE_MS, type Engine, type Project } from './fixtures/tcr-session'
import { NET_TEST_MS, sweep } from './fixtures/tcr-net'

const NO_SHARE_OF_STEPS = { index: 0, of: 1_000_000 }
const STEPS_OF_AN_EDIT = 12
const EVERY_FOURTH_STEP = { index: 0, of: 4 }
const RUNS_OF_EVERY_FOURTH_STEP = 3
const ODD_STEPS_FROM_ONE = { index: 1, of: 4 }

/** The scenario every test here sweeps: the agent edits a file while the host's steps are armed. */
function editing($: Engine) {
  return async (current: Project) => {
    const { injection } = current.workspace
    injection.isArmed = false
    await current.clock.advance(SETTLE_MS)
    current.willChange(['a.py'], 'f1')
    injection.isArmed = true
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    injection.isArmed = false
    await current.clock.advance(SETTLE_MS)
  }
}

/** A sweep fails when its plain run makes another number of steps than the literal it names, and passes with the number it makes. */
test('a sweep whose literal is not the number of steps its plain run makes fails, and passes with the right one', { timeoutMs: NET_TEST_MS + LONG_TEST_MS }, async ($, on) => {
  const project = tcrProject(on, { mute: true })
  const entry = editing($)
  const wrong = await sweep({ $, project, entry, steps: 1, share: NO_SHARE_OF_STEPS }, () => undefined).then(() => undefined, (error: unknown) => String(error))
  expect(wrong).toContain(`Received: ${STEPS_OF_AN_EDIT}`)
  expect(await sweep({ $, project, entry, steps: 12, share: NO_SHARE_OF_STEPS }, () => undefined)).toBe(STEPS_OF_AN_EDIT)
})

/** A sweep gives its check the plain run and each run it plays, and no run is left unchecked. */
test('a sweep runs its check once for the plain run and once for each run it plays', { timeoutMs: NET_TEST_MS + LONG_TEST_MS }, async ($, on) => {
  const project = tcrProject(on, { mute: true })
  const entry = editing($)
  const throwAts: (number | undefined)[] = []
  await sweep({ $, project, entry, steps: 12, share: EVERY_FOURTH_STEP }, (_run, { throwAt }) => { throwAts.push(throwAt) })
  expect(throwAts).toEqual([undefined, 4, 8, 12])
  expect(throwAts.length).toBe(RUNS_OF_EVERY_FOURTH_STEP + 1)
})

/** A sweep gives its check the runs of odd steps too, so that a wrapper that skips them fails. */
test('a sweep runs its check for the runs of odd steps as for those of even steps', { timeoutMs: NET_TEST_MS + LONG_TEST_MS }, async ($, on) => {
  const project = tcrProject(on, { mute: true })
  const throwAts: (number | undefined)[] = []
  await sweep({ $, project, entry: editing($), steps: 12, share: ODD_STEPS_FROM_ONE }, (_run, { throwAt }) => { throwAts.push(throwAt) })
  expect(throwAts).toEqual([undefined, 1, 5, 9])
})
