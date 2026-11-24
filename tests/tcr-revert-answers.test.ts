import { expect } from 'claude-code/testing'
import { WARNINGS } from './fixtures/tcr'
import { inSession, toldPlain, DECIDE_MS, longTest, type Project } from './fixtures/tcr-session'

const STEP_MS = 10
const MOST_STEPS = 300
const LIVE_REPORT_MS = 500
const SAVED_REF = 'refs/overwatch/tcr/1'
const REVERTED_OPENING = 'overwatch: TCR reverted'
const TRIED_OPENING = 'overwatch: TCR tried to revert'
const NOT_KNOWN_RESET = 'it is not known whether git finished the reset'
const COPY_UNKNOWN = 'Whether a copy was saved is not known'
const FILES = ['a.py', 'b.py']

const HUGE_CHARACTERS = 1_000_000
const REPLACEMENT = '\uFFFD'
const FAILED_EXIT = 1
const WORKED_EXIT = 0

type Printed = (answer: Record<string, unknown>) => { code: number; text: string }
type Cell = { name: string; as?: Record<string, unknown>; prints?: Printed; opening: string; says: string }

const printing = (code: number, over: Record<string, unknown>): Printed => answer => ({ code, text: JSON.stringify({ ...answer, ...over }) })

const CELLS: Cell[] = [
  { name: 'an engine that gives no reset', as: { reset: undefined }, opening: TRIED_OPENING, says: SAVED_REF },
  { name: 'a reset that is no known word', as: { reset: 'maybe' }, opening: TRIED_OPENING, says: SAVED_REF },
  { name: 'a reset that is no text', as: { reset: 5 }, opening: TRIED_OPENING, says: NOT_KNOWN_RESET },
  { name: 'no reset and no ref', as: { reset: undefined, saved: undefined }, opening: TRIED_OPENING, says: COPY_UNKNOWN },
  { name: 'a worked revert that also says the files changed', as: { changed: true }, opening: REVERTED_OPENING, says: SAVED_REF },
  { name: 'a worked revert that names an empty ref', as: { saved: '' }, opening: REVERTED_OPENING, says: 'Whether the discarded work was saved is not known' },
  { name: 'a worked revert with a staged version and no ref', as: { saved: null, staged: true }, opening: REVERTED_OPENING, says: 'Whether the discarded work was saved is not known' },
  { name: 'a JSON array and exit 0', prints: () => ({ code: WORKED_EXIT, text: '[]' }), opening: TRIED_OPENING, says: COPY_UNKNOWN },
  { name: 'a JSON array and exit 1', prints: () => ({ code: FAILED_EXIT, text: '[]' }), opening: TRIED_OPENING, says: COPY_UNKNOWN },
  { name: 'exit 0 with an error field', prints: printing(WORKED_EXIT, { error: 'it broke' }), opening: REVERTED_OPENING, says: SAVED_REF },
  { name: 'exit 1 with an empty ref and a done reset', prints: printing(FAILED_EXIT, { error: 'it broke', saved: '' }), opening: REVERTED_OPENING, says: 'Whether the discarded work was saved is not known' },
  { name: 'exit 1 with an empty ref and a failed reset', prints: printing(FAILED_EXIT, { error: 'it broke', saved: '', reset: 'failed' }), opening: TRIED_OPENING, says: COPY_UNKNOWN },
  { name: 'reverted given as text', as: { reverted: 'true' }, opening: REVERTED_OPENING, says: SAVED_REF },
  { name: 'reverted false with a done reset and a ref', as: { reverted: false }, opening: REVERTED_OPENING, says: SAVED_REF },
  { name: 'reverted false with a ref and no reset', as: { reverted: false, reset: undefined }, opening: TRIED_OPENING, says: SAVED_REF },
  { name: 'reverted false with changed files and a done reset', as: { reverted: false, changed: true }, opening: REVERTED_OPENING, says: SAVED_REF },
  { name: 'empty output', prints: () => ({ code: WORKED_EXIT, text: '' }), opening: TRIED_OPENING, says: COPY_UNKNOWN },
  { name: 'two lines of JSON', prints: answer => ({ code: WORKED_EXIT, text: `${JSON.stringify(answer)}\n${JSON.stringify(answer)}\n` }), opening: TRIED_OPENING, says: COPY_UNKNOWN },
  { name: 'output that is no UTF-8 text', prints: () => ({ code: FAILED_EXIT, text: `${REPLACEMENT}${REPLACEMENT}{` }), opening: TRIED_OPENING, says: COPY_UNKNOWN },
  { name: 'output of a million characters', prints: () => ({ code: FAILED_EXIT, text: 'x'.repeat(HUGE_CHARACTERS) }), opening: TRIED_OPENING, says: COPY_UNKNOWN },
]

async function untilNotice(project: Project, opening: string): Promise<string[]> {
  for (let step = 0; step < MOST_STEPS; step++) {
    const notices = toldPlain(project).filter(text => text.startsWith(opening))
    if (notices.length > 0) return notices
    await project.clock.advance(STEP_MS)
  }
  return []
}

for (const cell of CELLS.filter(each => each.opening !== '')) {
  longTest(`${cell.name}: the agent is told the revert, with where the work is saved`,  async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(DECIDE_MS)
      project.setReport(WARNINGS)
      await project.clock.advance(LIVE_REPORT_MS)
      project.workspace.silent = true
      project.workspace.revertAs = cell.as
      project.workspace.revertPrints = cell.prints
      project.willChange(FILES, 'f1')
      await $.tool.call({ tool: 'Edit', file_path: `/repo/${FILES[0]}` })
      const notices = await untilNotice(project, cell.opening)
      expect(notices.length).toBe(1)
      expect(notices[0]).toContain(cell.says)
      expect(project.workspace.reverted.length).toBe(1)
      expect(toldPlain(project).some(text => text.startsWith('overwatch: TCR is unavailable') && text.includes('answered the revert with'))).toBe(false)
      expect(toldPlain(project).some(text => text.includes('overwatch: TCR is unavailable'))).toBe(true)
    })
  })
}
