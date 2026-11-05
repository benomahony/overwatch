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
  commandLine,
  environmentIn,
  environmentLine,
  environmentMessage,
  exitMessage,
  failureMessage,
  gaveUpMessage,
  hasRegression,
  languageOf,
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
type Slot = {
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
  /** Where VS Code's overwatch writes this watcher's reports, while the slot follows them in place of running the watcher. */
  feed: string | undefined
  /** Whether the slot is being stopped to start again the other way: following a feed that appeared, or running the watcher whose feed went. */
  isSwitching: boolean
  wasFailing: boolean
  /** The first result that was not an environment error: what the project was like when the session found it. */
  baseline: Report | undefined
  /** Whether the agent edited since the watcher was found, so a first result may already hold its changes. */
  isEdited: boolean
  /** What the agent was last told of this watcher, so a failure that repeats is told once. */
  told: string | undefined
  /** This watcher's part of the plugin's one status line. */
  status: string | undefined
}

/** A message for the agent, waiting to go with the others that arrive with it; each slot has at most one of each kind waiting. */
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
  /** Whether the running turn has had its one message from overwatch. */
  isToldThisTurn: boolean
  /** The messages not yet sent, by their slot's key and kind. */
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
  slots: Slot[]
  /** The home directory, read as watchers are found, where VS Code's overwatch keeps its feeds; undefined without one. */
  home: string | undefined
  /** This Claude Code process's pid, which a followed feed's `.claude` file holds for the extension to check; read when first needed. */
  pid: string | undefined
}

/** One watcher running in its slot: what each step of a run needs. */
type Run = { state: State; slot: Slot; watcher: Watcher; cwd: string }

/** Everything needed to decide whether and when a watcher should restart. */
type Restart = { state: State; slot: Slot; watcher: Watcher; ending: Ending }

/** Sets this slot's part of the status line, which shows every running watcher's. */
function setStatus($: EngineInterface, state: State, slot: Slot, text: string | undefined) {
  assert(state.slots.includes(slot), `slot ${slot.key} is not one of the session's; push it to state.slots first`)
  slot.status = text
  const parts = state.slots.flatMap(({ status }) => (status === undefined ? [] : [status]))
  assert(text === undefined || parts.includes(text), `status ${text} for ${slot.key} is missing from the line ${parts}`)
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

/** Holds a message for the agent in place of any of its kind this slot has waiting, unless the agent was already given it, by its `signature`. */
function queue($: EngineInterface, { state, slot }: { state: State; slot: Slot }, signature: string, message: Message) {
  assert(signature !== '', `message for ${slot.key} has signature ${JSON.stringify(signature)}; sign it by what it reports`)
  const key = `${slot.key}:${message.kind}`
  if (slot.told === signature && !state.outbox.has(key)) return
  slot.told = signature
  state.outbox.set(key, message)
  assert(state.outbox.get(key) === message, `the ${message.kind} message for ${slot.key} is not waiting after queueing it`)
  schedule($, state)
}

/** Holds a watcher's environment error for the one summary of them, once for each. */
function queueEnvironment($: EngineInterface, { state, slot, watcher }: Omit<Run, 'cwd'>, line: string) {
  assert(line !== '' && !line.includes('\n'), `environment line ${JSON.stringify(line)} for ${slot.key} must be one line of text`)
  const key = `${slot.key}\n${line}`
  if (state.environment.has(key)) return
  state.environment.add(key)
  state.outbox.set(`${slot.key}:environment`, { text: environmentLine(watcher, line), isWaking: false, kind: 'environment' })
  assert(state.outbox.get(`${slot.key}:environment`)?.isWaking === false, `${slot.key}'s environment error would wake the agent; it never should`)
  schedule($, state)
}

/** Writes a watcher's full output where the agent can read it, keeping it out of the conversation; undefined when it cannot. */
async function writeLog($: EngineInterface, slot: Slot, text: string, suffix = ''): Promise<string | undefined> {
  const home = await $.env.get('HOME').catch(() => undefined)
  if (home === undefined || home === '') return undefined
  const name = slot.key.replace(/[^\w.-]+/g, '-')
  const path = `${home}/.cache/overwatch/logs/${name}${suffix}.log`
  assert(name !== '' && !name.includes('/'), `log name ${name} for ${slot.key} must be one file name`)
  assert(path.startsWith(`${home}/.cache/overwatch/logs/`), `log path ${path} for ${slot.key} is outside the logs directory`)
  return $.fs.write(path, text).then(
    () => path,
    () => undefined,
  )
}

/** Saves inherited issues once, with a compact pointer for deliberate backlog triage. */
async function baselineInventory($: EngineInterface, run: Run, report: Report) {
  if (!report.isFailed) return
  const { state, slot, watcher } = run
  const log = await writeLog($, slot, report.text, '.baseline')
  if (log === undefined) return
  const path = log + '.json'
  const inventory = { checks: [{ name: watcher.name, dir: watcher.dir, command: commandLine(watcher),
    summary: report.summary, failures: report.failures, log }] }
  const saved = await $.fs.write(path, JSON.stringify(inventory)).then(() => true, () => false)
  if (!saved || !slot.isWatching) return
  const detail = report.failures.length > 0 ? report.failures.length + ' named issues' : 'individual issue names unavailable; see full log'
  const text = 'overwatch: inherited backlog (' + detail + '). ' +
    'Inherited findings follow the configured failure policy. Triage inventory: ' + path +
    '. Filter or page it with hooks/triage.py; full output is linked there.'
  assert(path === `${log}.json`, `inventory ${path} is not beside its log ${log}`)
  assert(text.includes(path), `the backlog notice for ${slot.key} does not name its inventory ${path}`)
  state.outbox.set(slot.key + ':baseline', { text, isWaking: false, kind: 'baseline' })
  schedule($, state)
}

/** The baseline of a watcher whose first result came after the agent's edits: every failure counts as new. */
const UNTOUCHED: Report = { summary: 'passed', isFailed: false, text: '', failures: [] }

/** Timings in a summary, which change from run to run of the same failure. */
const TIMING = /\d+(?:\.\d+)?m?s\b/g

/**
 * Tells the agent of a failure its session caused: one the watcher's first
 * result, its baseline, did not already have. An environment error is told
 * once, apart from the code's failures.
 */
async function deliver($: EngineInterface, run: Run, report: Report) {
  const { state, slot, watcher } = run
  assert(slot.watcher === undefined || slot.watcher.marker === watcher.marker, `${watcher.name} reported into slot ${slot.key}, which runs ${slot.watcher?.name}`)
  slot.report = report
  setStatus($, state, slot, statusLine(watcher, report))
  assert(slot.status === statusLine(watcher, report), `${slot.key}'s status was not set to ${watcher.name}'s report`)
  if (report.environment !== undefined) {
    queueEnvironment($, run, report.environment)
    return
  }
  if (slot.baseline === undefined) {
    slot.baseline = slot.isEdited ? UNTOUCHED : report
    if (!slot.isEdited) await baselineInventory($, run, report)
    if (!slot.isWatching) return
  }
  const isRegression = hasRegression(report, slot.baseline)
  const wasFailing = slot.wasFailing
  slot.wasFailing = isRegression
  if (isRegression) {
    const known = slot.baseline.isFailed ? slot.baseline.failures : []
    const knownNames = new Set(known)
    const fresh = report.failures.filter(name => !knownNames.has(name))
    const signature = `failed:${fresh.length > 0 ? [...fresh].sort().join('\n') : report.summary.replace(TIMING, '')}`
    if (slot.told === signature && !state.outbox.has(`${slot.key}:report`)) return
    const text = failureMessage(watcher, report, known, await writeLog($, slot, report.text))
    queue($, run, signature, { text, isWaking: true, kind: 'report' })
    return
  }
  if (!wasFailing) return
  if (state.outbox.delete(`${slot.key}:report`)) {
    slot.told = undefined
    return
  }
  queue($, run, 'recovered', { text: recoveryMessage(watcher, report), isWaking: false, kind: 'report' })
}

/** Runs a command to its end and reports what it printed, unless it was stopped for a newer run first. */
async function runOnce($: EngineInterface, run: Run, argv: readonly string[], isStale = () => false) {
  const { state, slot, watcher, cwd } = run
  assert(argv.length > 0, `${watcher.name} was asked to run an empty command; give it argv or baseline`)
  assert(slot.kill === undefined, `${slot.key} starts ${commandLine(watcher, argv)} while another run is still killable; stop it first`)
  const child = $.process.spawn({ argv, cwd })
  slot.kill = () => child.return({ code: null, signal: null })
  let output = ''
  let code: number | null
  try {
    for await (const { text } of child) output += text
    ;({ code } = await child.result)
  } catch (error) {
    if (isStale()) return
    setStatus($, state, slot, `overwatch ${watcher.name}: could not start ${commandLine(watcher, argv)}`)
    $.ui.log(`overwatch: ${String(error)}`, { to: 'debug' })
    return
  } finally {
    slot.kill = undefined
  }
  if (!slot.isWatching || isStale()) return
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
    if (!run.slot.isWatching) return
    if (isRunning) {
      isPending = true
      await run.slot.kill?.()
      return
    }
    isRunning = true
    isPending = false
    await runOnce($, run, argv, () => isPending)
    assert(run.slot.kill === undefined, `${run.slot.key}'s run ended but is still killable; clear slot.kill when it ends`)
    isRunning = false
    if (isPending) await rerun()
    assert(!isRunning || isPending, `${run.slot.key} is marked running after its last run ended`)
  }
  run.slot.changed = () => {
    timer?.cancel()
    timer = $.clock.after(QUIET_MS, () => void rerun())
  }
  assert(run.slot.changed !== undefined, `${run.slot.key} has no change handler after rerunOnChange`)
}

/** How a watcher ended of itself, its process exited or never started, when, and what it printed after its last report. */
type Ending = { isStarted: boolean; startedAt: number; endedAt: number; output: string }

/** One report VS Code's overwatch read: the output it read it from, and the exit code of a run that ended. */
type FeedEntry = { text: string; code?: number | null }

/** The feed VS Code's overwatch keeps for this slot's watcher, when the extension host that writes it is running. */
async function liveFeed($: EngineInterface, { home }: State, slot: Slot): Promise<string | undefined> {
  assert(slot.key !== '' && slot.dir !== '', `slot ${JSON.stringify(slot.key)} in ${JSON.stringify(slot.dir)} has no key or directory to name its feed by`)
  if (home === undefined || home === '') return undefined
  const feed = `${home}/.cache/overwatch/feeds/${slot.key.replace(/[^\w.-]+/g, '-')}`
  const pid = await $.fs.read(`${feed}.pid`).then(text => text.trim(), () => '')
  if (!/^\d+$/.test(pid)) return undefined
  try {
    const check = $.process.spawn({ argv: ['kill', '-0', pid], cwd: slot.dir })
    for await (const _ of check);
    const isLive = (await check.result).code === 0
    assert(feed.startsWith(`${home}/.cache/overwatch/feeds/`), `feed ${feed} for ${slot.key} is outside the feeds directory`)
    return isLive ? feed : undefined
  } catch (error) {
    $.ui.log(`overwatch: could not check VS Code's process ${pid} for ${feed}: ${String(error)}`, { to: 'debug' })
    return undefined
  }
}

/** This Claude Code process's pid: the parent of a shell it starts; empty when no shell would start. */
async function claudePid($: EngineInterface, state: State, cwd: string): Promise<string> {
  assert(cwd !== '', `claudePid was given the directory ${JSON.stringify(cwd)}; pass the slot's directory to start the shell in`)
  if (state.pid !== undefined) return state.pid
  let output = ''
  try {
    const shell = $.process.spawn({ argv: ['sh', '-c', 'echo $PPID'], cwd })
    for await (const { text } of shell) output += text
  } catch (error) {
    $.ui.log(`overwatch: could not read Claude Code's pid from a shell in ${cwd}: ${String(error)}`, { to: 'debug' })
  }
  state.pid = output.trim()
  assert(/^\d*$/.test(state.pid), `the shell printed ${JSON.stringify(state.pid)} for Claude Code's pid, not a number`)
  return state.pid
}

/** Delivers a report VS Code's overwatch read, reading it again as this watcher would have. */
async function deliverEntry($: EngineInterface, run: Run, entry: FeedEntry) {
  const { slot, watcher } = run
  assert(typeof entry.text === 'string', `a feed entry for ${slot.key} holds ${JSON.stringify(entry)}, with no text to read`)
  const report = readReport(watcher, entry.text, entry.code ?? undefined)
  if (report === undefined) return
  await deliver($, run, report)
  const kept = slot.report
  assert(kept === report, `${slot.key} kept ${kept?.summary} after delivering ${report.summary}`)
}

/**
 * Follows the reports VS Code's overwatch writes to `feed` for this watcher,
 * in place of running the watcher a second time: its latest report first, as
 * a run of the full suite would be, then each new one. The agent's edits ask
 * the extension to rerun a watcher that has no watch command. `<feed>.claude`
 * holds this process's pid while it follows, for the extension to show.
 */
async function follow($: EngineInterface, run: Run, feed: string): Promise<Ending | undefined> {
  const { state, slot, watcher, cwd } = run
  assert(slot.feed === feed, `${slot.key} is asked to follow ${feed} while its feed is ${slot.feed}; set slot.feed first`)
  setStatus($, state, slot, `overwatch ${watcher.name}: following VS Code`)
  await $.fs.write(`${feed}.claude`, await claudePid($, state, cwd)).catch(() => undefined)
  slot.changed = () => void $.fs.write(`${feed}.changed`, '').catch(() => undefined)
  const latest = await $.fs.read(`${feed}.json`).then(text => JSON.parse(text) as FeedEntry, () => undefined)
  if (latest !== undefined) await deliverEntry($, run, latest)
  const startedAt = await $.clock.now()
  if (!slot.isWatching) return undefined
  const child = $.process.spawn({ argv: ['tail', '-n', '0', '-F', `${feed}.jsonl`], cwd })
  slot.kill = () => child.return({ code: null, signal: null })
  let pending = ''
  try {
    for await (const { stream, text } of child) {
      if (stream !== 'stdout') continue
      const lines = (pending + text).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '' || !slot.isWatching) continue
        await deliverEntry($, run, JSON.parse(line) as FeedEntry)
      }
    }
  } catch (error) {
    $.ui.log(`overwatch: ${String(error)}`, { to: 'debug' })
  } finally {
    slot.kill = undefined
    await $.fs.write(`${feed}.claude`, '').catch(() => undefined)
  }
  assert(slot.kill === undefined, `${slot.key} stopped following ${feed} but is still killable`)
  if (!slot.isWatching) return undefined
  return { isStarted: true, startedAt, endedAt: await $.clock.now(), output: '' }
}

/** Follows VS Code's feed for the watcher while the extension runs it, else runs it here; resolves how it ended. */
async function attend($: EngineInterface, run: Run): Promise<Ending | undefined> {
  const { state, slot, watcher } = run
  assert(slot.isWatching, `${slot.key} is asked to watch ${watcher.name} while not watching; set isWatching first`)
  slot.feed = await liveFeed($, state, slot)
  assert(slot.feed === undefined || slot.feed.endsWith(slot.key.replace(/[^\w.-]+/g, '-')), `${slot.key} follows feed ${slot.feed}, named for another slot`)
  return slot.feed === undefined ? watch($, run) : follow($, run, slot.feed)
}

/** Watches until the watcher ends of itself, resolving how; a watcher with no command never ends. */
async function watch($: EngineInterface, run: Run): Promise<Ending | undefined> {
  const { state, slot, watcher, cwd } = run
  assert(slot.isWatching, `${slot.key} is asked to watch ${watcher.name} while not watching; set isWatching first`)
  if (watcher.baseline !== undefined && watcher.baseline.length > 0) {
    const text = `overwatch ${watcher.name}: running the full suite with ${commandLine(watcher, watcher.baseline)}`
    setStatus($, state, slot, text)
    await runOnce($, run, watcher.baseline)
    if (!slot.isWatching) return undefined
  }
  if (watcher.argv === undefined) {
    if (watcher.baseline !== undefined) rerunOnChange($, run, watcher.baseline)
    if (slot.isEdited) slot.changed?.()
    return undefined
  }
  const startedAt = await $.clock.now()
  if (!slot.isWatching) return undefined
  const child = $.process.spawn({ argv: watcher.argv, cwd })
  slot.kill = () => child.return({ code: null, signal: null })
  setStatus($, state, slot, `overwatch ${watcher.name}: starting ${commandLine(watcher)}`)
  let output = ''
  let flush: Timer | undefined
  let isStarted = true
  try {
    for await (const { text } of child) {
      output += text
      flush?.cancel()
      flush = $.clock.after(QUIET_MS, () => {
        const report = readReport(watcher, output)
        if (report === undefined) return
        output = ''
        void deliver($, run, report)
      })
    }
    flush?.cancel()
    if (!slot.isWatching) return undefined
  } catch (error) {
    flush?.cancel()
    if (!slot.isWatching) return undefined
    $.ui.log(`overwatch: ${String(error)}`, { to: 'debug' })
    isStarted = false
    output += String(error)
  } finally {
    slot.kill = undefined
  }
  if (!slot.isWatching) return undefined
  const endedAt = await $.clock.now()
  assert(endedAt >= startedAt, `${watcher.name} ended at ${endedAt}, before it started at ${startedAt}; read both from $.clock`)
  if (isStarted) await deliverExit($, run, output)
  return { isStarted, startedAt, endedAt, output }
}

/** Delivers the last report before showing that the watcher exited. */
async function deliverExit($: EngineInterface, run: Run, output: string) {
  assert(run.slot.kill === undefined, `${run.slot.key} exited but is still killable; clear slot.kill when it ends`)
  const report = readReport(run.watcher, output)
  if (report !== undefined) await deliver($, run, report)
  assert(report === undefined || run.slot.report === report, `${run.watcher.name}'s last report was not delivered to ${run.slot.key}`)
  if (run.slot.isWatching) $.ui.toast(`overwatch: ${commandLine(run.watcher)} exited`)
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
  for (const checker of CHECKERS) if (await isOnPath($, checker.marker)) checkers.push(checker)
  const watchers = await findWatchers($, cwd, override)
  assert(checkers.every(checker => CHECKERS.includes(checker)), `checkers ${checkers.map(({ name }) => name)} are not all from CHECKERS`)
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
  const { cwd, epoch } = state
  if (cwd === undefined) return
  if (state.isFinding) {
    state.isFindDue = true
    return
  }
  // A search asked for during one runs once after it; asks come from hooks and exits, so each round answers all so far.
  // A round lasts until its slots are started, since following a feed waits on the extension between them.
  try {
    await findRounds($, state, cwd, epoch)
  } finally {
    state.isFinding = false
  }
  assert(!state.isFinding, `a search of ${cwd} is still marked running after its rounds ended`)
  // A new session that asked for a search while the last one's round finished gets it now.
  if (state.epoch !== epoch && state.isFindDue) state.onWatcherEnded?.()
  assert(state.epoch !== epoch || !state.isFindDue, `a search of ${cwd} was asked for during the last round and not run`)
}

/**
 * Whether a running slot is left as it is this round: it follows the feed it should, or the search's session has
 * ended. One whose feed appeared or went is stopped to start again the other way, now if nothing ran in it.
 */
async function isSettled($: EngineInterface, state: State, found: Slot, epoch: number): Promise<boolean> {
  assert(found.isWatching, `${found.key} is not watching; only a running slot can be settled or switched`)
  const feed = await liveFeed($, state, found)
  if (state.epoch !== epoch) return true
  if (feed !== undefined && feed === found.feed && state.pid !== undefined) void $.fs.write(`${feed}.claude`, state.pid).catch(() => undefined)
  if (feed === found.feed) return true
  found.isSwitching = found.kill !== undefined
  found.isWatching = false
  found.changed = undefined
  await found.kill?.()
  assert(!found.isWatching, `${found.key} still watches after switching from feed ${found.feed} to ${feed}`)
  return found.isSwitching
}

/** Searches until no further search was asked for, starting each watcher found that is not running or waiting out a retry. */
async function findRounds($: EngineInterface, state: State, cwd: string, epoch: number) {
  assert(state.cwd === cwd && state.epoch === epoch, `a search of ${cwd} at epoch ${epoch} began in session ${state.cwd} at epoch ${state.epoch}`)
  do {
    state.isFinding = true
    state.isFindDue = false
    state.finding = findIn($, cwd)
    state.home ??= await $.env.get('HOME').catch(() => undefined)
    const watchers = await state.finding.finally(() => {
      state.finding = undefined
    })
    if (state.epoch !== epoch) return
    const now = await $.clock.now()
    for (const { watcher, dir } of watchers) {
      const key = `${languageOf(watcher)}:${dir}`
      let found = state.slots.find(each => each.key === key)
      if (found === undefined) {
        found = slot(key, dir)
        state.slots.push(found)
      }
      if (found.isWatching && (await isSettled($, state, found, epoch))) continue
      if (state.epoch !== epoch) return
      if (found.isWatching || now < found.retryAt) continue
      found.isWatching = true
      void start($, state, found, watcher)
    }
    assert(watchers.every(({ watcher, dir }) => state.slots.some(each => each.key === `${languageOf(watcher)}:${dir}`)), `a watcher of ${cwd} has no slot`)
  } while (state.isFindDue && state.epoch === epoch)
  assert(state.finding === undefined, `a search of ${cwd} is still in flight after its last round`)
}

async function start($: EngineInterface, state: State, slot: Slot, watcher: Watcher) {
  const { epoch } = state
  assert(state.slots.includes(slot), `slot ${slot.key} is not one of the session's; push it to state.slots first`)
  slot.watcher = watcher
  slot.isWatching = true
  slot.isSwitching = false
  slot.retryAt = 0
  const ending = await attend($, { state, slot, watcher, cwd: slot.dir })
  assert(ending === undefined || ending.endedAt >= ending.startedAt, `${watcher.name} ended at ${ending?.endedAt}, before it started at ${ending?.startedAt}`)
  if (state.epoch !== epoch) return
  if (slot.isSwitching) {
    slot.isSwitching = false
    state.onWatcherEnded?.()
    return
  }
  if (ending === undefined) return
  await restart($, { state, slot, watcher, ending })
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
async function restart($: EngineInterface, { state, slot, watcher, ending }: Restart) {
  const { epoch } = state
  const { isStarted, startedAt, endedAt, output } = ending
  assert(slot.watcher === watcher, `${slot.key} restarts ${watcher.name} but runs ${slot.watcher?.name}`)
  const isQuick = !isStarted || endedAt - startedAt < RETRY_MS
  slot.quickExits = isQuick ? slot.quickExits + 1 : 0
  slot.isWatching = false
  const what = isStarted ? `${commandLine(watcher)} exited` : `could not start ${commandLine(watcher)}`
  const environment = environmentIn(output)
  if (environment !== undefined) queueEnvironment($, { state, slot, watcher }, environment)
  if (slot.quickExits >= GIVE_UP_AFTER) {
    slot.retryAt = endedAt + RETRY_MS
    const status = `${what} ${slot.quickExits} times in a row; retrying at the first turn after ${RETRY_MS / 1000}s`
    setStatus($, state, slot, `overwatch ${watcher.name}: ${status}`)
    if (slot.quickExits === GIVE_UP_AFTER && environment === undefined) {
      const text = gaveUpMessage(watcher, slot.quickExits, RETRY_MS, await writeLog($, slot, output))
      queue($, { state, slot }, `exited:${output}`, { text, isWaking: true, kind: 'exit' })
    }
    return
  }
  const delay = isQuick ? RETRY_MS * 2 ** (slot.quickExits - 1) : 0
  assert(delay < RETRY_MS * 2 ** GIVE_UP_AFTER, `${watcher.name} waits ${delay}ms to restart after ${slot.quickExits} quick exits; it should have given up`)
  slot.retryAt = endedAt + delay
  setStatus($, state, slot, `overwatch ${watcher.name}: ${what}, restarting ${delay === 0 ? 'now' : `in ${delay / 1000}s`}`)
  if (delay === 0) state.onWatcherEnded?.()
  else
    $.clock.after(delay, () => {
      if (state.epoch === epoch) state.onWatcherEnded?.()
    })
  if (environment !== undefined || !state.isTurnRunning) return
  queue($, { state, slot }, `exited:${output}`, { text: exitMessage(watcher, delay), isWaking: false, kind: 'exit' })
}

/** Stops every watcher and forgets what the session found and told, so the next session starts afresh. */
async function stop($: EngineInterface, state: State) {
  state.cwd = undefined
  state.onWatcherEnded = undefined
  state.completionCorrection = undefined
  state.head = undefined
  state.isTurnRunning = false
  state.isPromptQueued = false
  state.isToldThisTurn = false
  state.epoch += 1
  state.flushing?.cancel()
  state.outbox.clear()
  state.environment.clear()
  const slots = state.slots.map(each => {
    each.isWatching = false
    each.retryAt = 0
    each.quickExits = 0
    each.changed = undefined
    each.feed = undefined
    each.isSwitching = false
    each.wasFailing = false
    each.baseline = undefined
    each.isEdited = false
    each.report = undefined
    each.told = undefined
    each.status = undefined
    return each.kill?.()
  })
  await Promise.all([...slots, state.finding])
  assert(state.slots.every(each => !each.isWatching), `slots ${state.slots.filter(each => each.isWatching).map(each => each.key)} still watch after stop`)
  assert(state.outbox.size === 0, `${state.outbox.size} messages wait after stop; the next session must start afresh`)
  $.ui.status(undefined)
}

/** A new slot for the watcher of one language in dir, watching nothing yet. */
const slot = (key: string, dir: string): Slot => {
  assert(key.endsWith(`:${dir}`), `slot key ${key} does not end with its directory ${dir}; key slots by language and dir`)
  const made: Slot = {
    watcher: undefined,
    report: undefined,
    key,
    dir,
    isWatching: false,
    retryAt: 0,
    quickExits: 0,
    kill: undefined,
    changed: undefined,
    feed: undefined,
    isSwitching: false,
    wasFailing: false,
    baseline: undefined,
    isEdited: false,
    told: undefined,
    status: undefined,
  }
  assert(made.key === key && made.dir === dir, `slot for ${key} was made with key ${made.key} and dir ${made.dir}`)
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
  const blocked = state.slots.filter(({ report, baseline, watcher }) => {
    if (report === undefined || baseline === undefined || !report.isFailed || report.environment !== undefined) return false
    if (checks.length > 0 && !checks.includes(watcher?.name ?? '') && !checks.includes(watcher === undefined ? '' : languageOf(watcher))) return false
    return policy.inherited === 'block' || hasRegression(report, baseline)
  })
  if (blocked.length === 0) return undefined
  assert(blocked.every(each => each.report?.isFailed), `slots ${blocked.map(each => each.key)} guard while passing`)
  const summaries = blocked.map(each => `${each.watcher?.name}: ${each.report?.summary}`).join('; ')
  assert(summaries.split('; ').length >= blocked.length, `reason ${summaries} names fewer than ${blocked.length} guarding checks`)
  return `overwatch: this action is guarded while relevant checks fail. ${summaries}. Inspection, edits, and check commands remain available.`
}

/** Completion hooks return text; queue a correction instead of returning a tool-only denial. */
async function completionGuard($: EngineInterface, state: State): Promise<string | undefined> {
  if (!state.slots.some(each => each.report?.isFailed)) {
    state.completionCorrection = undefined
    return undefined
  }
  const reason = guardedFailure(state, await projectPolicy($, state))
  if (reason === undefined) {
    state.completionCorrection = undefined
    return undefined
  }
  if (state.completionCorrection === reason) return undefined
  assert(reason.startsWith('overwatch: '), `completion correction ${reason} does not say it is from overwatch`)
  state.completionCorrection = reason
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
    assert(reason.startsWith('overwatch: ') && state.isPromptQueued, `correction ${reason} is not from overwatch or is not queued; queue it through completionGuard`)
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
  for (const each of state.slots) {
    each.baseline = undefined
    each.isEdited = false
    each.changed?.()
  }
  assert(state.slots.every(each => each.baseline === undefined && !each.isEdited), `a slot kept its baseline after HEAD moved to ${head}; clear each`)
}

/** After a tool runs another correction pass may be useful; an editing tool also reruns each check and may have moved HEAD. */
async function afterTool($: EngineInterface, state: State, tool: string) {
  assert(tool !== '', `a tool call named the tool ${JSON.stringify(tool)}; pass the name of the tool the agent called`)
  state.completionCorrection = undefined
  if (!EDITING_TOOLS.has(tool)) return
  for (const each of state.slots) {
    each.isEdited = true
    each.changed?.()
  }
  await rebaselineOnMove($, state)
  assert(state.completionCorrection === undefined, `a correction ${state.completionCorrection} was kept across ${tool}; clear it so another pass may follow`)
}

/** A session's state before it starts: no directory, slots or messages. */
const initialState = (): State => {
  const state: State = {
    cwd: undefined,
    epoch: 0,
    isTurnRunning: false,
    isPromptQueued: false,
    head: undefined,
    completionCorrection: undefined,
    isToldThisTurn: false,
    outbox: new Map(),
    flushing: undefined,
    environment: new Set(),
    isFinding: false,
    finding: undefined,
    isFindDue: false,
    onWatcherEnded: undefined,
    slots: [],
    home: undefined,
    pid: undefined,
  }
  assert(state.slots.length === 0 && state.outbox.size === 0, `a new session starts with ${state.slots.length} slots and ${state.outbox.size} messages`)
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
    if (state.slots.some(each => each.report?.isFailed)) {
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
