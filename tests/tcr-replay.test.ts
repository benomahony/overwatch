/** Replay the TCR schedules that TLC computed from spec/Overwatch.tla through the plugin's hooks.
 *
 * tests/fixtures/tcr-traces.ts is the module that scripts/model_traces.py writes from the model, with the other
 * generated fixtures; the model's pull request commits the same module, byte for byte, so the two pull requests
 * agree on one path and one content, and the generator's check of that pull request fails when it goes stale.
 * Each schedule names the model's actions and what holds after each one. An edit of the agent is a tool call that
 * changes files, the checks and the checkpoint or the revert happen once the files are quiet, and a person's work is
 * a change that no tool call of the agent made. After each action the clean tree, the saved copies, the checkpoints and
 * the reverts of the project's repository must agree with the model; the notice of a revert and of a held edit must have been
 * told where the schedule tells it, and the notice that TCR is unavailable where the schedule leaves it so. The `head` and the `person`
 * of each state of the model are not compared with the plugin, nor is `held` after each action, only the notice of a held edit.
 */
import { expect } from 'claude-code/testing'
import { assert } from '../hooks/assert'
import { CLEAN, WARNINGS, type Workspace } from './fixtures/tcr'
import { inSession, personWrites, told, DECIDE_MS, SETTLE_MS, type Kit, type Project, longTest } from './fixtures/tcr-session'
import { onMain, pull } from './fixtures/tcr-move'
import { TCR_TRACES } from './fixtures/tcr-traces'

type State = { head: number; tcr: 'active' | 'unavailable' | 'off'; clean: boolean; held: boolean; saved: number; person: string }
type Schedule = { name: string; truth: string[][]; events: string[]; person: 'none' | 'seen'; expected: State[] }
/** The replay of one schedule so far: which workspace version the files are at, and how many of each action happened. */
type Replay = { version: number; turn: number; checkpoints: number; reverts: number }
/** What a step of the replay works on. */
type Run = { kit: Kit; project: Project; schedule: Schedule; replay: Replay }

const SCHEDULES = TCR_TRACES as unknown as Schedule[]
const SCHEDULES_IN_THE_FIXTURE = 21
const HANG_LIMIT_MS = 1500
const TIMEOUT_ENV = { OVERWATCH_TCR_TIMEOUT_SCALE: '0.002' }
const REFUSED_KEY = { path: 'key.txt', rule: 'private key', line: 1 }
const FAILED_COMMIT = 'the checkpoint commit failed and its changes are left staged: refused'
const UNFINISHED_REVERT = 'the files kept changing while the revert saved them, so nothing was deleted'
const WARNINGS_BASE = 28
const LAST_VERSION = 100

const TIMED_OUT = 'a check that timed out holds the edit and never reverts it'
const PULLED = 'a pull after the person committed a held edit ends the hold'
const ABORTED_REVERT = 'a revert whose files keep changing while it saves aborts and deletes nothing'
// The schedules in which a check first appears with the agent's edit, so that it has no earlier result.
const LATE_CHECK = [
  'a failing first result is held and the agent is told',
  'a held edit is committed by the person and the next edit that passes is committed',
  'a held check that gets worse is held again and never reverted',
  'a held edit survives a turn start and the next edit that passes is committed',
  'a change to the tree while an edit is held stops TCR at the turn start',
  'a held check that passed is judged again and a new failure is reverted',
  PULLED,
]
const JUDGING = new Set(['Checkpoint', 'Revert', 'Hold', 'FailCommit', 'Refuse', 'AbortRevert'])
const SILENT = new Set(['Build', 'Read', 'Quiet', 'Tick', 'Timeout', 'TellRevert', 'TellHold'])

function isHeldNotice(text: string): boolean {
  assert(typeof text === 'string', `what the agent was told is ${typeof text}, no text`)
  assert(text !== '', `the agent was told ${JSON.stringify(text)}, an empty message`)
  return text.includes('TCR held the edit') || text.includes('gave no result to judge by')
}

/** What the check prints for the model's failures: a failure, worse at each version of a check that has no earlier result. */
function reportOf(schedule: Schedule, failures: string[], version: number): string {
  assert(version >= 0, `version ${version} is before the first workspace version`)
  assert(schedule.truth.length > 0, `${schedule.name} gives the check no failures to print`)
  if (failures.length === 0) return CLEAN
  return LATE_CHECK.includes(schedule.name) ? `zanity: 0 errors and ${WARNINGS_BASE + version} warnings in 1 of 1 files\n` : WARNINGS
}

/** The report of the check at the workspace version that the replay has reached. */
function reportAt({ schedule, replay }: Run): string {
  assert(replay.version >= 0 && Number.isInteger(replay.version), `the replay is at version ${replay.version}`)
  assert(schedule.events.length > 0, `${schedule.name} has no events to replay`)
  return reportOf(schedule, schedule.truth[replay.version] ?? [], replay.version)
}

function seenPerson(workspace: Workspace) {
  workspace.dirty = ['mine.py']
  workspace.fingerprint = 'mine'
  assert(workspace.dirty.length === 1, `the person's file is not the only dirty file: ${workspace.dirty}`)
  assert(workspace.fingerprint === 'mine', `the person's file left the fingerprint ${workspace.fingerprint}`)
}

function optionsOf(schedule: Schedule): Parameters<typeof inSession>[2] {
  assert(schedule.person === 'none' || schedule.person === 'seen', `${schedule.name}: a person who is ${schedule.person} at the start`)
  assert(schedule.truth.length > 0, `${schedule.name} has no failures for the check to start with`)
  return {
    initial: reportOf(schedule, schedule.truth[0] ?? [], 0),
    mute: LATE_CHECK.includes(schedule.name),
    ...(schedule.name === TIMED_OUT ? { env: TIMEOUT_ENV, hang: 'check' as const } : {}),
    ...(schedule.name === PULLED ? { prepare: onMain } : {}),
    ...(schedule.person === 'seen' ? { prepare: seenPerson } : {}),
  }
}

/** The file that the agent's edit of the workspace version changes. */
function fileOf(version: number): string {
  assert(Number.isInteger(version) && version > 0, `the agent edits version ${version}, which is no edit`)
  assert(version < LAST_VERSION, `the agent edits version ${version}, past any schedule`)
  return `edit${version}.py`
}

async function startTurn({ kit, project, replay }: Run) {
  replay.turn++
  assert(replay.turn > 0, `the replay is at turn ${replay.turn}`)
  assert(Array.isArray(project.workspace.asked), `the project asked the checkpoint command ${project.workspace.asked}, which is no list`)
  await kit.$.turn.start({ text: 'go', turnId: `t${replay.turn}` })
  await project.clock.advance(DECIDE_MS)
}

async function completeTurn({ kit, replay }: Run) {
  assert(replay.turn > 0, `a turn completes at turn ${replay.turn}, before any started`)
  assert(Number.isInteger(replay.turn), `the turn ${replay.turn} is no count`)
  await kit.$.turn.complete({ turnId: `t${replay.turn}`, answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
}

async function agentEdits(run: Run) {
  run.replay.version++
  const file = fileOf(run.replay.version)
  assert(run.schedule.truth.length > run.replay.version - 1, `${run.schedule.name} edits past its last version`)
  assert(file.endsWith('.py'), `the edit changes ${file}, which is no file the project checks`)
  run.project.setReport(reportAt(run))
  run.project.willChange([file], `f${run.replay.version}`)
  await run.kit.$.tool.call({ tool: 'Edit', file_path: `/repo/${file}` })
}

async function personObserved({ kit }: Run) {
  assert(typeof kit.$.tool.call === 'function', 'the engine has no tool call to observe')
  assert(typeof kit.on === 'function', `the kit's hook registration is ${typeof kit.on}`)
  await kit.$.tool.call({ tool: 'Read', file_path: '/repo/person.py' })
}

function personCommits({ project }: Run) {
  const { workspace } = project
  assert(workspace.dirty.length > 0, `the person commits a clean tree: ${workspace.dirty}`)
  workspace.dirty = []
  workspace.committed = workspace.fingerprint
  assert(workspace.dirty.length === 0, `the person's commit left ${workspace.dirty} dirty`)
}

function personOutside({ project, replay }: Run) {
  assert(!project.workspace.dirty.includes('person.py'), 'the person wrote the same file twice, which changes nothing')
  replay.version++
  personWrites(project)
  assert(project.workspace.dirty.includes('person.py'), `the person's file is not in ${project.workspace.dirty}`)
}

async function pulls(run: Run) {
  const { project } = run
  run.replay.version++
  assert(project.workspace.dirty.length === 0, `${project.workspace.dirty} is not clean, and a pull needs a clean tree`)
  assert(run.replay.version < run.schedule.truth.length, `${run.schedule.name} pulls past its last version`)
  project.setReport(reportAt(run))
  pull(project)
  await run.kit.$.tool.call({ tool: 'Bash', command: 'git pull' })
  await project.clock.advance(SETTLE_MS)
}

async function judges(run: Run, event: string) {
  const { workspace } = run.project
  assert(JUDGING.has(event), `${event} is no action that judges an edit`)
  assert(workspace.dirty.length > 0 || event === 'Hold', `${event} judges nothing: the tree is clean`)
  if (event === 'FailCommit') workspace.refusal = FAILED_COMMIT
  if (event === 'Refuse') workspace.refused = [REFUSED_KEY]
  if (event === 'AbortRevert') workspace.revertError = UNFINISHED_REVERT
  await run.project.clock.advance(run.schedule.name === TIMED_OUT ? SETTLE_MS + HANG_LIMIT_MS : SETTLE_MS)
  if (event === 'Checkpoint') run.replay.checkpoints++
  if (event === 'Revert') run.replay.reverts++
}

/** What each action of the model is for the plugin; an action that only lets time pass is no entry. */
const ACTIONS: Record<string, (run: Run) => Promise<void> | void> = {
  Start: startTurn,
  Complete: completeTurn,
  Edit: agentEdits,
  Outside: personOutside,
  Observe: personObserved,
  Commit: personCommits,
  Move: pulls,
}

async function applyEvent(run: Run, event: string) {
  assert(event in ACTIONS || JUDGING.has(event) || SILENT.has(event), `${run.schedule.name}: the replay does not know the event ${event}`)
  assert(run.schedule.events.includes(event), `${event} is no event of ${run.schedule.name}`)
  const action = ACTIONS[event]
  if (action !== undefined) await action(run)
  else if (JUDGING.has(event)) await judges(run, event)
}

function agree({ project, schedule, replay }: Run, event: string, expected: State) {
  const { workspace } = project
  const label = `${schedule.name}: after ${event}`
  assert(expected.tcr === 'active' || expected.tcr === 'unavailable', `${label}: the model's TCR ${expected.tcr} is none of its states`)
  assert(replay.checkpoints >= 0 && replay.reverts >= 0, `${label}: ${replay.checkpoints} checkpoints and ${replay.reverts} reverts`)
  expect(workspace.dirty.length === 0, `${label}: clean tree`).toBe(expected.clean)
  expect(workspace.saved.length, `${label}: saved copies`).toBe(expected.saved)
  expect(workspace.commits.length, `${label}: checkpoints`).toBe(replay.checkpoints)
  expect(workspace.reverted.length, `${label}: reverts`).toBe(replay.reverts)
  if (event === 'Revert') expect(told(project).filter(text => text.includes('TCR reverted')).length, `${label}: notices of a revert`).toBe(replay.reverts)
  if (event === 'Hold') expect(told(project).some(isHeldNotice), `${label}: notice of a held edit`).toBe(true)
  if (event === 'TellRevert') expect(told(project).some(text => text.includes('TCR reverted')), `${label}: the agent was told of the revert`).toBe(true)
  if (event === 'TellHold') expect(told(project).some(isHeldNotice), `${label}: the agent was told of the held edit`).toBe(true)
}

/** The agent is told of a held edit exactly when the model holds one. */
function checkHeld({ project, schedule }: Run) {
  const toldHeld = told(project).some(isHeldNotice)
  assert(schedule.events.length > 0, `${schedule.name} has no events`)
  assert(typeof toldHeld === 'boolean', `whether the agent was told of a held edit is ${typeof toldHeld}`)
  expect(toldHeld, `${schedule.name}: the agent is told of a held edit exactly when the model holds one`).toBe(schedule.events.includes('Hold'))
}

/** The agent is told that TCR is unavailable when a turn starts, or the session ends, with TCR still unavailable; a pause that
 * is over before the next turn start is never told, and a schedule that never leaves TCR unavailable is never told so. */
function checkUnavailable({ project, schedule }: Run) {
  const { events, expected } = schedule
  const lasting = expected.some((state, at) => state.tcr === 'unavailable' && (at === expected.length - 1 || (events[at] === 'Start' && expected[at + 1]?.tcr === 'unavailable')))
  const goesUnavailable = expected.some(state => state.tcr === 'unavailable')
  const toldUnavailable = told(project).some(text => text.includes('TCR is unavailable'))
  assert(expected.length === events.length + 1, `${schedule.name}: ${expected.length} states for ${events.length} events`)
  assert(typeof toldUnavailable === 'boolean' && typeof lasting === 'boolean', `${schedule.name}: ${toldUnavailable} and ${lasting} are no answers`)
  if (lasting) expect(toldUnavailable, `${schedule.name}: the agent is told that TCR stays unavailable`).toBe(true)
  if (!goesUnavailable) expect(toldUnavailable, `${schedule.name}: the agent is told that TCR is unavailable, which the model never leaves it`).toBe(false)
}

async function replaySchedule(kit: Kit, schedule: Schedule) {
  assert(schedule.events.length + 1 === schedule.expected.length, `${schedule.name}: ${schedule.expected.length} states for ${schedule.events.length} events`)
  assert(schedule.events.length > 0, `${schedule.name} has no events to replay`)
  await inSession(kit, async project => {
    const run: Run = { kit, project, schedule, replay: { version: 0, turn: 0, checkpoints: 0, reverts: 0 } }
    for (const [index, event] of schedule.events.entries()) {
      await applyEvent(run, event)
      agree(run, event, schedule.expected[index + 1]!)
    }
    await project.clock.advance(SETTLE_MS)
    checkUnavailable(run)
    checkHeld(run)
  }, optionsOf(schedule))
}

longTest('the fixture holds the schedules the replay is written for', () => {
  const names = SCHEDULES.map(schedule => schedule.name)
  expect(names.length).toBe(SCHEDULES_IN_THE_FIXTURE)
  expect(new Set(names).size, 'schedule names are unique').toBe(names.length)
  for (const known of [TIMED_OUT, PULLED, ABORTED_REVERT, ...LATE_CHECK]) expect(names, `the schedule ${known} no longer exists; update the replay`).toContain(known)
})

for (const schedule of SCHEDULES) {
  longTest(`model conformance of TCR: ${schedule.name}`,  async ($, on) => {
    await replaySchedule({ $, on }, schedule)
  })
}
