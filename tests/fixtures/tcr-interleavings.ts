import { assert } from '../../hooks/assert'
import { QUIET_MS } from '../../hooks/delivery'
import { CLEAN, WARNINGS, start, tcrProject } from './tcr'
import { beginEdit, type Kit, type On, type Project } from './tcr-session'

/**
 * The class check of TCR's interleavings: every sequence of the events below, with exactly one write by a person, plays
 * against the plugin's hooks and a fake checkpoint command that answers from one workspace, and no checkpoint or revert may
 * take a file a person wrote. An editing tool call is two events, 'begin' and 'end', so that it overlaps the start of a
 * turn, which decides slowly here, the person's write, the quiet window, the end of the checks, and another editing call.
 * It covers the plugin's own decisions: when a turn start, an editing tool, a result of the checks and the quiet window let
 * TCR act, pause or wait. It does not cover the engine's compare-and-swap, the `--expect` fingerprint a checkpoint and a
 * revert carry, because the fake never changes the files between the plugin's look and its ask; the plugin's asks that carry
 * it are pinned in tcr-judgement.test.ts and tcr-holding.test.ts, and the refusal by the engine in test_checkpoint_command.py.
 * It does not play two editing tools that begin together, since each of its comparisons of the files ends before the next call begins; tcr-overlap.test.ts plays every sequence of up to four events with begins that overlap a slow comparison.
 * It does not play a tool that does not edit; the liveness check, tcr-liveness-*.test.ts, does, with no write by a person, and holds that
 * every edit of the agent is then committed or reverted, and a person's write before such a tool is pinned in tcr-person.test.ts. It sees a person's file taken, which is a failure of safety, and not an edit that is never judged, so a
 * comparison too weak to tell two fingerprints apart needs the direct tests in tcr-person.test.ts, which use fingerprints of one length.
 */
export const EVENTS = ['begin', 'end', 'person', 'turn', 'green', 'red', 'quiet'] as const

/** The events of the liveness check: no write by a person, and a tool that does not edit. */
const LIVENESS_EVENTS = ['begin', 'end', 'turn', 'green', 'red', 'quiet', 'tool'] as const
export type Event = (typeof EVENTS)[number] | (typeof LIVENESS_EVENTS)[number]

/** The most events of a sequence; the first the class check needs is a person's write between an edit and a turn start that the next edit begins in, which is five. */
export const SEQUENCE_LENGTH = 5

/** The most events of a sequence of the liveness check; a tool that does not edit, after an edit, then the quiet window, is four. */
const LIVENESS_LENGTH = 4

/** The most editing tool calls that run at once, which is enough for one to begin while another runs. */
const MOST_RUNNING = 2

/** How long the checks of an edit take once the quiet window has ended, so that a person can write while they run. */
const CHECKS_MS = 100

/** How long the decision at a turn start takes, longer than the turn event waits, so that tool calls and writes overlap it. */
export const DECISION_MS = 150
const TURN_MS = 50
const RESULT_MS = CHECKS_MS + TURN_MS
const SESSION_START_MS = DECISION_MS + TURN_MS
const SESSION_END_MS = QUIET_MS

const isResult = (event: Event) => event === 'green' || event === 'red'

/** How long the play of an event takes on the project's clock. */
function durationOf(event: Event): number {
  if (event === 'turn') return TURN_MS
  if (event === 'quiet') return QUIET_MS
  return isResult(event) ? RESULT_MS : 0
}

/** How many editing tool calls run after each event of the sequence. */
function runningAfter(sequence: readonly Event[]): number[] {
  let running = 0
  return sequence.map(event => {
    if (event === 'begin') running += 1
    if (event === 'end') running -= 1
    return running
  })
}

/** Whether a sequence says nothing new: the same event twice that only repeats itself, two results with nothing between that the second replaces, a call that ends with none running, or more calls running at once than the check plays. */
function isRedundant(sequence: readonly Event[]): boolean {
  const running = runningAfter(sequence)
  return running.some(count => count < 0 || count > MOST_RUNNING) || sequence.some((event, at) => {
    const next = sequence[at + 1]
    return next !== undefined && ((event === next && event !== 'begin' && event !== 'end') || (isResult(event) && isResult(next)))
  })
}

/** Every sequence of one to `length` events of `events`, with at most `writes` writes by a person, that does not repeat itself. */
function generated(events: readonly Event[], length: number, writes: number): Event[][] {
  assert(length > 0 && Number.isInteger(length), `${length} is no length of a sequence`)
  let layer: Event[][] = [[]]
  const all: Event[][] = []
  for (let size = 0; size < length; size++) {
    layer = layer.flatMap(prefix => events.map(event => [...prefix, event])).filter(sequence => !isRedundant(sequence) && sequence.filter(event => event === 'person').length <= writes)
    all.push(...layer)
  }
  assert(all.every(sequence => sequence.length > 0 && sequence.length <= length), `a sequence is outside one to ${length} events`)
  return all
}

/** Every sequence of one to `length` events with exactly one write by a person, that does not repeat itself. */
export function sequencesOf(length: number): Event[][] {
  const all = generated(EVENTS, length, 1).filter(sequence => sequence.includes('person'))
  assert(all.every(sequence => sequence.filter(event => event === 'person').length === 1), 'a sequence holds no write by a person, or more than one')
  return all
}

/** Every sequence of one to `length` events with an editing tool call and no write by a person, which TCR must judge whatever else happens. */
function livenessSequencesOf(length: number): Event[][] {
  const all = generated(LIVENESS_EVENTS, length, 0).filter(sequence => sequence.includes('begin'))
  assert(all.every(sequence => !sequence.includes('person')), 'a sequence holds a write by a person')
  return all
}

/**
 * Whether a person writes while an editing tool call runs, which nothing can tell from the call's own write, so the call's
 * checkpoint takes the file with the agent's, as a limit stated in the README. Counted, not checked.
 */
export function holdsBlindWrite(sequence: readonly Event[]): boolean {
  const running = runningAfter(sequence)
  const at = sequence.indexOf('person')
  assert(at >= 0 && running.length === sequence.length, `the sequence ${sequence} holds no write by a person`)
  return running[at] !== undefined && running[at] > 0
}

/**
 * Whether an editing tool call ends, and writes, while the decision a turn start began is still in flight. That edit looks
 * like changes that were there before the turn, so TCR is unavailable and the edit is neither committed nor reverted, a limit
 * stated in the README, which the liveness check does not hold against TCR.
 */
function endsDuringDecision(sequence: readonly Event[]): boolean {
  let sinceTurn = Infinity
  for (const event of sequence) {
    if (event === 'end' && sinceTurn < DECISION_MS) return true
    sinceTurn = event === 'turn' ? durationOf(event) : sinceTurn + durationOf(event)
  }
  return false
}

/** The files the checkpoints and the reverts took, by name. */
function takenFiles(project: Project): string[] {
  const { commits, reverted } = project.workspace
  const taken = [...commits.flatMap(commit => commit.replace('tcr: ', '').split(', ')), ...reverted.flat()]
  assert(taken.every(name => name.endsWith('.py')), `${taken} holds a name that is no file of the project`)
  return taken
}

function resetProject(project: Project) {
  const { workspace } = project
  Object.assign(workspace, { fingerprint: 'clean', committed: 'clean', dirty: [], commits: [], reverted: [], saved: [], next: undefined })
  workspace.started.clear()
  workspace.calls.clear()
  project.setReport(CLEAN)
  assert(workspace.dirty.length === 0 && workspace.started.size === 0, 'the project was not reset to a clean one')
}

/** An editing tool call that has begun: the way to end it, and the settling of the call. */
type Running = ReturnType<typeof beginEdit>

/** Plays the events one after the other; each has the number of its place in the sequence in the names it makes. Calls still running at the end are ended once the decisions have ended. */
async function play($: Kit['$'], project: Project, sequence: readonly Event[]) {
  assert(sequence.length > 0, `a sequence of ${sequence.length} events plays nothing`)
  const running: Running[] = []
  const settled: Promise<unknown>[] = []
  for (const [place, event] of sequence.entries()) {
    const { workspace } = project
    if (event === 'begin') {
      const call = beginEdit($, project, [`a${place}.py`], `f${place}`)
      running.push(call)
      settled.push(call.done)
      await project.clock.advance(0)
    } else if (event === 'end') {
      running.shift()?.end()
      await project.clock.advance(0)
    } else if (event === 'person') {
      workspace.dirty = [...workspace.dirty, `p${place}.py`]
      workspace.fingerprint = `p${place}`
    } else if (event === 'tool') {
      settled.push($.tool.call({ tool: 'Read', file_path: '/repo/read.py' }))
      await project.clock.advance(0)
    } else if (event === 'turn') {
      await $.turn.start({ text: `prompt ${place}`, turnId: `t${place}` })
      await project.clock.advance(TURN_MS)
    } else if (event === 'quiet') await project.clock.advance(QUIET_MS)
    else {
      project.setReport(event === 'green' ? CLEAN : WARNINGS)
      await project.clock.advance(RESULT_MS)
    }
  }
  await project.clock.advance(DECISION_MS)
  for (const call of running) call.end()
  await project.clock.advance(0)
  await Promise.all(settled)
  if (sequence.includes('begin')) await project.clock.advance(QUIET_MS + CHECKS_MS + TURN_MS)
  assert(project.workspace.next === undefined, `an edit of ${sequence} never reached the project`)
}

/** Plays the sequence in a session of its own, in a project reset to a clean one, and ends the session. */
async function playSession({ $, project }: { $: Kit['$']; project: Project }, sequence: readonly Event[]) {
  resetProject(project)
  await $.session.start(start)
  await project.clock.advance(SESSION_START_MS)
  await play($, project, sequence)
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await project.clock.advance(SESSION_END_MS)
  await ending
}

/** What one run of the sequences found: those with a violation, with the files taken, and how many held a write while an editing tool ran. */
export type Found = { sequences: number; blind: number; blindExamples: string[]; violations: [string, string[]][] }

/** How many sequences each check generates, and how many of the class check's hold a write by a person while an editing tool runs and how many of the liveness check's end an editing tool during a turn start's decision, which the checks count and do not play. */
export function totals(): { class: { sequences: number; blind: number }; liveness: { sequences: number; limited: number } } {
  const classSequences = sequencesOf(SEQUENCE_LENGTH)
  const livenessSequences = livenessSequencesOf(LIVENESS_LENGTH)
  assert(classSequences.length > 0 && livenessSequences.length > 0, `the checks generated ${classSequences.length} and ${livenessSequences.length} sequences; each must generate some`)
  return { class: { sequences: classSequences.length, blind: classSequences.filter(holdsBlindWrite).length }, liveness: { sequences: livenessSequences.length, limited: livenessSequences.filter(endsDuringDecision).length } }
}

/** Runs every `shards`th sequence from the `shard`th, each in a session of its own, in a project whose checks and decisions take a while. */
export async function runShard({ $, on }: { $: Kit['$']; on: On }, shard: number, shards: number): Promise<Found> {
  assert(shard >= 0 && shard < shards, `the shard ${shard} is none of the ${shards}`)
  const project = tcrProject(on, { judgeDelayMs: CHECKS_MS, reasonDelayMs: DECISION_MS })
  const found: Found = { sequences: 0, blind: 0, blindExamples: [], violations: [] }
  for (const [index, sequence] of sequencesOf(SEQUENCE_LENGTH).entries()) {
    if (index % shards !== shard) continue
    found.sequences += 1
    if (holdsBlindWrite(sequence)) {
      found.blind += 1
      if (found.blindExamples.length < 3) found.blindExamples.push(sequence.join(' '))
      continue
    }
    await playSession({ $, project }, sequence)
    const taken = takenFiles(project).filter(name => name.startsWith('p'))
    if (taken.length > 0) found.violations.push([sequence.join(' '), taken])
  }
  assert(found.sequences > 0, `the shard ${shard} of ${shards} ran no sequence`)
  return found
}

/** The files the agent's editing tool calls wrote, by name: one for each 'begin' of the sequence. */
function writtenFiles(sequence: readonly Event[]): string[] {
  return sequence.flatMap((event, place) => (event === 'begin' ? [`a${place}.py`] : []))
}

/** What one run of the liveness check found: the sequences, how many of them were left out for ending an editing tool call during a turn start's decision, and those played in which an edit of the agent was neither committed nor reverted, with the files left. */
export type Lived = { sequences: number; limited: number; violations: [string, string[]][] }

/** Runs every `shards`th sequence without a write by a person from the `shard`th, and finds those that leave an edit of the agent unjudged: with no one else writing, every edit must be committed or reverted. */
export async function runLivenessShard({ $, on }: { $: Kit['$']; on: On }, shard: number, shards: number): Promise<Lived> {
  assert(shard >= 0 && shard < shards, `the shard ${shard} is none of the ${shards}`)
  const project = tcrProject(on, { judgeDelayMs: CHECKS_MS, reasonDelayMs: DECISION_MS })
  const found: Lived = { sequences: 0, limited: 0, violations: [] }
  for (const [index, sequence] of livenessSequencesOf(LIVENESS_LENGTH).entries()) {
    if (index % shards !== shard) continue
    found.sequences += 1
    if (endsDuringDecision(sequence)) {
      found.limited += 1
      continue
    }
    await playSession({ $, project }, sequence)
    const taken = takenFiles(project)
    const unjudged = writtenFiles(sequence).filter(name => !taken.includes(name))
    if (unjudged.length > 0) found.violations.push([sequence.join(' '), unjudged])
  }
  assert(found.sequences > 0, `the shard ${shard} of ${shards} ran no sequence`)
  return found
}
