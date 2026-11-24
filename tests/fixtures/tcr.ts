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
/** How long a read that never answers takes, in milliseconds: longer than any test plays. */
const NEVER_MS = 10_000_000
export const INJECTED_MESSAGE = 'a host call threw here'
export const ZIG_GREEN = 'Build Summary: 3/3 steps succeeded; 1/1 tests passed\n'
export const ZIG_RED = 'Build Summary: 2/3 steps succeeded (1 failed); 0/1 tests passed (1 failed)\n'

type Options = { settings?: Record<string, unknown>; initial?: string; withUpstream?: boolean; withZig?: boolean; zigInitial?: string; findDelayMs?: number; reasonDelayMs?: number; silentWatcher?: boolean; judgeDelayMs?: number; withoutChecks?: boolean; withRust?: boolean; mute?: boolean; watcherEndsAfterTicks?: number; branch?: string; commandDelayMs?: number; fingerprintDelayMs?: number; hang?: 'reason' | 'fingerprint' | 'check' | 'baseline' | 'revert'; rawSettings?: unknown; checkWrites?: string[]; env?: Record<string, string>; scaleRead?: { deny: string; names?: string[] }; isPathDelayable?: boolean; prepare?: (workspace: Workspace) => void }

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
  hang: 'reason' | 'fingerprint' | 'check' | 'baseline' | 'revert' | undefined
  next: { files: string[]; fingerprint: string } | undefined
  /** What the editing tool call with this `file_path` changes once its gate opens, and the gate it waits for, which a test opens to end the call. */
  calls: Map<string, { change: { files: string[]; fingerprint: string }; gate: Promise<void> }>
  onRevert: () => void
  /** What happens as the Nth ask of a command begins (`fingerprint#3`), or once it is answered (`revert#1:after`). */
  hooks: Record<string, () => void>
  silent: boolean
  /** How long a read of the project's settings takes, which nothing but the whole judgement's limit bounds. */
  settingsDelayMs: number
  /** How many reads of the settings answer from the moment a test sets it; every read after them never answers. */
  settingsAnswers: number | undefined
  /** How long a read of PATH takes, in a project that set `isPathDelayable`. */
  pathDelayMs: number
  /** How long a write of the plugin's log of a check takes, which nothing but the whole judgement's limit bounds. */
  writeDelayMs: number
  /** Whether the next read of the settings is the only one that takes settingsDelayMs, the reads after it answering at once. */
  isSettingsDelayOnce?: boolean
  /** What the revert fails with, as the checkpoint command prints it with exit code 1; none when it works. */
  revertError: string | undefined
  /** A revert that fails once it began to discard the work: whether the files were reset, and the error, which the command prints with exit code 1 and the ref that holds the work, or as a traceback when `asBug` says a bug made it fail. */
  revertIncomplete: { error: string; resets: boolean; outcome?: 'done' | 'failed' | 'unknown'; asBug?: boolean; asText?: boolean; leaves?: string[] } | undefined
  /** What the fingerprint fails with, as the checkpoint command prints it with exit code 1; none when it works. */
  fingerprintError: string | undefined
  /** A promise the nth ask of a command, as `command#nth`, waits for before it answers, so that a test decides when that answer comes. */
  holds: Record<string, Promise<unknown>>
  /** How many reads of the settings and how many `git status` runs the plugin began, so that a test holds the nth of either as `settings#nth` or `status#nth` in `holds`. */
  reads: { settings: number; status: number }
  /** What the revert says git could not inspect after it, as the checkpoint command answers it; none when it could. */
  revertUnavailable: string | undefined
  /** Fields laid over the answer of a revert that worked, as an engine of another version or a bug would print them; one set to undefined is left out. */
  revertAs: Record<string, unknown> | undefined
  /** What the revert command prints and exits with instead of its answer, from the answer it would give after it did its work: the tree is reverted as it would be, and only what the plugin reads differs. */
  revertPrints: ((answer: Record<string, unknown>) => { code: number; text: string }) | undefined
  /** Where a test makes a call of the host throw: once `isArmed`, each call of the host the plugin makes, and each chunk a process prints, counts as a step, and the step `throwAt` throws `injected`; `steps` names the steps counted. */
  injection: { isArmed: boolean; throwAt: number | undefined; injected: Error; steps: string[] }
  /** The files `.gitignore` ignores: a change of only these leaves the files of the project, and so the fingerprint, as they were, as the engine lists them. */
  ignored: string[]
  /** What the plugin wrote to the host's log. */
  logged: string[]
  /** What the checkpoint command names as the commit it made, instead of a commit id, as an engine of another version or a bug would print it. */
  commitText: string | undefined
  /** The submodules that hold changes: git lists them unless asked to ignore submodules, and a revert leaves them as they are. */
  submodules: string[]
  /** A bug that makes the next look for a file throw, as a defect of the plugin or of the host would, which no failure of the checkpoint command can. */
  existsBug: Error | undefined
  /** The command that dies without printing, and the exit code it dies with, as a Python traceback would end it. */
  crash: { command: string; code: number } | undefined
  /** Whether the saved ref also holds a version that only the index held, in its second parent. */
  staged?: boolean
  /** The checks that hang, which a test sets with `hang`, and were stopped, by name. */
  stopped: string[]
  /** The files the fake's own reset restored, in the order it restored them, whatever a person did to the tree afterwards. */
  operated: string[]
  /** The files of the repository's metadata directory that the plugin reads for itself, by path; the checkpoint command line reads none. */
  files: Map<string, string>
}

/** What the agent's tool call does to the files: it waits for its gate, if a test set one, and then writes what the test said it changes. */
async function applyCall(workspace: Workspace, filePath: string) {
  const call = workspace.calls.get(filePath)
  await call?.gate
  const change = call?.change ?? workspace.next
  const isIgnored = change !== undefined && change.files.length > 0 && change.files.every(name => workspace.ignored.includes(name))
  if (change !== undefined && !isIgnored) {
    workspace.dirty = [...new Set([...workspace.dirty, ...change.files])]
    workspace.fingerprint = change.fingerprint
    if (call === undefined) workspace.next = undefined
  }
  assert(call === undefined || workspace.calls.has(filePath), `the call of ${filePath} that waited for its gate is no longer known`)
  return { result: 'ok' }
}

/** Counts one step of the plugin's calls of the host once a test armed the injection, and throws at the step the test chose. */
function step(workspace: Workspace, name: string) {
  const { injection } = workspace
  if (!injection.isArmed) return
  injection.steps.push(name)
  if (injection.steps.length === injection.throwAt) throw injection.injected
}

type HostHandler = (host: never, event: never) => unknown

/** `handler` as the host runs it, with each call a step of the injection. */
function stepping(workspace: Workspace, name: string, handler: HostHandler): HostHandler {
  return (host, event) => {
    step(workspace, name)
    return handler(host, event)
  }
}

type SpawnHandler = (host: never, event: never) => AsyncGenerator<unknown, unknown>

/** The process hook with each spawn a step of the injection, and each chunk the checkpoint command or git prints one too, so that a throw lands where the plugin reads the answer. */
function steppingSpawn(workspace: Workspace, handler: SpawnHandler) {
  return async function* (host: never, event: never) {
    step(workspace, 'process.spawn')
    const stream = handler(host, event)
    const argv = (event as { argv?: readonly string[] } | undefined)?.argv ?? []
    const isEngineOrGit = argv[1]?.endsWith('checkpoint.py') === true || argv[0] === 'git'
    try {
      let next = await stream.next()
      while (next.done !== true) {
        if (isEngineOrGit) step(workspace, 'process.spawn chunk')
        yield next.value
        next = await stream.next()
      }
      return next.value
    } finally {
      await stream.return(undefined)
    }
  }
}

/** The wait a test sets for a read of the settings, which the next read only takes when it says so. */
async function waitForSettings(workspace: Workspace, clock: ReturnType<typeof mock.clock>) {
  workspace.reads.settings += 1
  await workspace.holds[`settings#${workspace.reads.settings}`]
  if (workspace.settingsAnswers !== undefined) {
    if (workspace.settingsAnswers === 0) await clock.sleep(NEVER_MS)
    workspace.settingsAnswers -= 1
  }
  const delay = workspace.settingsDelayMs
  if (workspace.isSettingsDelayOnce) workspace.settingsDelayMs = 0
  if (delay > 0) await clock.sleep(delay)
  assert(delay >= 0, `a read of the settings was delayed by ${delay}ms`)
}

type Files = { workspace: Workspace; clock: ReturnType<typeof mock.clock>; settings: () => unknown; branch: string | undefined; findDelayMs: number; present: readonly string[] }

/** What the project's files answer: the settings, the metadata the plugin reads, and which paths exist. */
function hostFiles(hosted: (name: string, handler: HostHandler) => void, { workspace, clock, settings, branch, findDelayMs, present }: Files) {
  assert(findDelayMs >= 0, `the search for a check is delayed by ${findDelayMs}ms`)
  hosted('fs.read', (async (_$: unknown, e: { path: string }) => {
    if (e.path.endsWith('/.overwatch.json')) {
      await waitForSettings(workspace, clock)
      return { value: JSON.stringify(settings()) }
    }
    if (workspace.files.has(e.path)) return { value: workspace.files.get(e.path)! }
    return e.path === '/repo/.git/HEAD' && branch !== undefined ? { value: `ref: refs/heads/${branch}\n` } : { deny: 'missing' }
  }) as HostHandler)
  hosted('fs.exists', (async (_$: unknown, e: { path: string }) => {
    const bug = workspace.existsBug
    workspace.existsBug = undefined
    if (bug !== undefined) throw bug
    if (findDelayMs > 0 && e.path === '/usr/bin/zanity') await clock.sleep(findDelayMs)
    return { value: present.includes(e.path) }
  }) as HostHandler)
}

/** A real hook chain whose watcher results and git repository are controlled by the test. */
export function tcrProject(on: On, options: Options = {}) {
  const { settings = { mode: 'tcr' }, initial = CLEAN, withUpstream = false, withZig = false, zigInitial = ZIG_GREEN, findDelayMs = 0, reasonDelayMs = 0, silentWatcher = false, judgeDelayMs = 0, withoutChecks = false, withRust = false, mute = false, watcherEndsAfterTicks = 0, branch, commandDelayMs = 0, fingerprintDelayMs = 0, hang, rawSettings, checkWrites = [], env = {}, scaleRead, isPathDelayable = false, prepare } = options
  assert(initial.startsWith('zanity: '), `initial output ${JSON.stringify(initial)} must be a zanity summary`)
  assert(typeof settings === 'object' && settings !== null, `the project's settings ${JSON.stringify(settings)} must be an object`)
  const session = mock.session(on)
  const clock = mock.clock(on)
  const prompts: string[] = []
  const toasts: string[] = []
  const freshWorkspace = (): Workspace => ({ fingerprint: 'clean', content: 'same', committed: 'clean', dirty: [], refusal: undefined, reasonOverride: undefined, commits: [], reverted: [], asked: [], oneShots: [], started: new Set(), flags: [], saved: [], refused: [], isNewShape: false, rawCheckpoint: undefined, hang, next: undefined, calls: new Map(), onRevert: () => { output = initial }, hooks: {}, silent: mute, settingsDelayMs: 0, pathDelayMs: 0, settingsAnswers: undefined, writeDelayMs: 0, revertError: undefined, revertIncomplete: undefined, fingerprintError: undefined, holds: {}, reads: { settings: 0, status: 0 }, revertUnavailable: undefined, revertAs: undefined, revertPrints: undefined, commitText: undefined, injection: { isArmed: false, throwAt: undefined, injected: new Error(INJECTED_MESSAGE), steps: [] }, logged: [], ignored: [], submodules: [], crash: undefined, existsBug: undefined, operated: [], files: new Map(), stopped: [] })
  const workspace = freshWorkspace()
  prepare?.(workspace)
  let output = initial
  let zigOutput = zigInitial
  let upstreamOutput = 'no upstream to track\n'
  let rustCode = 0
  let current: unknown = rawSettings === undefined ? settings : rawSettings
  const hosted = ((name: string, handler: HostHandler) => on(name as never, stepping(workspace, name, handler) as never)) as (name: string, handler: HostHandler) => void
  on('ui.log', (_$, e) => { workspace.logged.push(String((e as { message?: unknown; text?: unknown }).message ?? (e as { text?: unknown }).text ?? JSON.stringify(e))); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  hosted('ui.toast', ((_$: unknown, e: unknown) => { toasts.push(JSON.stringify(e)); return { value: undefined } }) as HostHandler)
  answerEnvironment(on, { workspace, clock, env, scaleRead, isPathDelayable })
  hosted('fs.write', (async () => {
    if (workspace.writeDelayMs > 0) await clock.sleep(workspace.writeDelayMs)
    return { value: undefined }
  }) as HostHandler)
  hostFiles(hosted, { workspace, clock, settings: () => current, branch, findDelayMs, present: ['/repo/.git', '/repo/.overwatch.json', ...(withoutChecks ? [] : ['/usr/bin/zanity']), ...(withUpstream ? ['/usr/bin/git'] : []), ...(withZig ? ['/repo/build.zig'] : []), ...(withRust ? ['/repo/Cargo.toml'] : [])] })
  on('process.spawn', steppingSpawn(workspace, processes({ workspace, clock, output: () => output, zig: () => zigOutput, upstream: () => upstreamOutput, reportsInitial: initial, reasonDelayMs, silentWatcher, judgeDelayMs, rustCode: () => rustCode, endsAfterTicks: watcherEndsAfterTicks, commandDelayMs, fingerprintDelayMs, checkWrites }) as SpawnHandler))
  answerSessionEvents(on)
  on('tool.call', (_$, e) => applyCall(workspace, String((e as { file_path?: unknown }).file_path)))
  hosted('prompt.submit', ((_$: unknown, e: { text: string }) => { prompts.push(e.text); return { text: e.text } }) as HostHandler)
  return {
    clock,
    prompts,
    toasts,
    workspace,
    appended: () => session.appended().map(row => JSON.stringify(row.message.content)),
    setReport: (report: string) => { output = report },
    setZigReport: (report: string) => { zigOutput = report },
    /** What the upstream check prints from its next tick on. */
    setUpstreamReport: (report: string) => { upstreamOutput = report },
    /** A watcher that was silent starts to report what its check says. */
    unmute: () => { workspace.silent = false },
    setRustCode: (code: number) => { rustCode = code },
    setSettings: (changed: unknown) => { current = changed },
    /** Starts the project's files over as a new session finds them, for a test that plays a scenario again with the same registered hooks. */
    reset: () => { Object.assign(workspace, freshWorkspace()); output = initial; zigOutput = zigInitial; current = rawSettings === undefined ? settings : rawSettings; prepare?.(workspace) },
    /** The agent's next tool call changes these files, leaving the workspace with this fingerprint. */
    willChange: (files: string[], fingerprint: string) => { workspace.next = { files, fingerprint } },
  }
}

type Environment = { workspace: Workspace; clock: Clock; env: Record<string, string>; scaleRead: Options['scaleRead']; isPathDelayable: boolean }

/** What the environment answers: PATH and the variables a test sets, a refusal of the scale or of the names a test lists, and a wait before PATH answers when the project can delay it. */
function answerEnvironment(on: On, { workspace, clock, env, scaleRead, isPathDelayable }: Environment) {
  if (isPathDelayable) {
    on('env.get', async (_$, e) => {
      if (e.name === 'PATH' && workspace.pathDelayMs > 0) await clock.sleep(workspace.pathDelayMs)
      return { value: e.name === 'PATH' ? '/usr/bin' : env[e.name] }
    })
  } else if (scaleRead === undefined) mock.env(on, { PATH: '/usr/bin', ...env })
  else on('env.get', (_$, e) => ((scaleRead.names ?? ['OVERWATCH_TCR_TIMEOUT_SCALE']).includes(e.name) ? { deny: scaleRead.deny } : { value: e.name === 'PATH' ? '/usr/bin' : env[e.name] }))
}

type Processes = { workspace: Workspace; clock: ReturnType<typeof mock.clock>; output: () => string; zig: () => string; upstream: () => string; reportsInitial: string; reasonDelayMs: number; silentWatcher: boolean; judgeDelayMs: number; rustCode: () => number; endsAfterTicks: number; commandDelayMs: number; fingerprintDelayMs: number; checkWrites: string[] }

type Clock = ReturnType<typeof mock.clock>
/** The session and turn events of the project, which answer with what they were given. */
function answerSessionEvents(on: On) {
  assert(typeof on === 'function', 'answerSessionEvents needs the hooks registrar, not ' + typeof on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
}

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
type Watch = { isOneShot: boolean; first: string; current: () => string; isQuiet: () => boolean; judgeDelayMs: number; ticks: number; hangs: boolean; onHungStopped: () => void }

/** A watch command. A run started to judge an edit prints the current result first, after the delay a test sets. */
async function* watchRun(clock: Clock, { isOneShot, first, current, isQuiet, judgeDelayMs, ticks, hangs, onHungStopped }: Watch) {
  assert(ticks > 0, `a watch command that prints ${ticks} times never reports again`)
  try {
    while (hangs && isOneShot) {
      await clock.sleep(HANG_TICK_MS)
      yield chunk('\n')
    }
  } finally {
    if (hangs && isOneShot) onHungStopped()
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

/** The upstream check, which prints that there is nothing to track, then each change of its report and blank lines between. */
async function* upstreamRun(clock: Clock, current: () => string) {
  let printed = current()
  yield chunk(printed)
  for (let tick = 0; tick < EMISSIONS; tick++) {
    await clock.sleep(EMISSION_MS)
    yield chunk(current() === printed ? '\n' : current())
    printed = current()
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
async function* checkpointRun(clock: Clock, workspace: Workspace, argv: readonly string[], delays: { reasonDelayMs: number; commandDelayMs: number; fingerprintDelayMs: number }) {
  const command = argv[2] ?? ''
  const flags = argv.slice(4)
  workspace.asked.push(command)
  workspace.flags.push([...flags])
  const nth = workspace.asked.filter(each => each === command).length
  workspace.hooks[`${command}#${nth}`]?.()
  await workspace.holds[`${command}#${nth}`]
  while (workspace.hang === command) {
    await clock.sleep(HANG_TICK_MS)
    yield chunk('\n')
  }
  if (workspace.crash?.command === command) return exited(workspace.crash.code)
  if (command === 'fingerprint' && delays.fingerprintDelayMs > 0) await clock.sleep(delays.fingerprintDelayMs)
  const { code, answer, raw } = answerTo(workspace, command, flags)
  if (command === 'reason' && delays.reasonDelayMs > 0) await clock.sleep(delays.reasonDelayMs)
  if ((command === 'checkpoint' || command === 'revert') && delays.commandDelayMs > 0) await clock.sleep(delays.commandDelayMs)
  workspace.hooks[`${command}#${nth}:after`]?.()
  if (raw !== '') yield chunk(raw ?? `${JSON.stringify(answer)}\n`)
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
async function* statusRun(workspace: Workspace, argv: readonly string[]) {
  workspace.reads.status += 1
  await workspace.holds[`status#${workspace.reads.status}`]
  const listed = argv.includes('--ignore-submodules=all') ? [] : workspace.submodules.map(name => ` M ${name}\0`)
  const files = workspace.dirty.map(name => (name.includes('\0') ? `${name}\0` : `?? ${name}\0`))
  if (files.length + listed.length > 0) yield chunk([...files, ...listed].join(''))
  assert(workspace.dirty.every(name => name !== ''), `a dirty file has no name: ${workspace.dirty}`)
  return exited(0)
}

/** The processes the plugin starts: the checkpoint command, the upstream check, a test run by exit code, and the watchers. */
function processes({ workspace, clock, output, zig, upstream, reportsInitial, reasonDelayMs, silentWatcher, judgeDelayMs, rustCode, endsAfterTicks, commandDelayMs, fingerprintDelayMs, checkWrites }: Processes) {
  assert(reportsInitial.startsWith('zanity: '), `the watcher starts with ${JSON.stringify(reportsInitial)}, not a zanity summary`)
  assert(workspace.asked.length === 0, `the processes start after the checkpoint command was asked ${workspace.asked}`)
  return async function* ($: unknown, e: { argv: readonly string[] }) {
    if (e.argv[1]?.endsWith('checkpoint.py')) return yield* checkpointRun(clock, workspace, e.argv, { reasonDelayMs, commandDelayMs, fingerprintDelayMs })
    if (e.argv[0] === 'git') return yield* statusRun(workspace, e.argv)
    const name = e.argv[0] ?? ''
    const isOneShot = workspace.started.has(name)
    workspace.started.add(name)
    if (isOneShot) workspace.oneShots.push(name)
    if (isOneShot) writeFiles(workspace, checkWrites)
    if (name === 'cargo') return yield* cargoRun(clock, rustCode(), workspace.hang === 'baseline' && workspace.oneShots.filter(each => each === name).length === 1)
    if (name === 'sh') return yield* upstreamRun(clock, upstream)
    const isZig = name === 'zig'
    const ticks = ticksOf(isZig, isOneShot, endsAfterTicks)
    return yield* watchRun(clock, { isOneShot, first: isZig ? zig() : workspace.silent ? '\n' : reportsInitial, current: isZig ? zig : output, isQuiet: () => !isOneShot && (isZig ? silentWatcher : silentWatcher || workspace.silent), judgeDelayMs, ticks, hangs: workspace.hang === 'check', onHungStopped: () => workspace.stopped.push(name) })
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
  const commit = committed ? (workspace.commitText ?? COMMIT) : null
  assert(committed === (workspace.commits.length > 0 && commit !== null), `a checkpoint of ${committed ? 'files' : 'nothing'} named the commit ${commit}`)
  return { code: 0, answer: workspace.isNewShape ? { commit, refused: [] } : { commit } }
}

type Answered = { code: number; answer: Record<string, unknown>; raw?: string }

/** The revert that fails after it began, as `workspace.revertIncomplete` says: it saves the files unless told not to, resets them or not, and answers with the error and the ref, or as a traceback. */
function incompleteRevert(workspace: Workspace, flags: readonly string[]): Answered {
  const failure = workspace.revertIncomplete
  assert(failure !== undefined, `an incomplete revert was made though the workspace says ${String(failure)} of how it fails`)
  const saved = flags.includes('--no-save-ref') ? null : `refs/overwatch/tcr/${workspace.saved.length + 1}`
  if (saved !== null) workspace.saved.push(saved)
  if (failure.resets) {
    const left = failure.leaves ?? []
    workspace.operated.push(...workspace.dirty.filter(name => !left.includes(name)))
    workspace.reverted.push(workspace.dirty.filter(name => !left.includes(name)))
    workspace.dirty = workspace.dirty.filter(name => left.includes(name))
    workspace.fingerprint = left.length > 0 ? 'left' : workspace.committed
    if (left.length === 0) workspace.onRevert()
  }
  const recovery = saved === null ? '' : `; the discarded work is saved in \`${saved}\`, recover it with \`git checkout ${saved} -- .\``
  assert(saved === null || recovery.includes(saved), `the recovery text ${recovery} leaves out the ref ${saved}`)
  if (failure.asText) return { code: 1, answer: {}, raw: `${failure.error}\n` }
  if (failure.asBug) return { code: 1, answer: {}, raw: `Traceback (most recent call last):\nAssertionError: ${failure.error}${recovery}\n` }
  return { code: 1, answer: { error: `${failure.error}${recovery}`, saved, reset: failure.outcome ?? (failure.resets ? 'done' : 'failed') } }
}

/** What the fake checkpoint command answers to a revert that worked or had nothing to do: the reset is done only when files were restored. */
function revertedAnswer(workspace: Workspace, isReverted: boolean, saved: string | null): Record<string, unknown> {
  assert(isReverted || saved === null, `a revert that restored nothing saved ${saved}`)
  return { reverted: isReverted, saved, ...(isReverted ? { reset: 'done' } : {}), ...(saved !== null && workspace.staged ? { staged: true } : {}), ...(workspace.submodules.length > 0 && isReverted ? { skipped: workspace.submodules } : {}), ...(workspace.revertUnavailable !== undefined ? { unavailable: workspace.revertUnavailable } : {}) }
}

/** What the fake checkpoint command answers to a revert: whether it changed the files, and the ref it saved them in unless told not to. */
function revertAnswer(workspace: Workspace, flags: readonly string[]): Answered {
  if (workspace.revertError !== undefined) return { code: 1, answer: { error: workspace.revertError } }
  assert(flags.every((flag, at) => flag.startsWith('--') || flags[at - 1] === '--expect'), `the revert was given ${flags}, which holds something that is no flag or fingerprint`)
  const expected = flags[flags.indexOf('--expect') + 1]
  if (flags.includes('--expect') && expected !== workspace.fingerprint) return { code: 0, answer: { reverted: false, saved: null, changed: true } }
  if (workspace.revertIncomplete !== undefined) return incompleteRevert(workspace, flags)
  const restored = workspace.dirty
  let saved: string | null = null
  if (restored.length > 0) {
    workspace.reverted.push(restored)
    workspace.operated.push(...restored)
    if (!flags.includes('--no-save-ref')) {
      saved = `refs/overwatch/tcr/${workspace.reverted.length}`
      workspace.saved.push(saved)
    }
    workspace.dirty = []
    workspace.fingerprint = workspace.committed
    workspace.onRevert()
  }
  assert(workspace.dirty.length === 0 && (restored.length === 0 || workspace.fingerprint === workspace.committed), `a revert left ${workspace.dirty} dirty at ${workspace.fingerprint}, not ${workspace.committed}`)
  return { code: 0, answer: { ...revertedAnswer(workspace, restored.length > 0, saved), ...workspace.revertAs } }
}

/** What the fake checkpoint command answers to command, and its exit code. */
function answerTo(workspace: Workspace, command: string, flags: readonly string[]): Answered {
  assert(['reason', 'fingerprint', 'checkpoint', 'revert'].includes(command), `the plugin asked the checkpoint command for ${JSON.stringify(command)}; it knows reason, fingerprint, checkpoint and revert`)
  if (command === 'reason') return { code: 0, answer: { reason: workspace.reasonOverride !== undefined ? workspace.reasonOverride : workspace.dirty.length > 0 && !flags.includes('--held') ? UNCOMMITTED : null } }
  if (command === 'fingerprint' && workspace.fingerprintError !== undefined) return { code: 1, answer: { error: workspace.fingerprintError } }
  if (command === 'fingerprint') return { code: 0, answer: flags.includes('--content') ? { fingerprint: workspace.fingerprint, content: workspace.content } : { fingerprint: workspace.fingerprint } }
  const answered = command === 'checkpoint' ? checkpointAnswer(workspace, flags) : revertAnswer(workspace, flags)
  if (command === 'revert' && workspace.revertPrints !== undefined) {
    const { code, text } = workspace.revertPrints(answered.answer)
    return { code, answer: {}, raw: text }
  }
  assert(answered.code === 0 || 'error' in answered.answer || answered.raw !== undefined, `${command} failed with ${answered.code} but printed no error`)
  return answered
}
