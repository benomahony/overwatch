import type { EngineInterface, FsEntry, Register, Timer } from 'claude-code'
import { assert } from './assert'
import { protectedChecks, type GatePolicy } from './gating'
import {
  CHECKERS,
  LANGUAGES,
  OVERRIDE_PATH,
  SEARCH,
  WATCHERS,
  applyOverride,
  bareSummary,
  commandLine,
  configure,
  environmentIn,
  environmentLine,
  environmentMessage,
  exitMessage,
  failureMessage,
  gaveUpMessage,
  hasRegression,
  languageOf,
  lastBuild,
  overrideWatcher,
  readReport,
  recoveryMessage,
  statusLine,
  type Override,
  type Report,
  type Watcher,
} from './watchers'

const QUIET_MS = 400

/**
 * A watcher that ends within this long of its start counts as a quick exit and
 * waits before it restarts: this long after the first, doubling after each further one.
 */
const RETRY_MS = 30_000

/** After this many quick exits in a row, a watcher is no longer restarted on a timer, only as turns start. */
const GIVE_UP_AFTER = 3

/** Tools whose call may change the project's files; a watcher that is no long-running command reruns after each. */
const EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])

/** One watcher's place beside the others: a language in the project or one of its sub-projects, or a checker such as zanity. */
type LiveWatcher = {
  watcher: Watcher | undefined
  report: Report | undefined
  /** The watcher's language and the real path it runs in, which stay the same while the watcher run there may change. */
  key: string
  dir: string
  isWatching: boolean
  /** When a watcher that ended soon after its start may be started again. */
  retryAt: number
  /** How many times in a row the watcher ended within RETRY_MS of its start. */
  quickExits: number
  kill: (() => Promise<unknown>) | undefined
  changed: (() => void) | undefined
  wasFailing: boolean
  /** The first result that was not an environment error: what the project was like when the session found it. */
  baseline: Report | undefined
  /** Whether the agent edited since the watcher was found, so a first result may already hold its changes. */
  isEdited: boolean
  /** Whether the agent edited since this watcher's previous result; a result without one follows another process's change. */
  isEditedSinceResult: boolean
  /** Whose change the latest result followed; an unchanged result repeated with no edit keeps it. */
  origin: 'session' | 'outside'
  /** What the agent was last told of this watcher, so a failure that repeats is told once. */
  told: string | undefined
  /** This watcher's part of the plugin's one status line. */
  status: string | undefined
}

/** A message for the agent, waiting to go with the others that arrive with it; each live has at most one of each kind waiting. */
type Message = { text: string; isWaking: boolean; kind: 'report' | 'exit' | 'environment' | 'baseline' }

type State = {
  /** The interactive session's directory; undefined before it starts and once it ends. */
  cwd: string | undefined
  /** Bumped when the session ends, so a check still in flight starts nothing. */
  epoch: number
  isTurnRunning: boolean
  isPromptQueued: boolean
  /** The commit the session's baselines belong to; undefined until it is read, and when it cannot be. */
  head: string | undefined
  /** Last completion correction; only useful work or changed findings may request another pass. */
  completionCorrection: string | undefined
  /** Whether the running turn is that correction's own, whose tools do not earn it another copy. */
  isCorrectionTurn: boolean
  /** Whether the agent edited since the last correction was submitted; a guard that changed without one is not submitted again. */
  isEditedSinceCorrection: boolean
  /** Whether the running turn has had its one message from overwatch. */
  isToldThisTurn: boolean
  /** The messages not yet sent, by their live's key and kind. */
  outbox: Map<string, Message>
  flushing: Timer | undefined
  /** Each watcher's environment error the agent has been told of, so each is told once. */
  environment: Set<string>
  /** Whether the project is being searched for watchers, and whether it should be again once that is done. */
  isFinding: boolean
  finding: Promise<{ watcher: Watcher; dir: string }[]> | undefined
  isFindDue: boolean
  /** Asks for a fresh search when a watcher ends: the session's answer to that event, set while it runs. */
  onWatcherEnded: (() => void) | undefined
  /** One for each watcher found so far, in the order found, which is the status line's order. */
  liveWatchers: LiveWatcher[]
}

/** One watcher running in its live: what each step of a run needs. */
type Run = { state: State; live: LiveWatcher; watcher: Watcher; cwd: string }

/** Everything needed to decide whether and when a watcher should restart. */
type Restart = { state: State; live: LiveWatcher; watcher: Watcher; ending: Ending }

/** Sets this live's part of the status line, which shows every running watcher's. */
function setStatus($: EngineInterface, state: State, live: LiveWatcher, text: string | undefined) {
  assert(state.liveWatchers.includes(live), `live ${live.key} is not one of the session's; push it to state.liveWatchers first`)
  live.status = text
  const parts = state.liveWatchers.flatMap(({ status }) => (status === undefined ? [] : [status]))
  assert(text === undefined || parts.includes(text), `status ${text} for ${live.key} is missing from the line ${parts}`)
  $.ui.status(parts.length === 0 ? undefined : parts.join(' · '))
}

/**
 * Gives the agent every waiting message as one: joined to the running turn,
 * at most once a turn, or else as a new turn when one of them should wake
 * the agent. The rest wait for the next turn.
 */
async function send($: EngineInterface, state: State) {
  const messages = [...state.outbox.values()]
  if (messages.length === 0) return
  const isHeld = state.isTurnRunning ? state.isToldThisTurn : state.isPromptQueued || !messages.some(({ isWaking }) => isWaking)
  if (isHeld) return
  state.outbox.clear()
  const reports = messages.flatMap(({ text, kind }) => (kind === 'environment' ? [] : [text]))
  const environment = messages.flatMap(({ text, kind }) => (kind === 'environment' ? [text] : []))
  const text = [...reports, ...(environment.length === 0 ? [] : [environmentMessage(environment)])].join('\n\n')
  assert(reports.length + environment.length === messages.length, `sent ${reports.length + environment.length} of ${messages.length} waiting messages; send each`)
  assert(text !== '', `${messages.length} waiting messages joined to nothing; each message needs text`)
  if (state.isTurnRunning) {
    state.isToldThisTurn = true
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    return
  }
  state.isPromptQueued = true
  await $.prompt.submit({ text })
}

/** Sends the waiting messages once the reports arriving with them are in. */
function schedule($: EngineInterface, state: State) {
  const previous = state.flushing
  previous?.cancel()
  state.flushing = $.clock.after(QUIET_MS, () => void send($, state))
  assert(state.flushing !== undefined, `the clock gave ${typeof state.flushing} for the flush; $.clock.after must return a timer`)
  assert(state.flushing !== previous, `the flush timer ${typeof previous} was not replaced; schedule a new one each time`)
}

/** Holds a message for the agent in place of any of its kind this live has waiting, unless the agent was already given it, by its `signature`. */
function queue($: EngineInterface, { state, live }: { state: State; live: LiveWatcher }, signature: string, message: Message) {
  assert(signature !== '', `message for ${live.key} has signature ${JSON.stringify(signature)}; sign it by what it reports`)
  const key = `${live.key}:${message.kind}`
  if (live.told === signature && !state.outbox.has(key)) return
  live.told = signature
  state.outbox.set(key, message)
  assert(state.outbox.get(key) === message, `the ${message.kind} message for ${live.key} is not waiting after queueing it`)
  schedule($, state)
}

/** Holds a watcher's environment error for the one summary of them, once for each. */
function queueEnvironment($: EngineInterface, { state, live, watcher }: Omit<Run, 'cwd'>, line: string) {
  assert(line !== '' && !line.includes('\n'), `environment line ${JSON.stringify(line)} for ${live.key} must be one line of text`)
  const key = `${live.key}\n${line}`
  if (state.environment.has(key)) return
  state.environment.add(key)
  state.outbox.set(`${live.key}:environment`, { text: environmentLine(watcher, line), isWaking: false, kind: 'environment' })
  assert(state.outbox.get(`${live.key}:environment`)?.isWaking === false, `${live.key}'s environment error would wake the agent; it never should`)
  schedule($, state)
}

/** Writes a watcher's full output where the agent can read it, keeping it out of the conversation; undefined when it cannot. */
async function writeLog($: EngineInterface, live: LiveWatcher, text: string, suffix = ''): Promise<string | undefined> {
  const home = await $.env.get('HOME').catch(() => undefined)
  if (home === undefined || home === '') return undefined
  const name = live.key.replace(/[^\w.-]+/g, '-')
  const path = `${home}/.cache/overwatch/logs/${name}${suffix}.log`
  assert(name !== '' && !name.includes('/'), `log name ${name} for ${live.key} must be one file name`)
  assert(path.startsWith(`${home}/.cache/overwatch/logs/`), `log path ${path} for ${live.key} is outside the logs directory`)
  return $.fs.write(path, text).then(
    () => path,
    () => undefined,
  )
}

/** Saves inherited issues once, with a compact pointer for deliberate backlog triage. */
async function baselineInventory($: EngineInterface, run: Run, report: Report) {
  if (!report.isFailed) return
  const { state, live, watcher } = run
  const log = await writeLog($, live, report.text, '.baseline')
  if (log === undefined) return
  const path = log + '.json'
  const inventory = { checks: [{ name: watcher.name, dir: watcher.dir, command: commandLine(watcher),
    summary: report.summary, failures: report.failures, log }] }
  const saved = await $.fs.write(path, JSON.stringify(inventory)).then(() => true, () => false)
  if (!saved || !live.isWatching) return
  const detail = report.failures.length > 0 ? report.failures.length + ' named issues' : 'individual issue names unavailable; see full log'
  const text = 'overwatch: inherited backlog (' + detail + '). ' +
    'Inherited findings follow the configured failure policy. Triage inventory: ' + path +
    '. Filter or page it with engine/triage.py; full output is linked there.'
  assert(path === `${log}.json`, `inventory ${path} is not beside its log ${log}`)
  assert(text.includes(path), `the backlog notice for ${live.key} does not name its inventory ${path}`)
  state.outbox.set(live.key + ':baseline', { text, isWaking: false, kind: 'baseline' })
  schedule($, state)
}

/** The baseline of a watcher whose first result came after the agent's edits: every failure counts as new. */
const UNTOUCHED: Report = { summary: 'passed', isFailed: false, text: '', failures: [] }

/** Timings in a summary, which change from run to run of the same failure. */
const TIMING = /\d+(?:\.\d+)?m?s\b/g

/** Whether two results say the same, timings aside: a watcher printing an unchanged result again is no one's change. */
function sameResult(before: Report, after: Report): boolean {
  assert(!before.summary.includes('\n') && !after.summary.includes('\n'), `results ${before.summary} and ${after.summary} have multi-line summaries; compare ones readReport made`)
  const same = before.isFailed === after.isFailed && before.summary.replace(TIMING, '') === after.summary.replace(TIMING, '')
    && before.failures.join('\n') === after.failures.join('\n')
  assert(!same || before.failures.length === after.failures.length, `${before.summary} and ${after.summary} matched with different failures`)
  return same
}

/**
 * Tells the agent of a failure its session caused: one the watcher's first
 * result, its baseline, did not already have. An environment error is told
 * once, apart from the code's failures.
 */
async function deliver($: EngineInterface, run: Run, report: Report) {
  const { state, live, watcher } = run
  assert(live.watcher === undefined || live.watcher.marker === watcher.marker, `${watcher.name} reported into live ${live.key}, which runs ${live.watcher?.name}`)
  const previous = live.report
  live.report = report
  setStatus($, state, live, statusLine(watcher, report))
  assert(live.status === statusLine(watcher, report), `${live.key}'s status was not set to ${watcher.name}'s report`)
  if (report.environment !== undefined) {
    queueEnvironment($, run, report.environment)
    return
  }
  const isRepeat = previous !== undefined && sameResult(previous, report)
  const origin = live.isEditedSinceResult ? 'session' : isRepeat ? live.origin : 'outside'
  live.origin = origin
  live.isEditedSinceResult = false
  if (live.baseline === undefined) {
    live.baseline = live.isEdited ? UNTOUCHED : report
    if (!live.isEdited) await baselineInventory($, run, report)
    if (!live.isWatching) return
  }
  const isRegression = hasRegression(report, live.baseline)
  const wasFailing = live.wasFailing
  live.wasFailing = isRegression
  if (isRegression) {
    await tellRegression($, run, report)
    return
  }
  if (!wasFailing) return
  if (state.outbox.delete(`${live.key}:report`)) {
    live.told = undefined
    return
  }
  queue($, run, 'recovered', { text: recoveryMessage(watcher, report), isWaking: false, kind: 'report' })
}

/**
 * Queues a regression against `baseline` for the agent, unless it was told already. Another process's change is told
 * at the agent's next turn; it never wakes the agent.
 */
async function tellRegression($: EngineInterface, run: Run, report: Report) {
  const { state, live, watcher } = run
  const { baseline, origin } = live
  assert(baseline !== undefined && live.report === report, `${live.key} tells ${report.summary} without a baseline or as a result it does not hold; deliver it first`)
  assert(report.isFailed && hasRegression(report, baseline), `${watcher.name}'s ${report.summary} is no regression on ${baseline.summary}; tell only regressions`)
  const known = baseline.isFailed ? baseline.failures : []
  const knownNames = new Set(known)
  const fresh = report.failures.filter(name => !knownNames.has(name))
  const signature = `failed:${fresh.length > 0 ? [...fresh].sort().join('\n') : report.summary.replace(TIMING, '')}`
  if (live.told === signature && !state.outbox.has(`${live.key}:report`)) return
  const text = failureMessage(watcher, report, { known, log: await writeLog($, live, report.text), origin })
  queue($, run, signature, { text, isWaking: origin === 'session', kind: 'report' })
}

/** The spawn option that sets a watcher's env over overwatch's own; none when it sets none. */
function envOf(watcher: Watcher): { env?: Record<string, string> } {
  assert(watcher.env === undefined || Object.values(watcher.env).every(value => typeof value === 'string'), `${watcher.name}'s env ${JSON.stringify(watcher.env)} holds a value that is not a string; give each variable a string`)
  const option = watcher.env === undefined ? {} : { env: { ...watcher.env } }
  assert(option.env === undefined || Object.keys(option.env).length === Object.keys(watcher.env ?? {}).length, `the env option for ${watcher.name} lost variables of ${JSON.stringify(watcher.env)}; copy each`)
  return option
}

/** Runs a command to its end and reports what it printed, unless it was stopped for a newer run first. */
async function runOnce($: EngineInterface, run: Run, argv: readonly string[], isStale = () => false) {
  const { state, live, watcher, cwd } = run
  assert(argv.length > 0, `${watcher.name} was asked to run an empty command; give it argv or baseline`)
  assert(live.kill === undefined, `${live.key} starts ${commandLine(watcher, argv)} while another run is still killable; stop it first`)
  const child = $.process.spawn({ argv, cwd, ...envOf(watcher) })
  live.kill = () => child.return({ code: null, signal: null })
  let output = ''
  let code: number | null
  try {
    for await (const { text } of child) output += text
    ;({ code } = await child.result)
  } catch (error) {
    if (isStale()) return
    setStatus($, state, live, `${watcher.name}: could not start ${commandLine(watcher, argv)}`)
    $.ui.log(`overwatch: ${String(error)}`, { to: 'debug' })
    return
  } finally {
    live.kill = undefined
  }
  if (!live.isWatching || isStale()) return
  const report = readReport(watcher, output, code)
  if (report === undefined) {
    $.ui.log(`overwatch: ${commandLine(watcher, argv)} gave no summary:\n${output}`, { to: 'debug' })
    return
  }
  await deliver($, run, report)
}

/**
 * Reruns the suite once the agent's edits go quiet, one run at a time. An edit
 * made while it runs stops that run, whose result would already be out of
 * date, and starts another.
 */
function rerunOnChange($: EngineInterface, run: Run, argv: readonly string[]) {
  assert(argv.length > 0, `${run.watcher.name} reruns an empty command; give it a baseline`)
  let timer: Timer | undefined
  let isRunning = false
  let isPending = false
  const rerun = async () => {
    if (!run.live.isWatching) return
    if (isRunning) {
      isPending = true
      await run.live.kill?.()
      return
    }
    isRunning = true
    isPending = false
    await runOnce($, run, argv, () => isPending)
    assert(run.live.kill === undefined, `${run.live.key}'s run ended but is still killable; clear live.kill when it ends`)
    isRunning = false
    if (isPending) await rerun()
    assert(!isRunning || isPending, `${run.live.key} is marked running after its last run ended`)
  }
  run.live.changed = () => {
    timer?.cancel()
    timer = $.clock.after(QUIET_MS, () => void rerun())
  }
  assert(run.live.changed !== undefined, `${run.live.key} has no change handler after rerunOnChange`)
}

/** How a watcher ended of itself, its process exited or never started, when, and what it printed after its last report. */
type Ending = { isStarted: boolean; startedAt: number; endedAt: number; output: string }

/** Watches until the watcher ends of itself, resolving how; a watcher with no command never ends. */
async function watch($: EngineInterface, run: Run): Promise<Ending | undefined> {
  const { state, live, watcher, cwd } = run
  assert(live.isWatching, `${live.key} is asked to watch ${watcher.name} while not watching; set isWatching first`)
  if (watcher.baseline !== undefined && watcher.baseline.length > 0) {
    const text = `${watcher.name}: running the full suite`
    setStatus($, state, live, text)
    await runOnce($, run, watcher.baseline)
    if (!live.isWatching) return undefined
  }
  if (watcher.argv === undefined) {
    if (watcher.baseline !== undefined) rerunOnChange($, run, watcher.baseline)
    if (live.isEdited) live.changed?.()
    return undefined
  }
  const startedAt = await $.clock.now()
  if (!live.isWatching) return undefined
  const child = $.process.spawn({ argv: watcher.argv, cwd, ...envOf(watcher) })
  live.kill = () => child.return({ code: null, signal: null })
  setStatus($, state, live, `${watcher.name}: starting`)
  let output = ''
  let flush: Timer | undefined
  let isStarted = true
  try {
    for await (const { text } of child) {
      output += text
      flush?.cancel()
      flush = $.clock.after(QUIET_MS, () => {
        // A transport chunk can stop in the middle of a summary line.
        const end = output.lastIndexOf('\n') + 1
        const lines = output.slice(0, end)
        const report = readReport(watcher, lines)
        if (report === undefined) return
        output = lastBuild(watcher, lines).remaining + output.slice(end)
        void deliver($, run, report)
      })
    }
    flush?.cancel()
    if (!live.isWatching) return undefined
  } catch (error) {
    flush?.cancel()
    if (!live.isWatching) return undefined
    $.ui.log(`overwatch: ${String(error)}`, { to: 'debug' })
    isStarted = false
    output += String(error)
  } finally {
    live.kill = undefined
  }
  if (!live.isWatching) return undefined
  const endedAt = await $.clock.now()
  assert(endedAt >= startedAt, `${watcher.name} ended at ${endedAt}, before it started at ${startedAt}; read both from $.clock`)
  if (isStarted) await deliverExit($, run, output)
  return { isStarted, startedAt, endedAt, output }
}

/** Delivers the last report before showing that the watcher exited. */
async function deliverExit($: EngineInterface, run: Run, output: string) {
  assert(run.live.kill === undefined, `${run.live.key} exited but is still killable; clear live.kill when it ends`)
  const report = readReport(run.watcher, output)
  if (report !== undefined) await deliver($, run, report)
  assert(report === undefined || run.live.report === report, `${run.watcher.name}'s last report was not delivered to ${run.live.key}`)
  if (run.live.isWatching) $.ui.toast(`overwatch: ${commandLine(run.watcher)} exited`)
}

/** Where `path` lands once its links are followed; the path itself when it cannot be resolved. */
async function realPath($: EngineInterface, path: string): Promise<string> {
  assert(path !== '', `realPath was given ${JSON.stringify(path)}; pass the directory to resolve`)
  const resolved = await $.fs
    .stat(path, { resolve: true })
    .then(({ realPath }) => realPath ?? path)
    .catch(() => path)
  assert(resolved !== '', `${path} resolved to an empty path; fall back to the path itself`)
  return resolved
}

/** The real path of the git repository holding `dir`, the nearest directory with a `.git`; undefined outside one. */
async function repositoryOf($: EngineInterface, dir: string): Promise<string | undefined> {
  let at = (await realPath($, dir)).replace(/\/$/, '')
  // Each step drops the last part of the path, so this ends by the root at most.
  while (!(await $.fs.exists(`${at}/.git`))) {
    if (at === '') return undefined
    const parent = at.slice(0, at.lastIndexOf('/'))
    assert(parent.length < at.length, `the parent of ${at} is ${parent}; each step must climb one directory`)
    at = parent
  }
  const root = at === '' ? '/' : at
  assert(root.startsWith('/') || !dir.startsWith('/'), `repository ${root} of ${dir} is not an absolute path`)
  return root
}

/** A commit id as git writes it in .git: forty hex digits, or sixty-four in a SHA-256 repository. */
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * The commit checked out in the repository at root, read from its .git directory: HEAD itself when detached, else
 * the branch it names, loose or packed. Undefined when none can be read, as in a worktree whose .git is a file.
 */
async function commitOf($: EngineInterface, root: string): Promise<string | undefined> {
  assert(root.startsWith('/'), `commitOf was given ${root}; pass the repository's absolute path`)
  const read = async (name: string) => {
    assert(name !== '' && !name.startsWith('/'), `commitOf read ${JSON.stringify(name)}; name a file inside .git`)
    const text = await $.fs.read(`${root}/.git/${name}`).then(found => found.trim(), () => '')
    assert(text === text.trim(), `${name} read as ${JSON.stringify(text)}, untrimmed; trim what .git holds`)
    return text
  }
  const head = await read('HEAD')
  const ref = /^ref: (\S+)$/.exec(head)?.[1]
  if (ref === undefined) return COMMIT.test(head) ? head : undefined
  const loose = await read(ref)
  const packed = loose === '' ? await read('packed-refs') : ''
  const commit = loose || (packed.split('\n').find(line => line.endsWith(` ${ref}`))?.split(' ')[0] ?? '')
  assert(loose === '' || commit === loose, `${ref} reads ${loose} but resolved to ${commit}; prefer the loose ref`)
  return COMMIT.test(commit) ? commit : undefined
}

/** The project's .overwatch.json in cwd, or no override when it has none or it is not JSON. */
async function readOverride($: EngineInterface, cwd: string): Promise<Override> {
  assert(cwd !== '' && !cwd.endsWith(`/${OVERRIDE_PATH}`), `readOverride was given ${cwd}; pass the project's directory`)
  const override: Override = await $.fs
    .read(`${cwd}/${OVERRIDE_PATH}`)
    .then(text => JSON.parse(text) as Override)
    .catch(() => ({}))
  assert(override !== null && typeof override === 'object', `${cwd}/${OVERRIDE_PATH} holds ${JSON.stringify(override)}, not an object; make it a JSON object`)
  return override
}

/** Whether `marker`, a path, is in `dir`, whose own entries are `names`. */
async function hasMarker($: EngineInterface, dir: string, names: ReadonlySet<string>, marker: string): Promise<boolean> {
  assert(marker !== '' && !marker.startsWith('/'), `marker ${marker} must be a path relative to ${dir}`)
  const [first = '', ...rest] = marker.split('/')
  const has = names.has(first) && (rest.length === 0 || (await $.fs.exists(`${dir}/${marker}`)))
  assert(!has || names.has(first), `${dir} has marker ${marker} without its first part ${first}`)
  return has
}

/** A directory below the project's root, relative to it, and its entries' names. */
type Subproject = { dir: string; names: ReadonlySet<string> }

/** The directories SEARCH.depth levels down, nearest and then alphabetically first, leaving out hidden and SEARCH.skip ones. */
async function findSubprojects($: EngineInterface, cwd: string): Promise<Subproject[]> {
  const found: Subproject[] = []
  let parents = ['']
  for (let depth = 0; depth < SEARCH.depth && parents.length > 0; depth += 1) {
    const level: string[] = []
    for (const parent of parents) {
      const entries: readonly FsEntry[] = await $.fs.list(parent === '' ? cwd : `${cwd}/${parent}`).catch(() => [])
      for (const { name, kind } of entries) {
        if (kind === 'dir' && !name.startsWith('.') && !SEARCH.skip.has(name)) level.push(parent === '' ? name : `${parent}/${name}`)
      }
    }
    level.sort()
    for (const dir of level) {
      const entries: readonly FsEntry[] = await $.fs.list(`${cwd}/${dir}`).catch(() => [])
      found.push({ dir, names: new Set(entries.map(({ name }) => name)) })
    }
    parents = level
  }
  assert(new Set(found.map(({ dir }) => dir)).size === found.length, `subprojects of ${cwd} repeat a directory; list each parent once`)
  assert(found.every(({ dir }) => dir.split('/').length <= SEARCH.depth), `subprojects of ${cwd} go past ${SEARCH.depth} levels; stop at SEARCH.depth`)
  return found
}

/** The first of a language's alternatives whose marker `has` finds and whose tool, if it needs one, is on PATH. */
async function firstPresent($: EngineInterface, alternatives: readonly Watcher[], has: (marker: string) => Promise<boolean>) {
  assert(new Set(alternatives.map(languageOf)).size <= 1, `alternatives ${alternatives.map(({ name }) => name)} span languages; pass one language's`)
  for (const watcher of alternatives) {
    if (!(await has(watcher.marker))) continue
    if (watcher.requires === undefined || (await isOnPath($, watcher.requires))) return watcher
  }
  assert(alternatives.length > 0 || LANGUAGES.length === 0, `firstPresent was given ${alternatives.length} alternatives of ${LANGUAGES.length} languages; pass a language from LANGUAGES`)
  return undefined
}

/**
 * The project's test watchers, one for each language it has: the first of
 * that language's whose marker, and tool if it needs one, are present. A
 * language the root lacks is looked for in each sub-project, one not inside
 * another that has it. The override applies to the first watcher found; with
 * none, it is the watcher.
 */
async function findWatchers($: EngineInterface, cwd: string, override: Override): Promise<Watcher[]> {
  const found: Watcher[] = []
  let subprojects: Subproject[] | undefined
  for (const language of LANGUAGES) {
    const alternatives = WATCHERS.filter(watcher => languageOf(watcher) === language)
      .flatMap(watcher => configure(watcher, watcher.name, override) ?? [])
    const atRoot = await firstPresent($, alternatives, marker => $.fs.exists(`${cwd}/${marker}`))
    if (atRoot !== undefined) {
      found.push(atRoot)
      continue
    }
    subprojects ??= await findSubprojects($, cwd)
    const claimed: string[] = []
    for (const { dir, names } of subprojects) {
      if (claimed.some(parent => dir.startsWith(`${parent}/`))) continue
      const watcher = await firstPresent($, alternatives, marker => hasMarker($, `${cwd}/${dir}`, names, marker))
      if (watcher === undefined) continue
      claimed.push(dir)
      found.push({ ...watcher, language, name: `${watcher.name} ${dir}`, dir })
    }
  }
  const [first, ...rest] = found
  assert(new Set(found.map(({ name }) => name)).size === found.length, `watchers ${found.map(({ name }) => name)} repeat a name; find each language once per directory`)
  if (first !== undefined) return [applyOverride(first, override), ...rest]
  const project = overrideWatcher(override)
  assert(project === undefined || project.marker === OVERRIDE_PATH, `the override watcher ${project?.name} is not marked by ${OVERRIDE_PATH}`)
  return project === undefined ? [] : [project]
}

/** Whether `name` is an executable in a directory on PATH. */
async function isOnPath($: EngineInterface, name: string): Promise<boolean> {
  assert(name !== '' && !name.includes('/'), `isOnPath was given ${name}; pass an executable's name`)
  const path = (await $.env.get('PATH').catch(() => undefined)) ?? ''
  const dirs = path.split(':').filter(dir => dir !== '')
  for (const dir of dirs) {
    if (await $.fs.exists(`${dir}/${name}`).catch(() => false)) return true
  }
  assert(dirs.every(dir => !dir.includes(':')), `PATH ${path} split into ${dirs}; split it at colons`)
  return false
}

/** Every watcher the project has, read afresh, then each checker installed; none while overwatch is off. */
async function findAll($: EngineInterface, cwd: string): Promise<Watcher[]> {
  const override = await readOverride($, cwd)
  if (override.enabled === false) return []
  const checkers: Watcher[] = []
  for (const checker of CHECKERS) {
    const configured = configure(checker, checker.name, override)
    if (configured !== undefined && (await isOnPath($, checker.marker))) checkers.push(configured)
  }
  const watchers = await findWatchers($, cwd, override)
  assert(checkers.every(checker => CHECKERS.some(({ name }) => name === checker.name)), `checkers ${checkers.map(({ name }) => name)} are not all from CHECKERS`)
  assert(checkers.length <= CHECKERS.length, `found ${checkers.length} of ${CHECKERS.length} checkers; add each once`)
  return [...watchers, ...checkers]
}

/** The watchers of the git repository holding `cwd`, each with the real path it runs in; none outside a repository. */
async function findIn($: EngineInterface, cwd: string): Promise<{ watcher: Watcher; dir: string }[]> {
  const root = await repositoryOf($, cwd)
  if (root === undefined) return []
  const watchers = await findAll($, root)
  const placed = await Promise.all(
    watchers.map(async watcher => ({ watcher, dir: await realPath($, watcher.dir === undefined ? root : `${root}/${watcher.dir}`) })),
  )
  assert(placed.length === watchers.length, `placed ${placed.length} of ${watchers.length} watchers of ${root}`)
  assert(placed.every(({ dir }) => dir !== ''), `a watcher of ${root} has no directory to run in`)
  return placed
}

/**
 * Finds the watchers of the git repository the session is in afresh, reading
 * its markers and override, so a
 * project scaffolded mid-session gets its watcher, and starts each that is
 * not running or waiting out a retry. One search runs at a time; asked for
 * during one, another follows it. A watcher that exits asks for another, see `restart`.
 */
async function ensureAll($: EngineInterface, state: State) {
  if (state.cwd === undefined) return
  if (state.isFinding) {
    state.isFindDue = true
    return
  }
  // A search asked for during one runs once after it; asks come from hooks and exits, so each round answers all so far.
  // The search stays marked running until its watchers have started, so a search asked for meanwhile waits its turn.
  // Each round reads the session afresh, so a search a newer session asked for runs in that session's directory.
  try {
    do {
      const { cwd, epoch } = state
      if (cwd === undefined) break
      state.isFinding = true
      state.isFindDue = false
      state.finding = findIn($, cwd)
      const watchers = await state.finding.finally(() => {
        state.finding = undefined
      })
      if (state.epoch !== epoch) continue
      const now = await $.clock.now()
      for (const { watcher, dir } of watchers) {
        const key = `${languageOf(watcher)}:${dir}`
        let found = state.liveWatchers.find(each => each.key === key)
        if (found === undefined) {
          found = liveWatcher(key, dir)
          state.liveWatchers.push(found)
        }
        if (found.isWatching || now < found.retryAt) continue
        found.isWatching = true
        void start($, state, found, watcher)
      }
      assert(watchers.every(({ watcher, dir }) => state.liveWatchers.some(each => each.key === `${languageOf(watcher)}:${dir}`)), `a watcher of ${cwd} has no live`)
    } while (state.isFindDue)
  } finally {
    state.isFinding = false
  }
  assert(state.finding === undefined, `a search of ${state.cwd} left its finding ${state.finding} behind after it ended`)
}

async function start($: EngineInterface, state: State, live: LiveWatcher, watcher: Watcher) {
  const { epoch } = state
  assert(state.liveWatchers.includes(live), `live ${live.key} is not one of the session's; push it to state.liveWatchers first`)
  live.watcher = watcher
  live.isWatching = true
  live.retryAt = 0
  const ending = await watch($, { state, live, watcher, cwd: live.dir })
  assert(ending === undefined || ending.endedAt >= ending.startedAt, `${watcher.name} ended at ${ending?.endedAt}, before it started at ${ending?.startedAt}`)
  if (ending === undefined || state.epoch !== epoch) return
  await restart($, { state, live, watcher, ending })
}

/**
 * After a watcher ends of itself: one that ran RETRY_MS or longer restarts at
 * once; a quick exit waits RETRY_MS, doubling with each one in a row, until
 * GIVE_UP_AFTER of them, when only a turn starts it again, still RETRY_MS
 * apart. The status line says it is down and the agent is told during a
 * turn, woken only once overwatch gives up, since until then the watcher
 * comes back on its own. One that cannot run in this environment is told of
 * once, in the environment summary, and never wakes the agent.
 */
async function restart($: EngineInterface, { state, live, watcher, ending }: Restart) {
  const { epoch } = state
  const { isStarted, startedAt, endedAt, output } = ending
  assert(live.watcher === watcher, `${live.key} restarts ${watcher.name} but runs ${live.watcher?.name}`)
  const isQuick = !isStarted || endedAt - startedAt < RETRY_MS
  live.quickExits = isQuick ? live.quickExits + 1 : 0
  live.isWatching = false
  const what = isStarted ? `${commandLine(watcher)} exited` : `could not start ${commandLine(watcher)}`
  const environment = environmentIn(output)
  if (environment !== undefined) queueEnvironment($, { state, live, watcher }, environment)
  if (live.quickExits >= GIVE_UP_AFTER) {
    live.retryAt = endedAt + RETRY_MS
    const status = `${what} ${live.quickExits} times in a row; retrying at the first turn after ${RETRY_MS / 1000}s`
    setStatus($, state, live, `${watcher.name}: ${status}`)
    if (live.quickExits === GIVE_UP_AFTER && environment === undefined) {
      const text = gaveUpMessage(watcher, live.quickExits, RETRY_MS, await writeLog($, live, output))
      queue($, { state, live }, `exited:${output}`, { text, isWaking: true, kind: 'exit' })
    }
    return
  }
  const delay = isQuick ? RETRY_MS * 2 ** (live.quickExits - 1) : 0
  assert(delay < RETRY_MS * 2 ** GIVE_UP_AFTER, `${watcher.name} waits ${delay}ms to restart after ${live.quickExits} quick exits; it should have given up`)
  live.retryAt = endedAt + delay
  setStatus($, state, live, `${watcher.name}: ${what}, restarting ${delay === 0 ? 'now' : `in ${delay / 1000}s`}`)
  if (delay === 0) state.onWatcherEnded?.()
  else
    $.clock.after(delay, () => {
      if (state.epoch === epoch) state.onWatcherEnded?.()
    })
  if (environment !== undefined || !state.isTurnRunning) return
  queue($, { state, live }, `exited:${output}`, { text: exitMessage(watcher, delay), isWaking: false, kind: 'exit' })
}

/** Stops every watcher and forgets what the session found and told, so the next session starts afresh. */
async function stop($: EngineInterface, state: State) {
  state.cwd = undefined
  state.onWatcherEnded = undefined
  state.completionCorrection = undefined
  state.isCorrectionTurn = false
  state.isEditedSinceCorrection = false
  state.head = undefined
  state.isTurnRunning = false
  state.isPromptQueued = false
  state.isToldThisTurn = false
  state.epoch += 1
  state.flushing?.cancel()
  state.outbox.clear()
  state.environment.clear()
  const liveWatchers = state.liveWatchers.map(each => {
    each.isWatching = false
    each.retryAt = 0
    each.quickExits = 0
    each.changed = undefined
    each.wasFailing = false
    each.baseline = undefined
    each.isEdited = false
    each.isEditedSinceResult = false
    each.report = undefined
    each.told = undefined
    each.status = undefined
    return each.kill?.()
  })
  await Promise.all([...liveWatchers, state.finding])
  assert(state.liveWatchers.every(each => !each.isWatching), `liveWatchers ${state.liveWatchers.filter(each => each.isWatching).map(each => each.key)} still watch after stop`)
  assert(state.outbox.size === 0, `${state.outbox.size} messages wait after stop; the next session must start afresh`)
  $.ui.status(undefined)
}

/** A new live for the watcher of one language in dir, watching nothing yet. */
const liveWatcher = (key: string, dir: string): LiveWatcher => {
  assert(key.endsWith(`:${dir}`), `live watcher key ${key} does not end with its directory ${dir}; key live watchers by language and dir`)
  const made: LiveWatcher = {
    watcher: undefined,
    report: undefined,
    key,
    dir,
    isWatching: false,
    retryAt: 0,
    quickExits: 0,
    kill: undefined,
    changed: undefined,
    wasFailing: false,
    baseline: undefined,
    isEdited: false,
    isEditedSinceResult: false,
    origin: 'session',
    told: undefined,
    status: undefined,
  }
  assert(made.key === key && made.dir === dir, `live watcher for ${key} was made with key ${made.key} and dir ${made.dir}`)
  return made
}

/** Policy is read afresh, but ordinary tool calls never rerun a check. */
async function projectPolicy($: EngineInterface, state: State): Promise<GatePolicy> {
  if (state.cwd === undefined) return {}
  const root = await repositoryOf($, state.cwd)
  const policy = root === undefined ? {} : (await readOverride($, root)).gate ?? {}
  assert(policy.inherited === undefined || ['allow', 'block'].includes(policy.inherited), `gate.inherited is ${policy.inherited}; set allow or block in ${OVERRIDE_PATH}`)
  assert(policy.protected_actions === undefined || Array.isArray(policy.protected_actions), `gate.protected_actions is ${JSON.stringify(policy.protected_actions)}; make it an array in ${OVERRIDE_PATH}`)
  return policy
}

/** Why an action is refused: the failing checks among checks that guard it, or undefined when none does. */
function guardedFailure(state: State, policy: GatePolicy, checks: readonly string[] = []): string | undefined {
  const blocked = state.liveWatchers.filter(({ report, baseline, watcher }) => {
    if (report === undefined || baseline === undefined || !report.isFailed || report.environment !== undefined) return false
    if (checks.length > 0 && !checks.includes(watcher?.name ?? '') && !checks.includes(watcher === undefined ? '' : languageOf(watcher))) return false
    return policy.inherited === 'block' || hasRegression(report, baseline)
  })
  if (blocked.length === 0) return undefined
  assert(blocked.every(each => each.report?.isFailed), `liveWatchers ${blocked.map(each => each.key)} guard while passing`)
  const summaries = blocked.map(each => `${each.watcher?.name}: ${each.report === undefined ? '' : bareSummary(each.report)}`).join('; ').replace(/\.$/, '')
  assert(summaries.split('; ').length >= blocked.length, `reason ${summaries} names fewer than ${blocked.length} guarding checks`)
  assert(!summaries.endsWith('.'), `reason ${summaries} ends in a full stop the guard text adds again; strip it`)
  return `overwatch: this action is guarded while relevant checks fail. ${summaries}. Inspection, edits, and check commands remain available.`
}

/** Completion hooks return text; queue a correction instead of returning a tool-only denial. */
async function completionGuard($: EngineInterface, state: State): Promise<string | undefined> {
  if (!state.liveWatchers.some(each => each.report?.isFailed)) {
    state.completionCorrection = undefined
    return undefined
  }
  const reason = guardedFailure(state, await projectPolicy($, state))
  if (reason === undefined) {
    state.completionCorrection = undefined
    return undefined
  }
  if (state.completionCorrection === reason) return reason
  if (state.completionCorrection !== undefined && !state.isEditedSinceCorrection) return reason
  assert(reason.startsWith('overwatch: '), `completion correction ${reason} does not say it is from overwatch`)
  state.completionCorrection = reason
  state.isEditedSinceCorrection = false
  state.isTurnRunning = false
  if (!state.isPromptQueued) {
    state.isPromptQueued = true
    await $.prompt.submit({ text: reason })
  }
  assert(state.isPromptQueued, `the correction ${reason} was neither queued nor already waiting`)
  return reason
}

/**
 * Ends the main agent's turn, unless a guarded failure stands: then the turn goes on and this returns the
 * correction for it. A cancelled or unsuccessful turn cannot carry out a correction pass, so it ends.
 */
async function completeTurn($: EngineInterface, state: State, isAnswered: boolean): Promise<string | undefined> {
  if (!isAnswered) {
    state.isTurnRunning = false
    // Hold automatic wakeups until the next turn starts, including queued watcher reports.
    state.isPromptQueued = true
    assert(!state.isTurnRunning && state.isPromptQueued, `an unanswered turn left isTurnRunning ${state.isTurnRunning} and isPromptQueued ${state.isPromptQueued}; end it and hold wakeups`)
    return undefined
  }
  const reason = await completionGuard($, state)
  if (reason !== undefined) {
    assert(reason.startsWith('overwatch: ') && (state.isTurnRunning || state.isPromptQueued), `correction ${reason} neither holds the running turn nor has a queued prompt`)
    return reason
  }
  state.isTurnRunning = false
  schedule($, state)
  assert(!state.isTurnRunning, `the turn still runs after it ended without a correction; set isTurnRunning to false`)
  return undefined
}

/**
 * Notes the commit the session's baselines belong to, and takes fresh ones once it moves under the session, as a
 * pull or checkout brings in failures the agent did not make. Each check reruns, stopping a run still reading the
 * old commit, and its next result is its baseline unless the agent edits first.
 */
async function rebaselineOnMove($: EngineInterface, state: State) {
  const { cwd, epoch } = state
  assert(state.head === undefined || COMMIT.test(state.head), `the session's HEAD ${state.head} is not a commit id; note only what commitOf returns`)
  if (cwd === undefined) return
  const root = await repositoryOf($, cwd)
  const head = root === undefined ? undefined : await commitOf($, root)
  if (state.epoch !== epoch || head === undefined || head === state.head) return
  const isMoved = state.head !== undefined
  state.head = head
  if (!isMoved) return
  for (const each of state.liveWatchers) {
    each.baseline = undefined
    each.isEdited = false
    each.isEditedSinceResult = false
    each.changed?.()
  }
  assert(state.liveWatchers.every(each => each.baseline === undefined && !each.isEdited), `a live watcher kept its baseline after HEAD moved to ${head}; clear each`)
}

/**
 * A tool that ran is work, so the same correction may be told again, except in the correction's own turn, where
 * inspecting it is the answer to it. An editing tool also reruns each check and may have moved HEAD.
 */
async function afterTool($: EngineInterface, state: State, tool: string) {
  assert(tool !== '', `a tool call named the tool ${JSON.stringify(tool)}; pass the name of the tool the agent called`)
  if (!state.isCorrectionTurn) state.completionCorrection = undefined
  assert(!state.isCorrectionTurn || state.completionCorrection !== undefined, `the correction turn lost its correction after ${tool}; keep it while the turn answers it`)
  if (!EDITING_TOOLS.has(tool)) return
  state.isEditedSinceCorrection = true
  for (const each of state.liveWatchers) {
    each.isEdited = true
    each.isEditedSinceResult = true
    each.changed?.()
  }
  await rebaselineOnMove($, state)
  assert(state.liveWatchers.every(each => each.isEdited || each.baseline === undefined), `a live watcher was not marked edited after ${tool}; mark each so its next result is read against the edit`)
}

/** Notes whether a starting turn is overwatch's own correction, submitted with that correction's text. */
function startTurn(state: State, text: string) {
  assert(typeof text === 'string', `a turn started with ${JSON.stringify(text)}, not its prompt text; pass turn.start's text`)
  state.isCorrectionTurn = state.completionCorrection !== undefined && text === state.completionCorrection
  assert(!state.isCorrectionTurn || text.startsWith('overwatch: '), `the turn ${JSON.stringify(text)} was taken for overwatch's correction; only its own text starts one`)
}

/** A session's state before it starts: no directory, liveWatchers or messages. */
const initialState = (): State => {
  const state: State = {
    cwd: undefined,
    epoch: 0,
    isTurnRunning: false,
    isPromptQueued: false,
    head: undefined,
    completionCorrection: undefined,
    isCorrectionTurn: false,
    isEditedSinceCorrection: false,
    isToldThisTurn: false,
    outbox: new Map(),
    flushing: undefined,
    environment: new Set(),
    isFinding: false,
    finding: undefined,
    isFindDue: false,
    onWatcherEnded: undefined,
    liveWatchers: [],
  }
  assert(state.liveWatchers.length === 0 && state.outbox.size === 0, `a new session starts with ${state.liveWatchers.length} liveWatchers and ${state.outbox.size} messages`)
  assert(!state.isTurnRunning && !state.isFinding, 'a new session starts with a turn or search running')
  return state
}

export const register: Register = on => {
  const state = initialState()
  assert(state.cwd === undefined, `overwatch registered with session directory ${state.cwd}; it is set when the session starts`)
  assert(state.epoch === 0, `overwatch registered at epoch ${state.epoch}; start from initialState()`)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive) return started
    state.cwd = e.cwd
    state.onWatcherEnded = () => void ensureAll($, state)
    void ensureAll($, state)
    void rebaselineOnMove($, state)
    return started
  })

  on('tool.call', async ($, e, next) => {
    if (state.liveWatchers.some(each => each.report?.isFailed)) {
      const policy = await projectPolicy($, state)
      const checks = protectedChecks(e.tool, e, policy)
      const reason = checks === undefined ? undefined : guardedFailure(state, policy, checks)
      if (reason !== undefined) return { deny: reason }
    }
    const result = await next(e)
    await afterTool($, state, e.tool)
    return result
  })

  on('turn.start', ($, e, next) => {
    startTurn(state, e.text)
    state.isTurnRunning = true
    state.isToldThisTurn = state.isPromptQueued
    state.isPromptQueued = false
    schedule($, state)
    void ensureAll($, state)
    void rebaselineOnMove($, state)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const isAnswered = !e.isAborted && e.reason === 'answer'
      const reason = await completeTurn($, state, isAnswered)
      if (reason !== undefined) return { text: reason }
      if (!isAnswered) return next(e)
    }
    void ensureAll($, state)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') return next(e)
    await stop($, state)
    if (e.reason === 'resume') {
      state.cwd = await $.session.cwd()
      state.onWatcherEnded = () => void ensureAll($, state)
      $.clock.after(0, () => void ensureAll($, state))
    }
    return next(e)
  })
}
