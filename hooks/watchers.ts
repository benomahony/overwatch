/**
 * The watchers overwatch can run, compiled from watchers.json, and how their
 * output is read into reports, status lines and messages for the agent.
 *
 * Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
 */
import { TABLE } from './table'
import { assert } from './assert'
import type { GatePolicy } from './gating'

/** A test watcher overwatch can run: the file that marks a project as its kind, the command, and how to read its output. */
export type Watcher = {
  name: string
  /**
   * Watchers of one language are alternatives, tried in order: the first whose
   * marker, and `requires` if it names one, are present runs. Each language
   * found in a project runs its own. Absent, the watcher's name.
   */
  language?: string
  /** The file that marks a project as this watcher's kind; for a checker, the executable that must be on PATH. */
  marker: string
  /** An executable that must be on PATH besides the marker, such as a watch tool the language does not ship. */
  requires?: string
  /** The long-running watch command; absent, overwatch reruns `baseline` itself after each change the agent makes. */
  argv?: readonly string[]
  /** Runs the whole suite once before the watcher starts, read the same way; absent or empty, the watcher's first build is the baseline. */
  baseline?: readonly string[]
  /**
   * Matches the line that closes one build's report. Absent, a run is read
   * when it exits and its exit code decides, so a watcher with no summary
   * has no `argv`.
   */
  summary?: RegExp
  /** Tested against the summary line: a match means the build failed. */
  failed?: RegExp
  /** The line the status line shows, when the build's result is printed before the line that closes its report. */
  result?: RegExp
  /** Global and multiline: each match is one failing test or error, named by the first of its groups that took part. */
  failure?: RegExp
  /** The sub-project the watcher runs in, relative to the project's root; absent, the root. */
  dir?: string
}

/** The project's own `.overwatch.json`, shared with the Neovim plugin, every field optional. */
export type Override = {
  gate?: GatePolicy
  enabled?: boolean
  name?: string
  argv?: string[]
  baseline?: string[]
  summary?: string
  failed?: string
}

export const OVERRIDE_PATH = '.overwatch.json'

/** One entry of watchers.json, the table every runtime reads: patterns are JavaScript regex source. */
type Entry = {
  name: string
  language?: string
  marker: string
  requires?: string
  argv?: readonly string[]
  baseline?: readonly string[]
  summary?: string
  failed?: string
  result?: string
  failure?: string
}

const table: {
  search: { depth: number; skip: readonly string[] }
  environment: readonly string[]
  watchers: readonly Entry[]
  checkers: readonly Entry[]
} = TABLE

/**
 * A language the project's root lacks is looked for in its sub-projects: the
 * directories this many levels down, leaving out hidden ones and these.
 */
export const SEARCH = { depth: table.search.depth, skip: new Set(table.search.skip) }

/**
 * A watchers.json entry with its patterns compiled: summary and result
 * multiline, failure global too. Entries come from table.ts, which
 * scripts/table.py generates from watchers.json at build time and which
 * refuses an entry without a name and marker, so this compiles the program's
 * own table, never outside input.
 */
function watcherOf({ summary, failed, result, failure, ...entry }: Entry): Watcher {
  if (entry.name === '' || entry.marker === '') throw new Error(`watchers.json entry "${entry.name}" with marker "${entry.marker}" needs both; set them in watchers.json`)
  const watcher: Watcher = {
    ...entry,
    ...(summary === undefined ? {} : { summary: pattern(entry.name, 'summary', summary, 'm') }),
    ...(failed === undefined ? {} : { failed: pattern(entry.name, 'failed', failed, '') }),
    ...(result === undefined ? {} : { result: pattern(entry.name, 'result', result, 'm') }),
    ...(failure === undefined ? {} : { failure: pattern(entry.name, 'failure', failure, 'gm') }),
  }
  const given = [summary, failed, result, failure].filter(each => each !== undefined).length
  const compiled = [watcher.summary, watcher.failed, watcher.result, watcher.failure].filter(each => each !== undefined).length
  assert(compiled === given, `${entry.name} compiled ${compiled} of its ${given} patterns; compile each with pattern()`)
  assert(watcher.failure?.global !== false, `${entry.name}'s failure pattern is not global; compile it with the g flag for matchAll`)
  return watcher
}

/** One of a watchers.json entry's patterns compiled with `flags`, or an error naming the entry and field to correct. */
function pattern(name: string, field: string, source: string, flags: string): RegExp {
  let compiled: RegExp
  try {
    compiled = new RegExp(source, flags)
  } catch (error) {
    throw new Error(`watchers.json entry "${name}" has an invalid ${field} pattern ${source}: ${(error as Error).message}; correct it in watchers.json`)
  }
  assert(compiled.flags.length === flags.length, `${name}'s ${field} pattern has flags ${compiled.flags}, not ${flags}; pass each flag once`)
  assert([...flags].every(flag => compiled.flags.includes(flag)), `${name}'s ${field} pattern has flags ${compiled.flags}, not ${flags}; pass them to new RegExp`)
  return compiled
}

/** Alternatives of one language are tried in order, so a project's own test runner, installed in node_modules, comes before bun's. */
export const WATCHERS: readonly Watcher[] = table.watchers.map(watcherOf)

/** Checkers run beside the project's watcher, in any project, whenever their executable is on PATH. */
export const CHECKERS: readonly Watcher[] = table.checkers.map(watcherOf)

/** Lines that mean a command could not run where it is, offline or missing an interpreter, a wheel or a key, which no change to the code fixes. */
const ENVIRONMENT: readonly RegExp[] = table.environment.map(pattern => new RegExp(pattern))

/** The first line of `output` that says it failed for want of something in its environment, not because of the code. */
export function environmentIn(output: string): string | undefined {
  const line = output
    .replace(ANSI, '')
    .split('\n')
    .find(each => ENVIRONMENT.some(pattern => pattern.test(each)))
    ?.trim()
  assert(line === undefined || !line.includes('\n'), `environment line ${line} spans lines; take one line of the output`)
  assert(line === undefined || ENVIRONMENT.some(pattern => pattern.test(line)), `environment line ${line} matches no environment pattern`)
  return line
}

/** How many failing tests a message names before it says how many more there are. */
export const FAILURE_LIMIT = 10

/** The language a watcher checks: its language, else its name. */
export function languageOf(watcher: Watcher): string {
  const language = watcher.language ?? watcher.name
  if (language === '') throw new Error(`watcher "${watcher.name}" has an empty language; set language or name in watchers.json`)
  assert(language === watcher.language || language === watcher.name, `watcher ${watcher.name} got language ${language}, neither its language nor its name`)
  assert(watcher.language !== undefined || language === watcher.name, `watcher ${watcher.name} got language ${language}; fall back to its name`)
  return language
}

/** Every language in WATCHERS, in order, each run in a slot of its own. */
export const LANGUAGES: readonly string[] = [...new Set(WATCHERS.map(languageOf))]

/** The watcher with the project's override of its name, commands and patterns; its language stays. */
export function applyOverride(watcher: Watcher, override: Override): Watcher {
  const result = {
    ...watcher,
    language: languageOf(watcher),
    name: override.name ?? watcher.name,
    argv: override.argv ?? watcher.argv,
    baseline: override.baseline ?? watcher.baseline,
    summary: override.summary === undefined ? watcher.summary : new RegExp(override.summary, 'm'),
    failed: override.failed === undefined ? watcher.failed : new RegExp(override.failed),
  }
  assert(result.language === languageOf(watcher), `override changed ${watcher.name}'s language to ${result.language}; overrides may not set it`)
  assert(result.marker === watcher.marker, `override changed ${watcher.name}'s marker to ${result.marker}; keep the watcher's`)
  return result
}

/** A project no marker matches gets the override itself as its watcher, once it names a command, a summary line and a failure pattern. */
export function overrideWatcher(override: Override): Watcher | undefined {
  const { argv, baseline, summary, failed } = override
  if ((argv === undefined && !baseline?.length) || summary === undefined || failed === undefined) return undefined
  const watcher = applyOverride({ name: 'project', language: 'project', marker: OVERRIDE_PATH }, override)
  assert(watcher.summary !== undefined && watcher.failed !== undefined, `override watcher ${watcher.name} lost its summary or failed pattern`)
  assert(commandLine(watcher) !== '' || watcher.argv !== undefined, `override watcher ${watcher.name} has no command; give it argv or baseline`)
  return watcher
}

export type Report = {
  summary: string
  isFailed: boolean
  text: string
  failures: readonly string[]
  /** For a failed build, the line saying its environment, not its code, stopped it. */
  environment?: string
}

/**
 * Each count a summary gives, keyed by its kind (error, warning or failure)
 * and its place among the counts of that kind, so a summary with two failure
 * counts, such as zig's failed steps and failed tests, compares each with its own.
 */
function summaryCounts(summary: string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  const seen = { error: 0, warning: 0, failure: 0 }
  for (const match of summary.matchAll(/(\d+)\s+(errors?|warnings?|failures?|failed|fail)\b/g)) {
    const label = match[2] ?? ''
    const kind = label.startsWith('error') ? 'error' : label.startsWith('warning') ? 'warning' : 'failure'
    counts.set(`${kind} ${seen[kind]}`, Number(match[1]))
    seen[kind] += 1
  }
  assert(counts.size === seen.error + seen.warning + seen.failure, `summary ${summary} gave ${counts.size} counts from ${JSON.stringify(seen)}; key each by its kind and place`)
  assert([...counts.values()].every(count => summary.includes(String(count))), `counts ${[...counts.values()]} are not in summary ${summary}; take each from it`)
  return counts
}

/** Whether report fails in a way baseline, the session's first result, did not: a new failure, or a count that grew. */
export function hasRegression(report: Report, baseline: Report): boolean {
  if (!report.isFailed) return false
  const known = new Set(baseline.failures)
  if (!baseline.isFailed || report.failures.some(name => !known.has(name))) return true
  const before = summaryCounts(baseline.summary)
  const grew = [...summaryCounts(report.summary)].filter(([kind, count]) => count > (before.get(kind) ?? 0))
  assert(baseline.isFailed && report.isFailed, `compared counts of ${report.summary} without two failing results; compare only failing ones`)
  assert(grew.every(([kind]) => kind !== ''), `${report.summary} grew in an unnamed kind; name each kind it counts`)
  return grew.length > 0
}

/** Colour codes, which some tools (deno) print even into a pipe. */
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

/** Each failing test or error the output names, once each, in the order it names them. */
function failuresIn(watcher: Watcher, output: string): string[] {
  if (watcher.failure === undefined) return []
  const names = [...output.matchAll(watcher.failure)].map(match => match.slice(1).find(group => group !== undefined)?.trim() ?? '')
  const unique = [...new Set(names.filter(name => name !== ''))]
  assert(unique.length <= names.length, `${watcher.name} named ${unique.length} failures from ${names.length} matches; take each from a match`)
  assert(unique.every(name => name === name.trim()), `${watcher.name}'s failures ${unique} keep padding; trim them`)
  return unique
}

/**
 * Reads one build's output: undefined until its summary line has arrived. A
 * run that has exited, given its `code`, is read by its exit code when the
 * watcher has no summary, and as failed when it gave none and exited nonzero.
 */
export function readReport(watcher: Watcher, output: string, code?: number | null): Report | undefined {
  const clean = output.replace(ANSI, '')
  const failures = failuresIn(watcher, clean)
  const line = watcher.summary?.exec(clean)?.[0]?.trim()
  let summary: string
  let isFailed: boolean
  if (line !== undefined) {
    summary = watcher.result?.exec(clean)?.[0]?.trim() ?? line
    isFailed = watcher.failed?.test(line) ?? false
  } else if (code === undefined || (code === 0 && watcher.summary !== undefined)) {
    return undefined
  } else {
    isFailed = code !== 0
    const failed = failures.length > 0 ? `${failures.length} failed` : code === null ? 'ended by a signal' : `exited with code ${code}`
    summary = isFailed ? failed : 'passed'
  }
  const environment = isFailed ? environmentIn(clean) : undefined
  const report: Report = {
    summary,
    isFailed,
    text: clean.trim(),
    failures: isFailed ? failures : [],
    ...(environment === undefined ? {} : { environment }),
  }
  assert(report.isFailed || report.failures.length === 0, `${watcher.name} passed with failures ${failures}; list failures only when it failed`)
  assert(report.environment === undefined || report.isFailed, `${watcher.name} passed but cannot run: ${environment}; read the environment only of a failure`)
  return report
}

/** A watcher's command as one line, its watch command unless argv is given. */
export function commandLine(watcher: Watcher, argv: readonly string[] = watcher.argv ?? watcher.baseline ?? []): string {
  const words = argv.map(shellWord)
  const line = words.join(' ')
  assert(words.length === argv.length, `command line ${line} for ${watcher.name} has ${words.length} words for ${argv.length} arguments; quote each argument`)
  assert(words.every(word => !/\s/.test(word) || word.startsWith('"')), `command line ${line} for ${watcher.name} has an unquoted word with a space; quote it with shellWord`)
  return line
}

/**
 * One argument as the command lines overwatch shows write it; nothing runs
 * them through a shell. An argument made only of letters, digits and
 * `_@%+=:,./-` stays as it is; any other is written as a JSON string, so its
 * bounds and every character in it are unambiguous.
 */
function shellWord(part: string): string {
  const word = /^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part)
  assert(word === part || JSON.parse(word) === part, `argument ${part} became ${word}; leave it or write it as a JSON string`)
  assert(word.length >= part.length, `argument ${part} lost characters as ${word}; only add quotes`)
  return word
}

/** The command as the agent is told of it, with the sub-project it runs in. */
function command(watcher: Watcher): string {
  const text = `\`${commandLine(watcher)}\`${watcher.dir === undefined ? '' : ` in \`${watcher.dir}\``}`
  assert(text.startsWith(`\`${commandLine(watcher)}\``), `command ${text} does not quote ${watcher.name}'s command first; put commandLine first`)
  assert(watcher.dir === undefined || text.endsWith(`\`${watcher.dir}\``), `command ${text} does not name ${watcher.name}'s dir ${watcher.dir}; end with the dir in backticks`)
  return text
}

/** Names the failing tests, the first FAILURE_LIMIT of them, for the agent. */
function failingLine(failures: readonly string[]): string[] {
  if (failures.length === 0) return []
  const named = failures.slice(0, FAILURE_LIMIT).map(name => `\`${name}\``).join(', ')
  const more = failures.length > FAILURE_LIMIT ? `, and ${failures.length - FAILURE_LIMIT} more` : ''
  const line = `Failing: ${named}${more}.`
  assert(line.startsWith(`Failing: \`${failures[0]}\``), `line ${line} does not name ${failures[0]} first; quote the first ${FAILURE_LIMIT} in order`)
  assert((failures.length > FAILURE_LIMIT) === line.endsWith(' more.'), `line ${line} for ${failures.length} failures miscounts the rest`)
  return [line]
}

/** Where the full output is, which the agent reads only when the summary is not enough. */
function logLine(log: string | undefined): string[] {
  const lines = log === undefined ? [] : [`Full output: \`${log}\``]
  assert(lines.length === (log === undefined ? 0 : 1), `log line for ${log} gave ${lines.length} lines; give one when there is a log`)
  assert(lines.every(line => line.includes(`\`${log}\``)), `log line ${lines} does not quote ${log}`)
  return lines
}

/**
 * Tells the agent what its changes broke: the failures that are new since the
 * session started, how many it already had, and where the full output is.
 */
export function failureMessage(watcher: Watcher, report: Report, known: readonly string[], log: string | undefined): string {
  const knownNames = new Set(known)
  const fresh = report.failures.filter(name => !knownNames.has(name))
  const old = report.failures.length - fresh.length
  assert(report.isFailed, `failure message for ${watcher.name}, which passed with ${report.summary}; send it only for a failure`)
  const message = [
    `overwatch: ${command(watcher)} failed after the latest change: ${report.summary}`,
    ...failingLine(fresh),
    ...(old === 0 ? [] : [`${old} more were already failing when the session started.`]),
    'Fix these new failures before finishing. Tools remain available while you investigate.',
    ...logLine(log),
  ].join('\n')
  assert(fresh.length + old === report.failures.length, `${watcher.name} split ${report.failures.length} failures into ${fresh.length} new and ${old} old`)
  return message
}

/**
 * Tells the agent a watcher is green again, or back to only the failures it
 * started with. `report` is one readReport built, so its fields are always
 * set; only its summary, taken from the watcher's output, can be empty.
 */
export function recoveryMessage(watcher: Watcher, report: Report): string {
  if (report.summary === '') throw new Error(`${watcher.name} gave an empty summary; make its summary pattern in watchers.json match the line with the counts`)
  const state = report.isFailed ? 'is back to the failures it had when the session started.' : 'is green again.'
  const message = `overwatch: ${command(watcher)} ${state} ${report.summary}`
  assert(message.endsWith(report.summary), `recovery ${message} drops ${watcher.name}'s summary; end with it`)
  assert(message.includes(command(watcher)), `recovery ${message} does not name ${watcher.name}'s command`)
  return message
}

/** One watcher's line in the environment summary: the command and why it cannot run. */
export function environmentLine(watcher: Watcher, line: string): string {
  assert(!line.includes('\n'), `environment line ${line} for ${watcher.name} spans lines; pass one line`)
  const text = `- ${command(watcher)}: ${line}`
  assert(text.endsWith(`: ${line}`), `environment line ${text} drops why ${watcher.name} cannot run`)
  return text
}

/** Tells the agent, once, which watchers cannot run here, and that its code is not why. */
export function environmentMessage(lines: readonly string[]): string {
  assert(lines.length > 0, `environment message with ${lines.length} lines; send it only when a check cannot run`)
  const message = [
    'overwatch: these checks cannot run in this environment, so they are not reporting. This is not caused by your changes and needs no code change:',
    ...lines,
  ].join('\n')
  assert(message.split('\n').length === lines.length + 1, `environment message has ${message.split('\n').length} lines for ${lines.length} checks; give each one line`)
  return message
}

/** Tells the agent the watcher stopped and when it comes back, so it knows a quiet build is not a passing one. */
export function exitMessage(watcher: Watcher, restartsInMs: number): string {
  assert(restartsInMs >= 0, `${watcher.name} restarts in ${restartsInMs}ms; pass a delay of zero or more`)
  const when = restartsInMs === 0 ? 'now' : `in ${restartsInMs / 1000}s`
  const message = `overwatch: ${command(watcher)} exited, so build failures are not reported until it restarts ${when}.`
  assert(message.endsWith(`${when}.`), `exit message ${message} does not say when ${watcher.name} restarts`)
  return message
}

/** Tells the agent the watcher keeps exiting as it starts, and where what it last printed is, so the cause can be fixed. */
export function gaveUpMessage(watcher: Watcher, exits: number, retryMs: number, log: string | undefined): string {
  assert(exits > 0 && retryMs > 0, `${watcher.name} gave up after ${exits} exits with retry ${retryMs}ms; pass both above zero`)
  const message = [
    `overwatch: ${command(watcher)} stopped ${exits} times in a row within ${retryMs / 1000}s of starting, so overwatch stopped restarting it on its own.`,
    `Build failures are not reported until it runs again; overwatch tries again as turns start, at most every ${retryMs / 1000}s.`,
    ...(log === undefined ? [] : [`What it printed last: \`${log}\``]),
  ].join('\n')
  assert(log === undefined || message.endsWith(`\`${log}\``), `gave-up message for ${watcher.name} does not end with its log ${log}`)
  return message
}

/** The decoration each tool puts around its summary, which the status line leaves out. */
const SUMMARY_DECORATION = /^Build Summary:\s*|^zanity:\s*|^=+\s*|\s*=+$|^Test Files\s+|^Test Suites:\s*|^DONE\s+|^(?:ok|FAILED) \| /g

/** A watcher's part of the status line: its name, a mark, its summary undecorated and its first failure. */
export function statusLine(watcher: Watcher, report: Report): string {
  const mark = report.isFailed ? '✗' : '✓'
  const [first, ...rest] = report.failures
  const failing = first === undefined ? '' : `: ${first}${rest.length > 0 ? ` +${rest.length} more` : ''}`
  const line = `overwatch ${watcher.name} ${mark} ${report.summary.replace(SUMMARY_DECORATION, '')}${failing}`
  assert(line.startsWith(`overwatch ${watcher.name} ${mark} `), `status ${line} does not open with ${watcher.name} and its mark; build it from the name, mark and summary`)
  assert(first === undefined || line.includes(`: ${first}`), `status ${line} does not name ${watcher.name}'s first failure ${first}; append it after a colon`)
  return line
}
