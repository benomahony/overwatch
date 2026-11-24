/**
 * What the agent is told when TCR leaves an edit alone: that it left it uncommitted and unreverted and why, that it held it
 * for a check with no earlier result, and why the files changed while the checks ran. Each writes the names and words it was
 * given with the shared escape, since a check, a file or a directory names them as it likes.
 */
import { assert } from './assert'
import { listed } from './notice-files'
import { safeLine, safeName, safePath } from './safe-text'

/** The reason's own sentence ends with a full stop, so the notice does not add a second. */
export function leftUncommitted(reason: string): string {
  assert(reason !== '', `TCR left a change alone for the reason ${JSON.stringify(reason)}; give one`)
  assert(typeof reason === 'string', `TCR left a change alone for a reason of ${typeof reason}`)
  const ending = reason.endsWith('.') ? '' : '.'
  const text = `overwatch: TCR left the latest change uncommitted and unreverted: ${safeLine(reason)}${ending}`
  return text
}

/** That TCR held the edit for the checks `names`, which failed and have no earlier result to compare with. */
export function heldBecause(names: readonly string[]): string {
  assert(names.length > 0, `TCR held an edit for ${names.length} checks; name the ones that hold it`)
  assert(Array.isArray(names), `TCR held an edit for ${typeof names}, not a list of checks`)
  const text = `overwatch: TCR held the edit: ${names.map(safePath).join(', ')} failed and has no earlier result to compare with`
  return text
}

/** The order of two names by code point, which is the order the engine sorts them in; a plain sort compares UTF-16 code units, which put a character above the basic plane before one at the end of it. */
export function byCodePoint(left: string, right: string): number {
  assert(typeof left === 'string' && typeof right === 'string', `two names to order are ${typeof left} and ${typeof right}, not text`)
  const first = Array.from(left, character => character.codePointAt(0) as number)
  const second = Array.from(right, character => character.codePointAt(0) as number)
  const shared = Math.min(first.length, second.length)
  for (let at = 0; at < shared; at++) {
    if (first[at] !== second[at]) return (first[at] as number) - (second[at] as number)
  }
  const order = first.length - second.length
  assert(Number.isInteger(order), `the order of ${JSON.stringify(left)} and ${JSON.stringify(right)} is ${order}, not a whole number`)
  return order
}

/** Why TCR stops for files that changed outside the agent's edits: `otherwise`, and the files that differ from the last checkpoint, with where a tool's or a watcher's output belongs, when git named them. */
export function changedOutside(names: readonly string[], otherwise: string): string {
  assert(Array.isArray(names) && typeof otherwise === 'string', `the files that differ are ${typeof names} and the reason ${typeof otherwise}`)
  assert(names.every(name => typeof name === 'string'), `the files that differ hold ${names.map(name => typeof name)}, which are no names`)
  const text = names.length > 0 ? `${otherwise}; the files that differ from the last checkpoint are ${listed(names)}. If a tool or a watcher wrote them, add its output to .gitignore, and run git rm --cached on a file that git tracks` : otherwise
  return text
}

/** Why the files differ after the checks ran: the files `written` that the checks `checks` wrote, when git named them; otherwise that something changed them. */
export function changedBecause(written: readonly string[], checks: readonly string[], otherwise: string): string {
  assert(checks.length > 0, `${checks.length} checks ran; name the ones that may have written`)
  assert(Array.isArray(written) && typeof otherwise === 'string', `the files written are ${typeof written} and the other reason ${typeof otherwise}`)
  const names = [...new Set(checks)].sort(byCodePoint)
  const named = names.map(safeName).join(', ')
  const writer = names.length === 1 ? `the check ${named}` : `one of the checks ${named}`
  const text = written.length > 0 ? `${writer} wrote files (${listed(written)}), so TCR cannot tell them from the agent's; add them to .gitignore, and run git rm --cached on a file that git tracks` : otherwise
  return text
}
