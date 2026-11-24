import type { EngineInterface } from 'claude-code'
import { assert } from './assert'
import { bringsInFiles } from './gating'
import { pauseOnExpected } from './pausing'
import { commitOf, isCommitted, rootOf } from './project'
import type { State } from './state'
import { TCR_ACTIVE, statusText } from './tcr'

/**
 * Notes the commit the session's baselines belong to, and takes fresh ones once it moves under the session, as a
 * pull or checkout brings in failures the agent did not make. Each check reruns, stopping a run still reading the
 * old commit, and its next result is its baseline unless the agent edits first. A commit keeps the baselines, even
 * one made in the same step as an edit, since it changes no file, unless `command`, the step that moved HEAD, ran a
 * git operation that can bring in files, as a squash merge committed in the same step does. Answers whether it took
 * fresh baselines, so TCR can leave the step's edit unjudged: the failures the move brought in are inherited; or says
 * that HEAD moved by a commit, which kept them; or that it did not move.
 */
export async function rebaselineOnMove($: EngineInterface, state: State, command = ''): Promise<'fresh' | 'kept' | 'none'> {
  assert(typeof command === 'string', `the step that moved HEAD is ${typeof command}, not text`)
  const { epoch } = state
  try {
    return await moveOf($, state, command)
  } catch (error) {
    pauseOnExpected($, state, error, epoch)
    assert(state.epoch !== epoch || state.tcr.status !== TCR_ACTIVE, `a read that failed with ${String(error)} left TCR ${statusText(state.tcr.status)}`)
    return 'none'
  }
}

async function moveOf($: EngineInterface, state: State, command: string): Promise<'fresh' | 'kept' | 'none'> {
  const { cwd, epoch } = state
  if (cwd === undefined) return 'none'
  const root = await rootOf($, cwd, state)
  const head = root === undefined ? undefined : await commitOf($, root)
  if (state.epoch !== epoch || head === undefined || head === state.head) return 'none'
  assert(root !== undefined, `HEAD ${head} was read with no repository for ${cwd}; read it only from one`)
  const from = state.head
  state.head = head
  if (from === undefined || state.epoch !== epoch) return 'none'
  if (!bringsInFiles(command) && await isCommitted($, root, from, head)) return 'kept'
  if (state.epoch !== epoch) return 'none'
  state.tcrHeld.clear()
  state.tcr.held = undefined
  for (const each of state.liveWatchers) {
    each.baseline = undefined
    each.isEdited = false
    each.isEditedSinceResult = false
    each.changed?.()
  }
  assert(state.liveWatchers.every(each => each.baseline === undefined && !each.isEdited), `a live watcher kept its baseline after HEAD moved to ${head}; clear each`)
  return 'fresh'
}
