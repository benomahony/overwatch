import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const start = { cwd: '/repo', surface: 'terminal' as const, isInteractive: true }
const ended = { turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' as const }
const ZANITY_CLEAN = 'zanity: checked 1 file, no issues found.\n'

/** A real hook-chain fixture: the watcher goes clean, red, then clean as the test repairs it. */
function gatingProject(on: On, inherited: 'allow' | 'block' = 'allow', initial = ZANITY_CLEAN) {
  const clock = mock.clock(on)
  const calls: string[] = []
  let output = 'zanity: 0 errors and 29 warnings in 1 of 1 files\n'
  const policy = { gate: { inherited, protected_actions: [{ tool: 'Publish', checks: ['zanity'] }] } }
  mock.env(on, { PATH: '/usr/bin' })
  on('fs.read', ($, e) => e.path.endsWith('/.overwatch.json') ? { value: JSON.stringify(policy) } : { deny: 'missing' })
  on('fs.exists', ($, e) => ({ value: ['/repo/.git', '/usr/bin/zanity'].includes(e.path) }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: initial }
    await clock.sleep(1000)
    yield { stream: 'stdout' as const, text: output }
    await clock.sleep(1000)
    yield { stream: 'stdout' as const, text: output }
    return { value: { code: 0, signal: null } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => { calls.push('complete'); return { text: e.answer } })
  on('tool.call', ($, e) => { calls.push(e.tool); return { result: 'ok' } })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  return { clock, calls, repair: () => { output = ZANITY_CLEAN } }
}

test('a failing watcher permits diagnostic and repair tool calls', async ($, on) => {
  const { clock, calls } = gatingProject(on)
  try {
    await $.session.start(start)
    await clock.advance(1500)
    await $.tool.call({ tool: 'Read', file_path: '/repo/example.py' })
    await $.tool.call({ tool: 'Edit', file_path: '/repo/example.py', old_string: 'a', new_string: 'b' })
    for (const command of ['rg --files', 'cat example.py', 'zanity check .', 'pytest']) {
      await $.tool.call({ tool: 'Bash', command })
    }
    expect(calls).toEqual(['Read', 'Edit', 'Bash', 'Bash', 'Bash', 'Bash'])
  } finally {
    const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
    await clock.advance(1000)
    await ending
  }
})

for (const inherited of ['allow', 'block'] as const) {
  test(`inherited watcher findings follow the ${inherited} policy without denying inspection`, async ($, on) => {
    const warnings = 'zanity: 0 errors and 29 warnings in 1 of 1 files\n'
    const { clock, calls } = gatingProject(on, inherited, warnings)
    try {
      await $.session.start(start)
      await clock.advance(1500)
      await $.tool.call({ tool: 'Read', file_path: '/repo/example.py' })
      try { await $.tool.call({ tool: 'Publish' }) } catch { /* Protected actions may be denied under the strict policy. */ }
      await $.turn.complete(ended)
      expect(calls).toEqual(inherited === 'block' ? ['Read'] : ['Read', 'Publish', 'complete'])
    } finally {
      const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
      await clock.advance(1000)
      await ending
    }
  })
}

test('failure gates protect publication and completion until a passing watcher report', async ($, on) => {
  const { clock, calls, repair } = gatingProject(on)
  try {
    await $.session.start(start)
    await clock.advance(1500)
    await $.turn.start({ text: 'finish', turnId: 't1' })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { await $.tool.call({ tool: 'Publish' }) } catch { /* A denial must not reach the tool implementation. */ }
      try { await $.turn.complete(ended) } catch { /* A denial must not reach the completion implementation. */ }
    }
    expect(calls).toEqual([])
    repair()
    await clock.advance(1000)
    await $.tool.call({ tool: 'Publish' })
    await $.turn.complete(ended)
    expect(calls).toEqual(['Publish', 'complete'])
  } finally {
    const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
    await clock.advance(1000)
    await ending
  }
})
