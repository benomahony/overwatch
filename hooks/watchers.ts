/** A test watcher overwatch can run: the file that marks a project as its kind, the command, and how to read its output. */
export type Watcher = {
  name: string
  /** The file that marks a project as this watcher's kind; for a checker, the executable that must be on PATH. */
  marker: string
  /** The long-running watch command; absent, overwatch reruns `baseline` itself after each change the agent makes. */
  argv?: readonly string[]
  /** Runs the whole suite once before the watcher starts, read the same way; absent or empty, the watcher's first build is the baseline. */
  baseline?: readonly string[]
  /** Matches the line that closes one build's report. */
  summary: RegExp
  /** Tested against the summary line: a match means the build failed. */
  failed: RegExp
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

export const WATCHERS: readonly Watcher[] = [
  {
    name: 'zig',
    marker: 'build.zig',
    argv: ['zig', 'build', '-Doptimize=fast', 'test', '--watch'],
    summary: /^Build Summary:.*$/m,
    failed: /failed/,
  },
  {
    name: 'python',
    marker: 'pyproject.toml',
    argv: ['uv', 'run', '--with', 'pytest', '--with', 'pytest-watcher', '--with', 'pytest-testmon', 'ptw', '.', '--testmon'],
    baseline: ['uv', 'run', '--with', 'pytest', '--with', 'pytest-testmon', 'pytest', '--testmon-noselect'],
    summary: /^=+ .+ in \d+(?:\.\d+)?s(?: \([^)]*\))? =+$/m,
    failed: /\b(?:failed|errors?)\b/,
  },
]

/** Checkers run beside the project's watcher, in any project, whenever their executable is on PATH. */
export const CHECKERS: readonly Watcher[] = [
  {
    name: 'zanity',
    marker: 'zanity',
    argv: ['zanity', 'check', '.', '--watch', '--no-color'],
    summary: /^zanity: (?:\d+ errors?(?:,| and) \d+ warnings? in .*|checked .*, no issues found\.?)$/m,
    failed: /\b[1-9]\d* (?:errors?|warnings?)\b/,
  },
]

export const REPORT_LIMIT = 8000

export function applyOverride(watcher: Watcher, override: Override): Watcher {
  return {
    ...watcher,
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
  return applyOverride({ name: 'project', marker: OVERRIDE_PATH, summary: /$^/, failed: /$^/ }, override)
}

export type Report = { summary: string; isFailed: boolean; text: string }

/** Reads one build's output; undefined until the summary line has arrived. */
export function readReport(watcher: Watcher, output: string): Report | undefined {
  const summary = watcher.summary.exec(output)?.[0]?.trim()
  if (summary === undefined) return undefined
  const text = output.trim()
  return {
    summary,
    isFailed: watcher.failed.test(summary),
    text: text.length > REPORT_LIMIT ? `${text.slice(0, REPORT_LIMIT)}\n… ${text.length - REPORT_LIMIT} more characters cut` : text,
  }
}

export function commandLine(watcher: Watcher, argv: readonly string[] = watcher.argv ?? watcher.baseline ?? []): string {
  return argv.join(' ')
}

export function failureMessage(watcher: Watcher, report: Report): string {
  return [
    `overwatch: \`${commandLine(watcher)}\` failed after the latest change.`,
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
  const text = output.trim()
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

export function statusLine(watcher: Watcher, report: Report): string {
  const mark = report.isFailed ? '✗' : '✓'
  return `overwatch ${watcher.name} ${mark} ${report.summary.replace(/^Build Summary:\s*|^zanity:\s*|^=+\s*|\s*=+$/g, '')}`
}
