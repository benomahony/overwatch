import type { EngineInterface, FsEntry, Register, Timer } from 'claude-code'
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
  /** Whether the running turn has had its one message from overwatch. */
  isToldThisTurn: boolean
  /** The messages not yet sent, by their slot's key and kind. */
  outbox: Map<string, Message>
  flushing: Timer | undefined
  /** Each watcher's environment error the agent has been told of, so each is told once. */
  environment: Set<string>
  /** Whether the project is being searched for watchers, and whether it should be again once that is done. */
  isFinding: boolean
  isFindDue: boolean
  /** One for each watcher found so far, in the order found, which is the status line's order. */
  slots: Slot[]
}

/** One watcher running in its slot: what each step of a run needs. */
type Run = { state: State; slot: Slot; watcher: Watcher; cwd: string }

/** Everything needed to decide whether and when a watcher should restart. */
type Restart = { state: State; slot: Slot; watcher: Watcher; ending: Ending }

/** Sets this slot's part of the status line, which shows every running watcher's. */
function setStatus($: EngineInterface, state: State, slot: Slot, text: string | undefined) {
  slot.status = text
  const parts = state.slots.flatMap(({ status }) => (status === undefined ? [] : [status]))
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
  state.flushing?.cancel()
  state.flushing = $.clock.after(QUIET_MS, () => void send($, state))
}

/** Holds a message for the agent in place of any of its kind this slot has waiting, unless the agent was already given it, by its `signature`. */
function queue($: EngineInterface, { state, slot }: { state: State; slot: Slot }, signature: string, message: Message) {
  const key = `${slot.key}:${message.kind}`
  if (slot.told === signature && !state.outbox.has(key)) return
  slot.told = signature
  state.outbox.set(key, message)
  schedule($, state)
}

/** Holds a watcher's environment error for the one summary of them, once for each. */
function queueEnvironment($: EngineInterface, { state, slot, watcher }: Omit<Run, 'cwd'>, line: string) {
  const key = `${slot.key}\n${line}`
  if (state.environment.has(key)) return
  state.environment.add(key)
  state.outbox.set(`${slot.key}:environment`, { text: environmentLine(watcher, line), isWaking: false, kind: 'environment' })
  schedule($, state)
}

/** Writes a watcher's full output where the agent can read it, keeping it out of the conversation; undefined when it cannot. */
async function writeLog($: EngineInterface, slot: Slot, text: string, suffix = ''): Promise<string | undefined> {
  const home = await $.env.get('HOME').catch(() => undefined)
  if (home === undefined || home === '') return undefined
  const path = `${home}/.cache/overwatch/logs/${slot.key.replace(/[^\w.-]+/g, '-')}${suffix}.log`
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
    'It is not a Stop blocker; only new failures are guarded. Triage inventory: ' + path +
    '. Filter or page it with hooks/triage.py; full output is linked there.'
  state.outbox.set(slot.key + ':baseline', { text, isWaking: false, kind: 'baseline' })
  schedule($, state)
}

/** Timings in a summary, which change from run to run of the same failure. */
const TIMING = /\d+(?:\.\d+)?m?s\b/g

/**
 * Tells the agent of a failure its session caused: one the watcher's first
 * result, its baseline, did not already have. An environment error is told
 * once, apart from the code's failures.
 */
async function deliver($: EngineInterface, run: Run, report: Report) {
  const { state, slot, watcher } = run
  setStatus($, state, slot, statusLine(watcher, report))
  if (report.environment !== undefined) {
    queueEnvironment($, run, report.environment)
    return
  }
  if (slot.baseline === undefined) {
    slot.baseline = report
    await baselineInventory($, run, report)
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
    isRunning = false
    if (isPending) await rerun()
  }
  run.slot.changed = () => {
    timer?.cancel()
    timer = $.clock.after(QUIET_MS, () => void rerun())
  }
}

/** How a watcher ended of itself, its process exited or never started, when, and what it printed after its last report. */
type Ending = { isStarted: boolean; startedAt: number; endedAt: number; output: string }

/** Watches until the watcher ends of itself, resolving how; a watcher with no command never ends. */
async function watch($: EngineInterface, run: Run): Promise<Ending | undefined> {
  const { state, slot, watcher, cwd } = run
  if (watcher.baseline !== undefined && watcher.baseline.length > 0) {
    const text = `overwatch ${watcher.name}: running the full suite with ${commandLine(watcher, watcher.baseline)}`
    setStatus($, state, slot, text)
    await runOnce($, run, watcher.baseline)
    if (!slot.isWatching) return undefined
  }
  if (watcher.argv === undefined) {
    if (watcher.baseline !== undefined) rerunOnChange($, run, watcher.baseline)
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
  if (isStarted) await deliverExit($, run, output)
  return { isStarted, startedAt, endedAt, output }
}

/** Delivers the last report before showing that the watcher exited. */
async function deliverExit($: EngineInterface, run: Run, output: string) {
  const report = readReport(run.watcher, output)
  if (report !== undefined) await deliver($, run, report)
  if (run.slot.isWatching) $.ui.toast(`overwatch: ${commandLine(run.watcher)} exited`)
}

/** Where `path` lands once its links are followed; the path itself when it cannot be resolved. */
async function realPath($: EngineInterface, path: string): Promise<string> {
  return $.fs
    .stat(path, { resolve: true })
    .then(({ realPath }) => realPath ?? path)
    .catch(() => path)
}

/** The real path of the git repository holding `dir`, the nearest directory with a `.git`; undefined outside one. */
async function repositoryOf($: EngineInterface, dir: string): Promise<string | undefined> {
  let at = (await realPath($, dir)).replace(/\/$/, '')
  while (true) {
    if (await $.fs.exists(`${at}/.git`)) return at === '' ? '/' : at
    if (at === '') return undefined
    at = at.slice(0, at.lastIndexOf('/'))
  }
}

async function readOverride($: EngineInterface, cwd: string): Promise<Override> {
  return $.fs
    .read(`${cwd}/${OVERRIDE_PATH}`)
    .then(text => JSON.parse(text) as Override)
    .catch(() => ({}))
}

/** Whether `marker`, a path, is in `dir`, whose own entries are `names`. */
async function hasMarker($: EngineInterface, dir: string, names: ReadonlySet<string>, marker: string): Promise<boolean> {
  const [first = '', ...rest] = marker.split('/')
  return names.has(first) && (rest.length === 0 || $.fs.exists(`${dir}/${marker}`))
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
  return found
}

/** The first of a language's alternatives whose marker `has` finds and whose tool, if it needs one, is on PATH. */
async function firstPresent($: EngineInterface, alternatives: readonly Watcher[], has: (marker: string) => Promise<boolean>) {
  for (const watcher of alternatives) {
    if (!(await has(watcher.marker))) continue
    if (watcher.requires === undefined || (await isOnPath($, watcher.requires))) return watcher
  }
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
  if (first !== undefined) return [applyOverride(first, override), ...rest]
  const project = overrideWatcher(override)
  return project === undefined ? [] : [project]
}

/** Whether `name` is an executable in a directory on PATH. */
async function isOnPath($: EngineInterface, name: string): Promise<boolean> {
  const path = (await $.env.get('PATH').catch(() => undefined)) ?? ''
  for (const dir of path.split(':')) {
    if (dir !== '' && (await $.fs.exists(`${dir}/${name}`).catch(() => false))) return true
  }
  return false
}

/** Every watcher the project has, read afresh, then each checker installed; none while overwatch is off. */
async function findAll($: EngineInterface, cwd: string): Promise<Watcher[]> {
  const override = await readOverride($, cwd)
  if (override.enabled === false) return []
  const checkers: Watcher[] = []
  for (const checker of CHECKERS) if (await isOnPath($, checker.marker)) checkers.push(checker)
  return [...(await findWatchers($, cwd, override)), ...checkers]
}

/** The watchers of the git repository holding `cwd`, each with the real path it runs in; none outside a repository. */
async function findIn($: EngineInterface, cwd: string): Promise<{ watcher: Watcher; dir: string }[]> {
  const root = await repositoryOf($, cwd)
  if (root === undefined) return []
  const watchers = await findAll($, root)
  return Promise.all(
    watchers.map(async watcher => ({ watcher, dir: await realPath($, watcher.dir === undefined ? root : `${root}/${watcher.dir}`) })),
  )
}

/**
 * Finds the watchers of the git repository the session is in afresh, reading
 * its markers and override, so a
 * project scaffolded mid-session gets its watcher, and starts each that is
 * not running or waiting out a retry. One search runs at a time; asked for
 * during one, another follows it. A watcher that exits is restarted, see `restart`.
 */
async function ensureAll($: EngineInterface, state: State) {
  const { cwd, epoch } = state
  if (cwd === undefined) return
  if (state.isFinding) {
    state.isFindDue = true
    return
  }
  state.isFinding = true
  state.isFindDue = false
  const watchers = await findIn($, cwd).finally(() => {
    state.isFinding = false
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
    if (found.isWatching || now < found.retryAt) continue
    found.isWatching = true
    void start($, state, found, watcher)
  }
  if (state.isFindDue) await ensureAll($, state)
}

async function start($: EngineInterface, state: State, slot: Slot, watcher: Watcher) {
  const { epoch } = state
  slot.isWatching = true
  slot.retryAt = 0
  const ending = await watch($, { state, slot, watcher, cwd: slot.dir })
  if (ending === undefined || state.epoch !== epoch) return
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
  slot.retryAt = endedAt + delay
  setStatus($, state, slot, `overwatch ${watcher.name}: ${what}, restarting ${delay === 0 ? 'now' : `in ${delay / 1000}s`}`)
  if (delay === 0) void ensureAll($, state)
  else
    $.clock.after(delay, () => {
      if (state.epoch === epoch) void ensureAll($, state)
    })
  if (environment !== undefined || !state.isTurnRunning) return
  queue($, { state, slot }, `exited:${output}`, { text: exitMessage(watcher, delay), isWaking: false, kind: 'exit' })
}

/** Stops every watcher and forgets what the session found and told, so the next session starts afresh. */
async function stop($: EngineInterface, state: State) {
  state.cwd = undefined
  state.epoch += 1
  state.flushing?.cancel()
  state.outbox.clear()
  state.environment.clear()
  const slots = state.slots.map(each => {
    each.isWatching = false
    each.changed = undefined
    each.wasFailing = false
    each.baseline = undefined
    each.told = undefined
    each.status = undefined
    return each.kill?.()
  })
  await Promise.all(slots)
  $.ui.status(undefined)
}

const slot = (key: string, dir: string): Slot => ({
  key,
  dir,
  isWatching: false,
  retryAt: 0,
  quickExits: 0,
  kill: undefined,
  changed: undefined,
  wasFailing: false,
  baseline: undefined,
  told: undefined,
  status: undefined,
})

export const register: Register = on => {
  const state: State = {
    cwd: undefined,
    epoch: 0,
    isTurnRunning: false,
    isPromptQueued: false,
    isToldThisTurn: false,
    outbox: new Map(),
    flushing: undefined,
    environment: new Set(),
    isFinding: false,
    isFindDue: false,
    slots: [],
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive) return started
    state.cwd = e.cwd
    void ensureAll($, state)
    return started
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (!EDITING_TOOLS.has(e.tool)) return result
    for (const each of state.slots) each.changed?.()
    return result
  })

  on('turn.start', ($, e, next) => {
    state.isTurnRunning = true
    state.isToldThisTurn = state.isPromptQueued
    state.isPromptQueued = false
    schedule($, state)
    void ensureAll($, state)
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      state.isTurnRunning = false
      schedule($, state)
    }
    void ensureAll($, state)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') return next(e)
    await stop($, state)
    return next(e)
  })
}
