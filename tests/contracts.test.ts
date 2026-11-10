/** Every Claude contract observation comes from TLC, through the production hook chain. */
import { expect, test } from 'claude-code/testing'
import { CONTRACT_TRACES } from './fixtures/integration-contract'
import { modelHost } from './fixtures/model-host'

for (const trace of CONTRACT_TRACES.filter(trace => trace.host === 'claude')) {
  test(`Claude host contract: ${trace.name}`, async () => {
    const names = { primary: 'zig', secondary: 'zanity' } as const
    const host = modelHost({ multi: true, inherited: trace.inherited, checks: trace.selected.map(key => names[key]) })
    const begin = () => host.fire('session.start', { cwd: '/repo', surface: 'terminal', isInteractive: true })
    const snapshot = async (reports: { readonly primary: readonly string[]; readonly secondary: readonly string[] }) => {
      const body = reports.primary.map(name => `error: '${name}' failed:\n`).join('')
      await host.emit(body + (reports.primary.length ? 'Build Summary: 2/3 steps succeeded (1 failed)\n' : 'Build Summary: 3/3 steps succeeded\n'))
      await host.emit(reports.secondary.length ? 'zanity: 0 errors, 1 warning in 1/1 files.\n' : 'zanity: checked 1 file, no issues found.\n', 'zanity')
      await host.timer('read'); await host.timer('read')
    }
    await begin()
    await snapshot(trace.baseline)
    if (trace.inTurn) await host.fire('turn.start', { text: 'work', turnId: 'contract' })
    // The model's starting reports, like each Finish, follow the session's own change; OutsideFinish follows another process's.
    const edit = () => host.fire('tool.call', { tool: 'Edit', file_path: '/repo/main.zig', old_string: 'a', new_string: 'b' })
    await edit()
    await snapshot(trace.reports)
    let response = 'none', stopped = false, pending: Promise<void> | undefined
    try {
      for (let index = 0; index < trace.events.length; index++) {
        const event = trace.events[index]!, expected = trace.expected[index + 1]!
        if (event.startsWith('Request')) {
          pending = (async () => {
          const kind = event.slice(7).toLowerCase()
          if (kind === 'complete') {
            const before = host.snapshot().completions
            await host.fire('turn.complete', { turnId: 'contract', answer: '', isAborted: false, reason: 'answer' })
            response = host.snapshot().completions > before ? 'allow' : 'block'
          } else {
            const result = await host.fire('tool.call', { tool: kind === 'publish' ? 'Publish' : kind === 'repair' ? 'Edit' : 'Read' }) as { deny?: string }
            response = result?.deny ? 'deny' : 'allow'
          }
          })()
        }
        if (event === 'Respond' || event === 'Poll') { await pending; expect(response).toBe(expected.decision) }
        if (event === 'Begin' && !stopped) await edit()
        if (event === 'Finish' || event === 'OutsideFinish' || event === 'LateFinish' && !stopped) await snapshot(trace.next)
        if (event === 'Report' && !stopped) await snapshot(index > 0 && trace.events.slice(0, index).some(each => each === 'Finish' || each === 'OutsideFinish') ? trace.next : trace.reports)
        if (event === 'Deliver' && !stopped) await host.timer('flush')
        if (event === 'Stop') { stopped = true; await host.fire('session.end', { reason: 'prompt_input_exit', sessionId: 's1' }) }
        if (event === 'Work') await host.fire('tool.call', { tool: 'Read' })
        if (event === 'Turn') await host.fire('turn.start', { text: 'a person asks again', turnId: 'contract' })
        if (event === 'CorrectionTurn') await host.fire('turn.start', { text: host.snapshot().prompts.at(-1) ?? 'work', turnId: 'contract' })
        if (event === 'StartTurn') await host.fire('turn.start', { text: 'work', turnId: 'contract' })
        if (event === 'Restart') { stopped = false; await begin(); await snapshot(trace.reports) }
        if (event === 'Deliver') {
          const count = [...host.snapshot().messages, ...host.snapshot().prompts].filter(text => text.includes('failed after the latest change')).length
          expect(count).toBe(expected.contexts)
        }
        if (event === 'Report' && !stopped) {
          // Each trace's failures is its own literal tuple; read them all as the checks they name.
          const failures: readonly string[] = expected.failures
          for (const key of ['primary', 'secondary'] as const) {
            const part = host.snapshot().status.split(' · ').find(text => text.includes(names[key]))
            expect(part?.includes('✗')).toBe(failures.includes(key))
          }
        }
        expect(host.snapshot().prompts.filter(text => text.startsWith('overwatch: this action')).length).toBe(expected.corrections)
        expect(host.snapshot().prompts.filter(text => text.includes('failed after the latest change')).length).toBe(expected.wakes)
        if (event === 'Stop') expect(host.snapshot().status).toBe('')
      }
    } finally {
      if (!stopped) await host.fire('session.end', { reason: 'prompt_input_exit', sessionId: 's1' })
    }
  })
}
