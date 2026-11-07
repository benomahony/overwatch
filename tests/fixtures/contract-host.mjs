/** Real command-hook processes and native callbacks for the integration contract. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { serialChecker } from '../../engine/check.js'
import { piHost, v1Host, v2Host, buildOutput } from './integration-model-host.mjs'

const NAMES = { primary: 'zig', secondary: 'zanity' }

function shellPath(path) {
  assert(typeof path === 'string' && !path.includes('\0'), `invalid fixture path ${path}`)
  const quoted = "'" + path.replaceAll("'", "'\\''") + "'"
  assert(quoted.startsWith("'") && quoted.endsWith("'"), `fixture path ${path} lost shell quotes`)
  return quoted
}

async function bounded(promise, label) {
  let timer
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} waited behind a held check`)), 1500) })
    return await Promise.race([promise, timeout])
  } finally { clearTimeout(timer) }
}

async function started(path) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (existsSync(path)) return
    await delay(10)
  }
  throw new Error(`check never acquired its session lock: no ${path}`)
}

function contractFiles(t, trace) {
  const root = mkdtempSync(join(tmpdir(), 'overwatch-contract-'))
  let dispose = async () => {}
  t.after(async () => { await dispose(); rmSync(root, { recursive: true, force: true }) })
  const project = join(root, 'project'), bin = join(root, 'bin'), data = join(root, 'data')
  mkdirSync(project); mkdirSync(bin)
  execFileSync('git', ['init', '-q', project])
  writeFileSync(join(project, 'build.zig'), 'initial')
  const checkNames = trace.selected.map(name => NAMES[name])
  writeFileSync(join(project, '.overwatch.json'), JSON.stringify({ baseline: ['zig', 'full'], gate: {
    inherited: trace.inherited, protected_actions: [{ tool: 'Publish', checks: checkNames }],
  } }))
  const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
  symlinkSync(python, join(bin, 'python3'))
  const held = shellPath(join(root, 'hold')), released = shellPath(join(root, 'release')), began = shellPath(join(root, 'started'))
  writeFileSync(join(bin, 'zig'), `#!/bin/sh\nif [ -e ${held} ]; then touch ${began}; i=0; while [ ! -e ${released} ] && [ "$i" -lt 500 ]; do sleep 0.01; i=$((i+1)); done; fi\ncat ${shellPath(join(root, 'primary'))}\n`, { mode: 0o755 })
  writeFileSync(join(bin, 'zanity'), `#!/bin/sh\ncat ${shellPath(join(root, 'secondary'))}\n`, { mode: 0o755 })
  const old = { PATH: process.env.PATH, PLUGIN_DATA: process.env.PLUGIN_DATA }
  process.env.PATH = `${bin}:/usr/bin:/bin`; process.env.PLUGIN_DATA = data
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  let version = 0
  assert(project !== data, `contract state ${data} must be outside project ${project}`)
  return {
    root, project, data, cleanup(fn) { dispose = fn },
    set(reports) {
      writeFileSync(join(root, 'primary'), buildOutput(reports.primary))
      writeFileSync(join(root, 'secondary'), reports.secondary.length ? 'zanity: 0 errors, 1 warning in 1/1 files.\n' : 'zanity: checked 1 file, no issues found.\n')
      writeFileSync(join(project, 'build.zig'), `version ${++version}`)
    },
    hold() { rmSync(join(root, 'release'), { force: true }); rmSync(join(root, 'started'), { force: true }); writeFileSync(join(root, 'hold'), '') },
    release() { writeFileSync(join(root, 'release'), ''); rmSync(join(root, 'hold'), { force: true }) },
    waiting: () => started(join(root, 'started')),
    failures(id) {
      const file = createHash('sha256').update(`${id}\0${realpathSync(project)}`).digest('hex') + '.json'
      assert(file, `no contract session state under ${data}`)
      const reports = JSON.parse(readFileSync(join(data, file), 'utf8')).state.reports
      return Object.keys(NAMES).filter(key => reports.some(report => report.name === NAMES[key] && report.failed))
    },
  }
}

function codexHost(project, check, session) {
  const contexts = []
  let closed = false
  const event = async (kind, tool = '') => {
    const output = await check({ hook_event_name: kind, session_id: session.id, cwd: project, tool_name: tool, tool_input: {} })
    const text = output.hookSpecificOutput?.additionalContext
    if (!closed && text) contexts.push(text)
    return output
  }
  assert(typeof check === 'function', `Codex checker is ${typeof check}`)
  assert(contexts.length === 0, 'Codex context must start empty')
  return {
    start: () => event('SessionStart'), read: () => event('PostToolUse', 'Edit'), notice: () => event('UserPromptSubmit'),
    inspect: () => event('PreToolUse', 'Read'), repair: () => event('PreToolUse', 'Edit'),
    publish: async () => (await event('PreToolUse', 'Publish')).hookSpecificOutput?.permissionDecision === 'deny',
    complete: async () => (await event('Stop')).decision === 'block',
    progress: () => event('PostToolUse', 'Read'), context: () => {}, close: () => { closed = true }, observation: () => ({ contexts: [...contexts], warnings: 0, corrections: 0 }),
  }
}

/** Native host setup is independent of the input program and its expected observations. */
async function nativeContractHost({ trace, files, check, outputs, session }) {
  if (trace.host === 'codex') return codexHost(files.project, check, session)
  if (trace.host === 'pi') return piHost(files.project, check, session)
  if (trace.host === 'opencode1') return v1Host(files.project, check, outputs, session)
  return v2Host(files.project, check, outputs, session)
}

class ContractRunner {
  constructor({ trace, files, check, outputs, session, host }) {
    Object.assign(this, { trace, files, check, outputs, session, host })
    this.history = []
    this.ready = false
    this.response = 'none'
    this.stopped = false
  }

  /** Starts a check on the next snapshot: read after the session's edit, or noticed at a hook no edit precedes when another process made the change. */
  async begin(outside = false) {
    this.outside = outside
    this.files.hold()
    this.files.set(this.trace.reports)
    this.running = outside ? this.host.notice() : this.host.read()
    await this.files.waiting()
  }

  /** Reads the latest snapshot again through the hook that saw its change: the session's edit, or another process's. */
  reread() {
    assert(typeof this.host.read === 'function', `the ${this.trace.host} driver has no read`)
    return this.outside ? this.host.notice() : this.host.read()
  }

  request(event) {
    this.ready = false; this.response = 'none'
    const kind = event.slice('Request'.length).toLowerCase()
    this.pending = Promise.resolve().then(async () => {
      if (kind === 'inspect' || kind === 'repair') {
        const value = await this.host[kind]()
        return value?.block || value?.hookSpecificOutput?.permissionDecision === 'deny' ? 'deny' : 'allow'
      }
      if (kind === 'publish') return await this.host.publish() ? 'deny' : 'allow'
      const denied = await this.host.complete()
      return denied ? ({ codex: 'block', pi: 'continue', opencode1: 'warn', opencode2: 'queue' }[this.trace.host]) : 'allow'
    }).then(value => { if (!this.stopped) { this.ready = true; this.response = value } }).catch(error => { if (!this.stopped) throw error })
  }

  async respond(event, expected) {
    if (expected.ready) await bounded(this.pending, `${this.trace.host} ${this.trace.name}`)
    else await delay(80)
    assert.equal(this.ready, expected.ready, `${event} readiness while check held`)
    if (this.ready) assert.equal(this.response, expected.decision, `${event} decision`)
  }

  async restart() {
    this.history.push(this.host.observation())
    this.stopped = false
    this.session.id = 'restarted'
    this.host = await nativeContractHost({ trace: this.trace, files: this.files, check: this.check, outputs: this.outputs, session: this.session })
    await this.host.start()
  }

  observe(event, expected) {
    const current = this.host.observation()
    const all = [...this.history, current]
    if (event === 'Report' && !this.stopped) assert.deepEqual(this.files.failures(this.session.id), expected.failures)
    if (event === 'Deliver' || event === 'Report') {
      const count = all.flatMap(value => value.contexts).filter(text => text.includes('failed after the latest change')).length
      if (expected.delivery === 'event' || event === 'Deliver') assert.equal(count, expected.contexts, 'failure contexts')
      if (expected.persistentStatus && !this.stopped) {
        for (const key of Object.keys(NAMES)) {
          const part = current.status?.split(' · ').find(part => part.includes(NAMES[key]))
          assert(part, `no persistent status for ${key}: ${current.status}`)
          assert.equal(part.includes('✗'), expected.failures.includes(key))
        }
      }
    }
    if (event === 'Stop' && expected.persistentStatus) assert.equal(current.status, undefined, 'shutdown must clear status')
    assert.equal(all.reduce((sum, value) => sum + value.corrections, 0), expected.corrections, 'queued corrections')
    assert.equal(all.reduce((sum, value) => sum + value.warnings, 0), expected.warnings, 'idle warnings')
    assert.equal(this.trace.host === 'opencode2' ? all.reduce((sum, value) => sum + value.corrections, 0) : 0, expected.wakes, 'idle wakeups')
  }

  /** Releases the held check with the trace's next snapshot and waits for its result. */
  async finish() {
    this.files.set(this.trace.next)
    this.files.release()
    await this.running
    this.running = undefined
  }

  /** Closes the session, cancelling any reply still outstanding. */
  async stop() {
    this.stopped = true
    this.ready = true
    this.response = 'cancelled'
    await this.host.close()
  }

  async step(event, expected) {
    // Trace event names, as scripts/integration_traces.py writes them, to the host steps that replay them.
    const actions = new Map([
      ['Respond', () => this.respond(event, expected)], ['Poll', () => this.respond(event, expected)],
      ['Work', () => this.host.progress()],
      ['Begin', () => this.begin(false)], ['OutsideBegin', () => this.begin(true)],
      ['Finish', () => this.finish()], ['OutsideFinish', () => this.finish()], ['LateFinish', () => this.finish()],
      ['Report', () => (this.stopped || this.running ? undefined : this.reread())],
      ['Deliver', () => (this.stopped ? undefined : this.host.context())],
      ['Stop', () => this.stop()], ['Restart', () => this.restart()],
    ])
    if (event.startsWith('Request')) this.request(event)
    await actions.get(event)?.()
    this.observe(event, expected)
  }
}

/** Each response is observed through its real host channel; no model decision is supplied to the checker. */
export async function contractHost(t, trace) {
  const files = contractFiles(t, trace), backend = serialChecker(), outputs = [], session = { id: 'contract' }
  const check = async input => { const output = await backend(input); outputs.push(output); return output }
  const payload = kind => ({ hook_event_name: kind, session_id: session.id, cwd: files.project, tool_name: 'Publish', tool_input: {},
    ...(trace.host === 'codex' ? {} : { integration: trace.host }) })
  files.set(trace.baseline)
  await check(payload('SessionStart'))
  files.set(trace.reports)
  await check(payload('PreToolUse'))
  const host = await nativeContractHost({ trace, files, check, outputs, session })
  const runner = new ContractRunner({ trace, files, check, outputs, session, host })
  files.cleanup(async () => { files.release(); if (runner.running) await runner.running; runner.host.close() })
  if (trace.busy) await runner.begin()
  assert(outputs.length >= 2, `contract setup produced ${outputs.length} outputs; establish baseline and current report`)
  return runner
}
