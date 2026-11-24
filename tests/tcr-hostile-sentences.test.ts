import { expect } from 'claude-code/testing'
import { SENTENCES } from './fixtures/notice-sentences'
import { NAME_LIMIT } from '../hooks/safe-text'
import { WARNINGS, ended, type Workspace } from './fixtures/tcr'
import { inSession, toldPlain, DECIDE_MS, longTest, type Project } from './fixtures/tcr-session'

const STEP_MS = 10
const MOST_STEPS = 300
const LIVE_REPORT_MS = 500
const AFTER_REVERT = 'revert#1:after'
const REFUSED = 'the revert in /repo failed after it began to discard the work: git clean failed'
const REVERTED_OPENING = 'overwatch: TCR reverted'
const TRIED_OPENING = 'overwatch: TCR tried to revert'
const FIRST_FILE = 'first.py'

type Reset = 'done' | 'failed' | 'unknown'
type Cell = { reset: Reset; isStaged: boolean; isRemaining: boolean }

const CELLS: Cell[] = [
  { reset: 'done', isStaged: false, isRemaining: false },
  { reset: 'done', isStaged: true, isRemaining: true },
  { reset: 'failed', isStaged: false, isRemaining: true },
  { reset: 'unknown', isStaged: false, isRemaining: false },
]

const arrange = (workspace: Workspace, { reset, isStaged, isRemaining }: Cell, files: string[]) => {
  workspace.staged = isStaged
  if (reset !== 'done') workspace.revertIncomplete = { error: REFUSED, resets: false, outcome: reset }
  if (reset === 'done' && isRemaining) workspace.hooks[AFTER_REVERT] = () => Object.assign(workspace, { dirty: [...files], fingerprint: 'back' })
  if (reset !== 'done' && !isRemaining) workspace.hooks[AFTER_REVERT] = () => Object.assign(workspace, { dirty: [], fingerprint: 'cleaned' })
}

async function untilNotice(project: Project): Promise<string[]> {
  for (let step = 0; step < MOST_STEPS; step++) {
    const notices = toldPlain(project).filter(text => [REVERTED_OPENING, TRIED_OPENING].some(opening => text.startsWith(opening)))
    if (notices.length > 0) return notices
    await project.clock.advance(STEP_MS)
  }
  return []
}

async function revertWith(kit: Parameters<typeof inSession>[0], cell: Cell, text: string) {
  const files = [text, FIRST_FILE]
  await inSession(kit, async project => {
    await kit.$.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(`zanity: 0 errors and 29 warnings in ${text}\n`)
    await project.clock.advance(LIVE_REPORT_MS)
    project.workspace.silent = true
    arrange(project.workspace, cell, files)
    project.willChange(files, 'f1')
    await kit.$.tool.call({ tool: 'Edit', file_path: `/repo/${files[0]}` })
    const notices = await untilNotice(project)
    const wanted = cell.reset === 'done' ? REVERTED_OPENING : TRIED_OPENING
    expect({ cell, opening: notices.map(notice => notice.startsWith(wanted)) }).toEqual({ cell, opening: [true] })
    await kit.$.turn.complete({ ...ended })
  }, { settings: { mode: 'tcr', name: text } })
}

const chunked = SENTENCES.reduce<string[]>((chunks, sentence) => {
  const last = chunks.at(-1)
  if (last !== undefined && last.length + 1 + sentence.length <= NAME_LIMIT) chunks[chunks.length - 1] = `${last} ${sentence}`
  else chunks.push(sentence)
  return chunks
}, [])

for (const [index, chunk] of chunked.entries()) {
  for (const cell of CELLS) {
    longTest(`the sentences of notices, part ${index + 1} of ${chunked.length}, as a file name, a check name and a summary, in a revert that ${cell.reset === 'done' ? 'was done' : `was ${cell.reset}`}${cell.isStaged ? ' with a staged copy' : ''}${cell.isRemaining ? ' with files still changed' : ''}: the agent is told the revert as it is`,  async ($, on) => {
      await revertWith({ $, on }, cell, chunk)
    })
  }
}

const UNAVAILABLE_OPENING = 'overwatch: TCR is unavailable'

for (const command of ['revert', 'checkpoint'] as const) {
  longTest(`the ${command} command that fails with an empty error: the agent is told TCR is unavailable, with the command's exit code`,  async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(DECIDE_MS)
      if (command === 'revert') project.setReport(WARNINGS)
      await project.clock.advance(LIVE_REPORT_MS)
      project.workspace.silent = true
      if (command === 'revert') project.workspace.revertError = ''
      else project.workspace.refusal = ''
      project.willChange([FIRST_FILE], 'f1')
      await $.tool.call({ tool: 'Edit', file_path: `/repo/${FIRST_FILE}` })
      for (let step = 0; step < MOST_STEPS && !toldPlain(project).some(text => text.startsWith(UNAVAILABLE_OPENING)); step++) await project.clock.advance(STEP_MS)
      expect(toldPlain(project).filter(text => text.startsWith(UNAVAILABLE_OPENING)).map(text => text.includes(`${command} exited 1`))).toEqual([true])
    })
  })
}
