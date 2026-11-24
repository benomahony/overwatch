import { expect } from 'claude-code/testing'
import { ended, start, tcrProject } from './fixtures/tcr'
import { START_MS, STEP_MS, longTest, takes, type On } from './fixtures/tcr-session'

const SCALED_LIMITS = { OVERWATCH_TCR_TIMEOUT_SCALE: '0.004' }
const NEVER_MS = 10_000_000
const REPOSITORY_MARKER = '/repo/.git'
const READ_LIMIT_MS = 80
const ONE_READ_AND_A_STEP_MS = READ_LIMIT_MS + 2 * STEP_MS

/** The hooks registrar with the host's `names` calls for the repository unanswered for ever, counting each ask of the marker. */
function stalling(on: On, { names, asked, wait }: { names: string[]; asked: string[]; wait: () => Promise<unknown> }): On {
  return ((name: string, handler: (host: unknown, event: { path?: string }) => unknown) => {
    if (!names.includes(name)) return on(name as never, handler as never)
    return on(name as never, ((host: unknown, event: { path?: string }) => {
      if (name === 'fs.exists' && event.path === REPOSITORY_MARKER) asked.push(name)
      return event.path === REPOSITORY_MARKER || event.path === '/repo' ? wait() : handler(host, event)
    }) as never)
  }) as On
}

longTest('a search for watchers that never got an answer is not asked again within the time a stall is remembered',  async ($, on) => {
  const asked: string[] = []
  const project = tcrProject(stalling(on, { names: ['fs.exists'], asked, wait: () => project.clock.sleep(NEVER_MS) }), { env: SCALED_LIMITS })
  await $.session.start(start)
  await project.clock.advance(START_MS)
  const before = asked.length
  await $.turn.start({ text: 'go', turnId: 't1' })
  await project.clock.advance(START_MS)
  expect(asked.length).toBe(before)
  await $.turn.complete(ended)
})

longTest('the end of a session waits for a search that never got an answer no longer than one read',  async ($, on) => {
  const project = tcrProject(stalling(on, { names: ['fs.exists'], asked: [], wait: () => project.clock.sleep(NEVER_MS) }), { env: SCALED_LIMITS })
  on('fs.stat', (_$, { path }) => (path === '/repo' ? project.clock.sleep(NEVER_MS).then(() => ({ value: undefined })) : Promise.reject(new Error('no such path'))) as never)
  await $.session.start(start)
  await project.clock.advance(STEP_MS)
  const waited = await takes(project, $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } }))
  expect(waited).toBeLessThanOrEqual(ONE_READ_AND_A_STEP_MS)
})

const RESUME_GAP_MS = 5 * READ_LIMIT_MS
const UNAVAILABLE = 'TCR is unavailable'
const NOT_TRIED = 'was not tried'

longTest('a look for the repository of a session that ended outlasts its limit after the session ended: the session that resumes in its place looks for itself and is told nothing of the stall', async ($, on) => {
  let looks = 0
  const stalledOnce = ((name: string, handler: (host: unknown, event: { path?: string }) => unknown) => {
    if (name !== 'fs.exists') return on(name as never, handler as never)
    return on(name as never, ((host: unknown, event: { path?: string }) => {
      if (event.path !== REPOSITORY_MARKER) return handler(host, event)
      looks += 1
      return looks === 1 ? project.clock.sleep(NEVER_MS) : handler(host, event)
    }) as never)
  }) as On
  const project = tcrProject(stalledOnce, { env: SCALED_LIMITS })
  await $.session.start(start)
  await project.clock.advance(STEP_MS)
  const ending = $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
  await project.clock.advance(READ_LIMIT_MS + STEP_MS)
  await ending
  await project.clock.advance(RESUME_GAP_MS)
  const before = looks
  await $.session.start(start)
  await project.clock.advance(START_MS)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await project.clock.advance(START_MS)
  expect(looks).toBeGreaterThan(before)
  const texts = project.prompts.concat(project.appended())
  expect(texts.filter(text => text.includes(UNAVAILABLE) || text.includes(NOT_TRIED))).toEqual([])
})

const SLOW_READ_MS = 60

longTest('the end of a session waits for a search made of reads that each answer within their limit no longer than one read', async ($, on) => {
  let project: ReturnType<typeof tcrProject> | undefined
  const slow = ((name: string, handler: (host: unknown, event: unknown) => unknown) => {
    if (name !== 'fs.exists') return on(name as never, handler as never)
    return on(name as never, (async (host: unknown, event: unknown) => {
      await project?.clock.sleep(SLOW_READ_MS)
      return handler(host, event)
    }) as never)
  }) as On
  project = tcrProject(slow, { env: SCALED_LIMITS })
  await $.session.start(start)
  await project.clock.advance(STEP_MS)
  const waited = await takes(project, $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } }))
  expect(waited).toBeLessThanOrEqual(ONE_READ_AND_A_STEP_MS)
})
