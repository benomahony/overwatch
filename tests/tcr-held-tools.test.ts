import { expect } from 'claude-code/testing'
import { inSession, beginEdit, DECIDE_MS, FINGERPRINT_MS, SETTLE_MS, longTest, type Kit } from './fixtures/tcr-session'

const EDITING_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']
const OTHER_TOOLS = ['mcp__files__write', 'WebFetch', 'Task']
const SHORT_MS = 1

/** A tool call that begins while the first editing tool's comparison of the files runs, and whether its write has landed a moment later and once the comparison is over. */
async function writtenWhileCompared({ $, on }: Kit, tool: string): Promise<{ soon: boolean; later: boolean }> {
  let result = { soon: false, later: false }
  await inSession({ $, on }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(DECIDE_MS)
    const first = beginEdit($, project, ['first.py'], 'f1')
    await project.clock.advance(SHORT_MS)
    project.willChange(['other.py'], 'f2')
    const other = $.tool.call({ tool, file_path: '/repo/other.py' })
    await project.clock.advance(SHORT_MS)
    const soon = project.workspace.dirty.includes('other.py')
    await project.clock.advance(FINGERPRINT_MS * 2)
    const later = project.workspace.dirty.includes('other.py')
    first.end()
    await project.clock.advance(SETTLE_MS)
    await Promise.all([first.done, other])
    result = { soon, later }
  }, { fingerprintDelayMs: FINGERPRINT_MS })
  return result
}

for (const tool of EDITING_TOOLS) {
  longTest(`the editing tool ${tool} that begins while the files are compared writes only after the comparison`,  async ($, on) => {
    expect(await writtenWhileCompared({ $, on }, tool)).toEqual({ soon: false, later: true })
  })
}

for (const tool of OTHER_TOOLS) {
  longTest(`the tool ${tool}, which is no editing tool, is not held and writes while the files are compared, a limit of the README`,  async ($, on) => {
    expect(await writtenWhileCompared({ $, on }, tool)).toEqual({ soon: true, later: true })
  })
}
