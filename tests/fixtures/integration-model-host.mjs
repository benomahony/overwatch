/** Native plugin callbacks with the real Python checker and isolated repository files. */
import assert from 'node:assert/strict'
import { stopDaemons } from './daemons.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { serialChecker } from '../../engine/check.js'
import { createV1Hooks, setupV2 } from '../../integrations/opencode.js'
import { registerPi } from '../../integrations/pi.js'

/** The runner's output bytes for a model input, without deriving any expected decisions. */
export function buildOutput(names) {
  assert(Array.isArray(names), `runner names ${names} must be an array`)
  const body = names.map(name => `error: '${name}' failed:\n`).join('')
  const summary = names.length ? `Build Summary: 2/3 steps succeeded (1 failed); 0/${names.length} tests passed (${names.length} failed)\n`
    : 'Build Summary: 3/3 steps succeeded; 1/1 tests passed\n'
  assert(summary.endsWith('\n'), `runner summary ${summary} must close its line`)
  return body + summary
}

/** A pushable event subscription that acknowledges each event after the production loop handles it. */
function eventStream() {
  let deliver, acknowledge
  const source = {
    async *subscribe({ signal }) {
      while (!signal.aborted) {
        const event = await new Promise(resolve => { deliver = resolve; signal.addEventListener('abort', () => resolve(undefined), { once: true }) })
        if (event === undefined) return
        yield event
        acknowledge()
      }
    },
    async send(event) {
      assert(deliver !== undefined, `event subscription is not ready for ${event.type}`)
      await new Promise(resolve => { acknowledge = resolve; deliver(event) })
    },
  }
  assert(typeof source.subscribe === 'function', 'model event source needs subscribe()')
  return source
}

export function piHost(project, check, session = { id: 'model' }) {
  const handlers = {}, statuses = [], contexts = []
  registerPi({ on: (name, handler) => { handlers[name] = handler } }, check)
  const ctx = { cwd: project, sessionManager: { getSessionId: () => session.id }, ui: { setStatus: (_key, text) => statuses.push(text) } }
  assert(handlers.session_start && handlers.agent_before_settle, 'Pi must register startup and settlement handlers')
  assert(statuses.length === 0, 'Pi must not publish a status before startup')
  return {
    start: () => handlers.session_start({ reason: 'startup' }, ctx),
    read: async () => {
      const result = await handlers.tool_result({ toolName: 'edit', toolCallId: 'model', input: {}, content: [] }, ctx)
      if (result?.content) contexts.push(...result.content.filter(part => part.type === 'text').map(part => part.text))
      return result
    },
    inspect: () => handlers.tool_call({ toolName: 'read', input: {} }, ctx),
    repair: () => handlers.tool_call({ toolName: 'edit', input: {} }, ctx),
    progress: () => handlers.tool_result({ toolName: 'read', input: {}, content: [] }, ctx),
    context: async () => { const result = await handlers.before_agent_start(); if (result?.message) contexts.push(result.message.content); return result },
    observation: () => ({ contexts: [...contexts], status: statuses.at(-1), warnings: 0, corrections: 0 }),
    complete: async () => (await handlers.agent_before_settle({ entries: [] }, ctx))?.continue === true,
    publish: async () => (await handlers.tool_call({ toolName: 'Publish', input: {} }, ctx))?.block === true,
    status: () => statuses.at(-1),
    close: () => handlers.session_shutdown({}, ctx),
  }
}

export function v1Host(project, check, outputs, session = { id: 'model' }) {
  const warnings = [], contexts = []
  let idleWarnings = 0
  const hooks = createV1Hooks({ directory: project, client: { tui: { showToast: async ({ body }) => warnings.push(body.message) } } }, check)
  assert(typeof hooks.event === 'function', 'OpenCode V1 needs its event hook')
  assert(warnings.length === 0, 'OpenCode V1 must not warn before an event')
  return {
    start: () => hooks.event({ event: { type: 'session.created', sessionID: session.id } }),
    read: async () => {
      const result = { output: 'edited' }
      await hooks['tool.execute.after']({ tool: 'edit', sessionID: session.id, args: {} }, result)
      if (result.output !== 'edited') contexts.push(result.output)
      return result
    },
    inspect: () => hooks['tool.execute.before']({ tool: 'read', sessionID: session.id }, { args: {} }),
    repair: () => hooks['tool.execute.before']({ tool: 'edit', sessionID: session.id }, { args: {} }),
    progress: () => hooks['tool.execute.after']({ tool: 'read', sessionID: session.id }, { output: 'read' }),
    context: () => {},
    observation: () => ({ contexts: [...contexts], warnings: idleWarnings, corrections: 0 }),
    complete: async () => {
      const before = warnings.length
      await hooks.event({ event: { type: 'session.idle', sessionID: session.id } })
      const guarded = outputs.at(-1).decision === 'block'
      assert.equal(warnings.length - before, guarded ? 1 : 0)
      idleWarnings += warnings.length - before
      return guarded
    },
    publish: async () => {
      try { await hooks['tool.execute.before']({ tool: 'Publish', sessionID: session.id }, { args: {} }); return false }
      catch (error) { assert.match(error.message, /guarded/); return true }
    },
    close: () => hooks.event({ event: { type: 'session.deleted', sessionID: session.id } }),
  }
}

export async function v2Host(project, check, outputs, session = { id: 'model' }) {
  const hooks = {}, prompts = [], contexts = [], events = eventStream()
  const close = await setupV2({ location: { directory: project },
    session: { hook: async (name, fn) => { hooks[name] = fn }, prompt: async event => prompts.push(event) },
    tool: { hook: async (name, fn) => { hooks[name] = fn } }, event: events }, check)
  assert(hooks.context && hooks['execute.after'], 'OpenCode V2 needs context and editing hooks')
  assert(prompts.length === 0, 'OpenCode V2 must not queue a prompt at setup')
  return {
    start: () => hooks.context({ sessionID: session.id, system: [] }),
    read: () => hooks['execute.after']({ tool: 'edit', sessionID: session.id, input: {} }),
    inspect: () => hooks['execute.before']({ tool: 'read', sessionID: session.id, input: {} }),
    repair: () => hooks['execute.before']({ tool: 'edit', sessionID: session.id, input: {} }),
    progress: () => hooks['execute.after']({ tool: 'read', sessionID: session.id, input: {} }),
    // OpenCode 2 checks before each model call as well, with no edit before it: where another process's change is first seen.
    notice: () => hooks.context({ sessionID: session.id, system: [] }),
    context: async () => { const event = { sessionID: session.id, system: [] }; await hooks.context(event); contexts.push(...event.system.map(part => part.text)); return event },
    observation: () => ({ contexts: [...contexts], warnings: 0, corrections: prompts.length }),
    complete: async () => {
      const before = prompts.length
      await events.send({ type: 'session.idle', sessionID: session.id })
      const guarded = outputs.at(-1).decision === 'block'
      assert(prompts.length - before <= 1, `idle event queued ${prompts.length - before} corrections; queue at most one`)
      if (!guarded) assert.equal(prompts.length, before)
      return guarded
    },
    publish: async () => {
      try { await hooks['execute.before']({ tool: 'Publish', sessionID: session.id, input: {} }); return false }
      catch (error) { assert.match(error.message, /guarded/); return true }
    }, close,
  }
}

/** All filesystem and environment changes belong to the node test's cleanup lifecycle. */
export async function integrationHost(t, kind) {
  // The engine's checks go through the watcher daemon, whose Unix socket in the data directory needs a short path.
  const root = mkdtempSync(join('/tmp', 'overwatch-model-'))
  const project = join(root, 'project'), data = join(root, 'data')
  t.after(async () => { await stopDaemons(data); rmSync(root, { recursive: true, force: true }) })
  mkdirSync(project)
  execFileSync('git', ['init', '-q', project])
  writeFileSync(join(project, '.git/HEAD'), 'a'.repeat(40) + '\n')
  writeFileSync(join(project, 'build.zig'), 'initial')
  // The fake check prints the planned result and exits, as its full suite and as its watch command, which the daemon
  // starts again for each settled request; a short settle keeps the replay quick.
  const fakeCheck = ['sh', '-c', 'cat result; if [ -f overlap ]; then echo changed > build.zig; rm overlap; fi']
  writeFileSync(join(project, '.overwatch.json'), JSON.stringify({ baseline: fakeCheck, argv: fakeCheck, settle: 0.05, watchers: { git: { enabled: false } }, gate: { protected_actions: [{ tool: 'Publish' }] } }))
  const previous = { PATH: process.env.PATH, PLUGIN_DATA: process.env.PLUGIN_DATA }
  const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
  const bin = join(root, 'bin')
  mkdirSync(bin)
  symlinkSync(python, join(bin, 'python3'))
  process.env.PATH = `${bin}:/usr/bin:/bin`
  process.env.PLUGIN_DATA = data
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const backend = serialChecker(), outputs = []
  const check = async event => { const output = await backend(event); outputs.push(output); return output }
  const host = kind === 'pi' ? piHost(project, check) : kind === 'opencode1' ? v1Host(project, check, outputs) : await v2Host(project, check, outputs)
  t.after(host.close)
  assert(project !== data, `model state ${data} must be outside project ${project}`)
  assert(outputs.length === 0, 'creating an integration must not run a check')
  return { ...host,
    build: names => writeFileSync(join(project, 'result'), buildOutput(names)),
    edit: version => writeFileSync(join(project, 'build.zig'), `version ${version}`),
    overlap: () => writeFileSync(join(project, 'overlap'), ''),
    move: () => writeFileSync(join(project, '.git/HEAD'), 'b'.repeat(40) + '\n'),
    report: () => {
      const name = readdirSync(data).find(name => name.endsWith('.json') && !name.endsWith('.baseline.json'))
      assert(name, `checker saved no state under ${data}`)
      return JSON.parse(readFileSync(join(data, name), 'utf8')).state.reports[0]
    },
  }
}
