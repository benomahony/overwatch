import { expect } from 'claude-code/testing'
import { WARNINGS } from './fixtures/tcr'
import { edit, inSession, told, DECIDE_MS, SETTLE_MS, type On, longTest } from './fixtures/tcr-session'

const BUG = 'a bug in the plugin'
const BUG_NOTICE = 'overwatch hit an unexpected error'
const NEVER_MS = 10_000_000

type Logged = { message: string; to: string | undefined }

type Handler = (host: never, event: { text?: unknown; to?: string }) => unknown

/** `on` with each `ui.log` call also recorded with where it was written. */
function recording(on: On, logs: Logged[]): On {
  const record = (handler: Handler): Handler => (host, event) => {
    logs.push({ message: String(event.text), to: event.to })
    return handler(host, event)
  }
  return ((name: string, handler: Handler) => on(name as never, (name === 'ui.log' ? record(handler) : handler) as never)) as On
}

longTest('a bug of the plugin in a judgement that a timer started tells the agent once, and is written where the user sees it', async ($, on) => {
  const logs: Logged[] = []
  await inSession({ $, on: recording(on, logs) }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.workspace.existsBug = new TypeError(BUG)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(SETTLE_MS)
    expect(told(project).join('\n').split(BUG_NOTICE).length - 1).toBe(1)
    expect(logs.filter(({ message }) => message.includes(BUG_NOTICE)).map(({ to }) => to)).toEqual(['transcript'])
  })
})

longTest('a failure reported while the write of its log never answers is told without the log', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(SETTLE_MS)
    project.workspace.writeDelayMs = NEVER_MS
    project.setReport(WARNINGS)
    await edit($, project, ['a.py'], 'f1')
    await project.clock.advance(SETTLE_MS)
    expect(told(project).some(text => text.includes('zanity') && text.includes('warnings'))).toBe(true)
  }, { settings: {}, env: { OVERWATCH_TCR_TIMEOUT_SCALE: '0.04', HOME: '/home/me' } })
})

longTest('a bug in the look for the repository that starts a judgement is told as an unexpected error, not as a failed read', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    project.workspace.existsBug = new TypeError(BUG)
    await project.clock.advance(SETTLE_MS)
    expect(told(project).join('\n')).toContain(BUG_NOTICE)
  })
})

longTest('a bug in the read of HEAD after a checkpoint is told as an unexpected error, not as a failed read', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.workspace.hooks['checkpoint#1:after'] = () => { project.workspace.files.set('/repo/.git', null as never) }
    await edit($, project, ['a.py'], 'f1')
    await project.clock.advance(SETTLE_MS)
    expect(told(project).some(text => text.includes(`${BUG_NOTICE}: TypeError`))).toBe(true)
  })
})
