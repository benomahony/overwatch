/** The settings of `.overwatch.json` that TCR reads, checked as the Python engine checks them, with the error naming the field. */
import { assert } from './assert'
import { CommandError, TCR_MODE } from './tcr'
import { OVERRIDE_PATH, type Override } from './watchers'

/** The project's mode: TCR_MODE, or undefined when it names none. Any other mode is an error naming the field. */
export function readMode(override: Override): typeof TCR_MODE | undefined {
  const { mode } = override
  if (mode !== undefined && mode !== TCR_MODE) throw new CommandError(`${OVERRIDE_PATH} field 'mode' is ${pythonRepr(mode)}; the only mode is ${pythonRepr(TCR_MODE)}`)
  assert(mode === undefined || mode === TCR_MODE, `readMode accepted ${JSON.stringify(mode)}; accept only ${TCR_MODE}`)
  assert(mode === undefined || typeof mode === 'string', `the mode ${JSON.stringify(mode)} is not text`)
  return mode
}

const JSON_TOKEN = /"(?:[^"\\]|\\.)*"|\btrue\b|\bfalse\b|\bnull\b|[:,]/g
const PYTHON_TOKENS: Readonly<Record<string, string>> = { true: 'True', false: 'False', null: 'None', ':': ': ', ',': ', ' }

/** `value`, which came from JSON, as Python prints it, so that a message about a setting reads as the Python engine's does. */
export function pythonRepr(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) return value > 0 ? 'inf' : '-inf'
  assert(typeof value !== 'function' && typeof value !== 'symbol', `${String(value)} came from JSON but is a ${typeof value}`)
  const json = JSON.stringify(value) ?? 'null'
  assert(typeof value !== 'bigint', `${String(value)} came from JSON but is a ${typeof value}`)
  const text = json.replace(JSON_TOKEN, token => (token.startsWith('"') ? `'${token.slice(1, -1).replaceAll('\\"', '"')}'` : PYTHON_TOKENS[token] ?? token))
  return text
}

const PYTHON_SPACE = '[\\t-\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'
const PYTHON_STRIPPED = new RegExp(`^${PYTHON_SPACE}*([\\s\\S]*?)${PYTHON_SPACE}*$`)
const ONLY_WILDCARDS = /^[*/?[\]]+$/

/** Whether `entry` names no file once the characters at each end that Python's `str.strip()` removes are removed: it is empty or only wildcards. `trim()` removes other characters: it removes U+FEFF and keeps U+001C to U+001F and U+0085. */
function namesNoFile(entry: string): boolean {
  assert(typeof entry === 'string', `an allow entry that is ${typeof entry}, not text, was read`)
  const match = PYTHON_STRIPPED.exec(entry)
  assert(match !== null, `the allow entry ${JSON.stringify(entry)} was read as nothing, though the pattern matches any text`)
  const inner = match[1] ?? ''
  return inner === '' || ONLY_WILDCARDS.test(inner)
}

const TCR_FIELDS = ['saveReverted', 'hostLimitSeconds', 'allow'] as const

/** The error for a field of `tcr` that holds the wrong thing: it names the field, what it holds and what it must hold. */
function settingError(field: (typeof TCR_FIELDS)[number], value: unknown, wanted: string): CommandError {
  assert(TCR_FIELDS.includes(field) && wanted !== '', `the setting ${field} was reported without saying what it must hold`)
  const error = new CommandError(`${OVERRIDE_PATH} field 'tcr.${field}' is ${pythonRepr(value)}, not ${wanted}`)
  assert(typeof error.message === 'string' && typeof wanted === 'string', `the error of ${field} is ${typeof error.message} and what it wants ${typeof wanted}`)
  return error
}

/**
 * The settings of TCR in `.overwatch.json`: whether a revert keeps the removed content in a git ref, which it does unless
 * told not to. The other fields of `tcr` are checked as the Python engine checks them, and an error names the field.
 */
export function readTcrSettings(override: Override): { saveReverted: boolean } {
  const given = override.tcr === undefined ? {} : override.tcr
  if (given === null || typeof given !== 'object' || Array.isArray(given)) throw new CommandError(`${OVERRIDE_PATH} field 'tcr' is ${pythonRepr(given)}, not an object; give it ${TCR_FIELDS.join(', ')}`)
  const fields = given as Record<string, unknown>
  const unknown = Object.keys(fields).filter(name => !(TCR_FIELDS as readonly string[]).includes(name)).sort()
  if (unknown.length > 0) throw new CommandError(`${OVERRIDE_PATH} field 'tcr' has unknown fields ${pythonRepr(unknown)}; use ${TCR_FIELDS.join(', ')}`)
  const { saveReverted = true, hostLimitSeconds = 1, allow = [] } = fields
  if (typeof saveReverted !== 'boolean') throw settingError('saveReverted', saveReverted, 'a boolean; set it to true or false')
  if (typeof hostLimitSeconds !== 'number' || !Number.isFinite(hostLimitSeconds) || !(hostLimitSeconds > 0)) throw settingError('hostLimitSeconds', hostLimitSeconds, 'a finite number of seconds above zero')
  if (!Array.isArray(allow) || !allow.every(entry => typeof entry === 'string' && !namesNoFile(entry))) throw settingError('allow', allow, 'a list of paths or globs that name files; an entry may not be empty or only wildcards')
  assert(typeof saveReverted === 'boolean', `tcr.saveReverted is ${typeof saveReverted}, not true or false`)
  assert(Object.keys(fields).length <= TCR_FIELDS.length, `the settings of TCR hold ${Object.keys(fields)}; they hold ${TCR_FIELDS} alone`)
  return { saveReverted }
}
