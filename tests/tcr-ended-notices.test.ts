import { expect } from 'claude-code/testing'
import { tellEndedRevert } from '../hooks/revert-aftermath'
import { WARNINGS, start, tcrProject, type Workspace } from './fixtures/tcr'
import { inSession, told, toldPlain, DECIDE_MS, START_MS, STEP_MS as STEP, longTest, type On, type Project } from './fixtures/tcr-session'

const SETTLED_MS = 1500
const HELD_WAIT_MS = 4000
const SESSION_END_MS = 50
const RESUME = { reason: 'resume' as const, sessionId: 's1', resume: { id: 's1' } }
const UNEXPECTED = 'overwatch hit an unexpected error'
const HELD_NOTICE = 'left the latest change uncommitted and unreverted'
const NOT_KNOWN_TOAST = 'overwatch: a TCR revert was running when its session ended. It may have discarded files, and no copy of them is known.'
const NOT_SAVED_TOAST = 'overwatch: a TCR revert was running when its session ended. No copy of the files it may have discarded was saved.'
const SAVED_TOAST = (ref: string) => `overwatch: a TCR revert was running when its session ended. A copy of the files it may have discarded is saved in ${ref}.`
const NO_SAVE = { mode: 'tcr', tcr: { saveReverted: false } }
const PERSON_COMMITTED = { dirty: [], fingerprint: 'clean' }
const BOOM = 'the revert hit a bug'

const asked = (project: Project, command: string) => project.workspace.asked.length === 0 ? 0 : project.workspace.asked.filter(each => each === command).length

/** Holds the first ask of `command` that has `flag`, by the number of the call, and says which call it was. */
function holdFirstWith(project: Project, { command, flag }: { command: string; flag: string }): { release: () => void; nth: () => number | undefined } {
  const { workspace } = project
  let release = () => undefined
  const held = new Promise<void>(resolve => { release = resolve })
  let heldNth: number | undefined
  workspace.holds = new Proxy({} as Workspace['holds'], {
    get: (_target, key) => {
      const [name, count] = String(key).split('#')
      if (name !== command || heldNth !== undefined || workspace.flags.at(-1)?.includes(flag) !== true) return undefined
      heldNth = Number(count)
      return held
    },
  })
  return { release, nth: () => heldNth }
}

async function untilHeld(project: Project, held: { nth: () => number | undefined }) {
  for (let step = 0; step < HELD_WAIT_MS / STEP && held.nth() === undefined; step += 1) await project.clock.advance(STEP)
  expect(held.nth()).toBeDefined()
}

async function resumeAndStartAgain($: Parameters<Parameters<typeof longTest>[1]>[0], project: Project, whenEnded: Partial<Workspace> = {}) {
  const ending = $.session.end(RESUME)
  await project.clock.advance(SESSION_END_MS)
  await ending
  Object.assign(project.workspace, whenEnded)
  await $.session.start(start)
  await project.clock.advance(START_MS)
  await $.turn.start({ text: 'new session turn', turnId: 't3' })
  await project.clock.advance(START_MS)
  await $.tool.call({ tool: 'Read', file_path: '/repo/b.py' })
}

longTest('a hold that names the files of an ended session after the session resumed tells the next session nothing', async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(WARNINGS)
    const held = holdFirstWith(project, { command: 'fingerprint', flag: '--content' })
    project.workspace.hooks[`revert#${asked(project, 'revert') + 1}`] = () => { project.workspace.dirty = [] }
    project.willChange(['a.py'], 'f1')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await untilHeld(project, held)
    await resumeAndStartAgain($, project, PERSON_COMMITTED)
    held.release()
    await project.clock.advance(SETTLED_MS)
    await $.tool.call({ tool: 'Read', file_path: '/repo/b.py' })
    expect(toldPlain(project).filter(text => text.includes('TCR is on')).length).toBe(2)
    expect(toldPlain(project).filter(text => text.includes(HELD_NOTICE))).toEqual([])
  })
})

const REPOSITORY_MARKER = '/repo/.git'

/** The hooks of a host whose first look for the repository's `.git` waits until `release` is called and then fails with a bug of the plugin, as a read of the old session that answers late. */
function failingSearch(on: On): { on: On; arm: () => void; release: () => void; isReached: () => boolean } {
  let release = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  let isArmed = false
  let isReached = false
  const hooked = ((name: string, handler: (host: unknown, event: { path?: string }) => unknown) => {
    if (name !== 'fs.exists') return on(name as never, handler as never)
    return on(name as never, (async (host: unknown, event: { path?: string }) => {
      if (!isArmed || event.path !== REPOSITORY_MARKER) return handler(host, event)
      isArmed = false
      isReached = true
      await gate
      throw new TypeError(BOOM)
    }) as never)
  }) as On
  return { on: hooked, release, isReached: () => isReached, arm: () => { isArmed = true } }
}

longTest('an unexpected error of an ended session that surfaces after the next session began tells the next session nothing and leaves its TCR on', async ($, on) => {
  const search = failingSearch(on)
  const project = tcrProject(search.on)
  await $.session.start(start)
  await project.clock.advance(START_MS)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await project.clock.advance(START_MS)
  search.arm()
  await $.turn.start({ text: 'again', turnId: 't2' })
  await project.clock.advance(START_MS)
  expect(search.isReached()).toBe(true)
  const ending = $.session.end(RESUME)
  await project.clock.advance(SESSION_END_MS)
  await $.session.start(start)
  await project.clock.advance(START_MS)
  await $.turn.start({ text: 'new session turn', turnId: 't3' })
  await project.clock.advance(START_MS)
  expect(toldPlain(project).filter(text => text.includes(UNEXPECTED))).toEqual([])
  search.release()
  await project.clock.advance(SETTLED_MS)
  await ending
  await $.tool.call({ tool: 'Read', file_path: '/repo/b.py' })
  expect(toldPlain(project).filter(text => text.includes(UNEXPECTED) || text.includes(BOOM) || text.includes('TCR is paused'))).toEqual([])
  expect(toldPlain(project).filter(text => text.includes('TCR is on')).length).toBe(2)
  const closing = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await project.clock.advance(SESSION_END_MS)
  await closing
})

type Shape = { name: string; settings?: Record<string, unknown>; arrange: (project: Project) => void; toast: string | undefined; differs?: false; answers?: false }

const SHAPES: Shape[] = [
  { name: 'a traceback of the revert command', arrange: project => { project.workspace.revertIncomplete = { error: BOOM, resets: false, asBug: true } }, toast: NOT_KNOWN_TOAST },
  { name: 'a crash of the revert command', arrange: project => { project.workspace.crash = { command: 'revert', code: 139 } }, toast: NOT_KNOWN_TOAST, answers: false },
  { name: 'a revert that cannot tell what it left, that saved no copy', settings: NO_SAVE, arrange: project => { project.workspace.revertUnavailable = 'git could not list the files' }, toast: NOT_SAVED_TOAST },
  { name: 'a revert that saved no copy because the project says so', settings: NO_SAVE, arrange: () => undefined, toast: NOT_SAVED_TOAST },
  { name: 'a revert that failed after it saved a copy', arrange: project => { project.workspace.revertIncomplete = { error: BOOM, resets: false } }, toast: SAVED_TOAST('refs/overwatch/tcr/1') },
  { name: 'a revert of files that did not differ from the checkpoint', arrange: () => undefined, toast: undefined, differs: false },
]

for (const { name, settings, arrange, toast, differs, answers } of SHAPES) {
  longTest(`${name}, answered after its session ended, ${toast === undefined ? 'tells the user nothing' : 'tells the user what is known of the work it may have discarded'}`, async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(DECIDE_MS)
      project.setReport(WARNINGS)
      const nth = asked(project, 'revert') + 1
      let release = () => undefined
      project.workspace.holds[`revert#${nth}`] = new Promise<void>(resolve => { release = resolve })
      project.willChange(['a.py'], 'f1')
      await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
      for (let step = 0; step < SETTLED_MS / STEP && asked(project, 'revert') < nth; step += 1) await project.clock.advance(STEP)
      expect(asked(project, 'revert')).toBe(nth)
      let isAnswered = false
      project.workspace.hooks[`revert#${nth}:after`] = () => { isAnswered = true }
      arrange(project)
      await resumeAndStartAgain($, project, PERSON_COMMITTED)
      if (differs !== false) Object.assign(project.workspace, { dirty: ['a.py'], fingerprint: 'f1' })
      release()
      await project.clock.advance(SETTLED_MS)
      await $.tool.call({ tool: 'Read', file_path: '/repo/b.py' })
      expect(isAnswered).toBe(answers !== false)
      expect(project.toasts.map(each => (JSON.parse(each) as { text: string }).text).filter(each => each.includes('a TCR revert was running'))).toEqual(toast === undefined ? [] : [toast])
      expect(told(project).filter(text => text.includes('TCR tried to revert') || text.includes('TCR reverted'))).toEqual([])
    }, settings === undefined ? {} : { settings })
  })
}

longTest('the ref that the toast of an ended revert names is written with an escape for a hiding character and a line break', async () => {
  const toasts: string[] = []
  tellEndedRevert({ ui: { toast: (text: string) => toasts.push(text) } } as never, 'refs/x\u202e\nend')
  expect(toasts).toEqual([SAVED_TOAST('refs/x\\u202e\\x0aend')])
})
