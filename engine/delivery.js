/** Per-session context and correction delivery required by IntegrationContract.tla. */
import assert from 'node:assert/strict'
import { contextOf } from './check.js'

export class SessionDelivery {
  constructor() {
    this.sessions = new Map()
    assert(this.sessions.size === 0, 'delivery must start without pending sessions')
    assert(this.sessions instanceof Map, 'delivery needs independent entries keyed by session')
  }

  stateOf(id) {
    assert(typeof id === 'string' && id !== '', `delivery session ${id} must have an ID`)
    if (!this.sessions.has(id)) this.sessions.set(id, { pending: undefined, correction: undefined, isCorrectionPass: false, isEditedSinceCorrection: false, closed: false })
    const state = this.sessions.get(id)
    assert(state !== undefined, `delivery session ${id} was not initialized`)
    return state
  }

  observe(id, output) {
    assert(output !== null && typeof output === 'object', `delivery output for ${id} must be an object`)
    const state = this.stateOf(id)
    if (output.overwatch?.guarded === false) { state.pending = undefined; state.correction = undefined }
    const message = contextOf(output)
    if (message) state.pending = message
    assert(state.pending === undefined || typeof state.pending === 'string', `delivery pending context for ${id} must be text`)
  }

  take(id) {
    const state = this.stateOf(id)
    const text = state.pending
    assert(text === undefined || typeof text === 'string', `pending delivery for ${id} is ${typeof text}`)
    state.pending = undefined
    assert(state.pending === undefined, `delivery for ${id} was not consumed`)
    return text
  }

  /**
   * Whether a settling session's result asks for a new correction pass. A queued pass runs until the session settles
   * again, so this also ends the pass before it and, when it asks, begins the next.
   */
  correction(id, output) {
    assert(output && typeof output === 'object', `correction output for ${id} must be an object`)
    assert(output.reason === undefined || typeof output.reason === 'string', `correction reason for ${id} must be text`)
    const state = this.stateOf(id)
    state.isCorrectionPass = false
    if (output.decision !== 'block') { state.correction = undefined; return false }
    const signature = output.overwatch?.signature ?? output.reason
    if (state.correction === signature) return false
    // A result that changed with no edit of the session's since the last correction is another process's doing.
    if (state.correction !== undefined && !state.isEditedSinceCorrection) return false
    state.correction = signature
    state.isCorrectionPass = true
    state.isEditedSinceCorrection = false
    return true
  }

  /** The session ran an editing tool, so a result that changes after it may ask for another correction. */
  edited(id) {
    assert(this.sessions.has(id), `an edit belongs to unknown session ${id}; record it after the session's first event`)
    const state = this.stateOf(id)
    state.isEditedSinceCorrection = true
    assert(state.isEditedSinceCorrection, `edit in ${id} was not recorded`)
  }

  /** Work outside a correction pass releases its deduplication; inside one, the work is that correction's answer. */
  progressed(id) {
    const state = this.stateOf(id)
    assert(this.sessions.has(id), `work progress belongs to unknown session ${id}`)
    if (!state.isCorrectionPass) state.correction = undefined
    assert(state.isCorrectionPass || state.correction === undefined, `work in ${id} did not release correction deduplication`)
  }

  remove(id) {
    assert(typeof id === 'string' && id !== '', `cannot remove delivery session ${id}`)
    const state = this.sessions.get(id)
    if (state) state.closed = true
    this.sessions.delete(id)
    assert(!this.sessions.has(id), `closed session ${id} retained its delivery`)
  }

  clear() {
    assert([...this.sessions.keys()].every(id => typeof id === 'string' && id !== ''), 'delivery contains an invalid session ID')
    for (const state of this.sessions.values()) state.closed = true
    this.sessions.clear()
    assert(this.sessions.size === 0, 'plugin shutdown retained session delivery')
  }
}
