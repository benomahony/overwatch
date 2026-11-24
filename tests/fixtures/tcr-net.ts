import { expect } from 'claude-code/testing'
import { INJECTED_MESSAGE, WARNINGS, start } from './tcr'
import { DECIDE_MS, END_MS, SETTLE_MS, START_MS, type Engine, type Project } from './tcr-session'

export const FAILED_EXIT = 1
export const WORKED_EXIT = 0
export const NET_TEST_MS = 240_000
const TRIED = 'TCR tried to revert'
const DONE = 'TCR reverted'
const REVERT_OPENINGS = [DONE, TRIED]
const UNAVAILABLE = 'TCR is unavailable'
const UNEXPECTED = 'overwatch hit an unexpected error'
const HOST_SKIPPED = 'no implementation for'

/** What the revert command prints and exits with, from what it would answer. */
export type Printed = (answer: Record<string, unknown>) => { code: number; text: string }

/** What a run of one scenario with one step of the host throwing left: what the agent was told, what was written to the host's log of the thrown error, and what the entry point itself threw. */
export type Run = { project: Project; told: string[]; unhandled: string[]; awaited: unknown[]; result: unknown; steps: string[]; revertStep: number; answerStep: number }

export type Scenario = { $: Engine; project: Project; throwAt: number | undefined; prepare?: (project: Project) => void; entry: (project: Project) => Promise<unknown> }

/** What the agent was told since the counts, as the text it reads. */
function toldSince(project: Project, { prompts, appended }: { prompts: number; appended: number }): string[] {
  const texts = [...project.prompts.slice(prompts), ...project.appended().slice(appended)]
  return texts.map(text => (text.startsWith('[{') ? (JSON.parse(text) as { text: string }[]).map(part => part.text).join('') : text))
}

/** Plays a scenario in a new session of the project, with the host's step `throwAt` throwing, or with none throwing when it is undefined, and returns what it left. A project registers its hooks once per test, so a test that plays a scenario again gives it the same project. */
export async function play({ $, project, throwAt, prepare, entry }: Scenario): Promise<Run> {
  project.reset()
  const counts = { prompts: project.prompts.length, appended: project.appended().length }
  await $.session.start(start)
  await project.clock.advance(START_MS)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await project.clock.advance(DECIDE_MS)
  project.setReport(WARNINGS)
  prepare?.(project)
  const { injection, hooks } = project.workspace
  let revertStep = Number.POSITIVE_INFINITY
  let answerStep = Number.POSITIVE_INFINITY
  hooks['revert#1'] = () => { revertStep = injection.steps.length }
  hooks['revert#1:after'] = () => { answerStep = injection.steps.length + 1 }
  injection.throwAt = throwAt
  injection.isArmed = true
  const awaited: unknown[] = []
  const result = await entry(project).catch((error: unknown) => { awaited.push(error) })
  await project.clock.advance(SETTLE_MS)
  injection.isArmed = false
  const unhandled = project.workspace.logged.filter(line => line.startsWith(UNEXPECTED))
  const run = { project, told: toldSince(project, counts), unhandled, awaited, result, steps: [...injection.steps], revertStep, answerStep }
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await project.clock.advance(END_MS)
  await ending
  return run
}

/** Whether `error` is the one the test made a step throw. */
export function isInjected(error: unknown): boolean {
  return String(error).includes(INJECTED_MESSAGE) || String(error).includes(HOST_SKIPPED)
}

/** The steps of the host that run a process: an error there is the command failing, which the plugin tells as a failed revert and not as a bug of its own. */
const PROCESS_STEPS = ['process.spawn', 'process.spawn chunk']

/**
 * What must hold of a run in which the revert command was spawned and `throwAt` made a later step throw: the tree is reverted,
 * so the agent is told a revert, opening as the answer's reset says (a reset given as done is told as a revert, any other answer
 * as a try, and a throw after the answer may turn a revert into a try), with every ref it could learn, and TCR is paused. A failing
 * answer that threw nothing is a clean pause that says TCR is unavailable, with no unexpected error told; a throw of a process step is the command failing,
 * which is as clean; only a throw of another step may go on as an error of the plugin's own, told as one, at most once.
 */
export function expectToldOfRevert(run: Run, { throwAt, names, isFailing, opening }: { throwAt: number | undefined; names: boolean; isFailing: boolean; opening: 'done' | 'tried' }) {
  const { project, told, unhandled, awaited } = run
  const step = throwAt === undefined ? undefined : run.steps[throwAt - 1]
  const label = { throwAt, step, steps: run.steps }
  expect({ ...label, rejections: [...unhandled, ...awaited].filter(error => !isInjected(error)).length }).toEqual({ ...label, rejections: 0 })
  expect({ ...label, rejections: unhandled.length + awaited.length <= 1 }).toEqual({ ...label, rejections: true })
  expect({ ...label, reverted: project.workspace.reverted.length > 0 }).toEqual({ ...label, reverted: true })
  const opens = opening === 'tried' || throwAt === undefined ? [opening === 'tried' ? TRIED : DONE] : [DONE, TRIED]
  const openings = REVERT_OPENINGS.filter(each => told.some(text => text.includes(each)))
  expect({ ...label, openings, isAllowed: openings.length > 0 && openings.every(each => opens.includes(each)) }).toEqual({ ...label, openings, isAllowed: true })
  const isNamed = names && (throwAt === undefined || throwAt > run.answerStep)
  if (isNamed) for (const ref of project.workspace.saved) expect({ ...label, ref, isTold: told.some(text => text.includes(ref)) }).toEqual({ ...label, ref, isTold: true })
  const isPropagated = unhandled.length + awaited.length === 1
  const unexpectedTold = told.join('\n').split(UNEXPECTED).length - 1
  const isUnexpectedTold = unexpectedTold > 0
  const isUnavailableTold = told.some(text => text.includes(UNAVAILABLE))
  if (step !== undefined && PROCESS_STEPS.includes(step)) expect({ ...label, isPropagated }).toEqual({ ...label, isPropagated: false })
  if (isFailing && !isPropagated) expect({ ...label, isUnavailableTold, isUnexpectedTold }).toEqual({ ...label, isUnavailableTold: true, isUnexpectedTold: false })
  if (isPropagated) expect({ ...label, unexpectedTold }).toEqual({ ...label, unexpectedTold: 1 })
}

/** What a run left of the project and of the entry's answer, which a throw that changed nothing leaves as the run without one does. */
function leftBy(run: Run): string {
  const { commits, reverted, dirty } = run.project.workspace
  return JSON.stringify({ commits, reverted: reverted.length, dirty: [...dirty].sort(), result: run.result ?? null })
}

/** What must hold of a run of an entry point in which the host's step `throwAt` threw, against `plain`, the run in which none did: nothing but that error went on, at most once, and a run that left the project or the entry's answer other than `plain` did tells the agent something `plain` did not, so that nothing the throw changed goes unsaid. */
export function expectToldOfError(run: Run, { plain, throwAt }: { plain: Run; throwAt: number | undefined }) {
  const { told, unhandled, awaited } = run
  const label = { throwAt, step: throwAt === undefined ? undefined : run.steps[throwAt - 1] }
  const seen = [...unhandled, ...awaited]
  expect({ ...label, foreign: seen.filter(error => !isInjected(error)).length }).toEqual({ ...label, foreign: 0 })
  expect({ ...label, isAtMostOnce: unhandled.length <= 1 && awaited.length <= 1 }).toEqual({ ...label, isAtMostOnce: true })
  const isChanged = leftBy(run) !== leftBy(plain)
  const isTold = told.some(text => !plain.told.includes(text))
  expect({ ...label, isChanged, isSilent: isChanged && !isTold }).toEqual({ ...label, isChanged, isSilent: false })
  if (unhandled.length > 0) expect({ ...label, isPausedAndTold: told.some(text => text.includes(UNEXPECTED)) }).toEqual({ ...label, isPausedAndTold: true })
}

/** Which steps a sweep plays: those whose number leaves `index` when divided by `of`, so that `of` tests together play each step once. */
export type Share = { index: number; of: number }
const WHOLE: Share = { index: 0, of: 1 }

/** Plays `scenario` once with no step throwing, then once for each step the plugin's calls of the host made, and gives each run to `check` as soon as it ends, while the project still holds what the run left. Every run starts a session cold, as the first of a project does. The check runs once for the plain run and once for each run played, and the sweep fails when it ran any other number of times. The plain run must make exactly `steps` steps, a number each sweep names as a literal, so that a scenario that stops reaching the host, or reaches it more often, fails and its number is set again; answers how many steps the plain run made. */
export async function sweep(scenario: Omit<Scenario, 'throwAt'> & { share?: Share; steps: number }, check: (run: Run, context: { plain: Run; throwAt: number | undefined }) => void): Promise<number> {
  let checked = 0
  const asserted = (run: Run, context: { plain: Run; throwAt: number | undefined }) => {
    check(run, context)
    checked += 1
  }
  const plain = await play({ ...scenario, throwAt: undefined })
  asserted(plain, { plain, throwAt: undefined })
  expect(plain.steps.length).toBe(scenario.steps)
  const { index, of } = scenario.share ?? WHOLE
  let played = 0
  for (let throwAt = 1; throwAt <= plain.steps.length; throwAt += 1) {
    if (throwAt % of !== index) continue
    asserted(await play({ ...scenario, throwAt }), { plain, throwAt })
    played += 1
  }
  const shared = Array.from({ length: plain.steps.length }, (_, step) => step + 1).filter(throwAt => throwAt % of === index).length
  expect(played).toBe(shared)
  expect(checked).toBe(shared + 1)
  return plain.steps.length
}
