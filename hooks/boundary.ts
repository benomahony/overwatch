/**
 * The boundary around every entry the host calls into the plugin: a hook, a timer, a watcher's callback. An error nobody
 * expected there is a bug of the plugin or of the host. It is never left to end silently: the agent is told, TCR stops
 * where it runs, and the error goes on to the host, rethrown where a caller waits for the entry, and written to the host's
 * log where none does, since a rejection nothing handles ends a host that runs on Node and tells a test nothing.
 * An assert inside the boundary would replace the error it carries, so it asserts only what its own callers pass.
 */
import type { EngineInterface } from 'claude-code'
import { assert } from './assert'
import { safeLine } from './safe-text'
import { pauseTcr, queueTcr } from './pausing'
import { BUG_LOG, TCR_ACTIVE, tcrMessage } from './tcr'
import type { State } from './state'

const UNEXPECTED = 'overwatch hit an unexpected error'
const UNWRITABLE = 'an error that cannot be written as text'
const PAUSED = '; TCR is paused'
const ENDED_SESSION = ', in a session that had ended'

/** The sessions each error was told in already, so that a boundary around another boundary tells nothing twice, while a newer session that meets the same error is still told. */
const told = new WeakMap<object, Set<number>>()

/** Marks `error` as told in the session `epoch`, which a revert notice that names what is known of the files does in place of the boundary's. */
export function markTold(error: unknown, epoch: number): void { // zanity: ignore[assertion-density]
  if (typeof error !== 'object' || error === null) return
  const sessions = told.get(error) ?? new Set<number>()
  sessions.add(epoch)
  told.set(error, sessions)
}

/** What `error` says, as one escaped line. */
export function describeError(error: unknown): string { // zanity: ignore[assertion-density]
  try {
    return safeLine(String(error))
  } catch {
    return UNWRITABLE
  }
}

/** Tells the agent that overwatch hit an error nobody expected, and stops TCR where it runs. `epoch` is the session the entry began in: an error that comes after a newer session began is shown to the user and tells that session nothing and stops nothing. Returns what the agent is told. It never throws, so the error that came first is the one that goes on. */
export function tellUnexpected($: EngineInterface, state: State, error: unknown, epoch: number): string { // zanity: ignore[assertion-density]
  assert(typeof state === 'object' && state !== null, `an unexpected error was told for the state ${typeof state}`)
  const detail = `${UNEXPECTED}: ${describeError(error)}`
  const isEnded = state.epoch !== epoch
  const isOn = !isEnded && state.tcr.status === TCR_ACTIVE
  const text = isOn ? `${detail}${PAUSED}` : detail
  if (typeof error === 'object' && error !== null && told.get(error)?.has(epoch) === true) return text
  markTold(error, epoch)
  try {
    if (isEnded) {
      $.ui.toast(`${detail}${ENDED_SESSION}`)
      return text
    }
    queueTcr($, state, 'error', tcrMessage(text, true))
    if (isOn) {
      pauseTcr($, state, detail)
      state.outbox.delete('tcr:state')
    }
  } catch (secondary) {
    $.ui.log(`${describeError(secondary)} while telling: ${detail}`, { to: 'debug' })
  }
  return text
}

/** Runs the part of an entry that is the plugin's own: an error nobody expected is told and goes on to the caller. */
export async function guarded<T>($: EngineInterface, state: State, body: () => Promise<T> | T, epoch = state.epoch): Promise<T> {
  assert(typeof body === 'function', `the part of an entry to guard is ${typeof body}, not a function`)
  assert(typeof state === 'object' && state !== null, `the part of an entry was guarded for the state ${typeof state}`)
  try {
    return await body()
  } catch (error) {
    tellUnexpected($, state, error, epoch)
    throw error
  }
}

/** `guarded` for a part of an entry that runs at once, with nothing awaited, so that what the host does next is not put off by a turn of the event loop. */
export function guardedNow<T>($: EngineInterface, state: State, body: () => T): T {
  assert(typeof body === 'function', `the part of an entry to guard is ${typeof body}, not a function`)
  assert(typeof state === 'object' && state !== null, `the part of an entry was guarded for the state ${typeof state}`)
  const { epoch } = state
  try {
    return body()
  } catch (error) {
    tellUnexpected($, state, error, epoch)
    throw error
  }
}

/** Starts work no caller waits for: an error nobody expected is told, and written to the host's log, where it stays visible. */
export function background($: EngineInterface, state: State, body: () => Promise<unknown> | unknown): void {
  assert(typeof body === 'function', `the work to start is ${typeof body}, not a function`)
  assert(typeof state === 'object' && state !== null, `work was started for the state ${typeof state}`)
  void guarded($, state, body).catch((error: unknown) => {
    $.ui.log(`${UNEXPECTED}: ${describeError(error)}`, { to: BUG_LOG })
  })
}

/** Runs the part of an entry that decides nothing the call depends on, such as a comparison that only guards a person's files: an error nobody expected is told and written to the host's log, and the call goes on. */
export async function failOpen<T>($: EngineInterface, state: State, body: () => Promise<T> | T, epoch = state.epoch): Promise<T | undefined> {
  assert(typeof body === 'function', `the part of an entry to run open is ${typeof body}, not a function`)
  assert(typeof state === 'object' && state !== null, `a part of an entry ran open for the state ${typeof state}`)
  try {
    return await guarded($, state, body, epoch)
  } catch (error) {
    $.ui.log(`${UNEXPECTED}: ${describeError(error)}`, { to: BUG_LOG })
    return undefined
  }
}

/** Runs `before`, then `after` even when `before` threw. When both throw, one error that names both goes on, so that the agent is told of both. */
export async function runBoth<T>($: EngineInterface, state: State, { before, after }: { before: () => Promise<unknown>; after: () => Promise<T> | T }): Promise<T> {
  assert(typeof before === 'function' && typeof after === 'function', `the two parts to run are ${typeof before} and ${typeof after}, not functions`)
  assert(typeof state === 'object' && state !== null, `two parts were run for the state ${typeof state}`)
  let failure: { error: unknown } | undefined
  try {
    await before()
  } catch (error) {
    failure = { error }
  }
  let result: T
  try {
    result = await after()
  } catch (error) {
    if (failure === undefined) throw error
    throw new AggregateError([failure.error, error], `${describeError(failure.error)}; and then ${describeError(error)}`)
  }
  if (failure !== undefined) throw failure.error
  return result
}
