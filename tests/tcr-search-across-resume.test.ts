import { expect } from 'claude-code/testing'
import { start, tcrProject } from './fixtures/tcr'
import { takes, toldPlain, DECIDE_MS, SETTLE_MS, START_MS, longTest, type On } from './fixtures/tcr-session'

const UNEXPECTED_ERROR = 'overwatch hit an unexpected error'
const BUILD_MARKER = '/repo/build.zig'
const REPOSITORY_MARKER = '/repo/.git'
const SLOW_READ_MS = 3000
const SCALED_LIMITS = { OVERWATCH_TCR_TIMEOUT_SCALE: '0.2' }
const FALSE_CLAIM = 'no checks are configured'
const RELEASES_AFTER_EDIT_MS = [50, 200, 600, 1200]

type Handler = (host: never, event: { path?: string }) => unknown

/** `on` with the first read of the zig marker held until `gate` opens and then failing with a bug of the plugin. */
function failingOnce(on: On, { gate, sleep, error }: { gate: Promise<void>; sleep: (ms: number) => Promise<void>; error: Error }): On {
  let isFailed = false
  let isSlowed = false
  return ((name: string, handler: Handler) => {
    if (name !== 'fs.exists') return on(name as never, handler as never)
    return on(name as never, (async (host: never, event: { path?: string }) => {
      if (event.path === REPOSITORY_MARKER && !isSlowed) {
        isSlowed = true
        await sleep(SLOW_READ_MS)
      }
      if (event.path !== BUILD_MARKER || isFailed) return handler(host, event)
      isFailed = true
      await gate
      throw error
    }) as never)
  }) as On
}

for (const releaseMs of RELEASES_AFTER_EDIT_MS) {
  longTest(`a search of a session that ended and fails with a bug of the plugin, ${releaseMs}ms after the edit of the next session, still judges that edit and does not say the project has no checks`, async ($, on) => {
    let release = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const project = tcrProject(failingOnce(on, { gate, sleep: ms => project.clock.sleep(ms), error: new TypeError('a bug of the plugin in the search') }), { withZig: true, env: SCALED_LIMITS })
    await $.session.start(start)
    await project.clock.advance(START_MS)
    const ending = $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
    await takes(project, ending)
    await ending
    await $.session.start(start)
    await project.clock.advance(START_MS)
    await $.turn.start({ text: 'go', turnId: 't2' })
    await project.clock.advance(DECIDE_MS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(releaseMs)
    release()
    await project.clock.advance(SETTLE_MS)
    const heard = toldPlain(project).join('\n')
    expect({ claimsNoChecks: heard.includes(FALSE_CLAIM), claimsBug: heard.includes(UNEXPECTED_ERROR), commits: project.workspace.commits.length }).toEqual({ claimsNoChecks: false, claimsBug: false, commits: 1 })
    expect(project.toasts.filter(toast => toast.includes(UNEXPECTED_ERROR)).length).toBe(1)
  })
}

const AFTER_THE_LIMIT_MS = 5000

longTest('a search of a session that ended and outlasts the limit of a read shows the user nothing, and the edit of the next session is still judged', async ($, on) => {
  const never = new Promise<void>(() => undefined)
  const project = tcrProject(failingOnce(on, { gate: never, sleep: ms => project.clock.sleep(ms), error: new TypeError('never thrown') }), { withZig: true, env: SCALED_LIMITS })
  await $.session.start(start)
  await project.clock.advance(START_MS)
  const ending = $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
  await takes(project, ending)
  await ending
  await $.session.start(start)
  await project.clock.advance(START_MS)
  await $.turn.start({ text: 'go', turnId: 't2' })
  await project.clock.advance(DECIDE_MS)
  project.willChange(['a.py'], 'f1')
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
  await project.clock.advance(AFTER_THE_LIMIT_MS)
  expect({ toasts: project.toasts.filter(toast => toast.includes(UNEXPECTED_ERROR)).length, commits: project.workspace.commits.length }).toEqual({ toasts: 0, commits: 1 })
})
