/**
 * Where the notices of reverts wait in the outbox: each revert on its own key, so that none replaces another, and the
 * reverts past MAX_REVERT_NOTICES as one notice with their count.
 */
import { assert } from './assert'
import type { Message } from './state'

/** How many notices of reverts wait for the agent each on its own; the reverts past them are told as a count. */
export const MAX_REVERT_NOTICES = 5

const SLOT_PREFIX = 'tcr:revert:'
const OVERFLOW_KEY = `${SLOT_PREFIX}more`
const FIRST_SLOT = 1

/** The notice of one revert, or of one attempt to revert, which says whether a copy of the discarded work was saved. */
export function revertNotice(text: string, isSaved: boolean): Message {
  assert(typeof text === 'string' && typeof isSaved === 'boolean', `a revert notice was built from ${typeof text} and ${typeof isSaved}`)
  const reverts = { total: 1, saved: isSaved ? 1 : 0 }
  assert(reverts.saved <= reverts.total, `the notice of one revert counts ${reverts.saved} copies saved`)
  return { text, isWaking: true, kind: 'tcr', reverts }
}

function countNotice(total: number, saved: number): Message {
  assert(Number.isInteger(total) && Number.isInteger(saved), `the count of reverts is ${total} with ${saved} saved, which are no counts`)
  assert(saved <= total, `${saved} copies were saved by ${total} reverts`)
  const copies = saved === 0 ? 'None of them saved a copy.' : `${saved} of them saved a copy; \`git for-each-ref refs/overwatch/reverted\` lists the copies.`
  const text = `overwatch: TCR made ${total} more reverts or attempts after the first ${MAX_REVERT_NOTICES}. This notice names no files; \`git status\` shows the present state. ${copies}`
  return { text, isWaking: true, kind: 'tcr', reverts: { total, saved } }
}

/** Puts the notice in the first free slot of `outbox`, or adds it to the count of the reverts past the slots. Answers the key it waits under, or undefined when it was counted. */
export function placeRevertNotice(outbox: Map<string, Message>, queued: Message): string | undefined {
  assert(queued.reverts !== undefined && queued.reverts.total > 0, `a notice without the count of its reverts was placed: ${queued.text}`)
  const single = queued.reverts.total === 1
  const slot = !single ? undefined : Array.from({ length: MAX_REVERT_NOTICES }, (_, index) => `${SLOT_PREFIX}${index + FIRST_SLOT}`).find(key => !outbox.has(key))
  if (slot !== undefined) {
    outbox.set(slot, queued)
    return slot
  }
  const before = outbox.get(OVERFLOW_KEY)?.reverts ?? { total: 0, saved: 0 }
  outbox.set(OVERFLOW_KEY, countNotice(before.total + queued.reverts.total, before.saved + queued.reverts.saved))
  assert(outbox.has(OVERFLOW_KEY), `the count of the reverts past the slots is not waiting under ${OVERFLOW_KEY}`)
  return undefined
}

/** Puts back the notices the host did not take. One that a newer notice of a revert took the place of waits in a free slot, or in the count; the rest wait under their own key unless a newer message has it. */
export function restoreNotices(outbox: Map<string, Message>, sent: readonly (readonly [string, Message])[]) {
  assert(sent.length > 0 && sent.every(([key]) => typeof key === 'string'), `${sent.length} notices were put back; name the key of each`)
  for (const [key, message] of sent) {
    if (!outbox.has(key)) outbox.set(key, message)
    else if (key.startsWith(SLOT_PREFIX) && outbox.get(key) !== message && message.reverts !== undefined) placeRevertNotice(outbox, message)
  }
  assert(sent.every(([key]) => outbox.has(key)), `${sent.length} messages the host did not take are not waiting to be sent again`)
}
