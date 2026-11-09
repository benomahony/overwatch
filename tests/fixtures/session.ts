/** Hosts, outputs and watchers the session tests share. */
import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import { assert } from '../../hooks/assert'

export const FAILING = `test
+- run test 0 pass, 1 fail (1 total)
error: 'root.test.basic add functionality' failed:
       src/root.zig:17:5: 0x1049b466b in test.basic add functionality (test)
           try std.testing.expect(add(3, 7) == 11);

Build Summary: 3/5 steps succeeded (1 failed); 2/3 tests passed (1 failed)
test transitive failure
+- run test 0 pass, 1 fail (1 total)
`

export const PASSING = `Build Summary: 4/4 steps succeeded; 48/48 tests passed
test success
+- run test 48 pass (48 total) 1s MaxRSS:52M
`

/** A git repository with `files`, whose commands print `output`, and a second later `then.output` when given. */
export type Project = {
  files: readonly string[]
  output: string
  spawned: string[][]
  then?: { clock: ReturnType<typeof mock.clock>; output: string }
}

export const project = (on: On, { files, output, spawned, then }: Project) => {
  assert(files.every(file => file !== '' && !file.startsWith('/')), `project files ${files} must be names relative to /repo`)
  assert(spawned.length === 0, `project starts with ${spawned.length} commands already spawned; pass an empty list`)
  mock.env(on, { PATH: '/usr/bin' })
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: e.path === '/repo/.git' || files.some(file => e.path.endsWith(`/${file}`)) }))
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    yield { stream: 'stderr' as const, text: output }
    if (then !== undefined) {
      await then.clock.sleep(1000)
      yield { stream: 'stderr' as const, text: then.output }
    }
    return { value: { code: 0, signal: null } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
}

export const ZIG_WATCH = ['zig', 'build', '-Doptimize=fast', 'test', '--watch']

export const turnHooks = (on: On) => {
  const starts = on('turn.start', ($, e) => ({ turnId: e.turnId }))
  const completes = on('turn.complete', ($, e) => ({ text: e.answer }))
  assert(starts !== completes, `turn.start and turn.complete share registration ${typeof starts}; register each hook on its own`)
  assert(typeof starts.catch === 'function' && typeof completes.catch === 'function', `turn hooks registered as ${typeof starts.catch}; on() must return a registration`)
}

/** A project whose commands exit with `code`, printing `output` for each by its executable. */
export type Commands = { spawned: string[][]; output: Record<string, string>; code?: number }

export const commands = (on: On, run: Commands) => {
  assert(run.spawned.length === 0, `commands start with ${run.spawned.length} already spawned; pass an empty list`)
  assert(Object.keys(run.output).every(name => name !== '' && !name.includes(' ')), `outputs ${Object.keys(run.output)} must be keyed by executable name`)
  on('process.spawn', async function* ($, e) {
    run.spawned.push([...e.argv])
    const text = run.output[e.argv[0]!]
    if (text !== undefined) yield { stream: 'stdout' as const, text }
    return { value: { code: run.code ?? 1, signal: null } }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
}
