import type { EngineInterface } from 'claude-code'
import { assert } from './assert'
import { safeLine, safePath } from './safe-text'
import { listed } from './notice-files'
import { CommandError, readExpecting } from './command-error'

export { CommandError }
import { OVERRIDE_PATH, commandLine, hasRegression, readReport, type Override, type Report, type Watcher } from './watchers'

export const TCR_MODE = 'tcr'
export const TCR_ACTIVE = 'active'

/** TCR paused, with the reason it cannot run. A reason is the content of an object, never a status itself, so no reason text, whatever it says, is taken for TCR_ACTIVE. */
export type Paused = { readonly reason: string }

/** TCR_ACTIVE, or paused with a reason. */
export type Status = typeof TCR_ACTIVE | Paused

/** TCR paused for `reason`. */
export function pausedFor(cause: string): Paused {
  assert(typeof cause === 'string', `TCR was paused for a cause of ${typeof cause}, not text`)
  assert(!Array.isArray(cause), `TCR was paused for ${JSON.stringify(cause)}, a list; give one text`)
  return { reason: cause }
}

/** The status as text for a message to the agent or a failed assert: TCR_ACTIVE, or the reason. */
export function statusText(status: Status | undefined): string {
  assert(status === undefined || status === TCR_ACTIVE || typeof status === 'object', `a status of ${typeof status} was written as text`)
  assert(status === undefined || status === TCR_ACTIVE || typeof status.reason === 'string', 'a paused status holds no reason')
  return status === undefined ? 'undecided' : status === TCR_ACTIVE ? TCR_ACTIVE : status.reason
}

/** Whether two statuses are the same: both active, or both paused for the same reason. */
export function sameStatus(left: Status | undefined, right: Status | undefined): boolean {
  assert(left === undefined || left === TCR_ACTIVE || typeof left === 'object', `a status of ${typeof left} was compared`)
  assert(right === undefined || right === TCR_ACTIVE || typeof right === 'object', `a status of ${typeof right} was compared`)
  return left === right || (typeof left === 'object' && typeof right === 'object' && left.reason === right.reason)
}
/** The language of the upstream check, whose failure is another person's push, not an edit of the agent. */
export const UPSTREAM_LANGUAGE = 'git'
export const OUTSIDE_CHANGE = "files changed outside the agent's edits, and a revert would discard them"
const SHORT_COMMIT = 7
const MS_PER_SECOND = 1000
/** The most lines of what a command printed that a message to the agent holds besides the first, the last ones, where a traceback names its error. */
const PRINTED_LINES = 20
const OMITTED_LINES = '...'
/** The most characters of a line of what a command printed that a message to the agent holds; the rest of a longer line is cut, so a command that prints one line of a megabyte cannot fill the message. */
const PRINTED_LINE_CHARS = 400
const CUT_MARK = '... '
const CHECKPOINT_COMMAND = decodeURIComponent(new URL('../engine/checkpoint.py', import.meta.url).pathname)

/**
 * What TCR knows between events. `status` is undefined before it is decided, TCR_ACTIVE, or paused with the reason it cannot run.
 * `settled` is the fingerprint of the files at the latest checkpoint or revert, and `seen` the fingerprint after the
 * agent's latest editing tool, which files seen at any other tool must match. `unjudged` is whether an edit waits for
 * the project's checks to judge it. `held` is the fingerprint of the files when TCR left an edit uncommitted and
 * unreverted, so that the next turn start can tell the files are still that edit. `isLeftToChecks` is set when TCR tells nothing of the failures of the edit: the agent
 * committed in a step that left the files as TCR knew them, so TCR judges nothing of it, or TCR held the edit for a reason that
 * names no failure. The checks then tell its failures.
 */
export type Tcr = { status: Status | undefined; settled: string | undefined; seen: string | undefined; unjudged: boolean; held: string | undefined; isLeftToChecks?: boolean }

export function initialTcr(): Tcr {
  const tcr: Tcr = { status: undefined, settled: undefined, seen: undefined, unjudged: false, held: undefined }
  assert(tcr.status === undefined && !tcr.unjudged, 'a new session starts with TCR undecided and no edit to judge')
  assert(Object.keys(tcr).length === 5, `TCR starts with ${Object.keys(tcr)}; give it status, settled, seen, unjudged and held`)
  return tcr
}

/** How the engine says the reset of a revert ended: done, failed when git ran it and it exited with an error, or unknown when it timed out or could not run. */
export type Reset = 'done' | 'failed' | 'unknown'
const RESETS: readonly unknown[] = ['done', 'failed', 'unknown']

/** What the engine reported of a revert that failed after it may have begun to discard the work: how the reset ended. */
export type Outcome = { reset: Reset }

/**
 * A revert that failed after it may have begun to discard the work, so the engine's report of the reset says what is known
 * and the files say the rest; it proves nothing of the files themselves. `saved` is the ref that holds the discarded work, null when none was kept, or undefined when the
 * command gave no answer to name it. `outcome.reset` is unknown when it gave none.
 */
export class RevertFailure extends CommandError {
  readonly saved: string | null | undefined
  readonly outcome: Outcome

  constructor(message: string, saved: string | null | undefined, outcome: Outcome = { reset: 'unknown' }, answer?: Record<string, unknown>) {
    assert(typeof outcome === 'object' && outcome !== null, `the outcome of a failed revert is ${typeof outcome}, not an object`)
    assert(RESETS.includes(outcome.reset), `the reset of a failed revert is ${JSON.stringify(outcome.reset)}; it is done, failed or unknown`)
    super(message, answer)
    this.saved = saved
    this.outcome = outcome
  }
}

/** How long a question to the checkpoint command may take, in milliseconds: a git commit runs the project's own hooks. */
export const COMMAND_LIMITS_MS = { reason: 20_000, fingerprint: 20_000, checkpoint: 120_000, revert: 120_000 } as const

/** How long a one-shot run of a check may take before it is stopped, in milliseconds. */
export const CHECK_TIMEOUT_MS = 540_000

/** The questions about the files a judgement asks git or the checkpoint command, besides the checks and the commit or revert itself, each with its own limit. */
const FILE_QUESTIONS_PER_JUDGEMENT = 6

/**
 * How long a whole judgement may take before TCR stops waiting for it: the slowest check, the slower of a commit and a
 * revert, and every question about the files, each at its own limit. So the whole is never shorter than the steps it
 * holds, and a stop at this limit never comes while a commit or a revert is still within its own.
 */
export const JUDGEMENT_LIMIT_MS = CHECK_TIMEOUT_MS + Math.max(COMMAND_LIMITS_MS.checkpoint, COMMAND_LIMITS_MS.revert) + FILE_QUESTIONS_PER_JUDGEMENT * COMMAND_LIMITS_MS.fingerprint

/** Where a bug of the plugin is logged: a row the user sees, whereas a failure of the host goes to the debug log. */
export const BUG_LOG = 'transcript'

/** The longest time a timer waits: a delay above it makes the timer fire at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1

const SCALE_VARIABLE = 'OVERWATCH_TCR_TIMEOUT_SCALE'

/** The number every limit is multiplied by: what OVERWATCH_TCR_TIMEOUT_SCALE holds when it is a number above zero, cut to MAX_TIMER_MS, since a limit is never longer, otherwise one, which is also the scale when the read of the environment failed as expected. */
export async function scaleOf($: EngineInterface): Promise<number> {
  const given = Number((await readExpecting(() => $.env.get('OVERWATCH_TCR_TIMEOUT_SCALE'))).value)
  const scale = Number.isFinite(given) && given > 0 ? Math.min(given, MAX_TIMER_MS) : 1
  assert(scale > 0 && Number.isFinite(scale), `the limits were scaled by ${scale}`)
  assert(scale === 1 || scale === Math.min(given, MAX_TIMER_MS), `the scale ${scale} is neither one nor the ${given} the environment gave, cut to ${MAX_TIMER_MS}`)
  return scale
}

/** The variables of the environment whose toast was shown since the session began, which a resume of the session keeps and any other end of it clears. */
export type Announced = Set<string>

function toastOnce($: EngineInterface, shown: Announced, variable: string, text: string) {
  assert(shown instanceof Set, `the toasts shown are ${typeof shown}, not a set`)
  if (shown.has(variable)) return
  shown.add(variable)
  $.ui.toast(text)
  assert(shown.size > 0, `a toast was shown but ${shown.size} toasts are marked as shown`)
}

/** Tells the user, once for each session, that the limits are scaled, when OVERWATCH_TCR_TIMEOUT_SCALE changes them, since a value left in the environment shortens every limit; and that they keep their default length, when that variable could not be read. */
export async function announceScale($: EngineInterface, shown: Announced): Promise<void> {
  const { failure } = await readExpecting(() => $.env.get('OVERWATCH_TCR_TIMEOUT_SCALE'))
  if (failure !== undefined) toastOnce($, shown, SCALE_VARIABLE, `overwatch: OVERWATCH_TCR_TIMEOUT_SCALE could not be read (${safeLine(failure)}), so every TCR limit keeps its default length`)
  const scale = await scaleOf($)
  if (scale !== 1) toastOnce($, shown, SCALE_VARIABLE, `overwatch: every TCR limit is multiplied by ${scale}, and none is longer than ${MAX_TIMER_MS}ms, because OVERWATCH_TCR_TIMEOUT_SCALE is set`)
  assert(scale > 0 && Number.isFinite(scale), `the limits were announced as multiplied by ${scale}`)
  assert(scale === 1 || Number.isFinite(scale * 2), `the scale ${scale} cannot multiply a limit`)
}

/** Tells the user, once for each session, of PATH or HOME that the host refused to give, and what that costs. */
export async function announceUnreadable($: EngineInterface, shown: Announced): Promise<void> {
  const path = await readExpecting(() => $.env.get('PATH'))
  if (path.failure !== undefined) toastOnce($, shown, 'PATH', `overwatch: PATH could not be read (${safeLine(path.failure)}), so overwatch may not find the checks`)
  const home = await readExpecting(() => $.env.get('HOME'))
  if (home.failure !== undefined) toastOnce($, shown, 'HOME', `overwatch: HOME could not be read (${safeLine(home.failure)}), so the full output of a failed check is not saved`)
  assert(path.failure === undefined || path.value === undefined, `a PATH that failed with ${path.failure} also gave ${String(path.value)}`)
  assert(home.failure === undefined || home.value === undefined, `a HOME that failed with ${home.failure} also gave ${String(home.value)}`)
}

/** `ms` as the session scales it: unchanged unless OVERWATCH_TCR_TIMEOUT_SCALE holds a number above zero, which shortens every limit so that a test need not wait the minutes a real one does. */
export async function limitOf($: EngineInterface, ms: number): Promise<number> {
  const scale = await scaleOf($)
  assert(ms > 0 && scale > 0, `a limit of ${ms}ms scaled by ${scale} is no time`)
  const limit = Math.min(MAX_TIMER_MS, Math.max(1, Math.round(ms * scale)))
  assert(Number.isInteger(limit) && limit <= MAX_TIMER_MS && (limit <= ms || scale > 1), `the limit ${limit}ms of ${ms}ms scaled by ${scale} is no whole number of milliseconds within it`)
  return limit
}

/** The whole judgement of an edit, checks and checkpoint together, may take this long. */
export function judgementLimitOf($: EngineInterface): Promise<number> {
  assert(JUDGEMENT_LIMIT_MS >= CHECK_TIMEOUT_MS + COMMAND_LIMITS_MS.checkpoint + COMMAND_LIMITS_MS.fingerprint, `the whole judgement, ${JUDGEMENT_LIMIT_MS}ms, must be allowed longer than a check, ${CHECK_TIMEOUT_MS}ms, and its checkpoint, ${COMMAND_LIMITS_MS.checkpoint}ms`)
  assert(JUDGEMENT_LIMIT_MS < 2 ** 31, `the judgement limit ${JUDGEMENT_LIMIT_MS}ms is too long for a timer`)
  return limitOf($, JUDGEMENT_LIMIT_MS)
}

/** A limit in milliseconds as the whole seconds a notice names, rounded up so that a limit under a second is not zero. */
export function secondsOf(ms: number): number {
  assert(ms > 0, `a limit of ${ms}ms is no time`)
  assert(Number.isFinite(ms), `a limit of ${ms}ms is not a number of milliseconds`)
  return Math.ceil(ms / MS_PER_SECOND)
}

/** What a process printed and its exit code, or a CommandError saying that it could not start or ran past its limit. */
async function runWithin($: EngineInterface, spawn: { argv: readonly string[]; cwd: string }, ms: number, what: string): Promise<{ text: string; code: number | null }> {
  assert(spawn.argv.length > 0 && ms > 0, `${what} was asked to run ${spawn.argv.length} words for ${ms}ms`)
  let text = ''
  const child = $.process.spawn(spawn)
  const stop = child.return.bind(child, { code: null, signal: null })
  const limit = { isTimedOut: false, timer: $.clock.after(ms, () => { limit.isTimedOut = true; void stop() }) }
  try {
    for await (const { text: part } of child) text += part
    const { code } = await child.result
    if (limit.isTimedOut) throw new CommandError(`${what} took longer than ${secondsOf(ms)}s`)
    return { text, code }
  } catch (error) {
    if (error instanceof CommandError) throw error
    throw new CommandError(limit.isTimedOut ? `${what} took longer than ${secondsOf(ms)}s` : `${what} could not run: ${String(error)}`)
  } finally {
    limit.timer.cancel()
    assert(typeof text === 'string', `${what} printed ${typeof text}, not text`)
  }
}

/** The failure of a revert as `error` says it: unchanged when the command answered that it failed before it changed anything, which it does with neither `saved` nor `reset`, and otherwise one the files must tell. */
function revertFailureOf(error: unknown): unknown {
  if (!(error instanceof CommandError) || error instanceof RevertFailure) return error
  const { answer } = error
  assert(answer === undefined || typeof answer === 'object', `the answer of the failed revert is ${typeof answer}, not an object`)
  if (answer !== undefined && !('saved' in answer) && !('reset' in answer)) return error
  const saved = answer === undefined ? undefined : savedOf(answer)
  const reset = RESETS.includes(answer?.reset) ? (answer?.reset as Reset) : 'unknown'
  assert(answer !== undefined || saved === undefined, `a revert that gave no answer was given the ref ${String(saved)}`)
  return new RevertFailure(error.message, saved, { reset }, answer)
}

/** What engine/checkpoint.py answers to `command` for the repository at `root`, the one JSON object it prints. A revert that fails after it may have begun is a RevertFailure. */
export async function ask($: EngineInterface, root: string, command: keyof typeof COMMAND_LIMITS_MS, flags: readonly string[] = []): Promise<Record<string, unknown>> {
  assert(command in COMMAND_LIMITS_MS, `the checkpoint command was asked ${String(command)}, which has no limit`)
  assert(Array.isArray(flags), `the checkpoint command was given flags of ${typeof flags}, not a list`)
  try {
    return await askOnce($, root, command, flags)
  } catch (error) {
    throw command === 'revert' ? revertFailureOf(error) : error
  }
}

/** The first line of `text` and its last PRINTED_LINES lines, which is all of it when it is no longer, each cut after PRINTED_LINE_CHARS characters, never between the two halves of one, and marked as cut; where an error is named, at the top or at the end, depends on who printed it. */
function endOf(text: string): string {
  assert(typeof text === 'string', `the output to cut is ${typeof text}, not text`)
  const lines = text.trimEnd().split('\n')
  const kept = lines.length > PRINTED_LINES + 1 ? [lines[0] as string, OMITTED_LINES, ...lines.slice(-PRINTED_LINES)] : lines
  const cut = kept.map(line => cutLine(line)).join('\n')
  assert(lines.length > 0 && kept.length > 0, `${lines.length} lines of the output were cut to ${kept.length}`)
  assert(kept.length <= PRINTED_LINES + 2, `${kept.length} lines of the output were kept, more than the first, the marker and ${PRINTED_LINES}`)
  return cut
}

/** `line` as it is when longer than PRINTED_LINE_CHARS characters: its first characters, whole, then CUT_MARK. */
function cutLine(line: string): string {
  assert(typeof line === 'string' && PRINTED_LINE_CHARS > 0, `a line of ${typeof line} was cut after ${PRINTED_LINE_CHARS} characters`)
  const characters = Array.from(line)
  const cut = characters.length > PRINTED_LINE_CHARS ? `${characters.slice(0, PRINTED_LINE_CHARS).join('')}${CUT_MARK}` : line
  assert(characters.length > 0 || cut.length === 0, `an empty line was cut to ${cut.length} characters`)
  return cut
}

async function askOnce($: EngineInterface, root: string, command: keyof typeof COMMAND_LIMITS_MS, flags: readonly string[]): Promise<Record<string, unknown>> {
  assert(command in COMMAND_LIMITS_MS && flags.every(flag => typeof flag === 'string'), `the checkpoint command ${String(command)} was given flags that are not text`)
  assert(typeof root === 'string', `the checkpoint command ${command} was asked about ${typeof root}, not a repository path`)
  const { text, code } = await runWithin($, { argv: ['python3', CHECKPOINT_COMMAND, command, root, ...flags], cwd: root }, await limitOf($, COMMAND_LIMITS_MS[command]), `python3 ${CHECKPOINT_COMMAND} ${command}`)
  let answer: unknown
  try {
    answer = JSON.parse(text)
  } catch {
    throw new CommandError(`${CHECKPOINT_COMMAND} ${command} exited ${code} and printed ${JSON.stringify(endOf(text))}, not JSON`)
  }
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) throw new CommandError(`${CHECKPOINT_COMMAND} ${command} exited ${code} and printed ${JSON.stringify(endOf(text))}, not an object`)
  const printed = answer as Record<string, unknown>
  const isNamed = typeof printed.error === 'string' && printed.error !== ''
  if (code !== 0) throw new CommandError(isNamed ? (printed.error as string) : `${CHECKPOINT_COMMAND} ${command} exited ${code}`, printed)
  if (printed.error !== undefined) throw new CommandError(isNamed ? (printed.error as string) : `${CHECKPOINT_COMMAND} ${command} exited 0 and said the error ${JSON.stringify(printed.error)}`, printed)
  return printed
}

/** What a revert did: whether it changed the files, the submodules it left alone, the git ref that holds what it removed when it was asked to keep it, and why git could not inspect the files after it, if so. */
export type RevertAnswer = { reverted: boolean; saved: string | null | undefined; changed: boolean; staged: boolean; skipped: string[]; unavailable: string | null }

/** The ref the answer that came with `error` names, if it came with one; undefined when it gave no usable one. */
export function savedOfError(error: unknown): string | null | undefined {
  const answer = error instanceof CommandError ? error.answer : undefined
  assert(answer === undefined || typeof answer === 'object', `the answer of the error is ${typeof answer}, not an object`)
  assert(!(error instanceof RevertFailure) || error.answer === answer, `the answer ${JSON.stringify(answer)} of a revert failure was read apart from the failure`)
  return answer === undefined ? undefined : savedOf(answer)
}

/** The ref an answer names that holds the discarded work: the ref, null when it names none was kept, or undefined when it gives no usable one. */
function savedOf(answer: Record<string, unknown>): string | null | undefined {
  assert(typeof answer === 'object' && answer !== null, `the answer ${String(answer)} that names a ref is no object`)
  const saved = typeof answer.saved === 'string' && answer.saved !== '' ? answer.saved : answer.saved === null ? null : undefined
  assert(saved === undefined || saved === null || typeof saved === 'string', `the ref of ${JSON.stringify(answer)} was read as ${String(saved)}`)
  return saved
}

/** The failure for an answer to a revert that does not say what it must. The files may be reverted whatever it says, so it is a RevertFailure, which the agent is told with the ref the answer names and the reset as it gives it, unknown when it gives none. */
function badRevertAnswer(answer: Record<string, unknown>): RevertFailure {
  assert(typeof answer === 'object' && answer !== null, `the revert answer is ${typeof answer}, not an object`)
  assert(!Array.isArray(answer), `the revert answer ${JSON.stringify(answer)} is a list; the command raises one before it is read`)
  const message = `the checkpoint command answered the revert with ${JSON.stringify(answer)}; it must say { "reverted": true or false, "saved": a ref or null, "reset": "done" when it reverted, "changed": true or false, "staged": true or false }`
  const reset = RESETS.includes(answer.reset) ? (answer.reset as Reset) : 'unknown'
  return new RevertFailure(message, savedOf(answer), { reset }, answer)
}

/** A true or false that the checkpoint command may leave out, which says false. */
function flagOf(answer: Record<string, unknown>, name: 'changed' | 'staged'): boolean {
  assert(name === 'changed' || name === 'staged', `${name} is no yes-or-no field of the revert answer`)
  const flag = answer[name] ?? false
  if (typeof flag !== 'boolean') throw badRevertAnswer(answer)
  assert(typeof flag === 'boolean', `${name} was read as ${flag}, not true or false`)
  return flag
}

/** The submodules the revert left alone because they still hold changes, which the checkpoint command may leave out. */
function skippedOf(answer: Record<string, unknown>): string[] {
  const skipped = answer.skipped ?? []
  if (!Array.isArray(skipped) || !skipped.every(name => typeof name === 'string' && name !== '')) throw badRevertAnswer(answer)
  assert(skipped.every(name => typeof name === 'string'), `the submodules ${JSON.stringify(skipped)} are no names`)
  assert(Array.isArray(skipped), `the submodules ${JSON.stringify(skipped)} are no list`)
  return skipped as string[]
}

/** Why the files could not be inspected after the revert, which the checkpoint command may leave out; null when it did not say. */
function unavailableOf(answer: Record<string, unknown>): string | null {
  const unavailable = answer.unavailable ?? null
  if (unavailable !== null && (typeof unavailable !== 'string' || unavailable === '')) throw badRevertAnswer(answer)
  assert(unavailable === null || unavailable !== '', `the revert answer ${JSON.stringify(answer)} gives an empty reason for the failed inspection`)
  assert(unavailable === null || typeof unavailable === 'string', `the reason ${JSON.stringify(unavailable)} is no text`)
  return unavailable
}

/** Whether the fields of a revert answer that each have a valid value say what cannot be: a ref or a failed inspection for a revert that changed nothing, files that changed in one that reverted them, or a staged version in no ref. */
function contradicts(fields: { reverted: boolean; saved: string | null | undefined; changed: boolean; staged: boolean; unavailable: string | null }): boolean {
  const { reverted, saved, changed, staged, unavailable } = fields
  const isContradiction = (!reverted && typeof saved === 'string') || (changed && (reverted || typeof saved === 'string')) || (staged && typeof saved !== 'string') || (unavailable !== null && !reverted)
  assert(reverted || typeof saved !== 'string' || isContradiction, `a revert that changed nothing names the ref ${saved} and is not called a contradiction`)
  assert(!staged || typeof saved === 'string' || isContradiction, `a staged version in no ref, with unavailable ${unavailable} and changed ${changed}, is not called a contradiction`)
  return isContradiction
}

/** The answer of the checkpoint command to `revert`: `{ reverted, saved }`. */
export function revertedBy(answer: Record<string, unknown>): RevertAnswer {
  const reverted = typeof answer.reverted === 'boolean' ? answer.reverted : undefined
  const saved = answer.saved
  const changed = flagOf(answer, 'changed')
  const staged = flagOf(answer, 'staged')
  const unavailable = unavailableOf(answer)
  const skipped = skippedOf(answer)
  const isSound = reverted !== undefined && (saved === undefined || saved === null || (typeof saved === 'string' && saved !== '')) && (answer.reset === 'done') === reverted
  if (!isSound || contradicts({ reverted, saved: saved as string | null | undefined, changed, staged, unavailable })) throw badRevertAnswer(answer)
  assert(typeof reverted === 'boolean' && (saved === undefined || saved === null || typeof saved === 'string'), `the revert answer ${JSON.stringify(answer)} was read as ${reverted} and ${saved}`)
  assert(reverted || (typeof saved !== 'string' && unavailable === null && !staged), `the revert answer ${JSON.stringify(answer)} was accepted as ${reverted} with saved ${saved}, staged ${staged} and unavailable ${unavailable}`)
  return { reverted, saved: saved as string | null | undefined, changed, staged, skipped, unavailable }
}

/** What a checkpoint did: the commit it made, and the files it refused to commit, each with the rule that refused it. */
export type Refusal = { path: string; rule: string; line: number | null }
export type CheckpointAnswer = { commit: string | null; refused: Refusal[]; changed: boolean }

/** Whether `each` is what the checkpoint command prints for a file it refused: its path, the rule that refused it and the line it found it on, if one. */
function isRefusal(each: unknown): each is Refusal {
  assert(typeof each !== 'function', `a refusal was given as ${String(each).slice(0, 40)}, a function, not the object the command prints`)
  const fields = typeof each === 'object' && each !== null ? (each as Record<string, unknown>) : {}
  assert(typeof fields === 'object', `a refusal read as ${typeof fields}, not an object`)
  const isLine = fields.line === undefined || fields.line === null || (Number.isInteger(fields.line) && (fields.line as number) > 0)
  return typeof fields.path === 'string' && typeof fields.rule === 'string' && isLine
}

/** The answer of the checkpoint command to `checkpoint`: `{ commit, refused }`, where an older command prints the commit alone. */
export function checkpointedBy(answer: Record<string, unknown>): CheckpointAnswer {
  const { commit = null, refused = [], changed = false } = answer
  if ((commit !== null && typeof commit !== 'string') || !Array.isArray(refused) || !refused.every(isRefusal) || typeof changed !== 'boolean' || (commit !== null && changed)) throw new CommandError(`the checkpoint command answered the checkpoint with ${JSON.stringify(answer)}; it must say { "commit": a sha or null, "refused": [{ "path", "rule", "line" }], "changed": true or false }`)
  assert(commit === null || refused.length === 0, `the checkpoint command made ${commit} but also refused ${JSON.stringify(refused)}; it commits nothing when it refuses`)
  assert(commit === null || !changed, `the checkpoint command made ${commit} but also said the files changed; it commits nothing when they did`)
  return { commit, refused: (refused as Refusal[]).map(each => ({ path: each.path, rule: each.rule, line: each.line ?? null })), changed }
}

/** A refused file as the Python engine names it, before it is written for a notice: its path, with the line when a line of it was refused, then the rule. */
function refusalText(each: Refusal): string {
  assert(each.line === null || each.line > 0, `${each.path} was refused on line ${each.line}, which is no line number`)
  assert(typeof each.rule === 'string', `${each.path} was refused by a rule of ${typeof each.rule}`)
  const text = `${each.line === null ? each.path : `${each.path}:${each.line}`} (${each.rule})`
  return text
}

/** Why TCR stops when its checkpoint was refused: each file with the rule that refused it, and what to do about it. */
export function refusedBecause(refused: readonly Refusal[]): string {
  assert(refused.length > 0, `a checkpoint that refused ${refused.length} files has no reason to give`)
  assert(refused.every(each => typeof each.path === 'string'), `${refused.length} refusals hold a path that is no text`)
  const reason = `the checkpoint would commit ${listed(refused.map(refusalText))}, so nothing was committed or reverted; add what is safe to commit to \`tcr.allow\` in ${OVERRIDE_PATH}, or to .gitignore, and run git rm --cached on a file that git tracks, and commit the pending edit yourself`
  return reason
}

/**
 * The paths in the output of `git status --porcelain -z`: each record is two status letters, a space and a path, and a
 * rename or copy is followed by one more field, the path it came from, which has no status letters.
 */
export function namesInStatus(text: string): string[] {
  const fields = text.split('\0')
  const names: string[] = []
  for (let at = 0; at < fields.length; at += 1) {
    const entry = fields[at] as string
    if (entry.length <= 3) continue
    names.push(entry.slice(3))
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') {
      at += 1
      if ((fields[at] ?? '') !== '') names.push(fields[at] as string)
    }
  }
  assert(typeof text === 'string' && fields.length > 0, `git status was read as ${typeof text} in ${fields.length} fields`)
  assert(names.length >= fields.filter(entry => entry.length > 3).length, `git status named ${names.length} paths for ${fields.length} fields; every record names at least one`)
  return names
}

/** The files git lists as changed or new in the repository at `root`, by their paths, leaving out the submodules as the engine does; the checks and the edits can differ in what they write. */
export async function dirtyFiles($: EngineInterface, root: string): Promise<string[]> {
  const { text, code } = await runWithin($, { argv: ['git', 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=all', '-z'], cwd: root }, await limitOf($, COMMAND_LIMITS_MS.fingerprint), 'git status')
  if (code !== 0) throw new CommandError(`git status exited ${code} in ${root}`)
  const names = namesInStatus(text)
  assert(Array.isArray(names) && (code === 0 || names.length === 0), `git status exited ${code} with ${names.length} names`)
  assert(typeof root === 'string', `git status was asked about ${typeof root}`)
  return names
}

/** The fingerprint of the files of the repository at `root`. */
export async function fingerprintOf($: EngineInterface, root: string): Promise<string> {
  assert(typeof root === 'string', `the fingerprint was asked about ${typeof root}`)
  const { fingerprint } = await ask($, root, 'fingerprint')
  if (typeof fingerprint !== 'string' || fingerprint === '') throw new CommandError(`the checkpoint command gave the fingerprint ${JSON.stringify(fingerprint)}; it must be text`)
  assert(typeof fingerprint === 'string', `the fingerprint is ${typeof fingerprint}, not text`)
  return fingerprint
}

/**
 * What a held edit's files are: the workspace fingerprint, which a change of size or time shows, and a digest of the
 * contents of the files that differ from HEAD, which a change that keeps both shows, joined as the Python engine joins them.
 */
export async function identityOf($: EngineInterface, root: string): Promise<string> {
  assert(root.startsWith('/'), `the identity of ${root} was asked for; pass the repository's absolute path`)
  const { fingerprint, content } = await ask($, root, 'fingerprint', ['--content'])
  if (typeof fingerprint !== 'string' || fingerprint === '' || typeof content !== 'string' || content === '') throw new CommandError(`the checkpoint command gave the fingerprint ${JSON.stringify(fingerprint)} and the content digest ${JSON.stringify(content)}; both must be text`)
  assert(typeof fingerprint === 'string' && typeof content === 'string', `the identity is ${typeof fingerprint} and ${typeof content}`)
  return `${fingerprint}:${content}`
}

/** TCR_ACTIVE, or the reason TCR cannot run in the repository at `root`; an edit TCR holds, which `isHeld` says the files still are, is no reason by itself. */
export async function stateOf($: EngineInterface, root: string, isHeld = false): Promise<Status> {
  assert(root.startsWith('/'), `the state of ${root} is for a relative path; pass the repository's absolute path`)
  const { reason } = await ask($, root, 'reason', isHeld ? ['--held'] : []).catch(error => {
    if (!(error instanceof CommandError)) throw error
    return { reason: error.message }
  })
  if (reason !== null && (typeof reason !== 'string' || reason === '')) throw new CommandError(`the checkpoint command gave the reason ${JSON.stringify(reason)}; it must be text or null`)
  const state = reason === null ? TCR_ACTIVE : pausedFor(reason)
  assert(state === TCR_ACTIVE || typeof state === 'object', `the state of TCR is ${typeof state}, not active or paused`)
  return state
}

/** What the agent is told when the TCR state changed from `previous` to `next`; undefined when it did not. */
export function notice(previous: Status | undefined, next: Status): string | undefined {
  if (sameStatus(previous, next)) return undefined
  assert(next === TCR_ACTIVE || typeof next === 'object', `TCR told a change from ${statusText(previous)} to ${typeof next}`)
  const text = next === TCR_ACTIVE
    ? 'overwatch: TCR is on: an edit that keeps the checks green is committed, and an edit that adds a failure is reverted.'
    : `overwatch: TCR is unavailable: ${safeLine(next.reason)}. Nothing is committed or reverted until it can start again at the start of a turn.`
  assert(previous === undefined || previous === TCR_ACTIVE || typeof previous === 'object', `TCR told a change from ${typeof previous}, which is no status`)
  return text
}

/** The short name of a commit, for the status line, written so that a name the checkpoint command gave with a line break cannot start a line of its own. */
export function shortCommit(commit: string): string {
  assert(typeof commit === 'string', `a commit of ${typeof commit} was shortened`)
  assert(SHORT_COMMIT > 0, `a commit was shortened to ${SHORT_COMMIT} characters`)
  return safeLine([...commit].slice(0, SHORT_COMMIT).join(''))
}

/** A message about TCR, waiting to go to the agent; `isWaking` starts a turn for it when none runs. */
export function tcrMessage(text: string, isWaking: boolean): { text: string; isWaking: boolean; kind: 'tcr' } {
  assert(typeof text === 'string', `a message of ${typeof text} was queued, not text`)
  assert(typeof isWaking === 'boolean', `a message wakes ${typeof isWaking}, not true or false`)
  const message = { text, isWaking, kind: 'tcr' as const }
  return message
}

/** Whether a check's one-shot result is a failure its baseline did not have; undefined when it has no baseline to tell by. */
export function isNewFailure(baseline: Report | undefined, report: Report): boolean | undefined {
  assert(report.summary !== undefined, `a result without a summary cannot be compared with ${baseline?.summary}`)
  const isNew = !report.isFailed ? false : baseline === undefined ? undefined : hasRegression(report, baseline)
  assert(isNew !== true || report.isFailed, `${report.summary} passed but counts as a new failure`)
  return isNew
}

/**
 * What a check's result says of an edit: `new` for a failure to revert for, `unjudged` for a failure with no earlier
 * result to tell it by, and `fine` otherwise. A check in `held` stays unjudged for as long as it fails, whatever it
 * fails with: only a pass gives it an earlier result.
 */
export function verdictOf(held: ReadonlySet<string>, key: string, baseline: Report | undefined, report: Report): 'new' | 'unjudged' | 'fine' {
  assert(key !== '', `a result of ${report.summary} was judged for a check with no key`)
  if (held.has(key)) return report.isFailed ? 'unjudged' : 'fine'
  const isNew = isNewFailure(baseline, report)
  const verdict = isNew === undefined ? 'unjudged' : isNew ? 'new' : 'fine'
  assert(verdict === 'fine' || report.isFailed, `${report.summary} passed but is judged ${verdict}`)
  return verdict
}

/**
 * Runs a check once, as the Python engine does: its baseline command to the end, or else its watch command until its first
 * complete report. Undefined when it has no command, cannot start, times out or prints no summary. `stops` holds what
 * stops the run, for as long as it runs, so that a newer edit can end it.
 */
export async function runCheck($: EngineInterface, watcher: Watcher, spawn: { cwd: string; env?: Record<string, string> }, stops: Set<() => Promise<unknown>>): Promise<Report | undefined> {
  const isBaseline = watcher.baseline !== undefined && watcher.baseline.length > 0
  const argv = isBaseline ? watcher.baseline : watcher.argv
  assert(spawn.cwd.startsWith('/'), `${watcher.name} would run once in ${spawn.cwd}, which is no absolute directory`)
  if (argv === undefined || argv.length === 0) return undefined
  const child = $.process.spawn({ argv, ...spawn })
  const stop = child.return.bind(child, { code: null, signal: null })
  const limit = { isTimedOut: false, timer: $.clock.after(await limitOf($, CHECK_TIMEOUT_MS), () => { limit.isTimedOut = true; stop().catch((error: unknown) => $.ui.log(`overwatch: ${commandLine(watcher, argv)} could not be stopped: ${String(error)}`, { to: 'debug' })) }) }
  stops.add(stop)
  try {
    let output = ''
    for await (const { text } of child) {
      output += text
      const report = isBaseline ? undefined : readReport(watcher, output.slice(0, output.lastIndexOf('\n') + 1))
      if (report !== undefined) {
        await stop()
        return report
      }
    }
    if (limit.isTimedOut) return undefined
    const { code } = await child.result
    return readReport(watcher, output, code)
  } catch (error) {
    $.ui.log(`overwatch: ${commandLine(watcher, argv)} could not be judged: ${String(error)}`, { to: 'debug' })
    return undefined
  } finally {
    limit.timer.cancel()
    stops.delete(stop)
    assert(!stops.has(stop), `the run of ${commandLine(watcher, argv)} is still waiting to be stopped after it ended`)
  }
}

/** Whether TCR runs and leaves the failures of the edit to itself, so that it, not the check's own result, tells the agent of a failure: by a revert, or by why it held the edit. It does not tell when it is stopped, when the agent's own commit took the edit, or when it held the edit for a reason that names no failure. */
export function isEditJudgedByTcr(tcr: Tcr): boolean {
  const is = tcr.status === TCR_ACTIVE && tcr.isLeftToChecks !== true
  assert(tcr.status !== TCR_ACTIVE || tcr.settled !== undefined, `TCR is ${statusText(tcr.status)} with ${tcr.settled} settled; an active TCR has a checkpoint to restore`)
  assert(!tcr.unjudged || tcr.status === TCR_ACTIVE, `TCR judges an edit while it is ${statusText(tcr.status)}`)
  return is
}

/** Whether the judgement of `ticket` is still the one that counts: the session, the TCR state and the edit are those it started with. */
export function isJudging(state: { epoch: number; tcr: Tcr; tcrTicket: number }, started: { epoch: number; tcr: Tcr; ticket: number }): boolean {
  assert(started.ticket <= state.tcrTicket, `the judgement ${started.ticket} is from the future; the latest is ${state.tcrTicket}`)
  const is = state.epoch === started.epoch && state.tcr === started.tcr && state.tcrTicket === started.ticket
  assert(started.epoch <= state.epoch, `the judgement began in the session ${started.epoch}, which is after the present ${state.epoch}`)
  return is
}
