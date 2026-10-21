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

const table: { watchers: readonly Entry[]; checkers: readonly Entry[] } = TABLE

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

export const REPORT_LIMIT = 8000

/**
 * Cuts a report to about REPORT_LIMIT, at line ends: its first quarter, where
 * the run starts, and the rest from its end, where most tools (cargo, go,
 * pytest) print what failed and why.
 */
export function clip(text: string): string {
  if (text.length <= REPORT_LIMIT) return text
  const head = text.slice(0, text.lastIndexOf('\n', REPORT_LIMIT / 4) + 1 || REPORT_LIMIT / 4)
  const from = text.indexOf('\n', text.length - (REPORT_LIMIT - head.length)) + 1 || text.length - (REPORT_LIMIT - head.length)
  return `${head}… ${from - head.length} characters cut …\n${text.slice(from)}`
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

export type Report = { summary: string; isFailed: boolean; text: string; failures: readonly string[] }

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
  const text = clean.trim()
  return {
    summary,
    isFailed,
    text: clip(text),
    failures: isFailed ? failures : [],
  }
}

export function commandLine(watcher: Watcher, argv: readonly string[] = watcher.argv ?? watcher.baseline ?? []): string {
  return argv.join(' ')
}

/** Names the failing tests, the first FAILURE_LIMIT of them, for the agent. */
function failingLine(failures: readonly string[]): string[] {
  if (failures.length === 0) return []
  const named = failures.slice(0, FAILURE_LIMIT).map(name => `\`${name}\``).join(', ')
  const more = failures.length > FAILURE_LIMIT ? `, and ${failures.length - FAILURE_LIMIT} more` : ''
  return [`Failing: ${named}${more}.`]
}

export function failureMessage(watcher: Watcher, report: Report): string {
  return [
    `overwatch: \`${commandLine(watcher)}\` failed after the latest change.`,
    ...failingLine(report.failures),
    'Fix it before carrying on. If you are midway through a change that touches several files, finish it first; overwatch reports again after every rebuild.',
    '',
    '```',
    report.text,
    '```',
  ].join('\n')
}

export function recoveryMessage(watcher: Watcher, report: Report): string {
  return `overwatch: \`${commandLine(watcher)}\` is green again. ${report.summary}`
}

/** Cuts what a command printed to REPORT_LIMIT, keeping its end, where the reason it stopped is. */
function tail(output: string): string {
  const text = output.replace(ANSI, '').trim()
  return text.length > REPORT_LIMIT ? `… ${text.length - REPORT_LIMIT} earlier characters cut\n${text.slice(-REPORT_LIMIT)}` : text
}

/** Tells the agent the watcher stopped and when it comes back, so it knows a quiet build is not a passing one. */
export function exitMessage(watcher: Watcher, restartsInMs: number): string {
  const when = restartsInMs === 0 ? 'now' : `in ${restartsInMs / 1000}s`
  return `overwatch: \`${commandLine(watcher)}\` exited, so build failures are not reported until it restarts ${when}.`
}

/** Tells the agent the watcher keeps exiting as it starts, with what it last printed, so the cause can be fixed. */
export function gaveUpMessage(watcher: Watcher, exits: number, retryMs: number, output: string): string {
  const text = tail(output)
  return [
    `overwatch: \`${commandLine(watcher)}\` stopped ${exits} times in a row within ${retryMs / 1000}s of starting, so overwatch stopped restarting it on its own.`,
    `Build failures are not reported until it runs again; overwatch tries again as turns start, at most every ${retryMs / 1000}s.`,
    ...(text === '' ? [] : ['', 'What it printed last:', '', '```', text, '```']),
  ].join('\n')
}

/** The decoration each tool puts around its summary, which the status line leaves out. */
const SUMMARY_DECORATION = /^Build Summary:\s*|^zanity:\s*|^=+\s*|\s*=+$|^Test Files\s+|^Test Suites:\s*|^DONE\s+|^(?:ok|FAILED) \| /g

export function statusLine(watcher: Watcher, report: Report): string {
  const mark = report.isFailed ? '✗' : '✓'
  const [first, ...rest] = report.failures
  const failing = first === undefined ? '' : ` — ${first}${rest.length > 0 ? ` +${rest.length} more` : ''}`
  return `overwatch ${watcher.name} ${mark} ${report.summary.replace(SUMMARY_DECORATION, '')}${failing}`
}
