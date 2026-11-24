import { assert } from '../../hooks/assert'

/**
 * How many sequences the class checks of tcr-interleavings.ts must hold, counted from the rules that file states, by a
 * walk that extends one sequence at a time and does not use the generator, so that a change of the generator's rules, its
 * events or its length shows as a different count. The rules are written here again on purpose: a sequence of one to
 * `maxLength` events has no event twice in a row, except a call that begins or ends, no two results in a row, and between
 * none and `MOST_RUNNING` editing calls running after each event; the class check holds exactly one write by a person, and
 * the liveness check none and a call that begins.
 */
const MOST_RUNNING = 2
const CLASS_EVENTS = ['begin', 'end', 'person', 'turn', 'green', 'red', 'quiet'] as const
const LIVENESS_EVENTS_COUNTED = ['begin', 'end', 'turn', 'green', 'red', 'quiet', 'tool'] as const
const CLASS_LENGTH_COUNTED = 5
const LIVENESS_LENGTH_COUNTED = 4
const RESULTS = ['green', 'red']
const REPEATABLE = ['begin', 'end']
/** How long the events take and how long a turn start's decision lasts, in milliseconds, written here again on purpose: an editing call that ends within DECISION_MS of a turn event is left out of the liveness check, and a change of any of these in the generator changes the generator's count and not this one. */
const DECISION_COUNTED_MS = 150
const TURN_COUNTED_MS = 50
const QUIET_COUNTED_MS = 400
const RESULT_COUNTED_MS = 150

type Walk = { events: readonly string[]; maxLength: number; writes: number; needs: 'person' | 'begin' }
type Position = { length: number; last: string | undefined; running: number; writes: number; hasBegin: boolean; isBlind: boolean; sinceTurn: number; isLimited: boolean }

/** How long an event takes on the project's clock. */
function taking(event: string): number {
  return event === 'turn' ? TURN_COUNTED_MS : event === 'quiet' ? QUIET_COUNTED_MS : RESULTS.includes(event) ? RESULT_COUNTED_MS : 0
}

/** How long ago the latest turn began after `event` follows `at`, and whether an editing call has ended within a decision of one. */
function timed(at: Position, event: string): Pick<Position, 'sinceTurn' | 'isLimited'> {
  return { sinceTurn: event === 'turn' ? TURN_COUNTED_MS : at.sinceTurn + taking(event), isLimited: at.isLimited || (event === 'end' && at.sinceTurn < DECISION_COUNTED_MS) }
}

/** The position after `event` follows `at`, or undefined when a rule forbids that event there. */
function extended(walk: Walk, at: Position, event: string): Position | undefined {
  const running = at.running + (event === 'begin' ? 1 : 0) - (event === 'end' ? 1 : 0)
  const repeats = event === at.last && !REPEATABLE.includes(event)
  const twoResults = at.last !== undefined && RESULTS.includes(at.last) && RESULTS.includes(event)
  const writes = at.writes + (event === 'person' ? 1 : 0)
  if (repeats || twoResults || running < 0 || running > MOST_RUNNING || writes > walk.writes) return undefined
  return { length: at.length + 1, last: event, running, writes, hasBegin: at.hasBegin || event === 'begin', isBlind: at.isBlind || (event === 'person' && at.running > 0), ...timed(at, event) }
}

function counted(walk: Walk): { sequences: number; blind: number; limited: number } {
  const total = { sequences: 0, blind: 0, limited: 0 }
  const open: Position[] = [{ length: 0, last: undefined, running: 0, writes: 0, hasBegin: false, isBlind: false, sinceTurn: Infinity, isLimited: false }]
  for (let at = open.pop(); at !== undefined; at = open.pop()) {
    const holds = at.length > 0 && at.writes === walk.writes && (walk.needs === 'person' ? at.writes > 0 : at.hasBegin)
    total.sequences += holds ? 1 : 0
    total.blind += holds && at.isBlind ? 1 : 0
    total.limited += holds && at.isLimited ? 1 : 0
    const longer = at.length < walk.maxLength ? walk.events.map(event => extended(walk, at, event)) : []
    open.push(...longer.filter((next): next is Position => next !== undefined))
  }
  assert(total.blind <= total.sequences && total.limited <= total.sequences, `${total.blind} sequences are blind and ${total.limited} limited of ${total.sequences}`)
  return total
}

/** The sequences of the class check, and how many of them hold a write by a person while an editing call runs. */
export function classCount(): { sequences: number; blind: number } {
  const { sequences, blind } = counted({ events: CLASS_EVENTS, maxLength: CLASS_LENGTH_COUNTED, writes: 1, needs: 'person' })
  const count = { sequences, blind }
  assert(count.sequences > 0 && count.blind < count.sequences, `the class check counts ${count.sequences} sequences, ${count.blind} of them blind`)
  return count
}

/** The sequences of the liveness check, and how many of them end an editing call within a turn start's decision, which the check leaves out. */
export function livenessCounts(): { sequences: number; limited: number } {
  const { sequences, limited } = counted({ events: LIVENESS_EVENTS_COUNTED, maxLength: LIVENESS_LENGTH_COUNTED, writes: 0, needs: 'begin' })
  assert(sequences > 0 && limited < sequences, `the liveness check counts ${sequences} sequences, ${limited} of them limited`)
  return { sequences, limited }
}

/** The sequences of the liveness check. */
export function livenessCount(): number {
  return livenessCounts().sequences
}

/** How many of `total` sequences the `shard`th of `shards` runs, when each takes every `shards`th from its own place. */
export function shardSize(total: number, shard: number, shards: number): number {
  assert(shards > 0 && shard >= 0 && shard < shards, `the shard ${shard} is none of ${shards}`)
  const size = Math.floor(total / shards) + (shard < total % shards ? 1 : 0)
  assert(size > 0, `the shard ${shard} of ${shards} holds ${size} of ${total} sequences`)
  return size
}
