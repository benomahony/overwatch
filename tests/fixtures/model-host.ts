/** A deterministic host protocol for replaying model interleavings through production register. */
import type { EngineInterface, On } from 'claude-code'
import { register } from '../../hooks/register'
import { assert } from '../../hooks/assert'

type Event = Record<string, unknown>
type Handler = ($: EngineInterface, event: Event, next: (event: Event) => Promise<unknown>) => unknown
type Timer = { kind: 'read' | 'flush'; run: () => unknown; cancelled: boolean }

/** Settle bounded discovery and delivery promise chains without advancing any timers. */
async function settle() {
  for (let hop = 0; hop < 100; hop++) await Promise.resolve()
}

/** An explicitly controlled stream; returning it wakes any pending next() immediately. */
function outputStream() {
  const chunks: string[] = []
  let reader: ((result: IteratorResult<{ text: string }, { code: number; signal: null }>) => void) | undefined
  let stopped = false
  const stream = {
    [Symbol.asyncIterator]() { return this },
    next() {
      const text = chunks.shift()
      if (text !== undefined) return Promise.resolve({ done: false as const, value: { text } })
      if (stopped) return Promise.resolve({ done: true as const, value: { code: 0, signal: null } })
      return new Promise<IteratorResult<{ text: string }, { code: number; signal: null }>>(resolve => { reader = resolve })
    },
    return() {
      stopped = true
      const result = { done: true as const, value: { code: 0, signal: null } }
      reader?.(result)
      reader = undefined
      return Promise.resolve(result)
    },
  }
  assert(chunks.length === 0, 'model stream must start without buffered output')
  assert(!stopped, 'model stream must start open')
  return {
    stream,
    isStopped: () => stopped,
    async write(text: string) {
      assert(!stopped, `cannot emit ${JSON.stringify(text)} into a stopped model watcher`)
      if (reader !== undefined) {
        const resolve = reader
        reader = undefined
        resolve({ done: false, value: { text } })
      } else chunks.push(text)
      await settle()
    },
  }
}

/** The repository files and environment available to a single Zig watcher. */
type ModelOptions = { inherited?: 'allow' | 'block'; checks?: readonly string[]; multi?: boolean }

function projectIO(getCommit: () => string, options: ModelOptions) {
  const initial = getCommit()
  assert(/^[a-f0-9]{40}$/.test(initial), `model commit ${initial} must be a SHA-1 hex string`)
  const io = {
    env: { get: async (name: string) => name === 'PATH' ? '/usr/bin' : undefined },
    fs: {
      exists: async (path: string) => ['/repo/.git', '/repo/build.zig', ...(options.multi ? ['/usr/bin/zanity'] : [])].includes(path),
      read: async (path: string) => {
        if (path === '/repo/.git/HEAD') return getCommit()
        if (path === '/repo/.overwatch.json') return JSON.stringify({ gate: { inherited: options.inherited ?? 'allow', protected_actions: [{ tool: 'Publish', checks: options.checks ?? [] }] } })
        throw new Error(`model host has no file ${path}; add it to the fixture if required`)
      },
      stat: async (path: string) => ({ realPath: path }),
      list: async () => [],
    },
  }
  assert(getCommit() === initial, `constructing project I/O moved commit ${initial} to ${getCommit()}`)
  return io
}

/** Run one selected host timer, never a cancelled callback. */
async function runTimer(timers: Timer[], selected: Timer['kind']) {
  const timer = timers.findLast(each => each.kind === selected && !each.cancelled)
  if (timer === undefined) {
    assert(selected === 'flush', `model ${selected} requires a pending output timer`)
    return
  }
  timer.cancelled = true
  timer.run()
  await settle()
  assert(timer.cancelled, `model ${selected} callback became runnable again after being consumed`)
}

/** Replace only host I/O and clocks; all transitions run the production register function. */
export function modelHost(options: ModelOptions = {}) {
  const handlers = new Map<string, Handler>()
  const timers: Timer[] = []
  const messages: string[] = []
  const prompts: string[] = []
  let kind: Timer['kind'] = 'flush'
  let status = ''
  let commit = 'a'.repeat(40)
  let moves = 0
  let publications = 0
  let completions = 0
  const streams = { zig: outputStream(), zanity: outputStream() }
  // Unsupported I/O cannot fall back to the real machine.
  const host = {
    ...projectIO(() => commit, options),
    clock: {
      now: async () => 0,
      after: (_ms: number, run: () => unknown) => {
        const timer: Timer = { kind, run, cancelled: false }
        timers.push(timer)
        return { cancel: () => { timer.cancelled = true } }
      },
    },
    process: { spawn: ({ argv }: { argv: string[] }) => {
      const key = argv[0] === 'zanity' ? 'zanity' : 'zig'
      if (streams[key].isStopped()) streams[key] = outputStream()
      return streams[key].stream
    } },
    ui: { status: (text?: string) => { status = text ?? '' }, log: () => {}, toast: () => {} },
    session: { append: async (event: { message: unknown }) => { messages.push(JSON.stringify(event.message)) } },
    prompt: { submit: async ({ text }: { text: string }) => { prompts.push(text) } },
  }
  const engine = host as unknown as EngineInterface
  register(((name: string, handler: Handler) => { handlers.set(name, handler) }) as unknown as On)
  assert(handlers.has('session.start') && handlers.has('tool.call'), 'register must install session.start and tool.call for replay')
  assert(timers.length === 0 && handlers.size > 0, `register scheduled ${timers.length} timers with ${handlers.size} handlers before session.start`)
  return {
    async fire(name: string, event: Event) {
      const handler = handlers.get(name)
      assert(handler !== undefined, `model event ${name} has no registered production handler`)
      const result = await handler(engine, event, async input => {
        if (name === 'tool.call' && input.tool === 'Publish') publications++
        if (name === 'turn.complete') completions++
        return input
      })
      await settle()
      return result
    },
    async emit(text: string, checker: 'zig' | 'zanity' = 'zig') {
      kind = 'read'
      await streams[checker].write(text)
      kind = 'flush'
    },
    async timer(selected: Timer['kind']) {
      await runTimer(timers, selected)
    },
    move() { moves++; commit = moves.toString(16).padStart(40, 'b') },
    snapshot() { return { status, publications, completions, messages: [...messages], prompts: [...prompts] } },
  }
}
