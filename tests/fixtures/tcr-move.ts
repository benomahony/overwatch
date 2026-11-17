import { assert } from '../../hooks/assert'
import type { Workspace } from './tcr'
import type { Project } from './tcr-session'

export const BEFORE_MOVE = 'a'.repeat(40)
export const AFTER_MOVE = 'b'.repeat(40)
export const METADATA = '/repo/.git'

/** The repository sits at BEFORE_MOVE on main, as the plugin reads it from its metadata directory. */
export function onMain(workspace: Workspace) {
  workspace.files.set(`${METADATA}/HEAD`, 'ref: refs/heads/main\n')
  workspace.files.set(`${METADATA}/packed-refs`, `${BEFORE_MOVE} refs/heads/main\n`)
  assert(workspace.files.get(`${METADATA}/packed-refs`)?.startsWith(BEFORE_MOVE), `main was not placed at ${BEFORE_MOVE} in ${METADATA}`)
  assert(!workspace.files.has(`${METADATA}/logs/HEAD`), `${METADATA} starts with a history of moves; start it with none`)
}

/** A person's pull moves HEAD to AFTER_MOVE, which the reflog records as a pull, not a commit. */
export function pull({ workspace }: Project) {
  workspace.files.set(`${METADATA}/refs/heads/main`, `${AFTER_MOVE}\n`)
  workspace.files.set(`${METADATA}/logs/HEAD`, `${BEFORE_MOVE} ${AFTER_MOVE} Dev <dev@example.com> 1700000001 +0000\tpull: Fast-forward\n`)
  assert(workspace.files.get(`${METADATA}/refs/heads/main`)?.trim() === AFTER_MOVE, `main did not move to ${AFTER_MOVE}`)
  assert(workspace.files.get(`${METADATA}/logs/HEAD`)?.includes('pull: '), 'the reflog does not record the move as a pull')
}
