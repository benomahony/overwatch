import { expect, test } from 'claude-code/testing'
import { CLEAN, start, tcrProject } from './fixtures/tcr'
import { beginEdit, toldPlain, FINGERPRINT_MS, SETTLE_MS, type Kit, type Project } from './fixtures/tcr-session'

/**
 * The exhaustive check of editing tools that begin together: every sequence of one to four of the events below, with exactly
 * one write by a person, plays in a session of its own, where the comparison of the files takes a while, and no checkpoint or
 * revert may take the person's file unless the person wrote while a tool ran after the comparison had read the files, which
 * nothing can tell from the tool's own write, a limit stated in the README. The class check of tcr-interleavings.ts does not
 * hold two tools that begin together, since its tools begin one at a time and each comparison ends before the next begins;
 * giving every one of its sequences a slow comparison would change what each of them plays.
 */
const EVENTS = ['begin', 'end', 'person', 'wait'] as const
type Event = (typeof EVENTS)[number]
const LENGTH = 4
const MOST_RUNNING = 2
const SHARD_TIMEOUT_MS = 600_000
const SESSION_START_MS = 400
const SESSION_END_MS = 500
const SHORT_MS = 1
const EDIT_FILE = /^a\d+\.py$/
const EDIT_IN_COMMIT = /\ba\d+\.py\b/

type Running = { call: ReturnType<typeof beginEdit>; isCompared: boolean }

/** How many calls run after each event, and whether the sequence is allowed: a call ends only when one runs, and no more than MOST_RUNNING run. */
function isAllowed(sequence: readonly Event[]): boolean {
  let running = 0
  for (const event of sequence) {
    running += event === 'begin' ? 1 : event === 'end' ? -1 : 0
    if (running < 0 || running > MOST_RUNNING) return false
  }
  return sequence.filter(event => event === 'person').length <= 1
}

/** Every allowed sequence of one to `length` events, extended one event at a time. */
function sequencesOf(length: number): Event[][] {
  let layer: Event[][] = [[]]
  const all: Event[][] = []
  for (let size = 0; size < length; size++) {
    layer = layer.flatMap(prefix => EVENTS.map(event => [...prefix, event])).filter(isAllowed)
    all.push(...layer)
  }
  return all.filter(sequence => sequence.includes('person'))
}

/** The same count by a walk that carries the number of running calls and of writes, and does not build the sequences. */
function counted(length: number): number {
  let total = 0
  const open = [{ left: length, running: 0, writes: 0 }]
  for (let at = open.pop(); at !== undefined; at = open.pop()) {
    if (at.left === 0) continue
    for (const event of EVENTS) {
      const next = { left: at.left - 1, running: at.running + (event === 'begin' ? 1 : event === 'end' ? -1 : 0), writes: at.writes + (event === 'person' ? 1 : 0) }
      if (next.running < 0 || next.running > MOST_RUNNING || next.writes > 1) continue
      total += next.writes === 1 ? 1 : 0
      open.push(next)
    }
  }
  return total
}

/**
 * Whether the person writes before the comparison of the files has read them: the comparison of a batch reads the files in the
 * first wait after its first call begins, and a write before that wait, or with no call begun, lands before it. Only then
 * does TCR stop for the files; a write after it goes with the tool that runs, which no comparison tells from the tool's own.
 */
function isBeforeComparison(sequence: readonly Event[]): boolean {
  let hasBegun = false
  for (const event of sequence) {
    if (event === 'begin') hasBegun = true
    else if (event === 'wait' && hasBegun) return false
    else if (event === 'person') return true
  }
  return true
}

type Stage = 'comparing' | 'writing' | 'looked-at' | 'done'
type Call = { stage: Stage; isEnded: boolean }

/**
 * Whether the person writes while an editing tool runs after the comparison read the files, or while TCR has not yet looked at
 * the result of one that ended, which nothing tells from the tool's own write. A call compares, runs from the end of that
 * comparison, or at once when another call already runs, until TCR has looked at its result, one comparison after it wrote.
 */
function isBlind(sequence: readonly Event[]): boolean {
  const calls: Call[] = []
  for (const event of sequence) {
    if (event === 'begin') calls.push({ stage: calls.some(call => call.stage !== 'done') ? 'writing' : 'comparing', isEnded: false })
    else if (event === 'end') {
      const call = calls.find(each => !each.isEnded)
      if (call !== undefined) {
        call.isEnded = true
        if (call.stage === 'writing') call.stage = 'looked-at'
      }
    } else if (event === 'wait') {
      for (const call of calls) call.stage = call.stage === 'comparing' ? (call.isEnded ? 'looked-at' : 'writing') : call.stage === 'looked-at' ? 'done' : call.stage
    } else return calls.some(call => call.stage === 'writing' || call.stage === 'looked-at')
  }
  return false
}

/** Plays the sequence, and says whether an editing tool wrote while the first comparison of the files, which every tool that began meanwhile waits for, was still reading them. */
async function play({ $, project }: { $: Kit['$']; project: Project }, sequence: readonly Event[]): Promise<boolean> {
  const { workspace } = project
  Object.assign(workspace, { fingerprint: 'clean', committed: 'clean', dirty: [], commits: [], reverted: [], saved: [], next: undefined, hang: undefined })
  workspace.started.clear()
  workspace.calls.clear()
  project.setReport(CLEAN)
  await $.session.start(start)
  await project.clock.advance(SESSION_START_MS)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await project.clock.advance(SESSION_START_MS)
  const running: Running[] = []
  const settled: Promise<unknown>[] = []
  let isFirstComparison = false
  let hasBegun = false
  let wroteWhileCompared = false
  for (const [place, event] of sequence.entries()) {
    if (event === 'begin') {
      const call = beginEdit($, project, [`a${place}.py`], `f${place}`)
      isFirstComparison = isFirstComparison || !hasBegun
      hasBegun = true
      running.push({ call, isCompared: false })
      settled.push(call.done)
    } else if (event === 'end') {
      running.shift()?.call.end()
      if (isFirstComparison) {
        await project.clock.advance(SHORT_MS)
        wroteWhileCompared = wroteWhileCompared || project.workspace.dirty.some(name => EDIT_FILE.test(name))
      }
    } else if (event === 'person') {
      workspace.dirty = [...workspace.dirty, 'person.py']
      workspace.fingerprint = `p${place}`
    } else {
      await project.clock.advance(FINGERPRINT_MS)
      isFirstComparison = false
      for (const each of running) each.isCompared = true
    }
  }
  await project.clock.advance(FINGERPRINT_MS)
  for (const each of running) each.call.end()
  await project.clock.advance(SETTLE_MS)
  await Promise.all(settled)
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await project.clock.advance(SESSION_END_MS)
  await ending
  return wroteWhileCompared
}

/** Sequences longer than LENGTH, where both tools end before the first comparison has finished, which only a sequence with room for two ends and a person's write can play. */
const LONGER_SEQUENCES: Event[][] = [['begin', 'begin', 'end', 'end', 'person', 'wait'], ['begin', 'begin', 'end', 'end', 'wait', 'person'], ['begin', 'end', 'wait', 'wait', 'begin', 'wait', 'person']]
const OUTSIDE_NOTICE = 'overwatch: TCR is unavailable: files changed outside'

test('no checkpoint or revert takes a person\'s file in any sequence of editing tools that begin together, unless the sequence is one the README says cannot be told, and the sequences it names are ones where a file was taken', { timeoutMs: SHARD_TIMEOUT_MS }, async ($, on) => {
  const project = tcrProject(on, { fingerprintDelayMs: FINGERPRINT_MS })
  expect(sequencesOf(LENGTH).length).toBe(counted(LENGTH))
  expect(LONGER_SEQUENCES.every(isAllowed)).toBe(true)
  const sequences = [...sequencesOf(LENGTH), ...LONGER_SEQUENCES]
  const violations: [string, string[]][] = []
  const absent: string[] = []
  const unpaused: string[] = []
  const unjudged: string[] = []
  const heldBack: string[] = []
  const blind = sequences.filter(isBlind)
  let takenWhileBlind = 0
  for (const sequence of sequences) {
    const before = toldPlain(project).length
    const wroteWhileCompared = await play({ $, project }, sequence)
    if (wroteWhileCompared) heldBack.push(sequence.join(' '))
    const { commits, reverted, dirty } = project.workspace
    const taken = [...commits.flatMap(commit => commit.replace('tcr: ', '').split(', ')), ...reverted.flat()].filter(name => name === 'person.py')
    const isPaused = toldPlain(project).slice(before).some(text => text.startsWith(OUTSIDE_NOTICE))
    const isStopped = sequence.includes('begin') && isBeforeComparison(sequence)
    if (isPaused !== isStopped) unpaused.push(sequence.join(' '))
    if (sequence.includes('begin') && !isStopped && !commits.some(commit => EDIT_IN_COMMIT.test(commit))) unjudged.push(sequence.join(' '))
    if (isBlind(sequence)) {
      takenWhileBlind += taken.length > 0 ? 1 : 0
      continue
    }
    if (taken.length > 0) violations.push([sequence.join(' '), taken])
    if (!dirty.includes('person.py')) absent.push(sequence.join(' '))
  }
  expect(heldBack.slice(0, 5)).toEqual([])
  expect(violations.slice(0, 5)).toEqual([])
  expect(absent.slice(0, 5)).toEqual([])
  expect(unpaused.slice(0, 5)).toEqual([])
  expect(unjudged.slice(0, 5)).toEqual([])
  expect(blind.length).toBeGreaterThan(0)
  expect(blind.length).toBeLessThan(sequences.length)
  expect(takenWhileBlind).toBeGreaterThan(0)
})
