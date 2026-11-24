/**
 * The program a running watcher was started on, and what to do once PATH finds that program somewhere else: a nix
 * profile switch or a Homebrew upgrade swaps the toolchain under the same name, and the watcher keeps the old one.
 */
import type { EngineInterface } from 'claude-code'
import { assert } from './assert'
import { onPath, realPath } from './project'
import { RETRY_MS, setStatus } from './delivery'
import { pauseOnExpected } from './pausing'
import { CommandError } from './tcr'
import type { LiveWatcher, Run, State } from './state'
import type { Watcher } from './watchers'

/**
 * The real path of the program `argv0` runs, found on PATH with its links followed, so a toolchain swapped under the
 * same name reads differently; undefined for a path or a name PATH lacks.
 */
export async function toolchainOf($: EngineInterface, argv0: string | undefined): Promise<string | undefined> {
  assert(argv0 === undefined || typeof argv0 === 'string', `toolchainOf was given ${typeof argv0}, not a program`)
  const found = argv0 === undefined || argv0 === '' || argv0.includes('/') ? undefined : await onPath($, argv0)
  const resolved = found === undefined ? undefined : await realPath($, found)
  assert(resolved === undefined || resolved !== '', `${argv0} resolved to an empty path; fall back to where PATH has it`)
  return resolved
}

/** Where the running watch command's program is on PATH now, when it started from somewhere else; undefined otherwise. */
export async function replacedToolchain($: EngineInterface, live: LiveWatcher): Promise<string | undefined> {
  assert(live.toolchain === undefined || live.toolchain !== '', `${live.key} started on an empty toolchain path; record undefined instead`)
  const argv0 = live.watcher?.argv?.[0]
  const now = live.toolchain === undefined ? undefined : await toolchainOf($, argv0)
  const replaced = now !== undefined && now !== live.toolchain ? now : undefined
  assert(replaced === undefined || replaced !== live.toolchain, `${argv0} was replaced by ${replaced}, where it already was`)
  return replaced
}

/** Stops a running watcher whose program PATH now finds somewhere else, so it ends and restarts on the new one. */
export async function stopIfReplaced($: EngineInterface, live: LiveWatcher): Promise<void> {
  assert(live.isWatching, `${live.key} is not watching; only a running watcher can be on an old toolchain`)
  const replaced = await replacedToolchain($, live)
  if (replaced !== undefined) await live.kill?.()
  assert(replaced === undefined || replaced !== live.toolchain, `${live.key} was stopped for its toolchain being replaced by ${replaced}, the one it started on`)
}

/** Restarts at once a watcher that ended on an old toolchain, without counting a quick exit, and says where it runs now. */
export function restartOnReplaced($: EngineInterface, { state, live, watcher }: Omit<Run, 'cwd' | 'epoch'>, replaced: string): void {
  assert(replaced !== '' && replaced !== live.toolchain, `${live.key} would restart on ${JSON.stringify(replaced)}; pass where PATH finds its program now`)
  live.quickExits = 0
  live.isWatching = false
  live.retryAt = 0
  live.toolchain = undefined
  setStatus($, state, live, `${watcher.name}: ${watcher.argv?.[0]} is now ${replaced}, restarting`)
  state.onWatcherEnded?.()
  assert(!live.isWatching, `${live.key} still counts as watching after it ended on an old toolchain`)
}

/** After a read of the project's files failed where a watcher starts or restarts: the watcher waits out the retry delay, its status says why, and TCR stops with the same words, an expected failure told once; any other error goes on. */
export async function holdOffAfterRead($: EngineInterface, state: State, { live, watcher, epoch }: { live: LiveWatcher; watcher: Watcher; epoch: number }, error: unknown): Promise<void> {
  assert(Number.isInteger(epoch) && epoch <= state.epoch, `the watcher ${live.key} began in the session ${epoch}, not one that has not begun`)
  if (state.epoch === epoch) live.isWatching = false
  if (!(error instanceof CommandError)) throw error
  if (state.epoch !== epoch) return
  live.retryAt = (await $.clock.now()) + RETRY_MS
  setStatus($, state, live, `${watcher.name}: ${error.message}, retrying at the first turn after ${RETRY_MS / 1000}s`)
  pauseOnExpected($, state, error, epoch)
  assert(!live.isWatching && live.retryAt > 0, `${live.key} was not held off after ${error.message}`)
}
