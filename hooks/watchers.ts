import { TABLE } from './table'

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

function watcherOf({ summary, failed, result, failure, ...entry }: Entry): Watcher {
  return {
    ...entry,
    ...(summary === undefined ? {} : { summary: new RegExp(summary, 'm') }),
    ...(failed === undefined ? {} : { failed: new RegExp(failed) }),
    ...(result === undefined ? {} : { result: new RegExp(result, 'm') }),
    ...(failure === undefined ? {} : { failure: new RegExp(failure, 'gm') }),
  }
}

/** Alternatives of one language are tried in order, so a project's own test runner, installed in node_modules, comes before bun's. */
export const WATCHERS: readonly Watcher[] = table.watchers.map(watcherOf)

/** Checkers run beside the project's watcher, in any project, whenever their executable is on PATH. */
export const CHECKERS: readonly Watcher[] = table.checkers.map(watcherOf)

/** Lines that mean a command could not run where it is, offline or missing an interpreter, a wheel or a key, which no change to the code fixes. */
const ENVIRONMENT: readonly RegExp[] = table.environment.map(pattern => new RegExp(pattern))

/** The first line of `output` that says it failed for want of something in its environment, not because of the code. */
export function environmentIn(output: string): string | undefined {
  return output
    .replace(ANSI, '')
    .split('\n')
    .find(line => ENVIRONMENT.some(pattern => pattern.test(line)))
    ?.trim()
}

/** How many failing tests a message names before it says how many more there are. */
export const FAILURE_LIMIT = 10

export function languageOf(watcher: Watcher): string {
  return watcher.language ?? watcher.name
}

/** Every language in WATCHERS, in order, each run in a slot of its own. */
export const LANGUAGES: readonly string[] = [...new Set(WATCHERS.map(languageOf))]

export function applyOverride(watcher: Watcher, override: Override): Watcher {
  return {
    ...watcher,
    language: languageOf(watcher),
    name: override.name ?? watcher.name,
    argv: override.argv ?? watcher.argv,
    baseline: override.baseline ?? watcher.baseline,
    summary: override.summary === undefined ? watcher.summary : new RegExp(override.summary, 'm'),
    failed: override.failed === undefined ? watcher.failed : new RegExp(override.failed),
  }
}

/** A project no marker matches gets the override itself as its watcher, once it names a command, a summary line and a failure pattern. */
export function overrideWatcher(override: Override): Watcher | undefined {
  const { argv, baseline, summary, failed } = override
  if ((argv === undefined && !baseline?.length) || summary === undefined || failed === undefined) return undefined
  return applyOverride({ name: 'project', language: 'project', marker: OVERRIDE_PATH }, override)
}

export type Report = {
  summary: string
  isFailed: boolean
  text: string
  failures: readonly string[]
  /** For a failed build, the line saying its environment, not its code, stopped it. */
  environment?: string
}

/** Compare counts when a runner does not give enough issue identities to identify a regression. */
function summaryCounts(summary: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const match of summary.matchAll(/(\d+)\s+(errors?|warnings?|failures?|failed|fail)\b/g)) {
    const label = match[2] ?? ''
    const kind = label.startsWith('error') ? 'error' : label.startsWith('warning') ? 'warning' : 'failure'
    counts.set(kind, Math.max(counts.get(kind) ?? 0, Number(match[1])))
  }
  return counts
}

export function hasRegression(report: Report, baseline: Report): boolean {
  if (!report.isFailed) return false
  const known = new Set(baseline.failures)
  if (!baseline.isFailed || report.failures.some(name => !known.has(name))) return true
  const before = summaryCounts(baseline.summary)
  return [...summaryCounts(report.summary)].some(([kind, count]) => count > (before.get(kind) ?? 0))
}

/** Colour codes, which some tools (deno) print even into a pipe. */
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

/** Each failing test or error the output names, once each, in the order it names them. */
function failuresIn(watcher: Watcher, output: string): string[] {
  if (watcher.failure === undefined) return []
  const names = [...output.matchAll(watcher.failure)].map(match => match.slice(1).find(group => group !== undefined)?.trim() ?? '')
  return [...new Set(names.filter(name => name !== ''))]
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
  return {
    summary,
    isFailed,
    text: clean.trim(),
    failures: isFailed ? failures : [],
    ...(environment === undefined ? {} : { environment }),
  }
}

export function commandLine(watcher: Watcher, argv: readonly string[] = watcher.argv ?? watcher.baseline ?? []): string {
  return argv.join(' ')
}

/** The command as the agent is told of it, with the sub-project it runs in. */
function command(watcher: Watcher): string {
  return `\`${commandLine(watcher)}\`${watcher.dir === undefined ? '' : ` in \`${watcher.dir}\``}`
}

/** Names the failing tests, the first FAILURE_LIMIT of them, for the agent. */
function failingLine(failures: readonly string[]): string[] {
  if (failures.length === 0) return []
  const named = failures.slice(0, FAILURE_LIMIT).map(name => `\`${name}\``).join(', ')
  const more = failures.length > FAILURE_LIMIT ? `, and ${failures.length - FAILURE_LIMIT} more` : ''
  return [`Failing: ${named}${more}.`]
}

/** Where the full output is, which the agent reads only when the summary is not enough. */
function logLine(log: string | undefined): string[] {
  return log === undefined ? [] : [`Full output: \`${log}\``]
}

/**
 * Tells the agent what its changes broke: the failures that are new since the
 * session started, how many it already had, and where the full output is.
 */
export function failureMessage(watcher: Watcher, report: Report, known: readonly string[], log: string | undefined): string {
  const knownNames = new Set(known)
  const fresh = report.failures.filter(name => !knownNames.has(name))
  const old = report.failures.length - fresh.length
  return [
    `overwatch: ${command(watcher)} failed after the latest change: ${report.summary}`,
    ...failingLine(fresh),
    ...(old === 0 ? [] : [`${old} more were already failing when the session started.`]),
    'Fix these new failures before finishing. Tools remain available while you investigate.',
    ...logLine(log),
  ].join('\n')
}

export function recoveryMessage(watcher: Watcher, report: Report): string {
  if (report.isFailed) return `overwatch: ${command(watcher)} is back to the failures it had when the session started. ${report.summary}`
  return `overwatch: ${command(watcher)} is green again. ${report.summary}`
}

/** One watcher's line in the environment summary: the command and why it cannot run. */
export function environmentLine(watcher: Watcher, line: string): string {
  return `- ${command(watcher)}: ${line}`
}

/** Tells the agent, once, which watchers cannot run here, and that its code is not why. */
export function environmentMessage(lines: readonly string[]): string {
  return [
    'overwatch: these checks cannot run in this environment, so they are not reporting. This is not caused by your changes and needs no code change:',
    ...lines,
  ].join('\n')
}

/** Tells the agent the watcher stopped and when it comes back, so it knows a quiet build is not a passing one. */
export function exitMessage(watcher: Watcher, restartsInMs: number): string {
  const when = restartsInMs === 0 ? 'now' : `in ${restartsInMs / 1000}s`
  return `overwatch: ${command(watcher)} exited, so build failures are not reported until it restarts ${when}.`
}

/** Tells the agent the watcher keeps exiting as it starts, and where what it last printed is, so the cause can be fixed. */
export function gaveUpMessage(watcher: Watcher, exits: number, retryMs: number, log: string | undefined): string {
  return [
    `overwatch: ${command(watcher)} stopped ${exits} times in a row within ${retryMs / 1000}s of starting, so overwatch stopped restarting it on its own.`,
    `Build failures are not reported until it runs again; overwatch tries again as turns start, at most every ${retryMs / 1000}s.`,
    ...(log === undefined ? [] : [`What it printed last: \`${log}\``]),
  ].join('\n')
}

/** The decoration each tool puts around its summary, which the status line leaves out. */
const SUMMARY_DECORATION = /^Build Summary:\s*|^zanity:\s*|^=+\s*|\s*=+$|^Test Files\s+|^Test Suites:\s*|^DONE\s+|^(?:ok|FAILED) \| /g

export function statusLine(watcher: Watcher, report: Report): string {
  const mark = report.isFailed ? '✗' : '✓'
  const [first, ...rest] = report.failures
  const failing = first === undefined ? '' : `: ${first}${rest.length > 0 ? ` +${rest.length} more` : ''}`
  return `overwatch ${watcher.name} ${mark} ${report.summary.replace(SUMMARY_DECORATION, '')}${failing}`
}
