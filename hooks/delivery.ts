/**
 * How a session tells the agent what its checks found: the status line, messages queued and sent once each, logs of
 * full output, and the inherited backlog's triage inventory.
 */
import type { EngineInterface } from 'claude-code'
import { assert } from './assert'
import { safeLine, safePath } from './safe-text'
import {
  commandLine,
  environmentLine,
  environmentMessage,
  failureMessage,
  hasRegression,
  languageOf,
  recoveryMessage,
  statusLine,
  type Report,
} from './watchers'
import { isEditJudgedByTcr, UPSTREAM_LANGUAGE } from './tcr'
import { readExpecting } from './command-error'
import { ReadTimeout, within } from './project'
import { restoreNotices } from './revert-slots'
import type { LiveWatcher, Message, State, Run } from './state'

export const QUIET_MS = 400

/** How many times a message the host refused is sent again on its own: with nothing queued after it, no later message would send it with itself. */
export const HAND_RETRIES = 1

/**
 * A watcher that ends within this long of its start counts as a quick exit and
 * waits before it restarts: this long after the first, doubling after each further one.
 */
export const RETRY_MS = 30_000

/** Sets this live's part of the status line, which shows every running watcher's. */
export function setStatus($: EngineInterface, state: State, live: LiveWatcher, text: string | undefined) {
  assert(state.liveWatchers.includes(live), `live ${live.key} is not one of the session's; push it to state.liveWatchers first`)
  assert(text === undefined || typeof text === 'string', `the status of ${live.key} is ${typeof text}, not text`)
  live.status = text === undefined ? undefined : safeLine(text)
  try {
    const parts = state.liveWatchers.flatMap(({ status }) => (status === undefined ? [] : [status]))
    void Promise.resolve($.ui.status(parts.length === 0 ? undefined : parts.join(' · '))).catch((error: unknown) => $.ui.log(`the status line could not be set: ${String(error)}`, { to: 'debug' }))
  } catch (error) {
    $.ui.log(`the status line could not be set: ${String(error)}`, { to: 'debug' })
  }
}

/** Gives the host the text of the `sent` messages; when it does not take them, they wait again, and the error goes on. */
async function hand($: EngineInterface, state: State, { text, sent }: { text: string; sent: readonly (readonly [string, Message])[] }) {
  assert(sent.length > 0, `${sent.length} messages were handed to the host; hand it one at least`)
  const wasTold = state.isToldThisTurn
  const { epoch } = state
  try {
    if (state.isTurnRunning) {
      state.isToldThisTurn = wasTold || sent.some(([, { kind }]) => kind !== 'tcr' && kind !== 'gate')
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      return
    }
    state.isPromptQueued = true
    await $.prompt.submit({ text })
  } catch (error) {
    state.isToldThisTurn = wasTold
    if (!state.isTurnRunning) state.isPromptQueued = false
    if (state.epoch === epoch) {
      restoreNotices(state.outbox, sent)
      assert(state.outbox.size >= 1, `${sent.length} messages the host did not take are not waiting to be sent again`)
    }
    throw error
  }
}

/**
 * Gives the agent every waiting message as one: joined to the running turn,
 * at most once a turn, or else as a new turn when one of them should wake
 * the agent. In a turn that was told already only the TCR messages are sent;
 * the rest wait for the next turn.
 */
export async function send($: EngineInterface, state: State) {
  const waiting = [...state.outbox.entries()]
  const isOnlyTcr = state.isTurnRunning && state.isToldThisTurn
  const sent = waiting.filter(([, { kind }]) => !isOnlyTcr || kind === 'tcr' || kind === 'gate')
  const messages = sent.map(([, message]) => message)
  if (messages.length === 0) return
  const isHeld = !state.isTurnRunning && (state.isPromptQueued || !messages.some(({ isWaking }) => isWaking))
  if (isHeld) return
  for (const [key] of sent) state.outbox.delete(key)
  const reports = messages.flatMap(({ text, kind }) => (kind === 'environment' ? [] : [text]))
  const environment = messages.flatMap(({ text, kind }) => (kind === 'environment' ? [text] : []))
  const text = [...reports, ...(environment.length === 0 ? [] : [environmentMessage(environment)])].join('\n\n')
  assert(reports.length + environment.length === messages.length, `sent ${reports.length + environment.length} of ${messages.length} waiting messages; send each`)
  assert(text !== '', `${messages.length} waiting messages joined to nothing; each message needs text`)
  await hand($, state, { text, sent })
}

/** Sends the waiting messages, again up to HAND_RETRIES times after the host refuses them, unless the session ended meanwhile. */
async function sendRetrying($: EngineInterface, state: State) {
  const { epoch } = state
  assert(Number.isInteger(epoch) && HAND_RETRIES >= 0, `the messages were sent in the session ${epoch} with ${HAND_RETRIES} retries, which is no count`)
  let tried = 0
  for (let attempt = 0; attempt <= HAND_RETRIES && state.epoch === epoch; attempt += 1) {
    tried += 1
    try {
      return await send($, state)
    } catch (error) {
      $.ui.log(`overwatch: ${String(error)} while telling the agent`, { to: 'debug' })
      if (attempt < HAND_RETRIES) await $.clock.sleep(QUIET_MS)
    }
  }
  assert(tried <= HAND_RETRIES + 1, `the messages were sent ${tried} times, past ${HAND_RETRIES} retries`)
}

/** Sends the waiting messages once the reports arriving with them are in. */
export function schedule($: EngineInterface, state: State) {
  const previous = state.flushing
  previous?.cancel()
  state.flushing = $.clock.after(QUIET_MS, () => void sendRetrying($, state))
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
export function queueEnvironment($: EngineInterface, { state, live, watcher }: Omit<Run, 'cwd' | 'epoch'>, line: string) {
  assert(typeof line === 'string', `the environment line of ${live.key} is ${typeof line}, not text`)
  const key = `${live.key}\n${line}`
  if (state.environment.has(key)) return
  state.environment.add(key)
  state.outbox.set(`${live.key}:environment`, { text: environmentLine(watcher, line), isWaking: false, kind: 'environment' })
  assert(state.outbox.get(`${live.key}:environment`)?.isWaking === false, `${live.key}'s environment error would wake the agent; it never should`)
  schedule($, state)
}

/** Writes a watcher's full output where the agent can read it, keeping it out of the conversation; undefined when it cannot, or when the host does not answer within the limit of a read. */
export async function writeLog($: EngineInterface, live: LiveWatcher, text: string, suffix = ''): Promise<string | undefined> {
  assert(typeof text === 'string' && typeof suffix === 'string', `a log of ${typeof text} with the suffix ${typeof suffix} was written; give text for both`)
  return within($, async () => {
    const { value: home } = await readExpecting(() => $.env.get('HOME'))
    if (home === undefined || home === '') return undefined
    const name = live.key.replace(/[^\w.-]+/g, '-')
    const path = `${home}/.cache/overwatch/logs/${name}${suffix}.log`
    assert(typeof live.key === 'string' && home !== undefined, `the log of ${typeof live.key} was written for the home ${typeof home}`)
    return $.fs.write(path, text).then(
      () => path,
      () => undefined,
    )
  }).catch((error: unknown) => {
    if (error instanceof ReadTimeout) return undefined
    throw error
  })
}

/** Saves inherited issues once, with a compact pointer for deliberate backlog triage. */
export async function baselineInventory($: EngineInterface, run: Run, report: Report) {
  if (!report.isFailed) return
  const { state, live, watcher } = run
  const log = await writeLog($, live, report.text, '.baseline')
  if (log === undefined) return
  const path = log + '.json'
  assert(typeof path === 'string' && report.isFailed, `the inventory of ${live.key} is ${typeof path} for a report that passed`)
  const inventory = { checks: [{ name: watcher.name, dir: watcher.dir, command: commandLine(watcher),
    summary: report.summary, failures: report.failures, log }] }
  const saved = await within($, () => $.fs.write(path, JSON.stringify(inventory))).then(() => true, () => false)
  if (!saved || !live.isWatching || run.epoch !== state.epoch) return
  const detail = report.failures.length > 0 ? report.failures.length + ' named issues' : 'individual issue names unavailable; see full log'
  const text = 'overwatch: inherited backlog (' + detail + '). ' +
    'Inherited findings follow the configured failure policy. Triage inventory: ' + safePath(path) +
    '. Filter or page it with engine/triage.py; full output is linked there.'
  assert(path === `${log}.json`, `inventory ${path} is not beside its log ${log}`)
  state.outbox.set(live.key + ':baseline', { text, isWaking: false, kind: 'baseline' })
  schedule($, state)
}

/** The baseline of a watcher whose first result came after the agent's edits: every failure counts as new. */
export const UNTOUCHED: Report = { summary: 'passed', isFailed: false, text: '', failures: [] }

/** Timings in a summary, which change from run to run of the same failure. */
export const TIMING = /\d+(?:\.\d+)?m?s\b/g

/** Whether two results say the same, timings aside: a watcher printing an unchanged result again is no one's change. */
export function sameResult(before: Report, after: Report): boolean {
  const same = before.isFailed === after.isFailed && before.summary.replace(TIMING, '') === after.summary.replace(TIMING, '')
    && before.failures.join('\n') === after.failures.join('\n')
  assert(!same || before.isFailed === after.isFailed, `${before.summary} and ${after.summary} matched with a different verdict`)
  assert(!same || before.failures.length === after.failures.length, `${before.summary} and ${after.summary} matched with different failures`)
  return same
}

/** The live's baseline, which `report` becomes when it has none; undefined when the session stopped watching meanwhile. */
async function takeBaseline($: EngineInterface, run: Run, report: Report): Promise<Report | undefined> {
  const { state, live } = run
  assert(state.liveWatchers.some(each => each === live), `live ${live.key} takes a baseline but is not one of the session's`)
  if (live.baseline !== undefined) return live.baseline
  const baseline = live.isEdited ? UNTOUCHED : report
  live.baseline = baseline
  if (!live.isEdited) await baselineInventory($, run, report)
  assert(live.baseline !== undefined, `${live.key} has no baseline after it took one from ${report.summary}`)
  return live.isWatching && run.epoch === state.epoch ? baseline : undefined
}

/**
 * Tells the agent of a failure its session caused: one the watcher's first
 * result, its baseline, did not already have. An environment error is told
 * once, apart from the code's failures. While TCR runs it tells of the failures it judges; the upstream check is not
 * judged, so its results are told here.
 */
export async function deliver($: EngineInterface, run: Run, report: Report) {
  const { state, live, watcher } = run
  if (run.epoch !== state.epoch) return
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
  const baseline = await takeBaseline($, run, report)
  if (baseline === undefined) return
  const isRegression = hasRegression(report, baseline)
  const wasFailing = live.wasFailing
  live.wasFailing = isRegression
  if (isEditJudgedByTcr(state.tcr) && languageOf(watcher) !== UPSTREAM_LANGUAGE) {
    live.suppressed = isKeptForTcr(state, { isRegression, origin }) ? report : undefined
    return
  }
  live.suppressed = undefined
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

/** Whether a failure is kept to be told later, not now: it follows an edit TCR waits to judge, or a change of another process while TCR runs, which nothing judges. */
function isKeptForTcr(state: State, { isRegression, origin }: { isRegression: boolean; origin: LiveWatcher['origin'] }): boolean {
  assert(typeof isRegression === 'boolean', `a result was kept for TCR as a regression that is ${typeof isRegression}, not yes or no`)
  const isKept = isRegression && (state.tcr.unjudged || origin === 'outside')
  assert(!isKept || isRegression, `a result that is no regression was kept for TCR after ${origin}`)
  return isKept
}

/** Forgets the failures TCR was left to tell, once it has told them by a revert or by why it held the edit, or has committed the edit the checks passed. */
export function forgetSuppressed(state: State) {
  assert(Array.isArray(state.liveWatchers), `the live watchers are ${typeof state.liveWatchers}, not a list`)
  for (const live of state.liveWatchers) live.suppressed = undefined
  assert(state.liveWatchers.every(live => live.suppressed === undefined), 'a failure that TCR was left to tell is still waiting after TCR told it')
}

/** Tells the agent the failures that TCR was left to tell and did not, because it stopped before it judged the edit they follow, as the checks tell them. */
export async function tellSuppressed($: EngineInterface, state: State) {
  const { epoch } = state
  assert(Number.isInteger(epoch) && Array.isArray(state.liveWatchers), `failures were told in the session ${epoch} of ${typeof state.liveWatchers}, not a list of checks`)
  for (const live of state.liveWatchers) {
    const { suppressed, watcher } = live
    live.suppressed = undefined
    if (suppressed === undefined || watcher === undefined || live.report !== suppressed || live.isEditedSinceResult || state.epoch !== epoch) continue
    await tellRegression($, { state, live, watcher, cwd: live.dir, epoch }, suppressed)
  }
  assert(state.epoch !== epoch || state.liveWatchers.every(live => live.suppressed === undefined), `a failure that TCR was left to tell is still waiting in the session ${state.epoch} after the checks told it in ${epoch}`)
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
  if (run.epoch !== state.epoch) return
  queue($, run, signature, { text, isWaking: origin === 'session', kind: 'report' })
}
