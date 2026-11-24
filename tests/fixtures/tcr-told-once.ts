import { expect } from 'claude-code/testing'
import { WARNINGS, ended, start } from './tcr'
import { METADATA, onMain, commit } from './tcr-move'
import { inSession, edit, personWrites, toldPlain, longTest, DECIDE_MS, END_MS, SETTLE_MS, START_MS, type Engine, type Project } from './tcr-session'

export const FAILURE = '29 warnings'
export const GUARD = 'this action is guarded while relevant checks fail'
const CHECK_TICK_MS = 500
const GIVES_UP_AT_ONCE = { OVERWATCH_TCR_TIMEOUT_SCALE: '0.002' }
const TCR_RUN_OF_THE_CHECK_MS = 300

type Options = Parameters<typeof inSession>[2]
type State = { name: string; options: Options; reach: ($: Engine, project: Project) => Promise<void> }
type Arrival = 'before the next turn starts' | 'after the next turn started'
type Source = 'a change the agent did not make' | 'an edit of the agent'
/** When the turn completes, in milliseconds after the failure begins; none when it does not complete before the next turn starts. */
type Stop = { name: string; delayMs: number | undefined }

/**
 * The states in which a turn that completes after the check reported the failure is told it twice: by the guard of its end, and by the check at a next turn start.
 * The value is how many of the cases of the state tell it twice; every other state tells it once.
 */
const TOLD_TWICE = new Map([
  ['paused by a change outside', 12],
  ['unavailable at the start', 12],
  ['holding an edit for a check that gave no result', 7],
  ["left to the checks by the agent's own commit", 6],
])

const hasTold = (project: Project, part: string) => toldPlain(project).some(text => text.includes(part))
const mentionsOf = (text: string) => text.split(FAILURE).length - 1

/** The states TCR can be in when a check reports a new failure, each reached from a turn that started, and each asserting what only that state shows. */
export const STATES: State[] = [
  {
    name: 'active',
    options: {},
    reach: async (_$, project) => {
      await project.clock.advance(SETTLE_MS)
      expect(hasTold(project, 'TCR is on')).toBe(true)
      expect(project.workspace.commits).toEqual([])
    },
  },
  {
    name: 'paused by a change outside',
    options: {},
    reach: async ($, project) => {
      personWrites(project)
      await $.tool.call({ tool: 'Read', file_path: '/repo/person.py' })
      await project.clock.advance(SETTLE_MS)
      expect(hasTold(project, "files changed outside the agent's edits")).toBe(true)
    },
  },
  {
    name: 'unavailable at the start',
    options: { prepare: workspace => { workspace.dirty = ['person.py']; workspace.fingerprint = 'person' } },
    reach: async (_$, project) => {
      await project.clock.advance(SETTLE_MS)
      expect(project.workspace.dirty).toEqual(['person.py'])
      expect(hasTold(project, 'TCR is unavailable')).toBe(true)
      expect(hasTold(project, 'uncommitted changes')).toBe(true)
    },
  },
  {
    name: 'holding an edit for a check that gave no result',
    options: { hang: 'check', env: GIVES_UP_AT_ONCE },
    reach: async ($, project) => {
      await edit($, project, ['a.py'], 'f1')
      await project.clock.advance(SETTLE_MS)
      expect(hasTold(project, 'gave no result to judge by')).toBe(true)
      expect(project.workspace.reverted).toEqual([])
    },
  },
  {
    name: 'left to the checks by the agent\'s own commit',
    options: { prepare: onMain },
    reach: async ($, project) => {
      commit(project)
      await $.tool.call({ tool: 'Bash', command: 'git commit --allow-empty -m x' })
      await project.clock.advance(SETTLE_MS)
      expect(project.workspace.files.get(`${METADATA}/logs/HEAD`)).toContain('commit: break')
    },
  },
  {
    name: 'active after a checkpoint',
    options: {},
    reach: async ($, project) => {
      await edit($, project, ['a.py'], 'f1')
      expect(project.workspace.commits).toEqual(['tcr: a.py'])
    },
  },
  {
    name: 'decided again after the session resumed',
    options: {},
    reach: async ($, project) => {
      const asksBefore = project.workspace.asked.length
      const ending = $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
      await project.clock.advance(END_MS)
      await ending
      await $.session.start(start)
      await project.clock.advance(START_MS)
      expect(project.workspace.asked.length).toBeGreaterThan(asksBefore)
    },
  },
]

export const ARRIVALS: Arrival[] = ['before the next turn starts', 'after the next turn started']
export const SOURCES: Source[] = ['a change the agent did not make', 'an edit of the agent']
export const STOPS: Stop[] = [
  { name: 'the turn does not complete', delayMs: undefined },
  { name: 'the turn completes 300ms after the failure begins', delayMs: 300 },
  { name: 'the turn completes 700ms after the failure begins', delayMs: 700 },
  { name: 'the turn completes 900ms after the failure begins', delayMs: 900 },
  { name: 'the turn completes 1500ms after the failure begins', delayMs: 1500 },
]

/** The cases each state plays: an arrival, a source and a stop. */
export const CASES_PER_STATE = ARRIVALS.length * SOURCES.length * STOPS.length

/** What a case did, recorded only once it reached its state, for the check at the end of its state's shard. */
type Played = { name: string; reports: number; guards: number; reverts: number; isCompleted: boolean }
const played = new Map<string, Played[]>()

/** The checks report a new failure, as the source says: with no tool of the agent, or after an edit of the agent that leaves it; and the turn completes when the stop says. The check then prints nothing more, as a watcher that prints only a change does, so that a later print cannot tell the failure again. */
async function fails($: Engine, project: Project, { source, stop, turnId }: { source: Source; stop: Stop; turnId: string }): Promise<boolean> {
  project.setReport(WARNINGS)
  if (source === 'an edit of the agent') {
    project.willChange(['b.py'], 'f9')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/b.py' })
  }
  let waited = 0
  let completion: unknown
  if (stop.delayMs !== undefined) {
    await project.clock.advance(stop.delayMs)
    completion = await $.turn.complete({ ...ended, turnId })
    waited = stop.delayMs
  }
  await project.clock.advance(CHECK_TICK_MS + SETTLE_MS - waited)
  project.workspace.silent = true
  await project.clock.advance(SETTLE_MS)
  return completion !== undefined
}

/** Plays the cases of one state, each as a test, and a last test that the cases reached the state, told the failure once or, in the states of TOLD_TWICE, as many times twice as the table says, and were all played. */
export function playState(index: number) {
  const state = STATES[index] as State
  played.set(state.name, [])
  for (const arrival of ARRIVALS) for (const source of SOURCES) for (const stop of STOPS) {
    const name = `${arrival}, ${source}, ${stop.name}`
    longTest(`the agent is told of a new failure as its state pins: TCR ${state.name}, the failure from ${source} comes ${arrival}, ${stop.name}`, async ($, on) => {
      await inSession({ $, on }, async project => {
        await $.turn.start({ text: 'go', turnId: 't1' })
        await project.clock.advance(DECIDE_MS)
        await state.reach($, project)
        if (arrival === 'after the next turn started') {
          await $.turn.start({ text: 'again', turnId: 't2' })
          await project.clock.advance(SETTLE_MS)
        }
        const isCompleted = await fails($, project, { source, stop, turnId: arrival === 'after the next turn started' ? 't2' : 't1' })
        await $.turn.start({ text: 'third', turnId: 't3' })
        await project.clock.advance(SETTLE_MS)
        await $.tool.call({ tool: 'Read', file_path: '/repo/a.py' })
        await project.clock.advance(SETTLE_MS)
        await $.turn.start({ text: 'fourth', turnId: 't4' })
        await project.clock.advance(SETTLE_MS)
        await $.tool.call({ tool: 'Read', file_path: '/repo/a.py' })
        await project.clock.advance(SETTLE_MS)
        const told = toldPlain(project)
        const reports = told.filter(text => !text.includes(GUARD)).reduce((sum, text) => sum + mentionsOf(text), 0)
        const guards = told.filter(text => text.includes(GUARD)).reduce((sum, text) => sum + mentionsOf(text), 0)
        const reverts = project.workspace.reverted.length
        played.get(state.name)?.push({ name, reports, guards, reverts, isCompleted })
        expect(reports).toBe(1)
        expect(guards).toBeLessThanOrEqual(TOLD_TWICE.has(state.name) ? 1 : 0)
        if (guards > 0) expect(isCompleted).toBe(true)
        if (reverts > 0) expect(guards).toBe(0)
      }, { judgeDelayMs: TCR_RUN_OF_THE_CHECK_MS, ...state.options })
    })
  }
  longTest(`the cases of the state ${state.name} were all played, reached the state, and each told the failure as its state pins`, () => {
    const cases = played.get(state.name) ?? []
    expect(cases.length).toBe(CASES_PER_STATE)
    expect(new Set(cases.map(each => each.name)).size).toBe(CASES_PER_STATE)
    expect(cases.every(each => each.reports === 1)).toBe(true)
    expect(cases.filter(each => each.guards === 1).length).toBe(TOLD_TWICE.get(state.name) ?? 0)
    expect(cases.filter(each => each.isCompleted).length).toBe(CASES_PER_STATE - ARRIVALS.length * SOURCES.length)
    expect(cases.filter(each => each.reverts > 0).every(each => each.guards === 0)).toBe(true)
  })
}
