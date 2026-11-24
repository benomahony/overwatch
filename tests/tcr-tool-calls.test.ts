import { expect } from 'claude-code/testing'
import { ended, type Workspace } from './fixtures/tcr'
import { inSession, during, told, DECIDE_MS, SETTLE_MS, FINGERPRINT_MS, longTest } from './fixtures/tcr-session'

const SCALED_LIMITS = { OVERWATCH_TCR_TIMEOUT_SCALE: '0.002' }
const PAST_LIMIT_MS = 1500

longTest('a turn that completes while the files are compared before an editing tool does not stop the tool, whose edit is then committed',  async ($, on) => {
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(SETTLE_MS)
    during(project, 'fingerprint', 1, () => void $.turn.complete(ended))
    project.willChange(['a.py'], 'f1')
    const call = $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(SETTLE_MS)
    await expect(call).resolves.toBeDefined()
    expect(project.workspace.commits).toEqual(['tcr: a.py'])
  }, { fingerprintDelayMs: FINGERPRINT_MS })
})

const FAILURES: { name: string; arrange: (workspace: Workspace) => void }[] = [
  { name: 'the command answers with an error', arrange: workspace => { workspace.fingerprintError = 'git could not read the files' } },
  { name: 'the command dies without printing', arrange: workspace => { workspace.crash = { command: 'fingerprint', code: 1 } } },
  { name: 'the command never answers', arrange: workspace => { workspace.hang = 'fingerprint' } },
]

for (const { name, arrange } of FAILURES) {
  longTest(`an editing tool still runs, and TCR says it is unavailable, when the comparison of the files before it fails because ${name}`,  async ($, on) => {
    await inSession({ $, on }, async project => {
      await $.turn.start({ text: 'go', turnId: 't1' })
      await project.clock.advance(DECIDE_MS)
      arrange(project.workspace)
      project.willChange(['a.py'], 'f1')
      const call = $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
      await project.clock.advance(PAST_LIMIT_MS)
      await expect(call).resolves.toBeDefined()
      expect(project.workspace.dirty).toEqual(['a.py'])
      expect(told(project).some(text => text.includes('TCR is unavailable'))).toBe(true)
    }, { env: SCALED_LIMITS })
  })
}
