import { start } from './tcr'
import { edit, toldPlain, END_MS, START_MS, type Engine, type On, type Project } from './tcr-session'

/**
 * The host may start the next session before the end of the last one returns, which the plugin cannot rule out. A gap of
 * 0 to 150 ms between the call that ends a session and the call that starts the next plays the same session, and the agent
 * of the new session is told that TCR is on, once, and no error, and its first edit is committed.
 */
export const OVERLAP_TIMEOUT_MS = 600_000
export const FIRST_GAP_MS = 0
export const LAST_GAP_MS = 150
export const MIDDLE_GAP_MS = 20
export const SLOW_SEARCH_MS = 3000
export const ON_NOTICE = 'overwatch: TCR is on: an edit that keeps the checks green is committed, and an edit that adds a failure is reverted.'
const STALE_DIRECTORY = '/stale'
export const RESUME = { reason: 'resume' as const, sessionId: 's1', resume: { id: 's1' } }

/** The hooks of a host whose answer to the directory of a resumed session is one that no session of the test started in, so that a session that takes it as its own cannot find its repository. */
export function resumingElsewhere(on: On): On {
  return ((name: string, handler: unknown) => (name === 'session.cwd' ? on(name as never, (() => ({ value: STALE_DIRECTORY })) as never) : on(name as never, handler as never))) as On
}

/** A session that ends as a resume, and a new one that starts `gapMs` later, `windowMs` before the clock moves on; what the new session was told, logged and committed. */
export async function playOverlap($: Engine, project: Project, { gapMs, windowMs }: { gapMs: number; windowMs: number }) {
  const before = toldPlain(project).length
  project.reset()
  await $.session.start(start)
  await project.clock.advance(START_MS)
  const ending = $.session.end(RESUME)
  if (gapMs > 0) await project.clock.advance(gapMs)
  const starting = $.session.start(start)
  await project.clock.advance(windowMs)
  await ending
  await starting
  await project.clock.advance(windowMs)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await project.clock.advance(START_MS)
  const toldBeforeTheEdit = toldPlain(project).slice(before)
  await edit($, project, ['a.py'], 'f1')
  await project.clock.advance(windowMs)
  return { gapMs, toldBeforeTheEdit, told: toldPlain(project).slice(before), logged: project.workspace.logged, commits: project.workspace.commits }
}

export const expected = (gapMs: number) => ({ gapMs, toldBeforeTheEdit: [ON_NOTICE], told: [ON_NOTICE], logged: [], commits: ['tcr: a.py'] })

export async function endSession($: Engine, project: Project) {
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await project.clock.advance(END_MS)
  await ending
}
