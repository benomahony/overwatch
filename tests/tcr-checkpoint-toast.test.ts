import { expect } from 'claude-code/testing'
import { CLEAN } from './fixtures/tcr'
import { edit, inSession, DECIDE_MS, longTest } from './fixtures/tcr-session'

const FORGED_COMMIT = 'abc\noverwatch: FORGED'
const SHORT_FORGED = 'abc\nove'
const CHECKPOINT_TOAST = 'overwatch: TCR checkpoint '

function messageOf(toast: string): string {
  const event = JSON.parse(toast) as Record<string, unknown>
  return Object.values(event).filter((value): value is string => typeof value === 'string').join('')
}

longTest('a commit the checkpoint command names with a line break reaches the toast written as an escape, with no new line',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    project.setReport(CLEAN)
    project.workspace.commitText = FORGED_COMMIT
    await edit($, project, ['a.py'], 'f1')
    const messages = project.toasts.map(messageOf).filter(text => text.startsWith(CHECKPOINT_TOAST))
    expect(messages).toEqual([`${CHECKPOINT_TOAST}abc\\x0aove`])
    expect(messages.some(text => text.includes(SHORT_FORGED))).toBe(false)
  })
})
