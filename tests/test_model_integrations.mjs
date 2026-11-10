/** Each real integration and shared checker must honor TLC-derived result and guard observations. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { integrationHost } from './fixtures/integration-model-host.mjs'

const traces = JSON.parse(readFileSync(new URL('./fixtures/model-traces.json', import.meta.url), 'utf8')).filter(trace => trace.kind === 'check')

for (const kind of ['pi', 'opencode1', 'opencode2']) {
  for (const trace of traces) {
    test(`${kind} model conformance: ${trace.name}`, async t => {
      const host = await integrationHost(t, kind)
      let version = 0, first = true
      for (let index = 0; index < trace.events.length; index++) {
        const event = trace.events[index], expected = trace.expected[index + 1]
        // The agent starts an edit with its editing tool, whose before-tool hook runs before the tool changes anything.
        if (event === 'Edit') await host.repair()
        if (event === 'Edit' || event === 'Move') {
          version++
          if (first && trace.name.includes('during initial check')) host.overlap()
          else host.edit(version)
          if (event === 'Move') host.move()
        }
        if (event === 'Build') host.build(trace.truth[version])
        if (event === 'Read') {
          await (first ? host.start() : host.read())
          first = false
        }
        if (event === 'Complete') assert.equal(await host.complete(), expected.guarded, `completion at ${index + 1}`)
        if (event !== 'Read' && event !== 'Complete') continue
        const denied = await host.publish()
        assert.equal(denied, expected.guarded, `publication at ${index + 1}: ${JSON.stringify(host.report())}`)
        assert.deepEqual(host.report().failures, expected.failures, `reported failures at ${index + 1}`)
      }
    })
  }
}
