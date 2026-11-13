import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import { assert } from '../../hooks/assert'

export const start = { cwd: '/repo', surface: 'terminal' as const, isInteractive: true }
export const ended = { turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' as const }
export const CLEAN = 'zanity: checked 1 file, no issues found.\n'
export const WARNINGS = 'zanity: 0 errors and 29 warnings in 1 of 1 files\n'
const UNCOMMITTED = 'the working tree has uncommitted changes that a revert would discard'
const COMMIT = 'c'.repeat(40)
const EMISSIONS = 60
const EMISSION_MS = 450
const ZIG_GREEN = 'Build Summary: 3/3 steps succeeded; 1/1 tests passed\n'
export const ZIG_RED = 'Build Summary: 2/3 steps succeeded (1 failed); 0/1 tests passed (1 failed)\n'

type Options = { settings?: Record<string, unknown>; initial?: string; withUpstream?: boolean; withZig?: boolean; reasonDelayMs?: number; silentWatcher?: boolean; judgeDelayMs?: number; withoutChecks?: boolean; withRust?: boolean; mute?: boolean; watcherEndsAfterTicks?: number }

/** What the fake checkpoint command line knows about the repository, and what it was asked to do. */
export type Workspace = {
  fingerprint: string
  committed: string
  dirty: string[]
  refusal: string | undefined
  reasonOverride: string | null | undefined
  commits: string[]
  reverted: string[][]
  asked: string[]
  oneShots: string[]
  started: Set<string>
  next: { files: string[]; fingerprint: string } | undefined
  onRevert: () => void
}

/** A real hook chain whose watcher results and git repository are controlled by the test. */
export function tcrProject(on: On, options: Options = {}) {
  const { settings = { mode: 'tcr' }, initial = CLEAN, withUpstream = false, withZig = false, reasonDelayMs = 0, silentWatcher = false, judgeDelayMs = 0, withoutChecks = false, withRust = false, mute = false, watcherEndsAfterTicks = 0 } = options
  assert(initial.startsWith('zanity: '), `initial output ${JSON.stringify(initial)} must be a zanity summary`)
  assert(typeof settings === 'object' && settings !== null, `the project's settings ${JSON.stringify(settings)} must be an object`)
  const session = mock.session(on)
  const clock = mock.clock(on)
  const prompts: string[] = []
  const toasts: string[] = []
  const workspace: Workspace = { fingerprint: 'clean', committed: 'clean', dirty: [], refusal: undefined, reasonOverride: undefined, commits: [], reverted: [], asked: [], oneShots: [], started: new Set(), next: undefined, onRevert: () => { output = initial } }
  let output = initial
  let zigOutput = ZIG_GREEN
  let rustCode = 0
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => { toasts.push(JSON.stringify(e)); return { value: undefined } })
  mock.env(on, { PATH: '/usr/bin' })
  on('fs.read', ($, e) => (e.path.endsWith('/.overwatch.json') ? { value: JSON.stringify(settings) } : { deny: 'missing' }))
  on('fs.exists', ($, e) => ({ value: ['/repo/.git', ...(withoutChecks ? [] : ['/usr/bin/zanity']), ...(withUpstream ? ['/usr/bin/git'] : []), ...(withZig ? ['/repo/build.zig'] : []), ...(withRust ? ['/repo/Cargo.toml'] : [])].includes(e.path) }))
  on('process.spawn', processes({ workspace, clock, output: () => output, zig: () => zigOutput, reportsInitial: initial, reasonDelayMs, silentWatcher, judgeDelayMs, mute, rustCode: () => rustCode, endsAfterTicks: watcherEndsAfterTicks }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => {
    if (workspace.next !== undefined) {
      workspace.dirty = [...new Set([...workspace.dirty, ...workspace.next.files])]
      workspace.fingerprint = workspace.next.fingerprint
      workspace.next = undefined
    }
    return { result: 'ok' }
  })
  on('prompt.submit', ($, e) => { prompts.push(e.text); return { text: e.text } })
  return {
    clock,
    prompts,
    toasts,
    workspace,
    appended: () => session.appended().map(row => JSON.stringify(row.message.content)),
    setReport: (report: string) => { output = report },
    setZigReport: (report: string) => { zigOutput = report },
    setRustCode: (code: number) => { rustCode = code },
    /** The agent's next tool call changes these files, leaving the workspace with this fingerprint. */
    willChange: (files: string[], fingerprint: string) => { workspace.next = { files, fingerprint } },
  }
}

type Processes = { workspace: Workspace; clock: ReturnType<typeof mock.clock>; output: () => string; zig: () => string; reportsInitial: string; reasonDelayMs: number; silentWatcher: boolean; judgeDelayMs: number; mute: boolean; rustCode: () => number; endsAfterTicks: number }

type Clock = ReturnType<typeof mock.clock>
function chunk(text: string) {
  assert(typeof text === 'string', `a process printed ${typeof text}, not text`)
  assert(!text.includes('\r'), `a process printed ${JSON.stringify(text)} with a carriage return`)
  return { stream: 'stdout' as const, text }
}

function exited(code: number) {
  assert(Number.isInteger(code), `a process exited with ${code}, which is no exit code`)
  assert(code >= 0 && code < 256, `a process exited with ${code}, outside 0 to 255`)
  return { value: { code, signal: null } }
}

/** How many times a watcher prints after its first report: forever, unless a test ends it after `endsAfterTicks`. */
function ticksOf(isZig: boolean, isOneShot: boolean, endsAfterTicks: number): number {
  assert(endsAfterTicks >= 0, `a watcher ends after ${endsAfterTicks} ticks, which is no count`)
  const ticks = !isZig && !isOneShot && endsAfterTicks > 0 ? endsAfterTicks : EMISSIONS
  assert(ticks > 0 && ticks <= EMISSIONS, `a watcher prints ${ticks} times, outside 1 to ${EMISSIONS}`)
  return ticks
}

/** What a watch command prints: its first report, then one every tick, or nothing but blank lines when it is quiet. */
type Watch = { isOneShot: boolean; first: string; current: () => string; isQuiet: boolean; judgeDelayMs: number; ticks: number }

/** A watch command. A run started to judge an edit prints the current result first, after the delay a test sets. */
async function* watchRun(clock: Clock, { isOneShot, first, current, isQuiet, judgeDelayMs, ticks }: Watch) {
  assert(ticks > 0, `a watch command that prints ${ticks} times never reports again`)
  const snapshot = current()
  if (isOneShot && judgeDelayMs > 0) await clock.sleep(judgeDelayMs)
  yield chunk(isOneShot ? snapshot : first)
  for (let tick = 0; tick < ticks; tick++) {
    await clock.sleep(EMISSION_MS)
    yield chunk(isQuiet ? '\n' : current())
  }
  assert(ticks > 0 && EMISSION_MS > 0, `a watch command that printed ${ticks} times every ${EMISSION_MS}ms ended without waiting`)
  return exited(0)
}

/** The upstream check, which prints that there is nothing to track, then blank lines. */
async function* upstreamRun(clock: Clock) {
  yield chunk('no upstream to track\n')
  for (let tick = 0; tick < EMISSIONS; tick++) {
    await clock.sleep(EMISSION_MS)
    yield chunk('\n')
  }
  assert(EMISSIONS > 0 && EMISSION_MS > 0, `the upstream check printed ${EMISSIONS} times every ${EMISSION_MS}ms but ended without waiting`)
  return exited(0)
}

/** A test run that prints once and ends with the exit code a test sets. */
async function* cargoRun(code: number) {
  yield chunk('running tests\n')
  assert(Number.isInteger(code) && code >= 0, `a test run exits with ${code}, not an exit code`)
  return exited(code)
}

/** The checkpoint command: it answers once, after the delay a test sets for the reason. */
async function* checkpointRun(clock: Clock, workspace: Workspace, command: string, reasonDelayMs: number) {
  workspace.asked.push(command)
  const { code, answer } = answerTo(workspace, command)
  if (command === 'reason' && reasonDelayMs > 0) await clock.sleep(reasonDelayMs)
  yield chunk(`${JSON.stringify(answer)}\n`)
  assert(workspace.asked.at(-1) === command, `the command ${command} was not the last one asked`)
  return exited(code)
}

/** The processes the plugin starts: the checkpoint command, the upstream check, a test run by exit code, and the watchers. */
function processes({ workspace, clock, output, zig, reportsInitial, reasonDelayMs, silentWatcher, judgeDelayMs, mute, rustCode, endsAfterTicks }: Processes) {
  assert(reportsInitial.startsWith('zanity: '), `the watcher starts with ${JSON.stringify(reportsInitial)}, not a zanity summary`)
  assert(workspace.asked.length === 0, `the processes start after the checkpoint command was asked ${workspace.asked}`)
  return async function* ($: unknown, e: { argv: readonly string[] }) {
    if (e.argv[1]?.endsWith('checkpoint.py')) return yield* checkpointRun(clock, workspace, e.argv[2] ?? '', reasonDelayMs)
    const name = e.argv[0] ?? ''
    const isOneShot = workspace.started.has(name)
    workspace.started.add(name)
    if (isOneShot) workspace.oneShots.push(name)
    if (name === 'cargo') return yield* cargoRun(rustCode())
    if (name === 'sh') return yield* upstreamRun(clock)
    const isZig = name === 'zig'
    const ticks = ticksOf(isZig, isOneShot, endsAfterTicks)
    return yield* watchRun(clock, { isOneShot, first: isZig ? ZIG_GREEN : mute ? '\n' : reportsInitial, current: isZig ? zig : output, isQuiet: !isOneShot && (isZig ? silentWatcher : silentWatcher || mute), judgeDelayMs, ticks })
  }
}

/** What the fake checkpoint command answers to command, and its exit code. */
function answerTo(workspace: Workspace, command: string): { code: number; answer: Record<string, unknown> } {
  assert(['reason', 'fingerprint', 'checkpoint', 'revert'].includes(command), `the plugin asked the checkpoint command for ${JSON.stringify(command)}; it knows reason, fingerprint, checkpoint and revert`)
  if (command === 'reason') return { code: 0, answer: { reason: workspace.reasonOverride !== undefined ? workspace.reasonOverride : workspace.dirty.length > 0 ? UNCOMMITTED : null } }
  if (command === 'fingerprint') return { code: 0, answer: { fingerprint: workspace.fingerprint } }
  if (command === 'checkpoint') {
    if (workspace.refusal !== undefined) return { code: 1, answer: { error: workspace.refusal } }
    if (workspace.dirty.length === 0) return { code: 0, answer: { commit: null } }
    workspace.commits.push(`tcr: ${workspace.dirty.join(', ')}`)
    workspace.dirty = []
    workspace.committed = workspace.fingerprint
    return { code: 0, answer: { commit: COMMIT } }
  }
  const restored = workspace.dirty
  if (restored.length > 0) {
    workspace.reverted.push(restored)
    workspace.dirty = []
    workspace.fingerprint = workspace.committed
    workspace.onRevert()
  }
  assert(workspace.dirty.length === 0 && (restored.length === 0 || workspace.fingerprint === workspace.committed), `a revert left ${workspace.dirty} dirty at ${workspace.fingerprint}, not ${workspace.committed}`)
  return { code: 0, answer: { restored } }
}
