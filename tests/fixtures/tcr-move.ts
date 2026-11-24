import { assert } from '../../hooks/assert'
import type { Workspace } from './tcr'
import type { Project } from './tcr-session'

export const BEFORE_MOVE = 'a'.repeat(40)
export const AFTER_MOVE = 'b'.repeat(40)
export const METADATA = '/repo/.git'

/** Where git keeps what the repository at /repo reads: its own directory, and the one its refs live in, which differ in a worktree. */
export type Layout = { pointer?: string; own: string; common: string; commondir?: string }

export const PLAIN: Layout = { own: METADATA, common: METADATA }
export const LINKED_LAYOUTS: Record<string, Layout> = {
  worktree: { pointer: 'gitdir: /main/.git/worktrees/repo', own: '/main/.git/worktrees/repo', common: '/main/.git', commondir: '../..' },
  submodule: { pointer: 'gitdir: ../.git/modules/repo', own: '/.git/modules/repo', common: '/.git/modules/repo' },
}

/** The repository sits at BEFORE_MOVE on main, as the plugin reads it from the metadata directory its layout names. */
export function onMainIn(layout: Layout) {
  return (workspace: Workspace) => {
    if (layout.pointer !== undefined) workspace.files.set(METADATA, `${layout.pointer}\n`)
    if (layout.commondir !== undefined) workspace.files.set(`${layout.own}/commondir`, `${layout.commondir}\n`)
    workspace.files.set(`${layout.own}/HEAD`, 'ref: refs/heads/main\n')
    workspace.files.set(`${layout.common}/packed-refs`, `${BEFORE_MOVE} refs/heads/main\n`)
    assert(workspace.files.get(`${layout.common}/packed-refs`)?.startsWith(BEFORE_MOVE), `main was not placed at ${BEFORE_MOVE} in ${layout.common}`)
    assert(!workspace.files.has(`${layout.own}/logs/HEAD`), `${layout.own} starts with a history of moves; start it with none`)
  }
}

export const onMain = onMainIn(PLAIN)

/** HEAD moves to AFTER_MOVE, and the reflog records the move with `entry`: how git names what moved it. */
function moveHead({ workspace }: Project, entry: 'pull: Fast-forward' | 'commit: break', layout: Layout) {
  workspace.files.set(`${layout.common}/refs/heads/main`, `${AFTER_MOVE}\n`)
  workspace.files.set(`${layout.own}/logs/HEAD`, `${BEFORE_MOVE} ${AFTER_MOVE} Dev <dev@example.com> 1700000001 +0000\t${entry}\n`)
  assert(workspace.files.get(`${layout.common}/refs/heads/main`)?.trim() === AFTER_MOVE, `main did not move to ${AFTER_MOVE}`)
  assert(workspace.files.get(`${layout.own}/logs/HEAD`)?.includes(`${entry.split(':')[0]}: `), `the reflog does not record the move as ${entry}`)
}

/** A person's pull moves HEAD to AFTER_MOVE, which the reflog records as a pull, not a commit. */
export const pull = (project: Project, layout: Layout = PLAIN) => moveHead(project, 'pull: Fast-forward', layout)

/** The agent's own commit moves HEAD to AFTER_MOVE, which the reflog records as a commit, so the files the checks read stay as they were. */
export const commit = (project: Project, layout: Layout = PLAIN) => moveHead(project, 'commit: break', layout)
