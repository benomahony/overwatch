/** A test watcher overwatch can run: the file that marks a project as its kind, the command, and how to read its output. */
export type Watcher = {
  name: string
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

export function statusLine(watcher: Watcher, report: Report): string {
  const mark = report.isFailed ? '✗' : '✓'
  return `overwatch ${watcher.name} ${mark} ${report.summary.replace(/^Build Summary:\s*|^=+\s*|\s*=+$/g, '')}`
}
