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
const HANG_TICK_MS = 20
const ZIG_GREEN = 'Build Summary: 3/3 steps succeeded; 1/1 tests passed\n'
export const ZIG_RED = 'Build Summary: 2/3 steps succeeded (1 failed); 0/1 tests passed (1 failed)\n'

type Options = { settings?: Record<string, unknown>; initial?: string; withUpstream?: boolean; withZig?: boolean; reasonDelayMs?: number; silentWatcher?: boolean; judgeDelayMs?: number; withoutChecks?: boolean; withRust?: boolean; mute?: boolean; watcherEndsAfterTicks?: number; branch?: string; commandDelayMs?: number; hang?: 'reason' | 'fingerprint' | 'check' | 'baseline'; checkWrites?: string[]; env?: Record<string, string>; prepare?: (workspace: Workspace) => void }

/** What the fake checkpoint command line knows about the repository, and what it was asked to do. */
export type Workspace = {
  fingerprint: string
  content: string
  committed: string
  dirty: string[]
  refusal: string | undefined
  reasonOverride: string | null | undefined
  commits: string[]
  reverted: string[][]
  asked: string[]
  oneShots: string[]
  started: Set<string>
  flags: string[][]
  saved: string[]
  refused: { path: string; rule: string; line?: number | null }[]
  isNewShape: boolean
  rawCheckpoint: Record<string, unknown> | undefined
  hang: 'reason' | 'fingerprint' | 'check' | 'baseline' | undefined
  next: { files: string[]; fingerprint: string } | undefined
  onRevert: () => void
  /** What happens as the Nth ask of a command begins (`fingerprint#3`), or once it is answered (`revert#1:after`). */
  hooks: Record<string, () => void>
  silent: boolean
  /** How long a read of the project's settings takes, which nothing but the whole judgement's limit bounds. */
  settingsDelayMs: number
  /** What the revert fails with, as the checkpoint command prints it with exit code 1; none when it works. */
  revertError: string | undefined
  /** Whether the saved ref also holds a version that only the index held, in its second parent. */
  staged?: boolean
  /** The files of the repository's metadata directory that the plugin reads for itself, by path; the checkpoint command line reads none. */
  files: Map<string, string>
}

/** A real hook chain whose watcher results and git repository are controlled by the test. */
export function tcrProject(on: On, options: Options = {}) {
  const { settings = { mode: 'tcr' }, initial = CLEAN, withUpstream = false, withZig = false, reasonDelayMs = 0, silentWatcher = false, judgeDelayMs = 0, withoutChecks = false, withRust = false, mute = false, watcherEndsAfterTicks = 0, branch, commandDelayMs = 0, hang, checkWrites = [], env = {}, prepare } = options
  assert(initial.startsWith('zanity: '), `initial output ${JSON.stringify(initial)} must be a zanity summary`)
  assert(typeof settings === 'object' && settings !== null, `the project's settings ${JSON.stringify(settings)} must be an object`)
  const session = mock.session(on)
  const clock = mock.clock(on)
  const prompts: string[] = []
  const toasts: string[] = []
  const workspace: Workspace = { fingerprint: 'clean', content: 'same', committed: 'clean', dirty: [], refusal: undefined, reasonOverride: undefined, commits: [], reverted: [], asked: [], oneShots: [], started: new Set(), flags: [], saved: [], refused: [], isNewShape: false, rawCheckpoint: undefined, hang, next: undefined, onRevert: () => { output = initial }, hooks: {}, silent: mute, settingsDelayMs: 0, revertError: undefined, files: new Map() }
  prepare?.(workspace)
  let output = initial
  let zigOutput = ZIG_GREEN
  let rustCode = 0
  let current = settings
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => { toasts.push(JSON.stringify(e)); return { value: undefined } })
  mock.env(on, { PATH: '/usr/bin', ...env })
  on('fs.read', async ($, e) => {
    if (e.path.endsWith('/.overwatch.json')) {
      if (workspace.settingsDelayMs > 0) await clock.sleep(workspace.settingsDelayMs)
      return { value: JSON.stringify(current) }
    }
    if (workspace.files.has(e.path)) return { value: workspace.files.get(e.path)! }
    return e.path === '/repo/.git/HEAD' && branch !== undefined ? { value: `ref: refs/heads/${branch}\n` } : { deny: 'missing' }
  })
  on('fs.exists', ($, e) => ({ value: ['/repo/.git', ...(withoutChecks ? [] : ['/usr/bin/zanity']), ...(withUpstream ? ['/usr/bin/git'] : []), ...(withZig ? ['/repo/build.zig'] : []), ...(withRust ? ['/repo/Cargo.toml'] : [])].includes(e.path) }))
  on('process.spawn', processes({ workspace, clock, output: () => output, zig: () => zigOutput, reportsInitial: initial, reasonDelayMs, silentWatcher, judgeDelayMs, rustCode: () => rustCode, endsAfterTicks: watcherEndsAfterTicks, commandDelayMs, checkWrites }))
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
    /** A watcher that was silent starts to report what its check says. */
    unmute: () => { workspace.silent = false },
    setRustCode: (code: number) => { rustCode = code },
    setSettings: (changed: Record<string, unknown>) => { current = changed },
    /** The agent's next tool call changes these files, leaving the workspace with this fingerprint. */
    willChange: (files: string[], fingerprint: string) => { workspace.next = { files, fingerprint } },
  }
}

type Processes = { workspace: Workspace; clock: ReturnType<typeof mock.clock>; output: () => string; zig: () => string; reportsInitial: string; reasonDelayMs: number; silentWatcher: boolean; judgeDelayMs: number; rustCode: () => number; endsAfterTicks: number; commandDelayMs: number; checkWrites: string[] }

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
type Watch = { isOneShot: boolean; first: string; current: () => string; isQuiet: () => boolean; judgeDelayMs: number; ticks: number; hangs: boolean }

/** A watch command. A run started to judge an edit prints the current result first, after the delay a test sets. */
async function* watchRun(clock: Clock, { isOneShot, first, current, isQuiet, judgeDelayMs, ticks, hangs }: Watch) {
  assert(ticks > 0, `a watch command that prints ${ticks} times never reports again`)
  while (hangs && isOneShot) {
    await clock.sleep(HANG_TICK_MS)
    yield chunk('\n')
  }
  const snapshot = current()
  if (isOneShot && judgeDelayMs > 0) await clock.sleep(judgeDelayMs)
  yield chunk(isOneShot ? snapshot : first)
  for (let tick = 0; tick < ticks; tick++) {
    await clock.sleep(EMISSION_MS)
    yield chunk(isQuiet() ? '\n' : current())
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
async function* cargoRun(clock: Clock, code: number, hangs: boolean) {
  yield chunk('running tests\n')
  while (hangs) {
    await clock.sleep(HANG_TICK_MS)
    yield chunk('\n')
  }
  assert(Number.isInteger(code) && code >= 0, `a test run exits with ${code}, not an exit code`)
  return exited(code)
}

/** The checkpoint command: it answers once, after the delay a test sets for the reason. */
async function* checkpointRun(clock: Clock, workspace: Workspace, argv: readonly string[], delays: { reasonDelayMs: number; commandDelayMs: number }) {
  const command = argv[2] ?? ''
  const flags = argv.slice(4)
  workspace.asked.push(command)
  workspace.flags.push([...flags])
  const nth = workspace.asked.filter(each => each === command).length
  workspace.hooks[`${command}#${nth}`]?.()
  while (workspace.hang === command) {
    await clock.sleep(HANG_TICK_MS)
    yield chunk('\n')
  }
  const { code, answer } = answerTo(workspace, command, flags)
  if (command === 'reason' && delays.reasonDelayMs > 0) await clock.sleep(delays.reasonDelayMs)
  if ((command === 'checkpoint' || command === 'revert') && delays.commandDelayMs > 0) await clock.sleep(delays.commandDelayMs)
  workspace.hooks[`${command}#${nth}:after`]?.()
  yield chunk(`${JSON.stringify(answer)}\n`)
  assert(workspace.asked.includes(command), `the command ${command} was answered but never recorded as asked`)
  return exited(code)
}

/** The files a check writes while it runs, which the project then lists as changed; none when it writes none or already did. */
function writeFiles(workspace: Workspace, names: readonly string[]) {
  const [first = ''] = names
  if (names.length > 0 && !workspace.dirty.includes(first)) {
    workspace.dirty = [...workspace.dirty, ...names]
    workspace.fingerprint = 'wrote'
  }
  assert(names.every(name => name !== ''), `a check writes a file with no name: ${names}`)
  assert(names.length === 0 || workspace.dirty.includes(first), `the check wrote ${names} but the project does not list ${first}`)
}

/** git status in the repository: the files that differ from the latest commit, as `git status --porcelain -z` lists them. */
async function* statusRun(workspace: Workspace) {
  if (workspace.dirty.length > 0) yield chunk(workspace.dirty.map(name => (name.includes('\0') ? `${name}\0` : `?? ${name}\0`)).join(''))
  assert(workspace.dirty.every(name => name !== ''), `a dirty file has no name: ${workspace.dirty}`)
  return exited(0)
}

/** The processes the plugin starts: the checkpoint command, the upstream check, a test run by exit code, and the watchers. */
function processes({ workspace, clock, output, zig, reportsInitial, reasonDelayMs, silentWatcher, judgeDelayMs, rustCode, endsAfterTicks, commandDelayMs, checkWrites }: Processes) {
  assert(reportsInitial.startsWith('zanity: '), `the watcher starts with ${JSON.stringify(reportsInitial)}, not a zanity summary`)
  assert(workspace.asked.length === 0, `the processes start after the checkpoint command was asked ${workspace.asked}`)
  return async function* ($: unknown, e: { argv: readonly string[] }) {
    if (e.argv[1]?.endsWith('checkpoint.py')) return yield* checkpointRun(clock, workspace, e.argv, { reasonDelayMs, commandDelayMs })
    if (e.argv[0] === 'git') return yield* statusRun(workspace)
    const name = e.argv[0] ?? ''
    const isOneShot = workspace.started.has(name)
    workspace.started.add(name)
    if (isOneShot) workspace.oneShots.push(name)
    if (isOneShot) writeFiles(workspace, checkWrites)
    if (name === 'cargo') return yield* cargoRun(clock, rustCode(), workspace.hang === 'baseline' && workspace.oneShots.filter(each => each === name).length === 1)
    if (name === 'sh') return yield* upstreamRun(clock)
    const isZig = name === 'zig'
    const ticks = ticksOf(isZig, isOneShot, endsAfterTicks)
    return yield* watchRun(clock, { isOneShot, first: isZig ? ZIG_GREEN : workspace.silent ? '\n' : reportsInitial, current: isZig ? zig : output, isQuiet: () => !isOneShot && (isZig ? silentWatcher : silentWatcher || workspace.silent), judgeDelayMs, ticks, hangs: workspace.hang === 'check' })
  }
}

/** What the fake checkpoint command answers to a checkpoint: a commit, a refusal, or, when a test asks, the raw answer it sets. */
function checkpointAnswer(workspace: Workspace, flags: readonly string[]): { code: number; answer: Record<string, unknown> } {
  const expected = flags[flags.indexOf('--expect') + 1]
  if (flags.includes('--expect') && expected !== workspace.fingerprint) return { code: 0, answer: { commit: null, refused: [], changed: true } }
  assert(workspace.refused.every(each => typeof each === 'object'), `a refusal in ${JSON.stringify(workspace.refused)} is no object`)
  if (workspace.refusal !== undefined) return { code: 1, answer: { error: workspace.refusal } }
  if (workspace.rawCheckpoint !== undefined) return { code: 0, answer: workspace.rawCheckpoint }
  if (workspace.refused.length > 0) return { code: 0, answer: { commit: null, refused: workspace.refused } }
  const committed = workspace.dirty.length > 0
  if (committed) {
    workspace.commits.push(`tcr: ${workspace.dirty.join(', ')}`)
    workspace.dirty = []
    workspace.committed = workspace.fingerprint
  }
  const commit = committed ? COMMIT : null
  assert(committed === (workspace.commits.length > 0 && commit !== null), `a checkpoint of ${committed ? 'files' : 'nothing'} named the commit ${commit}`)
  return { code: 0, answer: workspace.isNewShape ? { commit, refused: [] } : { commit } }
}

/** What the fake checkpoint command answers to a revert: whether it changed the files, and the ref it saved them in unless told not to. */
function revertAnswer(workspace: Workspace, flags: readonly string[]): { code: number; answer: Record<string, unknown> } {
  if (workspace.revertError !== undefined) return { code: 1, answer: { error: workspace.revertError } }
  assert(flags.every((flag, at) => flag.startsWith('--') || flags[at - 1] === '--expect'), `the revert was given ${flags}, which holds something that is no flag or fingerprint`)
  const expected = flags[flags.indexOf('--expect') + 1]
  if (flags.includes('--expect') && expected !== workspace.fingerprint) return { code: 0, answer: { reverted: false, saved: null, changed: true } }
  const restored = workspace.dirty
  let saved: string | null = null
  if (restored.length > 0) {
    workspace.reverted.push(restored)
    if (!flags.includes('--no-save-ref')) {
      saved = `refs/overwatch/tcr/${workspace.reverted.length}`
      workspace.saved.push(saved)
    }
    workspace.dirty = []
    workspace.fingerprint = workspace.committed
    workspace.onRevert()
  }
  assert(workspace.dirty.length === 0 && (restored.length === 0 || workspace.fingerprint === workspace.committed), `a revert left ${workspace.dirty} dirty at ${workspace.fingerprint}, not ${workspace.committed}`)
  return { code: 0, answer: { reverted: restored.length > 0, saved, ...(saved !== null && workspace.staged ? { staged: true } : {}) } }
}

/** What the fake checkpoint command answers to command, and its exit code. */
function answerTo(workspace: Workspace, command: string, flags: readonly string[]): { code: number; answer: Record<string, unknown> } {
  assert(['reason', 'fingerprint', 'checkpoint', 'revert'].includes(command), `the plugin asked the checkpoint command for ${JSON.stringify(command)}; it knows reason, fingerprint, checkpoint and revert`)
  if (command === 'reason') return { code: 0, answer: { reason: workspace.reasonOverride !== undefined ? workspace.reasonOverride : workspace.dirty.length > 0 && !flags.includes('--held') ? UNCOMMITTED : null } }
  if (command === 'fingerprint') return { code: 0, answer: flags.includes('--content') ? { fingerprint: workspace.fingerprint, content: workspace.content } : { fingerprint: workspace.fingerprint } }
  const answered = command === 'checkpoint' ? checkpointAnswer(workspace, flags) : revertAnswer(workspace, flags)
  assert(answered.code === 0 || 'error' in answered.answer, `${command} failed with ${answered.code} but printed no error`)
  return answered
}
