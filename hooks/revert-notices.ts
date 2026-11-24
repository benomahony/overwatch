/**
 * What the agent is told of a revert: the one that was done, with the files that came back, and the one that was only tried,
 * with what is known of the files. Each says what the engine reported of the reset and no more.
 */
import { assert } from './assert'
import { MESSAGE_FILES, NO_LISTING, cameBackLine, leftLine, listed, type RevertedFiles } from './notice-files'
import { safeLine, safePath } from './safe-text'
import { OVERRIDE_PATH, command, failingLine, logLine, type Report, type Watcher } from './watchers'

/** One failing watcher's part of a revert: what it reported, what the session had already, and where its full output is. */
export type Reverted = { watcher: Watcher; report: Report; known: readonly string[]; log: string | undefined }

const LIST_COPIES = '`git for-each-ref refs/overwatch/reverted` lists the copies'

/** What the engine and the project's setting let the notice say of a copy: the setting is claimed only when it is false, which `saveReverted` says; a missing or null ref with the setting not false leaves it unknown. */
export type Copying = { saveReverted?: boolean; isFailure?: boolean }

/** What the agent is told of the content a revert removed: gone because the setting says so, saved in a ref, or that it is not known. */
function keptLine(saved: string | null | undefined, staged: boolean, { saveReverted, isFailure = false }: Copying): string {
  assert(typeof staged === 'boolean', `whether a staged version exists is ${typeof staged}, not true or false`)
  assert(!staged || typeof saved === 'string', `a staged version is told for the ref ${JSON.stringify(saved)}, which holds none`)
  if (saved === null && saveReverted === false) return `The discarded work is gone: \`tcr.saveReverted\` is false in ${OVERRIDE_PATH}.`
  if (typeof saved !== 'string') return isFailure ? `Whether the discarded work was saved is not known, because the revert command failed; ${LIST_COPIES}, and the output of the command is in the next message.` : `Whether the discarded work was saved is not known; ${LIST_COPIES}.`
  const ref = safePath(saved)
  return `The discarded work is saved in \`${ref}\`; recover it with \`git checkout ${ref} -- .\`.${staged ? ` The version that was staged is in \`${ref}^2\`; recover it with \`git checkout ${ref}^2 -- .\`.` : ''}`
}

/** Tells the agent TCR reverted its latest change, or part of it when some of its files are still changed: which new failures caused it, where the full output is, and which files came back, which are still changed and which a person changed after the listing. `files.isUnlisted` says git could not list the files after the revert. `saved` is undefined when the revert command failed without naming the ref. Only a revert whose reset the engine reported as done is told this way. */
export function revertMessage(causes: readonly Reverted[], files: RevertedFiles, saved: string | null | undefined, { staged = false, ...copying }: { staged?: boolean } & Copying = {}): string {
  assert(causes.length > 0, `a revert for ${causes.length} failures cannot be told; give one`)
  const isPart = files.restored.length > 0 && (files.remaining?.length ?? 0) > 0
  const opening = isPart ? 'TCR reverted part of the latest change' : 'TCR reverted the latest change'
  const parts = causes.map(({ watcher, report, known, log }) => {
    const knownNames = new Set(known)
    return [
      `overwatch: ${opening} because ${command(watcher)} failed: ${safeLine(report.summary)}`,
      ...failingLine(report.failures.filter(name => !knownNames.has(name))),
      ...logLine(log),
    ].join('\n')
  })
  const message = `${parts.join('\n\n')}\n${cameBackLine(files)} ${keptLine(saved, staged, copying)}${leftLine(files)} Try a smaller step.`
  assert(parts.length === causes.length && (isPart ? files.restored.length > 0 : true), `${parts.length} reverts were told for ${causes.length} causes`)
  return message
}

/** The sentence that names each check whose new failure TCR tried to revert, quoted, and where its full output is. */
function failingCheck(causes: readonly Reverted[]): string {
  assert(causes.length > 0, `${causes.length} failures were given to name; give the checks whose failure TCR tried to revert`)
  const names = listed(causes.map(({ watcher }) => watcher.name))
  const logs = causes.slice(0, MESSAGE_FILES).flatMap(({ log }) => (log === undefined ? [] : [`\`${safePath(log)}\``]))
  const isPlural = causes.length > 1
  const text = ` The failing ${isPlural ? 'checks are' : 'check is'} ${names}${logs.length > 0 ? `; ${isPlural ? 'their' : 'its'} full output is in ${logs.join(', ')}` : ''}.`
  assert(logs.length <= causes.length, `${logs.length} logs were named for ${causes.length} failures`)
  return text
}

/** What failed in a revert that TCR cannot call done: git, when the engine reported that it ran the reset and the reset failed; the revert command, when it gave no answer; otherwise the end of the reset is not known. */
export type Failed = 'git' | 'the revert command' | 'unknown'
const FAILED_TEXT: Readonly<Record<Failed, string>> = { git: 'git failed', 'the revert command': 'the revert command failed', unknown: 'it is not known whether git finished the reset' }

/** What an attempt to revert leaves the notice to say of the files, from the two listings around it: the files now as HEAD has them, those still changed, and those that changed after the listing. Absent when git could not list them. */
export type Attempted = { asHead: readonly string[]; still: readonly string[]; late: readonly string[] }

const PRESENT_STATE = '`git status` shows the present state.'

/**
 * Tells the agent TCR tried to revert its latest change and the revert did not finish as a revert, and what is known of the
 * files: that `git status` shows the present state, and never that they are unchanged, which nothing here proves;
 * the files now as HEAD has them, those still changed and those that changed after the listing, without a cause; and where a
 * copy of the work is saved, if one was, or that it is not known when the command gave no answer. `failed` says what failed.
 */
export function unrevertedMessage(saved: string | null | undefined, { failed, files, causes, saveReverted }: { failed: Failed; files: Attempted | undefined; causes: readonly Reverted[]; saveReverted?: boolean }): string {
  assert(causes.length > 0 && failed in FAILED_TEXT, `an attempt that ${failed} was told for ${causes.length} causes`)
  const state = files === undefined ? NO_LISTING : PRESENT_STATE
  const copy = saved === undefined
    ? `Whether a copy was saved is not known; ${LIST_COPIES}, and the output of the revert command is in the next message.`
    : saved === null ? (saveReverted === false ? `No copy was saved: \`tcr.saveReverted\` is false in ${OVERRIDE_PATH}.` : `Whether a copy was saved is not known; ${LIST_COPIES}.`) : `A copy of the work is saved in \`${safePath(saved)}\`; \`git checkout ${safePath(saved)} -- .\` restores it.`
  const named = files === undefined ? '' : [
    ...(files.asHead.length > 0 ? [` Now as HEAD has them: ${listed(files.asHead)}.`] : []),
    ...(files.still.length > 0 ? [` Still changed: ${listed(files.still)}.`] : []),
    ...(files.late.length > 0 ? [` Changed after TCR listed the files: ${listed(files.late)}.`] : []),
  ].join('')
  const message = `overwatch: TCR tried to revert the latest change after a new failure, and ${FAILED_TEXT[failed]}. ${state} ${copy}${named}${failingCheck(causes)}`
  assert(files === undefined || (Array.isArray(files.asHead) && Array.isArray(files.still) && Array.isArray(files.late)), `the files ${JSON.stringify(files)} of an attempt are no three lists`)
  return message
}

/** What the agent is told when TCR tried to revert and something nobody expected broke after the revert command was spawned, and the files could not be told, which is built from what is known and asks the host for nothing. */
export function brokenRevertMessage(saved: string | null | undefined, causes: readonly Reverted[], saveReverted: boolean): string {
  assert(causes.length > 0, `a broken revert was told for ${causes.length} causes; give one`)
  assert(typeof saveReverted === 'boolean', `whether the copy is kept is ${typeof saveReverted}, not true or false`)
  return unrevertedMessage(saved, { failed: 'unknown', files: undefined, causes, saveReverted })
}
