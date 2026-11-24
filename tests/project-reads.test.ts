import { expect } from 'claude-code/testing'
import { ReadTimeout, branchOf, commitOf, findSubprojects, findWatchers, hasMarker, isCommitted, onPath, readSettings, repositoryOf } from '../hooks/project'
import { CommandError } from '../hooks/tcr'
import type { EngineInterface } from 'claude-code'
import { toolchainOf } from '../hooks/toolchain'
import { turnOfEventLoop } from './fixtures/event-loop'
import { longTest } from './fixtures/tcr-session'

const COMMIT = 'a'.repeat(40)
const OTHER_COMMIT = 'b'.repeat(40)
const SETTLE_TICKS = 5
const MOST_LIMITS = 20

type Files = { exists?: (path: string) => Promise<boolean>; read?: (path: string) => Promise<string> }

const never = () => new Promise<never>(() => undefined)

/** The host as a project's files answer it: what `files` says, and every call it leaves out never answers, as a named pipe does. */
function hostOf(files: Files) {
  const timers: (() => void)[] = []
  const $ = {
    env: { get: async () => '/usr/bin' },
    clock: { after: (_ms: number, run: () => void) => { timers.push(run); return { cancel: () => undefined } } },
    fs: {
      exists: files.exists ?? never,
      read: files.read ?? never,
      stat: files.exists === undefined ? never : () => Promise.reject(new Error('no stat')),
      list: never,
    },
  }
  const runLimits = async () => {
    for (let tick = 0; tick < SETTLE_TICKS; tick += 1) await turnOfEventLoop()
    for (const run of timers.splice(0)) run()
  }
  return { $: $ as never, runLimits }
}

longTest('a repository at the root of the filesystem has its commit read, with no assert over its path', async () => {
  const { $ } = hostOf({
    exists: async path => path === '/.git',
    read: async path => (path === '/.git/HEAD' ? COMMIT : path === '/.git' ? '' : Promise.reject(new Error('missing'))),
  })
  expect(await repositoryOf($, '/')).toBe('/')
  expect(await commitOf($, '/')).toBe(COMMIT)
  expect(await branchOf($, '/')).toBeUndefined()
})

longTest('a HEAD that names a ref from the root has no commit and breaks nothing', async () => {
  const { $ } = hostOf({
    exists: async path => path === '/repo/.git',
    read: async path => (path === '/repo/.git/HEAD' ? 'ref: /x\n' : Promise.reject(new Error('missing'))),
  })
  expect(await commitOf($, '/repo')).toBeUndefined()
})

longTest('a HEAD that names a ref with a step up has no commit and breaks nothing', async () => {
  const { $ } = hostOf({ read: async path => (path === '/repo/.git/HEAD' ? 'ref: ../../x\n' : path === '/repo/.git/../../x' ? OTHER_COMMIT : Promise.reject(new Error('missing'))) })
  expect(await commitOf($, '/repo')).toBeUndefined()
})

longTest('a directory that is no absolute path is no repository, and a repository named like the settings file has its settings read', async () => {
  const { $ } = hostOf({ exists: async path => path === '/.overwatch.json/.overwatch.json', read: async () => '{"mode":"tcr"}' })
  expect(await repositoryOf($, 'C:\\project')).toBeUndefined()
  expect(await readSettings($, '/.overwatch.json')).toEqual({ mode: 'tcr' })
})

longTest('a program named by an empty argv entry has no toolchain and breaks nothing', async () => {
  const { $ } = hostOf({})
  expect(await toolchainOf($, '')).toBeUndefined()
})

const HEAD_FILE = '/repo/.git/HEAD'
const REFLOG_FILE = '/repo/.git/logs/HEAD'
const ENTRY_NODE_MODULES = new Set(['node_modules'])

/** Runs the limits of the reads that `pending` waits on until it settles, and gives how it ended. */
async function endsAt(runLimits: () => Promise<void>, pending: Promise<unknown>) {
  let isDone = false
  const settled = pending.then(() => { isDone = true }, () => { isDone = true })
  for (let round = 0; round < MOST_LIMITS && !isDone; round += 1) await runLimits()
  await settled
  return pending
}

const READS: [string, Files, ($: EngineInterface) => Promise<unknown>][] = [
  ['the search for the repository', {}, $ => repositoryOf($, '/repo')],
  ['the settings', {}, $ => readSettings($, '/repo')],
  ['HEAD', { read: path => (path === HEAD_FILE ? never() : Promise.reject(new Error('missing'))) }, $ => commitOf($, '/repo')],
  ['the branch', { read: path => (path === HEAD_FILE ? never() : Promise.reject(new Error('missing'))) }, $ => branchOf($, '/repo')],
  ['the reflog', { read: path => (path === REFLOG_FILE ? never() : Promise.reject(new Error('missing'))) }, $ => isCommitted($, '/repo', COMMIT, OTHER_COMMIT)],
  ['the entries of the root', {}, $ => findSubprojects($, '/repo')],
  ['a marker below a sub-project', {}, $ => hasMarker($, '/repo/web', ENTRY_NODE_MODULES, 'node_modules/.bin/vitest')],
  ['a marker at the root', {}, $ => findWatchers($, '/repo', {})],
  ['PATH', { exists: () => never() }, $ => onPath($, 'zanity')],
  ['the toolchain of a watch command', { exists: () => never() }, $ => toolchainOf($, 'zanity')],
]

for (const [what, files, read] of READS) {
  longTest(`a read of ${what} that never answers ends at the limit as a ReadTimeout, a failure TCR tells, and gives no fallback`, async () => {
    const { $, runLimits } = hostOf(files)
    const error: unknown = await endsAt(runLimits, read($)).then(() => undefined, (failure: unknown) => failure)
    expect(error).toBeInstanceOf(ReadTimeout)
    expect(error).toBeInstanceOf(CommandError)
    expect((error as Error).message).toBe("a read of the project's files took longer than 20s")
  })
}
