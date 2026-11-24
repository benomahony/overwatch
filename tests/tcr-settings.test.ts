import { expect } from 'claude-code/testing'
import { inSession, told, SETTLE_MS, DECIDE_MS, longTest } from './fixtures/tcr-session'

const NOT_OBJECTS: [string, unknown][] = [['an array', []], ['a number', 5], ['null', null], ['a string', 'x'], ['a boolean', true]]

for (const [name, raw] of NOT_OBJECTS) {
  longTest(`a settings file that holds ${name} is reported and TCR does not act, with no failure of the plugin`,  async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(SETTLE_MS)
      expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('.overwatch.json must contain a JSON object'))).toBe(true)
      project.willChange(['a.py'], 'f1')
      await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
      await project.clock.advance(SETTLE_MS)
      expect(project.workspace.commits).toEqual([])
      expect(project.workspace.reverted).toEqual([])
    }, { rawSettings: raw })
  })

  longTest(`a settings file that comes to hold ${name} while TCR runs is reported at the next turn start`, async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(DECIDE_MS)
      project.setSettings(raw)
      await $.turn.start({ text: 'again', turnId: 't2' })
      await project.clock.advance(SETTLE_MS)
      expect(told(project).some(text => text.includes('TCR is unavailable') && text.includes('.overwatch.json must contain a JSON object'))).toBe(true)
    })
  })
}
