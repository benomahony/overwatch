import { expect } from 'claude-code/testing'
import { WARNINGS, ended, type Workspace } from './fixtures/tcr'
import { inSession, personWrites, toldPlain, DECIDE_MS, longTest, type Project } from './fixtures/tcr-session'

const REFUSED = 'the revert in /repo failed after it began to discard the work: git clean failed'
const GUARDED = 'this action is guarded while relevant checks fail'
const STEP_MS = 10
const MOST_STEPS = 300
const LIVE_REPORT_MS = 500
const SAVED_REF = 'refs/overwatch/tcr/'
const AFTER_REVERT = 'revert#1:after'
const FILES_SHOWN = 5
const MANY_FILES = 3000
const NOTICE_LIMIT_CHARS = 2000

type Saved = 'ref' | 'unknown' | 'off'
type Reset = 'done' | 'failed' | 'unknown'
type Names = { name: string; files: string[]; written: (file: string) => string }
type Shape = { name: string; saved: readonly Saved[]; left: (files: string[]) => string[]; isNoticeOfRevert?: false; outcome?: Reset; arrange: (workspace: Workspace, files: string[], how: Saved) => void }

const PLAIN: Names = { name: 'plain names', files: ['a.py', 'b.py', 'c.py'], written: file => file }
const HOSTILE: Names = { name: 'names with a backtick and a new line', files: ['a.py', 'we`ird.py', 'new\nline.py'], written: file => file.replace('`', '\\x60').replace('\n', '\\x0a') }
const MANY: Names = { name: `${MANY_FILES} files`, files: Array.from({ length: MANY_FILES }, (_, index) => `f${String(index).padStart(4, '0')}.py`), written: file => file }

const failed = (leaves: (files: string[]) => string[], resets: boolean, outcome?: Reset) => (workspace: Workspace, files: string[], how: Saved) => {
  workspace.revertIncomplete = { error: REFUSED, resets, leaves: leaves(files), asText: how === 'unknown', ...(outcome === undefined ? {} : { outcome }) }
}

const afterRevert = (workspace: Workspace, change: () => void) => { workspace.hooks[AFTER_REVERT] = change }

const SHAPES: Shape[] = [
  { name: 'the revert worked', saved: ['ref', 'off'], left: () => [], outcome: 'done', arrange: () => undefined },
  { name: 'git refused no file after it began', saved: ['ref', 'unknown', 'off'], left: () => [], outcome: 'done', arrange: failed(() => [], true) },
  { name: 'git refused one file', saved: ['ref', 'unknown', 'off'], left: files => [files[1] as string], outcome: 'done', arrange: failed(files => [files[1] as string], true) },
  { name: 'git reset no file', saved: ['ref', 'unknown', 'off'], left: files => files, outcome: 'failed', arrange: failed(() => [], false) },
  { name: 'the command failed before it changed a file', saved: ['ref'], left: files => files, isNoticeOfRevert: false, arrange: workspace => { workspace.revertError = 'the working tree is locked' } },
  { name: 'every file was dirty again after the revert', saved: ['ref'], left: files => files, outcome: 'done', arrange: (workspace, files) => afterRevert(workspace, () => Object.assign(workspace, { dirty: [...files], fingerprint: 'back' })) },
  { name: 'git reset no file and a person then cleaned every file', saved: ['ref'], left: () => [], outcome: 'failed', arrange: (workspace, files) => { failed(() => [], false)(workspace, files, 'ref'); afterRevert(workspace, () => Object.assign(workspace, { dirty: [], fingerprint: 'cleaned' })) } },
  { name: 'git reset no file and a person then deleted two of three files', saved: ['ref'], left: files => [files[1] as string], outcome: 'failed', arrange: (workspace, files) => { failed(() => [], false)(workspace, files, 'ref'); afterRevert(workspace, () => Object.assign(workspace, { dirty: [files[1] as string], fingerprint: 'some' })) } },
  { name: 'the reset timed out and nobody knows how it ended', saved: ['ref'], left: files => files, outcome: 'unknown', arrange: (workspace, files) => { failed(() => [], false, 'unknown')(workspace, files, 'ref') } },
  { name: 'the revert worked and a person then rewrote every file', saved: ['ref'], left: files => files, outcome: 'done', arrange: (workspace, files) => afterRevert(workspace, () => Object.assign(workspace, { dirty: [...files], fingerprint: 'rewritten' })) },
]

const CELLS = [
  ...SHAPES.flatMap(shape => shape.saved.map(saved => ({ shape, saved, names: PLAIN }))),
  ...[HOSTILE, MANY].flatMap(names => SHAPES.slice(0, 3).filter((_, index) => index !== 1).map(shape => ({ shape, saved: 'ref' as Saved, names }))),
].flatMap(cell => [false, true].map(isLate => ({ ...cell, isLate })))

function listOf(files: string[], written: (file: string) => string): string {
  const shown = files.slice(0, FILES_SHOWN).map(file => `\`${written(file)}\``).join(', ')
  return files.length > FILES_SHOWN ? `${shown} and ${files.length - FILES_SHOWN} more` : shown
}

async function untilNotice(project: Project): Promise<string> {
  for (let step = 0; step < MOST_STEPS; step++) {
    const notices = toldPlain(project).filter(text => text.includes('TCR reverted') || text.includes('TCR tried to revert') || text.includes('TCR is unavailable'))
    if (notices.length > 0) return notices.join('\n')
    await project.clock.advance(STEP_MS)
  }
  return ''
}

/** What the tree and the fake's own git operations say happened, not what the dirty list's names say: the files its reset restored, the files left changed at the end, and what the engine reported of the reset. */
type Facts = { outcome: Reset; isReported: boolean; files: string[]; operated: string[]; dirty: string[] }

function expectNotice(text: string, facts: Facts, written: (file: string) => string) {
  const { outcome, isReported, files, operated, dirty } = facts
  const clean = files.filter(file => !dirty.includes(file))
  const still = files.filter(file => dirty.includes(file))
  const late = dirty.filter(file => !files.includes(file))
  expect(text.includes('TCR reverted')).toBe(outcome === 'done')
  expect(text.includes('TCR tried to revert')).toBe(outcome !== 'done')
  expect(text.includes('git failed')).toBe(outcome === 'failed')
  expect(text.includes('the revert command failed')).toBe(outcome === 'unknown' && !isReported)
  expect(text.includes('it is not known whether git finished the reset')).toBe(outcome === 'unknown' && isReported)
  expect(text).not.toContain('The files are unchanged')
  expect(text.includes('Changed after TCR listed the files')).toBe(late.length > 0)
  if (late.length > 0) expect(text).toContain(`Changed after TCR listed the files: ${listOf(late, written)}.`)
  if (outcome === 'done') {
    const restored = clean.filter(file => operated.includes(file))
    const again = still.filter(file => operated.includes(file))
    const refused = still.filter(file => !operated.includes(file))
    expect(text.includes('Restored:')).toBe(restored.length > 0)
    if (restored.length > 0) expect(text).toContain(`Restored: ${listOf(restored, written)}.`)
    else expect(text).toContain('No file was restored.')
    expect(text.includes('reverted part of the latest change')).toBe(restored.length > 0 && still.length > 0)
    expect(text.includes('Still changed')).toBe(refused.length > 0)
    if (refused.length > 0) expect(text).toContain(`Still changed: ${listOf(refused, written)}.`)
    expect(text.includes('Changed again after the revert')).toBe(again.length > 0)
    if (again.length > 0) expect(text).toContain(`Changed again after the revert: ${listOf(again, written)}.`)
  } else {
    expect(text).not.toContain('Restored:')
    expect(text.includes('Now as HEAD has them')).toBe(clean.length > 0)
    if (clean.length > 0) expect(text).toContain(`Now as HEAD has them: ${listOf(clean, written)}.`)
    expect(text.includes('Still changed')).toBe(still.length > 0)
    if (still.length > 0) expect(text).toContain(`Still changed: ${listOf(still, written)}.`)
  }
  expect(text).not.toContain('we`ird')
  expect(text).not.toContain('new\nline')
  expect(text.length).toBeLessThan(NOTICE_LIMIT_CHARS)
}

const SAVED_WORDS = { ref: 'the work saved', off: 'saving off', unknown: 'the ref not known' }

for (const { shape, saved, names, isLate } of CELLS) {
  longTest(`${shape.name}, ${SAVED_WORDS[saved]}, ${names.name}${isLate ? ', a person\'s file lands after the listing' : ''}: the notice names the files as the tree has them, and a turn is blocked only while the failing edit is on disk`,  async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(DECIDE_MS)
      project.setReport(WARNINGS)
      await project.clock.advance(LIVE_REPORT_MS)
      project.workspace.silent = true
      shape.arrange(project.workspace, names.files, saved)
      const arrangedAfter = project.workspace.hooks[AFTER_REVERT]
      if (isLate) project.workspace.hooks[AFTER_REVERT] = () => { arrangedAfter?.(); personWrites(project) }
      project.willChange(names.files, 'f1')
      await $.tool.call({ tool: 'Edit', file_path: `/repo/${names.files[0]}` })
      const text = await untilNotice(project)
      expect(text).not.toBe('')
      const completed = await $.turn.complete({ ...ended })
      const { dirty, operated } = project.workspace
      expect(names.files.filter(file => dirty.includes(file))).toEqual(shape.left(names.files))
      expect(completed.text.includes(GUARDED)).toBe(names.files.some(file => dirty.includes(file)))
      if (shape.isNoticeOfRevert === false) return
      const outcome = saved === 'unknown' && shape.outcome !== undefined ? 'unknown' : (shape.outcome as Reset)
      expectNotice(text, { outcome, isReported: saved !== 'unknown', files: names.files, operated, dirty }, names.written)
      if (saved === 'ref') expect(text).toContain(SAVED_REF)
      if (saved === 'unknown') expect(text).toContain('not known')
      if (saved === 'off') expect(text).toMatch(/is gone|No copy was saved/)
    }, { settings: saved === 'off' ? { mode: 'tcr', tcr: { saveReverted: false } } : { mode: 'tcr' } })
  })
}
