import type { EngineInterface } from 'claude-code'
import { assert } from './assert'
import { pauseOnExpected } from './pausing'
import { commitOf } from './project'
import type { State } from './state'

/** Notes the commit HEAD is at after a checkpoint, unless the session that made it ended meanwhile, whose commit is no one's to note; a read of it that failed stops TCR. */
export async function noteHead($: EngineInterface, state: State, { root, epoch }: { root: string; epoch: number }) {
  assert(root.startsWith('/'), `the commit of ${root} was read; pass the repository's absolute path`)
  const head = await commitOf($, root).catch(error => pauseOnExpected($, state, error, epoch))
  if (state.epoch === epoch) state.head = head ?? state.head
  assert(state.epoch !== epoch || head === undefined || state.head === head, `HEAD was read as ${head} but the session notes ${state.head}`)
}
