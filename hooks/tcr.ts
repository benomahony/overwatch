import type { EngineInterface } from 'claude-code'
import { assert } from './assert'
import { OVERRIDE_PATH, commandLine, hasRegression, readReport, type Override, type Report, type Watcher } from './watchers'

export const TCR_MODE = 'tcr'
export const TCR_ACTIVE = 'active'
/** The language of the upstream check, whose failure is another person's push, not an edit of the agent. */
export const UPSTREAM_LANGUAGE = 'git'
export const OUTSIDE_CHANGE = "files changed outside the agent's edits, and a revert would discard them"
const SHORT_COMMIT = 7
const CHECKPOINT_COMMAND = decodeURIComponent(new URL('../engine/checkpoint.py', import.meta.url).pathname)

/**
 * What TCR knows between events. `status` is undefined before it is decided, TCR_ACTIVE, or the reason it cannot run.
 * `settled` is the fingerprint of the files at the latest checkpoint or revert, and `seen` the fingerprint after the
 * agent's latest editing tool, which files seen at any other tool must match. `unjudged` is whether an edit waits for
 * the project's checks to judge it. `held` is the fingerprint of the files when TCR left an edit uncommitted and
 * unreverted, so that the next turn start can tell the files are still that edit.
 */
export type Tcr = { status: string | undefined; settled: string | undefined; seen: string | undefined; unjudged: boolean; held: string | undefined }

export function initialTcr(): Tcr {
  const tcr: Tcr = { status: undefined, settled: undefined, seen: undefined, unjudged: false, held: undefined }
  assert(tcr.status === undefined && !tcr.unjudged, 'a new session starts with TCR undecided and no edit to judge')
  assert(Object.keys(tcr).length === 5, `TCR starts with ${Object.keys(tcr)}; give it status, settled, seen, unjudged and held`)
  return tcr
}

/** The checkpoint command could not answer, or refused; the message says why. */
export class CommandError extends Error {}

/** The project's mode: TCR_MODE, or undefined when it names none. Any other mode is an error naming the field. */
export function readMode(override: Override): typeof TCR_MODE | undefined {
  const { mode } = override
  if (mode !== undefined && mode !== TCR_MODE) throw new CommandError(`${OVERRIDE_PATH} field 'mode' is ${pythonRepr(mode)}; the only mode is ${pythonRepr(TCR_MODE)}`)
  assert(mode === undefined || mode === TCR_MODE, `readMode accepted ${JSON.stringify(mode)}; accept only ${TCR_MODE}`)
  assert(mode === undefined || typeof mode === 'string', `the mode ${JSON.stringify(mode)} is not text`)
  return mode
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

/** `ms` as the session scales it: unchanged unless OVERWATCH_TCR_TIMEOUT_SCALE holds a number above zero, which shortens every limit so that a test need not wait the minutes a real one does. */
export async function limitOf($: EngineInterface, ms: number): Promise<number> {
  const given = Number(await $.env.get('OVERWATCH_TCR_TIMEOUT_SCALE').catch(() => undefined))
  const scale = Number.isFinite(given) && given > 0 ? given : 1
  assert(ms > 0 && scale > 0, `a limit of ${ms}ms scaled by ${scale} is no time`)
  const limit = Math.max(1, Math.round(ms * scale))
  assert(Number.isInteger(limit) && limit <= ms || scale > 1, `the limit ${limit}ms of ${ms}ms scaled by ${scale} is no whole number of milliseconds within it`)
  return limit
}

/** The whole judgement of an edit, checks and checkpoint together, may take this long. */
export function judgementLimitOf($: EngineInterface): Promise<number> {
  assert(JUDGEMENT_LIMIT_MS >= CHECK_TIMEOUT_MS + COMMAND_LIMITS_MS.checkpoint + COMMAND_LIMITS_MS.fingerprint, `the whole judgement, ${JUDGEMENT_LIMIT_MS}ms, must be allowed longer than a check, ${CHECK_TIMEOUT_MS}ms, and its checkpoint, ${COMMAND_LIMITS_MS.checkpoint}ms`)
  assert(JUDGEMENT_LIMIT_MS < 2 ** 31, `the judgement limit ${JUDGEMENT_LIMIT_MS}ms is too long for a timer`)
  return limitOf($, JUDGEMENT_LIMIT_MS)
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
    if (limit.isTimedOut) throw new CommandError(`${what} took longer than ${Math.ceil(ms / 1000)}s`)
    return { text, code }
  } catch (error) {
    if (error instanceof CommandError) throw error
    throw new CommandError(limit.isTimedOut ? `${what} took longer than ${Math.ceil(ms / 1000)}s` : `${what} could not run: ${String(error)}`)
  } finally {
    limit.timer.cancel()
    assert(typeof text === 'string', `${what} printed ${typeof text}, not text`)
  }
}

/** What engine/checkpoint.py answers to `command` for the repository at `root`, the one JSON object it prints. */
export async function ask($: EngineInterface, root: string, command: keyof typeof COMMAND_LIMITS_MS, flags: readonly string[] = []): Promise<Record<string, unknown>> {
  assert(root.startsWith('/'), `the checkpoint command was asked about ${root}; pass the repository's absolute path`)
  assert(CHECKPOINT_COMMAND.startsWith('/') && !CHECKPOINT_COMMAND.includes('%20'), `the checkpoint command is at ${CHECKPOINT_COMMAND}, which is no path a process can run`)
  const { text, code } = await runWithin($, { argv: ['python3', CHECKPOINT_COMMAND, command, root, ...flags], cwd: root }, await limitOf($, COMMAND_LIMITS_MS[command]), `python3 ${CHECKPOINT_COMMAND} ${command}`)
  let answer: unknown
  try {
    answer = JSON.parse(text)
  } catch {
    throw new CommandError(`${CHECKPOINT_COMMAND} ${command} printed ${JSON.stringify(text)}, not JSON`)
  }
  if (answer === null || typeof answer !== 'object') throw new CommandError(`${CHECKPOINT_COMMAND} ${command} printed ${JSON.stringify(text)}, not an object`)
  const printed = answer as Record<string, unknown>
  if (code !== 0) throw new CommandError(typeof printed.error === 'string' ? printed.error : `${CHECKPOINT_COMMAND} ${command} exited ${code}`)
  assert(code === 0 && printed.error === undefined, `${command} exited ${code} with the error ${JSON.stringify(printed.error)} but did not fail`)
  return printed
}

/** What a revert did: whether it changed the files, and the git ref that holds what it removed when it was asked to keep it. */
export type RevertAnswer = { reverted: boolean; saved: string | null; changed: boolean; staged: boolean }

function badRevertAnswer(answer: Record<string, unknown>) {
  assert(typeof answer === 'object' && answer !== null && !Array.isArray(answer), `the revert answer ${JSON.stringify(answer)} is no object`)
  const error = new CommandError(`the checkpoint command answered the revert with ${JSON.stringify(answer)}; it must say { "reverted": true or false, "saved": a ref or null, "changed": true or false, "staged": true or false }`)
  assert(['reverted', 'saved', 'changed', 'staged'].every(field => error.message.includes(`"${field}"`)), `the message of ${error.message} leaves out a field of the revert answer`)
  return error
}

/** A true or false that the checkpoint command may leave out, which says false. */
function flagOf(answer: Record<string, unknown>, name: 'changed' | 'staged'): boolean {
  assert(name === 'changed' || name === 'staged', `${name} is no yes-or-no field of the revert answer`)
  const flag = answer[name] ?? false
  if (typeof flag !== 'boolean') throw badRevertAnswer(answer)
  assert(typeof flag === 'boolean', `${name} was read as ${flag}, not true or false`)
  return flag
}

/** The answer of the checkpoint command to `revert`: `{ reverted, saved }`. */
export function revertedBy(answer: Record<string, unknown>): RevertAnswer {
  const legacy = Array.isArray(answer.restored) ? answer.restored.length > 0 : undefined
  const reverted = typeof answer.reverted === 'boolean' ? answer.reverted : legacy
  const saved = answer.saved === undefined || answer.saved === null ? null : answer.saved
  const changed = flagOf(answer, 'changed')
  const staged = flagOf(answer, 'staged')
  if (reverted === undefined || (saved !== null && typeof saved !== 'string')) throw badRevertAnswer(answer)
  assert(typeof reverted === 'boolean' && (saved === null || typeof saved === 'string'), `the revert answer ${JSON.stringify(answer)} was read as ${reverted} and ${saved}`)
  assert(reverted || saved === null, `the revert answer ${JSON.stringify(answer)} says it saved ${saved} but changed nothing`)
  assert(!changed || (!reverted && saved === null), `the revert answer ${JSON.stringify(answer)} says the files changed but also that it reverted them`)
  assert(!staged || saved !== null, `the revert answer ${JSON.stringify(answer)} says the ref holds a staged version but names no ref`)
  return { reverted, saved, changed, staged }
}

const JSON_TOKEN = /"(?:[^"\\]|\\.)*"|\btrue\b|\bfalse\b|\bnull\b|[:,]/g
const PYTHON_TOKENS: Readonly<Record<string, string>> = { true: 'True', false: 'False', null: 'None', ':': ': ', ',': ', ' }

/** `value`, which came from JSON, as Python prints it, so that a message about a setting reads as the Python engine's does. */
function pythonRepr(value: unknown): string {
  assert(typeof value !== 'function' && typeof value !== 'symbol', `${String(value)} came from JSON but is a ${typeof value}`)
  const json = JSON.stringify(value) ?? 'null'
  const text = json.replace(JSON_TOKEN, token => (token.startsWith('"') ? `'${token.slice(1, -1).replaceAll('\\"', '"')}'` : PYTHON_TOKENS[token] ?? token))
  assert(text !== '' && !/\b(?:true|false|null)\b/.test(text.replace(/'(?:[^'\\]|\\.)*'/g, '')), `${text} still holds a word of JSON that Python spells differently`)
  return text
}

const TCR_FIELDS = ['saveReverted', 'hostLimitSeconds', 'allow'] as const

/** The error for a field of `tcr` that holds the wrong thing: it names the field, what it holds and what it must hold. */
function settingError(field: (typeof TCR_FIELDS)[number], value: unknown, wanted: string): CommandError {
  assert(TCR_FIELDS.includes(field) && wanted !== '', `the setting ${field} was reported without saying what it must hold`)
  const error = new CommandError(`${OVERRIDE_PATH} field 'tcr.${field}' is ${pythonRepr(value)}, not ${wanted}`)
  assert(error.message.includes(`tcr.${field}`) && error.message.endsWith(wanted), `the error ${error.message} does not name ${field} and what it must hold`)
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
  if (typeof hostLimitSeconds !== 'number' || !(hostLimitSeconds > 0)) throw settingError('hostLimitSeconds', hostLimitSeconds, 'a positive number of seconds')
  if (!Array.isArray(allow) || !allow.every(entry => typeof entry === 'string' && entry.trim() !== '' && !/^[*/?[\]]+$/.test(entry.trim()))) throw settingError('allow', allow, 'a list of paths or globs that name files; an entry may not be empty or only wildcards')
  assert(typeof saveReverted === 'boolean', `tcr.saveReverted is ${typeof saveReverted}, not true or false`)
  assert(Object.keys(fields).length <= TCR_FIELDS.length, `the settings of TCR hold ${Object.keys(fields)}; they hold ${TCR_FIELDS} alone`)
  return { saveReverted }
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
  assert(refused.every(each => each.path !== '' && each.rule !== ''), `a refusal in ${JSON.stringify(refused)} names no path or no rule`)
  return { commit, refused: (refused as Refusal[]).map(each => ({ path: each.path, rule: each.rule, line: each.line ?? null })), changed }
}

/** A refused file as the Python engine names it: its path, with the line when a line of it was refused, then the rule. */
function refusalText(each: Refusal): string {
  assert(each.line === null || each.line > 0, `${each.path} was refused on line ${each.line}, which is no line number`)
  const text = `${each.line === null ? each.path : `${each.path}:${each.line}`} (${each.rule})`
  assert(text.startsWith(each.path) && text.endsWith(`(${each.rule})`), `the refusal ${text} leaves out the path ${each.path} or the rule ${each.rule}`)
  return text
}

/** Why TCR stops when its checkpoint was refused: each file with the rule that refused it, and what to do about it. */
export function refusedBecause(refused: readonly Refusal[]): string {
  assert(refused.length > 0, `a checkpoint that refused ${refused.length} files has no reason to give`)
  const reason = `the checkpoint would commit ${refused.map(refusalText).join(', ')}, so nothing was committed or reverted; add what is safe to commit to \`tcr.allow\` in ${OVERRIDE_PATH}, or to .gitignore, and commit the pending edit yourself`
  assert(refused.every(each => reason.includes(refusalText(each))), `the reason ${reason} leaves out one of ${JSON.stringify(refused)}`)
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
  assert(names.every(name => name !== ''), `git status named ${JSON.stringify(names)}, which holds a blank path`)
  assert(names.length >= fields.filter(entry => entry.length > 3).length, `git status named ${names.length} paths for ${fields.length} fields; every record names at least one`)
  return names
}

/** The files git lists as changed or new in the repository at `root`, by their paths; the checks and the edits can differ in what they write. */
export async function dirtyFiles($: EngineInterface, root: string): Promise<string[]> {
  assert(root.startsWith('/'), `git status was asked about ${root}; pass the repository's absolute path`)
  const { text, code } = await runWithin($, { argv: ['git', 'status', '--porcelain', '--untracked-files=all', '-z'], cwd: root }, await limitOf($, COMMAND_LIMITS_MS.fingerprint), 'git status')
  if (code !== 0) throw new CommandError(`git status exited ${code} in ${root}`)
  const names = namesInStatus(text)
  assert(names.every(name => name !== '' && !name.startsWith(' ')), `git status named ${JSON.stringify(names)}, which holds a blank path`)
  return names
}

/** The fingerprint of the files of the repository at `root`. */
export async function fingerprintOf($: EngineInterface, root: string): Promise<string> {
  const { fingerprint } = await ask($, root, 'fingerprint')
  if (typeof fingerprint !== 'string' || fingerprint === '') throw new CommandError(`the checkpoint command gave the fingerprint ${JSON.stringify(fingerprint)}; it must be text`)
  assert(root.startsWith('/'), `the fingerprint of ${root} is for a relative path; pass the repository's absolute path`)
  assert(fingerprint === fingerprint.trim(), `the fingerprint ${JSON.stringify(fingerprint)} has spaces around it; the command prints it bare`)
  return fingerprint
}

/**
 * What a held edit's files are: the workspace fingerprint, which a change of size or time shows, and a digest of the
 * contents of the files that differ from HEAD, which a change that keeps both shows, joined as the Python engine joins them.
 */
export async function identityOf($: EngineInterface, root: string): Promise<string> {
  const { fingerprint, content } = await ask($, root, 'fingerprint', ['--content'])
  if (typeof fingerprint !== 'string' || fingerprint === '' || typeof content !== 'string' || content === '') throw new CommandError(`the checkpoint command gave the fingerprint ${JSON.stringify(fingerprint)} and the content digest ${JSON.stringify(content)}; both must be text`)
  assert(!fingerprint.includes(':') && !content.includes(':'), `the fingerprint ${fingerprint} or the digest ${content} holds a colon, which joins them`)
  assert(root.startsWith('/'), `the identity of ${root} was asked for; pass the repository's absolute path`)
  return `${fingerprint}:${content}`
}

/** TCR_ACTIVE, or the reason TCR cannot run in the repository at `root`; an edit TCR holds, which `isHeld` says the files still are, is no reason by itself. */
export async function stateOf($: EngineInterface, root: string, isHeld = false): Promise<string> {
  const { reason } = await ask($, root, 'reason', isHeld ? ['--held'] : []).catch(error => ({ reason: String(error.message) }))
  if (reason !== null && (typeof reason !== 'string' || reason === '')) throw new CommandError(`the checkpoint command gave the reason ${JSON.stringify(reason)}; it must be text or null`)
  const state = reason ?? TCR_ACTIVE
  assert(state !== '' && (state === TCR_ACTIVE) === (reason === null), `the state ${JSON.stringify(state)} disagrees with the reason ${JSON.stringify(reason)}`)
  assert(root.startsWith('/'), `the state of ${root} is for a relative path; pass the repository's absolute path`)
  return state
}

/** What the agent is told when the TCR state changed from `previous` to `next`; undefined when it did not. */
export function notice(previous: string | undefined, next: string): string | undefined {
  if (next === previous) return undefined
  const text = next === TCR_ACTIVE
    ? 'overwatch: TCR is on: an edit that keeps the checks green is committed, and an edit that adds a failure is reverted.'
    : `overwatch: TCR is unavailable: ${next}. Nothing is committed or reverted until it can start again at the start of a turn.`
  assert(text.startsWith('overwatch: TCR is '), `notice ${text} does not say it is about TCR`)
  assert((next === TCR_ACTIVE) === text.includes('is on'), `notice ${text} disagrees with the state ${next}`)
  return text
}

/** The short name of a commit, for the status line. */
export function shortCommit(commit: string): string {
  assert(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit), `${JSON.stringify(commit)} is not a commit id; pass what the checkpoint command printed`)
  const short = commit.slice(0, SHORT_COMMIT)
  assert(short.length === SHORT_COMMIT && commit.startsWith(short), `the short name ${short} does not start ${commit}`)
  return short
}

/** A message about TCR, waiting to go to the agent; `isWaking` starts a turn for it when none runs. */
export function tcrMessage(text: string, isWaking: boolean): { text: string; isWaking: boolean; kind: 'tcr' } {
  assert(text.startsWith('overwatch: TCR '), `the TCR message ${JSON.stringify(text)} does not say it is about TCR`)
  const message = { text, isWaking, kind: 'tcr' as const }
  assert(message.kind === 'tcr' && message.text === text, `the TCR message was made as ${JSON.stringify(message)}`)
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
  const limit = { isTimedOut: false, timer: $.clock.after(await limitOf($, CHECK_TIMEOUT_MS), () => { limit.isTimedOut = true; void stop() }) }
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

/** Whether TCR runs, so that it, not the watchers' own results, tells the agent of a failure: by a revert, or by why it held the edit. */
export function isToldByTcr(tcr: Tcr): boolean {
  const is = tcr.status === TCR_ACTIVE
  assert(!is || tcr.settled !== undefined, `TCR is ${tcr.status} with ${tcr.settled} settled; an active TCR has a checkpoint to restore`)
  assert(!tcr.unjudged || is, `TCR judges an edit while it is ${tcr.status}`)
  return is
}

/** Whether the judgement of `ticket` is still the one that counts: the session, the TCR state and the edit are those it started with. */
export function isJudging(state: { epoch: number; tcr: Tcr; tcrTicket: number }, started: { epoch: number; tcr: Tcr; ticket: number }): boolean {
  assert(started.ticket <= state.tcrTicket, `the judgement ${started.ticket} is from the future; the latest is ${state.tcrTicket}`)
  const is = state.epoch === started.epoch && state.tcr === started.tcr && state.tcrTicket === started.ticket
  assert(!is || state.tcr.status === started.tcr.status, `the same TCR state changed from ${started.tcr.status} to ${state.tcr.status} unseen`)
  return is
}
