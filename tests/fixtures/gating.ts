import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import { assert } from '../../hooks/assert'
import { QUIET_MS } from '../../hooks/delivery'

export const start = { cwd: '/repo', surface: 'terminal' as const, isInteractive: true }
export const ended = { turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' as const }
/** A fake watcher reports every REPORT_MS, a little after QUIET_MS, so that each report is judged before the next arrives. A scenario advances its clock by whole intervals, so that each advance ends as a report arrives: one that ends between a judgement and the next arrival makes the host wait about a second of real time, and a few of those pass the runner's limit. */
export const REPORT_MS = QUIET_MS + 50
/** Two report intervals. A report that arrives in the first is judged, after a quiet wait, before the second arrives; one that arrived just before it is judged and its message sent. */
export const JUDGED_MS = 2 * REPORT_MS
/** How long a fake watcher runs before it exits. */
const WATCHER_LIFETIME_MS = 4000
const ZANITY_CLEAN = 'zanity: checked 1 file, no issues found.\n'

type ProjectOptions = { inherited?: 'allow' | 'block'; initial?: string; withZig?: boolean }

/** A real hook chain with independently controlled watcher results and recorded prompts and tool calls. */
export function gatingProject(on: On, options: ProjectOptions = {}) {
  const { inherited = 'allow', initial = ZANITY_CLEAN, withZig = false } = options
  assert(['allow', 'block'].includes(inherited), `inherited policy ${inherited} must be allow or block`)
  assert(initial.startsWith('zanity: '), `initial output ${JSON.stringify(initial)} must be a zanity summary`)
  mock.session(on)
  const clock = mock.clock(on)
  const calls: string[] = []
  on('ui.status', () => ({ value: undefined }))
  const prompts: string[] = []
  let zigOutput = 'Build Summary: 2/3 steps succeeded (1 failed); 0/1 tests passed (1 failed)\n'
  let output = 'zanity: 0 errors and 29 warnings in 1 of 1 files\n'
  const policy = { gate: { inherited, protected_actions: [{ tool: 'Publish', checks: ['zanity'] }] } }
  mock.env(on, { PATH: '/usr/bin' })
  on('fs.read', ($, e) => e.path.endsWith('/.overwatch.json') ? { value: JSON.stringify(policy) } : { deny: 'missing' })
  on('fs.exists', ($, e) => ({ value: ['/repo/.git', '/usr/bin/zanity', ...(withZig ? ['/repo/build.zig'] : [])].includes(e.path) }))
  on('process.spawn', async function* ($, e) {
    const isZig = e.argv[0] === 'zig'
    yield { stream: 'stdout' as const, text: isZig ? 'Build Summary: 3/3 steps succeeded; 1/1 tests passed\n' : initial }
    for (let report = 0; report < Math.floor(WATCHER_LIFETIME_MS / REPORT_MS); report++) {
      await clock.sleep(REPORT_MS)
      yield { stream: 'stdout' as const, text: isZig ? zigOutput : output }
    }
    return { value: { code: 0, signal: null } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => { calls.push('complete'); return { text: e.answer } })
  on('tool.call', ($, e) => { calls.push(e.tool); return { result: 'ok' } })
  on('prompt.submit', ($, e) => { prompts.push(e.text); return { text: e.text } })
  return { clock, calls, prompts, setZigReport: (report: string) => { zigOutput = report }, setReport: (report: string) => { output = report }, repair: () => { output = ZANITY_CLEAN } }
}
