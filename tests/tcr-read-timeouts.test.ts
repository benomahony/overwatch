import { expect, type TestBody } from 'claude-code/testing'
import { start, tcrProject } from './fixtures/tcr'
import { toldPlain, DECIDE_MS, END_MS, JUDGE_MS, START_MS, longTest } from './fixtures/tcr-session'

type Kit = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const NEVER_MS = 10_000_000
const PAST_THE_LIMIT_MS = 4000
const LIMIT_NOTICE = "a read of the project's files took longer than"
const UNJUDGED = 'no checks are configured'
const REPOSITORY_MARKER = '/repo/.git'
const PROGRAM_PATH = '/usr/bin/zanity'
const WATCHER_TICKS = 4
const WATCHER_ENDS_MS = 3000
const HEAD_PATH = '/repo/.git/HEAD'
const FIRST_COMMIT = 'a'.repeat(40)
const SECOND_COMMIT = 'b'.repeat(40)
const SCALED_LIMITS = { OVERWATCH_TCR_TIMEOUT_SCALE: '0.004' }

type Never = { exists: string[]; read: string[]; list: string[] }

/** The hooks registrar with each call of a host function on a path of `never` left unanswered for ever, as a named pipe leaves a read. */
function leavingUnanswered(on: On, never: Never, wait: () => Promise<unknown>): On {
  const hanging = (name: keyof Never) => (path: string) => never[name].includes(path)
  const unanswered = { 'fs.exists': hanging('exists'), 'fs.read': hanging('read'), 'fs.list': hanging('list') }
  return ((name: string, handler: (host: unknown, event: { path?: string }) => unknown) => {
    const isUnanswered = unanswered[name as keyof typeof unanswered]
    if (isUnanswered === undefined) return on(name as never, handler as never)
    return on(name as never, ((host: unknown, event: { path?: string }) => (isUnanswered?.(event.path ?? '') === true ? wait() : handler(host, event))) as never)
  }) as On
}

/** A session of a project whose files answer as the fixture does, with every path of `never` never answering; `never` can grow once the session runs. */
async function inSearchOf({ $, on }: { $: Kit; on: On }, setup: { never: Never; listed?: Record<string, { name: string; kind: 'dir' | 'file' }[]>; withoutChecks?: boolean; endsAfterTicks?: number }, body: (project: ReturnType<typeof tcrProject>, files: Map<string, string>) => Promise<void>) {
  const waitForEver = () => project.clock.sleep(NEVER_MS)
  const project = tcrProject(leavingUnanswered(on, setup.never, waitForEver), { env: SCALED_LIMITS, withoutChecks: setup.withoutChecks, watcherEndsAfterTicks: setup.endsAfterTicks })
  const files = project.workspace.files
  files.set(HEAD_PATH, FIRST_COMMIT)
  on('fs.list', (_$, e) => (setup.never.list.includes(e.path) ? waitForEver() : { value: setup.listed?.[e.path] ?? [] }) as never)
  try {
    await $.session.start(start)
    await project.clock.advance(START_MS)
    await body(project, files)
  } finally {
    const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
    await project.clock.advance(END_MS)
    await ending
  }
}

async function editAndWait($: Kit, project: ReturnType<typeof tcrProject>) {
  await $.turn.start({ text: 'go', turnId: 't1' })
  await project.clock.advance(DECIDE_MS)
  project.willChange(['a.py'], 'f1')
}

function expectOneLimitNotice(project: ReturnType<typeof tcrProject>, committed = 0) {
  const told = toldPlain(project)
  expect(told.filter(text => text.includes(LIMIT_NOTICE)).length).toBe(1)
  expect(told.some(text => text.includes(UNJUDGED))).toBe(false)
  expect(told.some(text => text.includes('unexpected error'))).toBe(false)
  expect(project.workspace.commits.length).toBe(committed)
  expect(project.workspace.reverted).toEqual([])
}

const SEARCHES: [string, Parameters<typeof inSearchOf>[1]][] = [
  ['a marker below a sub-project', { never: { exists: ['/repo/web/node_modules/.bin/vitest'], read: [], list: [] }, withoutChecks: true, listed: { '/repo': [{ name: 'web', kind: 'dir' }], '/repo/web': [{ name: 'node_modules', kind: 'dir' }] } }],
  ['a marker at the root', { never: { exists: ['/repo/build.zig'], read: [], list: [] }, withoutChecks: true }],
  ['a program on PATH', { never: { exists: ['/usr/bin/zanity'], read: [], list: [] } }],
  ['the entries of the root', { never: { exists: [], read: [], list: ['/repo'] }, withoutChecks: true }],
]

for (const [what, setup] of SEARCHES) {
  longTest(`an edit made while ${what} never answers is told once that a read took longer than its limit, never that no checks are configured, and nothing is committed or reverted`,  async ($, on) => {
    await inSearchOf({ $, on }, setup, async project => {
      await editAndWait($, project)
      await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
      await project.clock.advance(PAST_THE_LIMIT_MS)
      expectOneLimitNotice(project)
    })
  })
}

longTest('an edit made while the read of HEAD never answers is told once that a read took longer than its limit, and nothing is committed or reverted',  async ($, on) => {
  const never: Never = { exists: [], read: [], list: [] }
  await inSearchOf({ $, on }, { never }, async project => {
    await editAndWait($, project)
    never.read.push(HEAD_PATH)
    const call = $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(PAST_THE_LIMIT_MS)
    await call
    await project.clock.advance(PAST_THE_LIMIT_MS)
    expectOneLimitNotice(project)
  })
})

longTest('an edit made as HEAD moves while the reflog never answers is told once that a read took longer than its limit, and nothing is committed or reverted',  async ($, on) => {
  const never: Never = { exists: [], read: ['/repo/.git/logs/HEAD'], list: [] }
  await inSearchOf({ $, on }, { never }, async (project, files) => {
    await editAndWait($, project)
    files.set(HEAD_PATH, SECOND_COMMIT)
    const call = $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    await project.clock.advance(PAST_THE_LIMIT_MS)
    await call
    await project.clock.advance(PAST_THE_LIMIT_MS)
    expectOneLimitNotice(project)
  })
})

longTest('an edit judged while the search for the repository never answers is told once that a read took longer than its limit, and nothing is committed or reverted',  async ($, on) => {
  const never: Never = { exists: [], read: [], list: [] }
  await inSearchOf({ $, on }, { never }, async project => {
    await editAndWait($, project)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    never.exists.push(REPOSITORY_MARKER)
    await project.clock.advance(JUDGE_MS + PAST_THE_LIMIT_MS)
    expectOneLimitNotice(project)
  })
})

longTest('a turn that starts while the read of the branch never answers is told once that a read took longer than its limit',  async ($, on) => {
  await inSearchOf({ $, on }, { never: { exists: [], read: [HEAD_PATH], list: [] } }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    await project.clock.advance(PAST_THE_LIMIT_MS)
    expectOneLimitNotice(project)
  })
})

longTest('a checkpoint made while the read of HEAD after it never answers is told once that a read took longer than its limit',  async ($, on) => {
  const never: Never = { exists: [], read: [], list: [] }
  await inSearchOf({ $, on }, { never }, async project => {
    await editAndWait($, project)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' })
    never.read.push(HEAD_PATH)
    await project.clock.advance(JUDGE_MS + PAST_THE_LIMIT_MS)
    expectOneLimitNotice(project, 1)
  })
})

longTest('a watcher that ends while the lookup of its program on PATH never answers is told once that a read took longer than its limit, never as an unexpected error',  async ($, on) => {
  const never: Never = { exists: [], read: [], list: [] }
  await inSearchOf({ $, on }, { never, endsAfterTicks: WATCHER_TICKS }, async project => {
    await $.turn.start({ text: 'go', turnId: 't1' })
    never.exists.push(PROGRAM_PATH)
    await project.clock.advance(WATCHER_ENDS_MS + PAST_THE_LIMIT_MS)
    expectOneLimitNotice(project)
  })
})
