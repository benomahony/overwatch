/**
 * The state a Claude Code session keeps: its live watchers, the messages waiting to reach the agent, and the turn.
 */
import type { Timer } from 'claude-code'
import type { Report, Watcher } from './watchers'
import { assert } from './assert'
import { initialTcr, type Tcr } from './tcr'
import type { RootStall } from './project'

/** One watcher's place beside the others: a language in the project or one of its sub-projects, or a checker such as zanity. */
export type LiveWatcher = {
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
  /** The real path the running watch command's program had on PATH when it started, so a swapped toolchain restarts it. */
  toolchain: string | undefined
  changed: (() => void) | undefined
  /** The timer of each run, by its session's epoch, that waits for the watcher's output or the agent's edits to go quiet; a run cancels only its own, and the end of the session cancels them all. */
  quiet: Map<number, Timer>
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
  /** The failure that TCR was left to tell because it judges, or will judge, the edit it follows, or that follows a change of another process while TCR runs and judges nothing: told by the checks when TCR stops without judging it, and at the next decision about TCR, unless a newer edit or result replaced it. */
  suppressed: Report | undefined
  /** This watcher's part of the plugin's one status line. */
  status: string | undefined
}

/** What a check was marked as before an editing tool marked it: edited since it was found, and since its previous result. */
export type Mark = { isEdited: boolean; isEditedSinceResult: boolean }

/** The marks an editing tool gave the checks, and whether the files were as they were once it ran, which the note of the files tells. */
export type EditMarks = { marks: Map<LiveWatcher, Mark>; isUnchanged: boolean }

/** Gives each check the marks it had before an editing tool that changed no file, so that its next result is not read as that tool's edit and a failure kept for TCR is not dropped. */
export function unmark(marks: ReadonlyMap<LiveWatcher, Mark>) {
  assert([...marks.keys()].every(live => typeof live.key === 'string'), `the marks to give back belong to ${[...marks.keys()].map(live => typeof live)}, not to checks`)
  for (const [live, mark] of marks) {
    live.isEdited = mark.isEdited
    live.isEditedSinceResult = mark.isEditedSinceResult
  }
  assert([...marks].every(([live, mark]) => live.isEdited === mark.isEdited && live.isEditedSinceResult === mark.isEditedSinceResult), 'a check kept the marks of a tool that changed no file')
}

/** The live's watcher and what its one-shot run printed, or undefined when it could not be read. */
export type Judged = { live: LiveWatcher; report: Report | undefined }

/** A message for the agent, waiting to go with the others that arrive with it; each live has at most one of each kind waiting. */
export type Message = { text: string; isWaking: boolean; kind: 'report' | 'exit' | 'environment' | 'baseline' | 'tcr' | 'gate'; reverts?: { total: number; saved: number } }

export type State = {
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
  /** What the agent was last told of a malformed gate, so it is told once for each message. */
  policyTold: string | undefined
  /** The look for the repository that last outlasted its limit, so that the calls within STALLED_MS of it fail at once with the same error and do not each wait out the limit. */
  rootStall: RootStall | undefined
  /** The toasts shown since the session began, so that a session the host resumes is told once. */
  announced: Set<string>
  /** Each watcher's environment error the agent has been told of, so each is told once. */
  environment: Set<string>
  /** Whether the project is being searched for watchers, and whether it should be again once that is done. */
  isFinding: boolean
  finding: Promise<{ watcher: Watcher; dir: string }[]> | undefined
  /** The search for watchers in flight, from its first round until their processes are started, which a judgement of an edit waits for. */
  discovering: Promise<void> | undefined
  isFindDue: boolean
  /** Asks for a fresh search when a watcher ends: the session's answer to that event, set while it runs. */
  onWatcherEnded: (() => void) | undefined
  /** One for each watcher found so far, in the order found, which is the status line's order. */
  liveWatchers: LiveWatcher[]
  /** Whether TCR runs in this project, and what it waits to settle; see tcr.ts. */
  tcr: Tcr
  /** The decision about TCR in flight, which an edit's fingerprint waits for. */
  tcrDeciding: Promise<void> | undefined
  /** The editing tool calls of the agent that run, from before they change the files until TCR has looked at the result; a call the host never ends is dropped when the turn completes. */
  tcrEditing: Set<symbol>
  /** The comparison of the files that the first editing tool call of a batch began with, which the calls that begin while it runs wait for, so that no tool of the batch writes while it reads the files. */
  tcrCompared: Promise<void> | undefined
  /** Has the checks tell the failures that TCR was left to tell and did not, as when it stops or holds an edit without naming them: the session's answer to that, set while it runs. */
  onUntold: (() => void) | undefined
  /** The judgement of the agent's latest edit: when it starts, which one it is, and how to stop the checks it runs. */
  tcrTimer: Timer | undefined
  tcrTicket: number
  tcrKills: Set<() => Promise<unknown>>
  /** The keys of the checks TCR left an edit unjudged for, which have no earlier result until one passes. */
  tcrHeld: Set<string>
}

/** One watcher running in its live: what each step of a run needs. A run of a session that has ended no longer changes the state. */
export type Run = { state: State; live: LiveWatcher; watcher: Watcher; cwd: string; epoch: number }

/** Everything needed to decide whether and when a watcher should restart. */
export type Restart = { state: State; live: LiveWatcher; watcher: Watcher; ending: Ending }

/** How a watcher ended of itself, its process exited or never started, when, and what it printed after its last report. */
export type Ending = { isStarted: boolean; startedAt: number; endedAt: number; output: string }

/** A new live for the watcher of one language in dir, watching nothing yet. */
export const liveWatcher = (key: string, dir: string): LiveWatcher => {
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
    toolchain: undefined,
    changed: undefined,
    quiet: new Map(),
    wasFailing: false,
    baseline: undefined,
    isEdited: false,
    isEditedSinceResult: false,
    origin: 'session',
    told: undefined,
    suppressed: undefined,
    status: undefined,
  }
  assert(made.key === key && made.dir === dir, `live watcher for ${key} was made with key ${made.key} and dir ${made.dir}`)
  return made
}

/** A session's state before it starts: no directory, liveWatchers or messages. */
export const initialState = (): State => {
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
    policyTold: undefined,
    announced: new Set(),
    rootStall: undefined,
    flushing: undefined,
    environment: new Set(),
    isFinding: false,
    finding: undefined,
    discovering: undefined,
    isFindDue: false,
    onWatcherEnded: undefined,
    onUntold: undefined,
    liveWatchers: [],
    tcr: initialTcr(),
    tcrDeciding: undefined,
    tcrEditing: new Set(),
    tcrCompared: undefined,
    tcrTimer: undefined,
    tcrTicket: 0,
    tcrKills: new Set(),
    tcrHeld: new Set(),
  }
  assert(state.liveWatchers.length === 0 && state.outbox.size === 0, `a new session starts with ${state.liveWatchers.length} liveWatchers and ${state.outbox.size} messages`)
  assert(!state.isTurnRunning && !state.isFinding, 'a new session starts with a turn or search running')
  return state
}
