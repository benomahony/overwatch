import { expect } from 'claude-code/testing'
import { WARNINGS } from './fixtures/tcr'
import { inSession, toldPlain, DECIDE_MS, SETTLE_MS, longTest } from './fixtures/tcr-session'

const SAVED_REF = 'refs/overwatch/tcr/9'
const FAILED_EXIT = 1
const WORKED_EXIT = 0
const REVERTED_OPENING = 'overwatch: TCR reverted'
const TRIED_OPENING = 'overwatch: TCR tried to revert'
const SETTING_CLAIM = '`tcr.saveReverted` is false'
const UNKNOWN_COPY = /Whether (?:the discarded work|a copy) was saved is not known/
const KEEPS_NOTHING = { mode: 'tcr', tcr: { saveReverted: false } }

type Saved = { name: string; field: Record<string, unknown> }
const SAVED: Saved[] = [
  { name: 'a ref', field: { saved: SAVED_REF } },
  { name: 'null', field: { saved: null } },
  { name: 'nothing', field: {} },
  { name: 'an empty text', field: { saved: '' } },
]
const RESETS = ['done', 'failed', 'unknown'] as const

for (const isSaveOn of [true, false]) {
  for (const saved of SAVED) {
    for (const reset of RESETS) {
      const name = `saveReverted ${isSaveOn} and saved ${saved.name} with the reset ${reset}`
      longTest(`${name}: the agent is told of the copy as the answer and the setting allow`,  async ($, on) => {
        await inSession({ $, on }, async project => {
          await $.turn.start({ text: 'go', turnId: 't1' })
          await project.clock.advance(DECIDE_MS)
          project.setReport(WARNINGS)
          project.workspace.revertPrints = () => (reset === 'done'
            ? { code: WORKED_EXIT, text: JSON.stringify({ reverted: true, reset, ...saved.field }) }
            : { code: FAILED_EXIT, text: JSON.stringify({ error: 'it broke', reset, ...saved.field }) })
          project.willChange(['a.py'], 'f1')
          await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
          await project.clock.advance(SETTLE_MS)
          const notices = toldPlain(project).filter(text => text.startsWith(reset === 'done' ? REVERTED_OPENING : TRIED_OPENING))
          expect(notices.length).toBe(1)
          const [notice] = notices
          const names = saved.name === 'a ref'
          expect(notice?.includes(SAVED_REF)).toBe(names)
          expect(notice?.includes(SETTING_CLAIM)).toBe(saved.name === 'null' && !isSaveOn)
          expect(UNKNOWN_COPY.test(notice ?? '')).toBe(!names && !(saved.name === 'null' && !isSaveOn))
        }, { settings: isSaveOn ? undefined : KEEPS_NOTHING })
      })
    }
  }
}
