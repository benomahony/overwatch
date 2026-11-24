import { assert } from './assert'
import { safeName } from './safe-text'

/** The most file names a notice lists in one sentence before it says how many more there were. */
export const MESSAGE_FILES = 5
const QUOTE = '`'

/** Up to MESSAGE_FILES names, each quoted and written by safeName, then how many more there were. */
export function listed(names: readonly string[]): string {
  const shown = names.slice(0, MESSAGE_FILES).map(name => `${QUOTE}${safeName(name)}${QUOTE}`)
  const hidden = names.length - shown.length
  assert(shown.length <= MESSAGE_FILES && hidden >= 0, `${shown.length} names were shown of ${names.length}, with the limit ${MESSAGE_FILES}`)
  assert(names.length === 0 || shown.length > 0, `no name was shown of ${names.length}`)
  return shown.join(', ') + (hidden > 0 ? ` and ${hidden} more` : '')
}

/**
 * The files of a revert as the agent is told them, from the two listings of git around it: those of the first listing that
 * the second does not list, those both list, those only the second lists, which changed after the first, and the
 * submodules the revert does not reach. `isUnlisted` says git could not list the files after the revert, so the notice names none of them. `isRemainingNew` says the engine proved the tree clean after the revert, so the
 * files that both listings give were changed again; without it they are only still changed, with no stated cause.
 */
export type RevertedFiles = { restored: readonly string[]; remaining?: readonly string[]; late?: readonly string[]; skipped?: readonly string[]; isRemainingNew?: boolean; isUnlisted?: boolean }

const SUBMODULES_LEFT = 'The files inside the submodules {names} were not restored and still hold changes.'
export const NO_LISTING = 'Git could not list the files now. `git status` shows the present state.'

/** What the notice says of the files that came back and of the submodules; that the files could not be listed when `isUnlisted` says so. */
export function cameBackLine({ restored, skipped = [], isUnlisted = false }: RevertedFiles): string {
  const first = isUnlisted ? NO_LISTING : restored.length > 0 ? `Restored: ${listed(restored)}.` : 'No file was restored.'
  assert(Array.isArray(restored) && Array.isArray(skipped), `the files that came back, ${typeof restored}, and the submodules, ${typeof skipped}, are lists`)
  assert(typeof isUnlisted === 'boolean', `whether the files were listed is ${typeof isUnlisted}, not true or false`)
  const text = [first, ...(skipped.length > 0 ? [SUBMODULES_LEFT.replace('{names}', () => listed(skipped))] : [])].join(' ')
  return text
}

/** What the notice says of the files that did not come back: those still changed or changed again, and those changed after the listing; empty when none. */
export function leftLine({ restored, remaining = [], late = [], isRemainingNew = false, isUnlisted = false }: RevertedFiles): string {
  assert(Array.isArray(remaining) && Array.isArray(late), `the files that remain, ${typeof remaining}, and those that came late, ${typeof late}, are lists`)
  assert(typeof isRemainingNew === 'boolean' && Array.isArray(restored), `whether the remaining files are new, ${typeof isRemainingNew}, is true or false, and the files that came back, ${typeof restored}, are a list`)
  if (isUnlisted) return ''
  const remainingSentence = isRemainingNew ? 'Changed again after the revert' : 'Still changed'
  return [
    ...(remaining.length > 0 ? [` ${remainingSentence}: ${listed(remaining)}.`] : []),
    ...(late.length > 0 ? [` Changed after TCR listed the files: ${listed(late)}.`] : []),
  ].join('')
}
