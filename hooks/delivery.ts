/**
 * How a session tells the agent what its checks found: the status line, messages queued and sent once each, logs of
 * full output, and the inherited backlog's triage inventory.
 */
import type { EngineInterface } from 'claude-code'
import { assert } from './assert'
import {
  commandLine,
  environmentLine,
  environmentMessage,
  failureMessage,
  hasRegression,
  recoveryMessage,
  statusLine,
  type Report,
} from './watchers'
import type { LiveWatcher, Message, State, Run } from './state'

export const QUIET_MS = 400

/** Sets this live's part of the status line, which shows every running watcher's. */
export function setStatus($: EngineInterface, state: State, live: LiveWatcher, text: string | undefined) {
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
export async function send($: EngineInterface, state: State) {
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
export function schedule($: EngineInterface, state: State) {
  const previous = state.flushing
  previous?.cancel()
  state.flushing = $.clock.after(QUIET_MS, () => void send($, state))
  assert(state.flushing !== undefined, `the clock gave ${typeof state.flushing} for the flush; $.clock.after must return a timer`)
  assert(state.flushing !== previous, `the flush timer ${typeof previous} was not replaced; schedule a new one each time`)
}

/** Holds a message for the agent in place of any of its kind this live has waiting, unless the agent was already given it, by its `signature`. */
export function queue($: EngineInterface, { state, live }: { state: State; live: LiveWatcher }, signature: string, message: Message) {
  assert(signature !== '', `message for ${live.key} has signature ${JSON.stringify(signature)}; sign it by what it reports`)
  const key = `${live.key}:${message.kind}`
  if (live.told === signature && !state.outbox.has(key)) return
  live.told = signature
  state.outbox.set(key, message)
  assert(state.outbox.get(key) === message, `the ${message.kind} message for ${live.key} is not waiting after queueing it`)
  schedule($, state)
}

/** Holds a watcher's environment error for the one summary of them, once for each. */
export function queueEnvironment($: EngineInterface, { state, live, watcher }: Omit<Run, 'cwd'>, line: string) {
  assert(line !== '' && !line.includes('\n'), `environment line ${JSON.stringify(line)} for ${live.key} must be one line of text`)
  const key = `${live.key}\n${line}`
  if (state.environment.has(key)) return
  state.environment.add(key)
  state.outbox.set(`${live.key}:environment`, { text: environmentLine(watcher, line), isWaking: false, kind: 'environment' })
  assert(state.outbox.get(`${live.key}:environment`)?.isWaking === false, `${live.key}'s environment error would wake the agent; it never should`)
  schedule($, state)
}

/** Writes a watcher's full output where the agent can read it, keeping it out of the conversation; undefined when it cannot. */
export async function writeLog($: EngineInterface, live: LiveWatcher, text: string, suffix = ''): Promise<string | undefined> {
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
export async function baselineInventory($: EngineInterface, run: Run, report: Report) {
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
export const UNTOUCHED: Report = { summary: 'passed', isFailed: false, text: '', failures: [] }

/** Timings in a summary, which change from run to run of the same failure. */
export const TIMING = /\d+(?:\.\d+)?m?s\b/g

/** Whether two results say the same, timings aside: a watcher printing an unchanged result again is no one's change. */
export function sameResult(before: Report, after: Report): boolean {
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
export async function deliver($: EngineInterface, run: Run, report: Report) {
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
export async function tellRegression($: EngineInterface, run: Run, report: Report) {
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
