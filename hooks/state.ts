/**
 * The state a Claude Code session keeps: its live watchers, the messages waiting to reach the agent, and the turn.
 */
import type { Timer } from 'claude-code'
import type { Report, Watcher } from './watchers'

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
export type Message = { text: string; isWaking: boolean; kind: 'report' | 'exit' | 'environment' | 'baseline' }

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
export type Run = { state: State; live: LiveWatcher; watcher: Watcher; cwd: string }

/** Everything needed to decide whether and when a watcher should restart. */
export type Restart = { state: State; live: LiveWatcher; watcher: Watcher; ending: Ending }

/** How a watcher ended of itself, its process exited or never started, when, and what it printed after its last report. */
export type Ending = { isStarted: boolean; startedAt: number; endedAt: number; output: string }
