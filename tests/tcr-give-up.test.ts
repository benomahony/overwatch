import type { On } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { PASSING, turnHooks } from './fixtures/session'
import { start } from './fixtures/gating'
import { longTest } from './fixtures/tcr-session'

const ENVIRONMENT_ERROR = 'error: Failed to fetch: `https://pypi.internal/simple/acme/`\n  Caused by: dns error\n'
const QUICK_EXIT_ERROR = 'zig: command not found'
const THREE_QUICK_EXITS_MS = 91_000
const AFTER_GIVE_UP_MS = 5000
const END_MS = 1000
const GAVE_UP = 'stopped restarting it on its own'

/** A zig project whose watcher exits at once each time it starts, and the prompts the agent is woken with. */
function quickExits(on: On, { prints }: { prints: string | undefined }) {
  const clock = mock.clock(on)
  const session = mock.session(on)
  const prompts: string[] = []
  let releaseLog = () => undefined
  const isLogHeld = { value: false }
  const logGate = new Promise<void>(resolve => { releaseLog = resolve })
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: e.path.endsWith('/build.zig') || e.path === '/repo/.git' }))
  on('process.spawn', async function* () {
    if (prints === undefined) throw new Error(QUICK_EXIT_ERROR)
    yield { stream: 'stderr' as const, text: prints }
    return { value: { code: 1, signal: null } }
  })
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.write', async () => {
    if (isLogHeld.value) await logGate
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  turnHooks(on)
  return { clock, heard: () => prompts.concat(session.appended().map(row => JSON.stringify(row.message.content))), holdLog: () => { isLogHeld.value = true }, releaseLog: () => releaseLog() }
}

const KINDS = [
  { name: 'that print an environment error never wake the agent', prints: ENVIRONMENT_ERROR, prompts: 0 },
  { name: 'that print no environment error wake the agent once', prints: PASSING, prompts: 1 },
]

for (const { name, prints, prompts } of KINDS) {
  longTest(`three quick exits in a row ${name}`, async ($, on) => {
    const project = quickExits(on, { prints })
    await $.session.start(start)
    await project.clock.advance(THREE_QUICK_EXITS_MS)
    expect(project.heard().filter(text => text.includes(GAVE_UP)).length).toBe(prompts)
    const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
    await project.clock.advance(END_MS)
    await ending
  })
}

longTest('a session that ends while the log of a watcher given up on is written wakes the agent of no session', async ($, on) => {
  const project = quickExits(on, { prints: undefined })
  await $.session.start(start)
  await project.clock.advance(THREE_QUICK_EXITS_MS - AFTER_GIVE_UP_MS)
  project.holdLog()
  await project.clock.advance(AFTER_GIVE_UP_MS)
  const ending = $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
  await project.clock.advance(END_MS)
  await ending
  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't2' })
  project.releaseLog()
  await project.clock.advance(AFTER_GIVE_UP_MS)
  expect(project.heard().filter(text => text.includes(GAVE_UP))).toEqual([])
  const next = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await project.clock.advance(END_MS)
  await next
})
