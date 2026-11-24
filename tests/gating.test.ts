import { expect } from 'claude-code/testing'
import { start, ended, gatingProject } from './fixtures/gating'
import { longTest } from './fixtures/tcr-session'

longTest('a failing watcher permits diagnostic and repair tool calls', async ($, on) => {
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
  longTest(`inherited watcher findings follow the ${inherited} policy without denying inspection`, async ($, on) => {
    const warnings = 'zanity: 0 errors and 29 warnings in 1 of 1 files\n'
    const { clock, calls } = gatingProject(on, { inherited, initial: warnings })
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

longTest('a guard names each check once and ends its summaries with one full stop', async ($, on) => {
  const { clock, prompts, setReport } = gatingProject(on)
  setReport('zanity: 0 errors, 1 warning in 1/1 file.\n')
  try {
    await $.session.start(start)
    await clock.advance(1500)
    await $.turn.start({ text: 'finish', turnId: 't1' })
    await $.turn.complete(ended)
    expect(prompts.filter(text => text.includes('guarded'))).toEqual([
      'overwatch: this action is guarded while relevant checks fail. zanity: 0 errors, 1 warning in 1/1 file. Inspection, edits, and check commands remain available.',
    ])
  } finally {
    const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
    await clock.advance(1000)
    await ending
  }
})

longTest('publication and repeated completion stay guarded until passing checks release them',  async ($, on) => {
  const { clock, calls, repair } = gatingProject(on)
  try {
    await $.session.start(start)
    await clock.advance(1500)
    await $.turn.start({ text: 'finish', turnId: 't1' })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { await $.tool.call({ tool: 'Publish' }) } catch { /* A denial must not reach the tool implementation. */ }
      try { await $.turn.complete(ended) } catch { /* A denial must not reach the completion implementation. */ }
    }
    // Deduplicating correction prompts must never release the completion gate.
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

for (const stops of ['...', '..', '.', '']) {
  longTest(`a guard whose check summary ends in ${JSON.stringify(stops)} is still given: it ends the summary with one full stop`, async ($, on) => {
    const { clock, prompts, setReport } = gatingProject(on)
    setReport(`zanity: 0 errors, 1 warning in ${stops}\n`)
    try {
      await $.session.start(start)
      await clock.advance(1500)
      await $.turn.start({ text: 'finish', turnId: 't1' })
      await $.turn.complete(ended)
      const guards = prompts.filter(text => text.includes('guarded'))
      expect(guards.length).toBe(1)
      expect(guards[0]).toMatch(/1 warning in ?\. Inspection, edits, and check commands remain available\.$/)
      expect(guards[0]).not.toContain('..')
    } finally {
      const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
      await clock.advance(1000)
      await ending
    }
  })
}
