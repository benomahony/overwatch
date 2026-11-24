/**
 * The watchers overwatch can run, compiled from watchers.json, and how their
 * output is read into reports, status lines and messages for the agent.
 *
 * Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
 */
import { TABLE } from './table'
import { assert } from './assert'
import { safeLine, safePath } from './safe-text'
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
  /** Variables set over overwatch's own environment for its commands. */
  env?: Readonly<Record<string, string>>
}

/** One watchers.json entry's settings in `.overwatch.json`, under `watchers` and its name; `env` is merged over the entry's. */
export type WatcherSettings = {
  enabled?: boolean
  argv?: string[]
  baseline?: string[]
  summary?: string
  failed?: string
  env?: Record<string, string>
}

/** The project's own `.overwatch.json`, shared with the Neovim plugin, every field optional. */
export type Override = {
  gate?: GatePolicy
  mode?: string
  tcr?: unknown
  enabled?: boolean
  name?: string
  argv?: string[]
  baseline?: string[]
  summary?: string
  failed?: string
  watchers?: Record<string, WatcherSettings>
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
  env?: Record<string, string>
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
  assert(typeof output === 'string', `the output to read is ${typeof output}, not text`)
  const line = output
    .replace(ANSI, '')
    .split('\n')
    .find(each => ENVIRONMENT.some(pattern => pattern.test(each)))
    ?.trim()
  assert(ENVIRONMENT.length > 0 && (line === undefined || typeof line === 'string'), `${ENVIRONMENT.length} environment patterns found ${typeof line}`)
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

/** Every language in WATCHERS, in order, each run as a live watcher of its own. */
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

/**
 * The watcher with the settings `.overwatch.json` gives its watchers.json name, its `env` merged over the entry's;
 * undefined when they turn it off. A sub-project's watcher is named after its entry, so it takes that entry's settings.
 */
export function configure(watcher: Watcher, entry: string, override: Override): Watcher | undefined {
  const settings = override.watchers?.[entry]
  if (settings === undefined) return watcher
  if (settings.enabled === false) return undefined
  const env = settings.env === undefined ? watcher.env : { ...watcher.env, ...settings.env }
  const result: Watcher = {
    ...watcher,
    argv: settings.argv ?? watcher.argv,
    baseline: settings.baseline ?? watcher.baseline,
    summary: settings.summary === undefined ? watcher.summary : new RegExp(settings.summary, 'm'),
    failed: settings.failed === undefined ? watcher.failed : new RegExp(settings.failed),
    ...(env === undefined ? {} : { env }),
  }
  assert(result.name === watcher.name && result.marker === watcher.marker, `settings for ${entry} renamed ${watcher.name} or moved its marker ${watcher.marker}; keep both`)
  assert(Object.entries(settings.env ?? {}).every(([name, value]) => result.env?.[name] === value), `${entry}'s env ${JSON.stringify(result.env)} lost the project's ${JSON.stringify(settings.env)}; merge it over the entry's`)
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
  assert(typeof summary === 'string', `the summary to count is ${typeof summary}, not text`)
  const counts = new Map<string, number>()
  const seen = { error: 0, warning: 0, failure: 0 }
  for (const match of summary.matchAll(/(\d+)\s+(errors?|warnings?|failures?|failed|fail)\b/g)) {
    const label = match[2] ?? ''
    const kind = label.startsWith('error') ? 'error' : label.startsWith('warning') ? 'warning' : 'failure'
    counts.set(`${kind} ${seen[kind]}`, Number(match[1]))
    seen[kind] += 1
  }
  assert(counts.size === seen.error + seen.warning + seen.failure, `summary ${summary} gave ${counts.size} counts from ${JSON.stringify(seen)}; key each by its kind and place`)
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

/** Each failing test or error the output names, once each, in the order it names them. A name is every group of
 * its match that matched, trimmed and joined by a space, so a pattern can name a failure from fields apart on its line. */
function failuresIn(watcher: Watcher, output: string): string[] {
  if (watcher.failure === undefined) return []
  const names = [...output.matchAll(watcher.failure)].map(match => match.slice(1).map(group => group?.trim() ?? '').filter(group => group !== '').join(' '))
  const unique = [...new Set(names.filter(name => name !== ''))]
  assert(typeof output === 'string', `the output of ${watcher.name} is ${typeof output}, not text`)
  assert(unique.length <= names.length, `${watcher.name} named ${unique.length} failures from ${names.length} matches; take each from a match`)
  return unique
}

/**
 * Reads one build's output: undefined until its summary line has arrived. A
 * run that has exited, given its `code`, is read by its exit code when the
 * watcher has no summary, and as failed when it gave none and exited nonzero.
 */
export function readReport(watcher: Watcher, output: string, code?: number | null): Report | undefined {
  const { complete: clean, text } = lastBuild(watcher, output)
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
    text: text.trim(),
    failures: isFailed ? failures : [],
    ...(environment === undefined ? {} : { environment }),
  }
  assert(report.isFailed || report.failures.length === 0, `${watcher.name} passed with failures ${failures}; list failures only when it failed`)
  assert(report.environment === undefined || report.isFailed, `${watcher.name} passed but cannot run: ${environment}; read the environment only of a failure`)
  return report
}

/**
 * Split the latest completed build from output still waiting for its summary.
 * Keep trailing diagnostics in the log text (some checkers print them after
 * their summary), but never read them as failures of a completed build.
 */
export function lastBuild({ name, summary }: Watcher, output: string): { complete: string; remaining: string; text: string } {
  assert(typeof output === 'string', `the output of ${name} is ${typeof output}, not text`)
  const clean = output.replace(ANSI, '')
  if (summary === undefined) return { complete: clean, remaining: '', text: clean }
  const flags = summary.flags
  const every = new RegExp(summary.source, `${flags.replace('g', '')}g`)
  const ends = [...clean.matchAll(every)].map(match => match.index + match[0].length)
  const start = ends.length > 1 ? (ends[ends.length - 2] ?? 0) : 0
  const end = ends.at(-1) ?? clean.length
  assert(start >= 0 && start <= end && end <= clean.length, `${name}'s last build spans ${start}..${end}, outside its ${clean.length} output characters`)
  const complete = clean.slice(start, end)
  return { complete, remaining: clean.slice(end), text: clean.slice(start) }
}

/** A watcher's command as one line, its watch command unless argv is given. */
export function commandLine(watcher: Watcher, argv: readonly string[] = watcher.argv ?? watcher.baseline ?? []): string {
  const words = argv.map(shellWord)
  const line = words.join(' ')
  assert(Array.isArray(argv), `the arguments of ${watcher.name} are ${typeof argv}, not a list`)
  assert(words.length === argv.length, `command line ${line} for ${watcher.name} has ${words.length} words for ${argv.length} arguments; quote each argument`)
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
export function command(watcher: Watcher): string {
  assert(typeof watcher === 'object' && watcher !== null, `a command was asked of ${typeof watcher}`)
  const line = safePath(commandLine(watcher))
  const text = `\`${line}\`${watcher.dir === undefined ? '' : ` in \`${safePath(watcher.dir)}\``}`
  assert(typeof text === 'string' && (watcher.dir === undefined || typeof watcher.dir === 'string'), `a command is told as ${typeof text} with its directory as ${typeof watcher.dir}, which is text or nothing`)
  return text
}

/** Names the failing tests, the first FAILURE_LIMIT of them, for the agent. */
export function failingLine(failures: readonly string[]): string[] {
  assert(Array.isArray(failures) && FAILURE_LIMIT > 0, `the failures are ${typeof failures}, not a list, and the limit is ${FAILURE_LIMIT}`)
  if (failures.length === 0) return []
  const named = failures.slice(0, FAILURE_LIMIT).map(name => `\`${safePath(name)}\``).join(', ')
  const more = failures.length > FAILURE_LIMIT ? `, and ${failures.length - FAILURE_LIMIT} more` : ''
  const line = `Failing: ${named}${more}.`
  assert(failures.length > 0 && typeof more === 'string', `${failures.length} failures were named`)
  return [line]
}

/** Where the full output is, which the agent reads only when the summary is not enough. */
/** A timing assertion in a test's output, as "took 87ms (limit: 50ms)" or a test reading elapsed time. */
const TIMING = /\btook \d+(?:\.\d+)? ?m?s\b|\belapsed\b|\bperf_counter\b/

/**
 * A line for a failure that looks like a timing test run under pytest-testmon, whose tracing slows every call so
 * timings in watch mode measure the instrumentation; none for any other failure. The failure still holds completion.
 */
function timingLine(watcher: Watcher, report: Report): string[] {
  const lines = watcher.argv?.includes('--testmon') && TIMING.test(report.text)
    ? [`This looks like a timing test, and \`--testmon\` traces every call in watch mode, so it runs slower than it would alone. If the code is no slower, mark timing tests and keep them out of the watcher with \`-m "not performance"\` in \`watchers.${safePath(watcher.name)}.argv\` in .overwatch.json.`]
    : []
  assert(lines.length <= 1, `timingLine gave ${lines.length} lines; give at most one`)
  assert(lines.length === 0 || watcher.argv!.includes('--testmon'), `timing hint given for ${watcher.name}, which runs no testmon`)
  return lines
}

export function logLine(log: string | undefined): string[] {
  assert(log === undefined || typeof log === 'string', `the log is ${typeof log}, not a path`)
  const lines = log === undefined ? [] : [`Full output: \`${safePath(log)}\``]
  assert(lines.length === (log === undefined ? 0 : 1), `log line for ${log} gave ${lines.length} lines; give one when there is a log`)
  return lines
}

/**
 * Tells the agent what its changes broke: the failures that are new since the
 * session started, how many it already had, and where the full output is.
 */
/** What a failure message says about a report beyond the report itself: what failed before, its log, whose change it followed. */
export type FailureContext = { known: readonly string[]; log: string | undefined; origin?: 'session' | 'outside' }

export function failureMessage(watcher: Watcher, report: Report, { known, log, origin = 'session' }: FailureContext): string {
  const knownNames = new Set(known)
  const fresh = report.failures.filter(name => !knownNames.has(name))
  const old = report.failures.length - fresh.length
  assert(report.isFailed, `failure message for ${watcher.name}, which passed with ${report.summary}; send it only for a failure`)
  const message = [
    origin === 'session'
      ? `overwatch: ${command(watcher)} failed after the latest change: ${safeLine(report.summary)}`
      : `overwatch: ${command(watcher)} failed after a change made outside this session: ${safeLine(report.summary)}`,
    ...failingLine(fresh),
    ...(old === 0 ? [] : [`${old} more were already failing when the session started.`]),
    origin === 'session'
      ? 'Fix these new failures before finishing. Tools remain available while you investigate.'
      : 'This session made no edit since the previous result, so another process may be changing these files; check before overwriting its work.',
    ...timingLine(watcher, report),
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
  assert(typeof report.isFailed === 'boolean', `the report of ${watcher.name} says ${typeof report.isFailed} of its failure`)
  assert(typeof report.summary === 'string', `the summary of ${watcher.name} is ${typeof report.summary}`)
  const state = report.isFailed ? 'is back to the failures it had when the session started.' : 'is green again.'
  const message = `overwatch: ${command(watcher)} ${state} ${safeLine(report.summary)}`
  return message
}

/** One watcher's line in the environment summary: the command and why it cannot run. */
export function environmentLine(watcher: Watcher, line: string): string {
  assert(typeof line === 'string' && typeof watcher === 'object', `the environment line is ${typeof line} for ${typeof watcher}`)
  assert(watcher !== null, 'a watcher has an environment line')
  const text = `- ${command(watcher)}: ${safeLine(line)}`
  return text
}

/** Tells the agent, once, which watchers cannot run here, and that its code is not why. */
export function environmentMessage(lines: readonly string[]): string {
  assert(lines.length > 0, `environment message with ${lines.length} lines; send it only when a check cannot run`)
  assert(lines.every(each => typeof each === 'string'), `${lines.length} lines of the environment are not all text`)
  const message = [
    'overwatch: these checks cannot run in this environment, so they are not reporting. This is not caused by your changes and needs no code change:',
    ...lines,
  ].join('\n')
  return message
}

/** Tells the agent the watcher stopped and when it comes back, so it knows a quiet build is not a passing one. */
export function exitMessage(watcher: Watcher, restartsInMs: number): string {
  assert(restartsInMs >= 0, `${watcher.name} restarts in ${restartsInMs}ms; pass a delay of zero or more`)
  assert(Number.isFinite(restartsInMs), `${watcher.name} restarts in ${restartsInMs}ms, which is no time`)
  const when = restartsInMs === 0 ? 'now' : `in ${restartsInMs / 1000}s`
  const message = `overwatch: ${command(watcher)} exited, so build failures are not reported until it restarts ${when}.`
  return message
}

/** Tells the agent the watcher keeps exiting as it starts, and where what it last printed is, so the cause can be fixed. */
export function gaveUpMessage(watcher: Watcher, exits: number, retryMs: number, log: string | undefined): string {
  assert(exits > 0 && retryMs > 0, `${watcher.name} gave up after ${exits} exits with retry ${retryMs}ms; pass both above zero`)
  assert(Number.isFinite(exits) && Number.isFinite(retryMs), `${watcher.name} stopped ${exits} times with retry ${retryMs}, which are no numbers`)
  const message = [
    `overwatch: ${command(watcher)} stopped ${exits} times in a row within ${retryMs / 1000}s of starting, so overwatch stopped restarting it on its own.`,
    `Build failures are not reported until it runs again; overwatch tries again as turns start, at most every ${retryMs / 1000}s.`,
    ...(log === undefined ? [] : [`What it printed last: \`${safePath(log)}\``]),
  ].join('\n')
  return message
}

/** The decoration each tool puts around its summary, which the status line leaves out. */
const SUMMARY_DECORATION = /^Build Summary:\s*|^zanity:\s*|^=+\s*|\s*=+$|^Test Files\s+|^Test Suites:\s*|^DONE\s+|^(?:ok|FAILED) \| /g

/** A report's summary without the decoration its tool puts around it, such as zanity's own name, for text that names the check itself. */
export function bareSummary(report: Report): string {
  assert(typeof report.summary === 'string', `the summary of a report is ${typeof report.summary}, not text`)
  assert(typeof report === 'object' && report !== null, `a summary was asked of ${typeof report}`)
  const bare = report.summary.replace(SUMMARY_DECORATION, '')
  return bare
}

/** A watcher's part of the status line: its name, a mark, its summary undecorated and its first failure. */
export function statusLine(watcher: Watcher, report: Report): string {
  assert(typeof report.isFailed === 'boolean', `the report of ${watcher.name} says ${typeof report.isFailed} of its failure`)
  assert(Array.isArray(report.failures), `the failures of ${watcher.name} are ${typeof report.failures}, not a list`)
  const mark = report.isFailed ? '✗' : '✓'
  const [first, ...rest] = report.failures
  const failing = first === undefined ? '' : `: ${safePath(first)}${rest.length > 0 ? ` +${rest.length} more` : ''}`
  const line = `${safePath(watcher.name)} ${mark} ${safeLine(bareSummary(report))}${failing}`
  return line
}

/** The spawn option that sets a watcher's env over overwatch's own; none when it sets none. */
export function envOf(watcher: Watcher): { env?: Record<string, string> } {
  assert(watcher.env === undefined || Object.values(watcher.env).every(value => typeof value === 'string'), `${watcher.name}'s env ${JSON.stringify(watcher.env)} holds a value that is not a string; give each variable a string`)
  const option = watcher.env === undefined ? {} : { env: { ...watcher.env } }
  assert(option.env === undefined || Object.keys(option.env).length === Object.keys(watcher.env ?? {}).length, `the env option for ${watcher.name} lost variables of ${JSON.stringify(watcher.env)}; copy each`)
  return option
}
