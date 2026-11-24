/** Replay TLC-derived observations through production hooks with a deterministic host. */
import { expect } from 'claude-code/testing'
import { MODEL_TRACES } from './fixtures/model-traces'
import { modelHost } from './fixtures/model-host'
import { longTest } from './fixtures/tcr-session'

for (const trace of MODEL_TRACES) {
  longTest(`model conformance: ${trace.name}`, async () => {
    const host = modelHost()
    let version = 0
    let partial = ''
    await host.fire('session.start', { cwd: '/repo', surface: 'terminal', isInteractive: true })
    try {
      for (let index = 0; index < trace.events.length; index++) {
        const event = trace.events[index]!
        const expected = trace.expected[index + 1]!
        if (event === 'Start') await host.fire('turn.start', { text: 'work', turnId: 't1' })
        if (event === 'Edit') {
          version++
          await host.fire('tool.call', { tool: 'Edit', file_path: '/repo/main.zig', old_string: 'a', new_string: 'b' })
        }
        // Another process changes the workspace: a new version with no tool call of the session's.
        if (event === 'Outside') version++
        if (event === 'Move') {
          version++
          host.move()
          await host.fire('tool.call', { tool: 'Bash', command: 'git pull' })
        }
        // Quiet is the external watcher's scheduling step; it needs no hook call.
        if (event === 'Partial' || event === 'PartialSummary' || event === 'Build') {
          const failures: readonly string[] = trace.truth[version] ?? []
          const body = failures.map(name => `error: '${name}' failed:\n`).join('')
          const summary = failures.length > 0
            ? `Build Summary: 2/3 steps succeeded (1 failed); 0/${failures.length} tests passed (${failures.length} failed)\n`
            : 'Build Summary: 3/3 steps succeeded; 1/1 tests passed\n'
          const prefix = 'Build Summary:'
          const text = event === 'Partial' ? body : event === 'PartialSummary' ? body + prefix
            : partial === 'PartialSummary' ? summary.slice(prefix.length) : (partial ? '' : body) + summary
          await host.emit(text)
          partial = event === 'Build' ? '' : event
        }
        if (event === 'Read' || event === 'Poll') await host.timer('read')
        if (event === 'Flush') await host.timer('flush')
        if (event === 'Complete') {
          const before = host.snapshot().completions
          await host.fire('turn.complete', { turnId: 't1', answer: '', isAborted: false, reason: 'answer' })
          expect(host.snapshot().completions - before).toBe(expected.guarded ? 0 : 1)
        }
        const before = host.snapshot().publications
        await host.fire('tool.call', { tool: 'Publish' })
        const snapshot = host.snapshot()
        expect({ event, step: index + 1, guarded: snapshot.publications === before }).toEqual({ event, step: index + 1, guarded: expected.guarded })
        if (expected.known) {
          const names = [...snapshot.status.matchAll(/: ([ab])(?: \+\d+ more)?$/g)].map(match => match[1])
          const extra = Number(/\+(\d+) more$/.exec(snapshot.status)?.[1] ?? 0)
          expect({ event, failed: snapshot.status.includes(' ✗ '), names, extra }).toEqual({
            event, failed: expected.failures.length > 0, names: expected.failures.slice(0, 1), extra: Math.max(0, expected.failures.length - 1),
          })
        }
        const wakes = snapshot.prompts.filter(text => !text.startsWith('overwatch: this action')).length
        expect({ event, wakes, sent: wakes + snapshot.messages.length }).toEqual({ event, wakes: expected.wakes, sent: expected.sent })
      }
    } finally {
      await host.fire('session.end', { reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
    }
  })
}
