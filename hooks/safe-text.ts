/**
 * Writing text the plugin does not control, as a file, check or directory name, a command, a summary, a path or the words of
 * git and the engine, into a notice, so that none of it can start a line the agent reads as overwatch's own, imitate its
 * marks or end the quotes around it. It mirrors engine/safe_text.py: the same characters, the same escapes, the same cut.
 */
import { assert } from './assert'

const BACKTICK = '`'
const SPACE = ' '
const TAB = '\t'

/** Which characters a notice writes as an escape: those that match `categories` and are not among the characters it `keeps` raw. */
type Rule = { readonly categories: RegExp; readonly keeps: string }

/** Control, format, line-separator, paragraph-separator and space-separator characters: a line break, a bidirectional override, a zero-width character, a byte order mark, a tag character, a no-break space. */
const HIDING_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/u
const LINE_BREAKS: Rule = { categories: /[\p{Cc}\p{Zl}\p{Zp}]/u, keeps: SPACE + TAB }
const HIDING: Rule = { categories: HIDING_CHARACTER, keeps: SPACE }
const HIDING_BUT_TABS: Rule = { categories: HIDING_CHARACTER, keeps: SPACE + TAB }
const BYTE_LIMIT = 0x100
const BASIC_PLANE_LIMIT = 0x10000
const BYTE_DIGITS = 2
const BASIC_PLANE_DIGITS = 4
const ASTRAL_DIGITS = 8
const HEX = 16
/** The most characters of a name a notice holds. */
export const NAME_LIMIT = 200
const CUT = '...'

function isUnsafe(character: string, rule: Rule, isQuoted: boolean): boolean {
  assert([...character].length === 1, `${JSON.stringify(character)} is not one character`)
  const isHiding = rule.categories.test(character) && !rule.keeps.includes(character)
  assert(character !== SPACE || !isHiding, `the plain space ${JSON.stringify(character)} is written as an escape, so no text keeps its spaces`)
  return isHiding || (isQuoted && character === BACKTICK)
}

/** The escape for one character a notice does not carry raw: \xNN below BYTE_LIMIT, \uNNNN in the basic plane, \UNNNNNNNN above it. */
function escape(character: string): string {
  const code = character.codePointAt(0) as number
  assert(character.length > 0, `an escape was asked for ${JSON.stringify(character)}, which is no character`)
  assert([...character].length === 1, `${JSON.stringify(character)} is not one character`)
  const digits = code.toString(HEX)
  const text = code < BYTE_LIMIT ? `\\x${digits.padStart(BYTE_DIGITS, '0')}` : code < BASIC_PLANE_LIMIT ? `\\u${digits.padStart(BASIC_PLANE_DIGITS, '0')}` : `\\U${digits.padStart(ASTRAL_DIGITS, '0')}`
  return text
}

/** How many characters a piece of text holds, a code point above the basic plane counting as one, as the engine counts. */
function sizeOf(piece: string): number {
  assert(typeof piece === 'string', `a piece to count is ${typeof piece}, not text`)
  const size = [...piece].length
  assert(size > 0 && size <= piece.length, `the piece ${JSON.stringify(piece)} holds ${size} characters in ${piece.length} code units`)
  return size
}

function written(text: string, rule: Rule, isQuoted: boolean, limit: number | undefined): string {
  assert(limit === undefined || limit > CUT.length, `the limit ${limit} leaves no room for text before ${JSON.stringify(CUT)}`)
  assert(typeof isQuoted === 'boolean' && typeof text === 'string', `the text is ${typeof text} and its quotes ${typeof isQuoted}`)
  const pieces = [...text].map(character => (isUnsafe(character, rule, isQuoted) ? escape(character) : character))
  const length = pieces.reduce((sum, piece) => sum + sizeOf(piece), 0)
  const isCut = limit !== undefined && length > limit
  const kept: string[] = []
  let used = 0
  for (const piece of pieces) {
    const size = sizeOf(piece)
    if (isCut && used + size > limit - CUT.length) break
    kept.push(piece)
    used += size
  }
  const result = kept.join('') + (isCut ? CUT : '')
  return result
}

/** The name with each hiding character and backtick written as an escape, cut to NAME_LIMIT characters; for a file name or a saved ref, which a notice puts in quotes. */
export function safeName(name: string): string {
  assert(typeof name === 'string', `a name is ${typeof name}, not text`)
  assert(NAME_LIMIT > CUT.length, `the name limit ${NAME_LIMIT} leaves no room for ${CUT.length} characters of a cut`)
  const text = written(name, HIDING, true, NAME_LIMIT)
  return text
}

/** The text with each line break and control character but the tab written as an escape, and nothing else changed or cut, so that a command, a check, a failing test, a directory or a path stays as it is to copy and cannot start a line. */
export function safePath(path: string): string {
  assert(typeof path === 'string', `a path is ${typeof path}, not text`)
  assert(!Array.isArray(path), `a path is one text, not a list of ${String(path).length} characters`)
  const text = written(path, LINE_BREAKS, false, undefined)
  return text
}

/** The text with each hiding character but the tab written as an escape, backticks kept and no cut, for a summary or the words of git, which hold the quotes of the notice's own words and, as a Go summary does, tabs. */
export function safeLine(text: string): string {
  assert(typeof text === 'string', `a line is ${typeof text}, not text`)
  const result = written(text, HIDING_BUT_TABS, false, undefined)
  assert([...result].length >= [...text].length, `the line ${JSON.stringify(text)} was written shorter as ${JSON.stringify(result)}; only escapes may be added`)
  return result
}
