import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { assert } from '../hooks/assert'

const start = { cwd: '/repo', surface: 'terminal' as const, isInteractive: true }
const PASSING = 'Build Summary: 4/4 steps succeeded; 48/48 tests passed\n'
const FAILING = "error: 'root.test.add' failed:\nBuild Summary: 3/5 steps succeeded (1 failed); 2/3 tests passed (1 failed)\n"
const FEED = '/home/me/.cache/overwatch/feeds/zig-repo'
const ZIG_WATCH = ['zig', 'build', '-Doptimize=fast', 'test', '--watch']

/** What VS Code's overwatch writes to FEED: its latest report, the ones it reads next, a second apart, and whether its extension host still runs. */
type Feed = { latest: string; next: readonly string[]; isLive: () => boolean }

/** A zig project whose watcher VS Code's overwatch runs, writing its reports to FEED as `feed` says; `reads` holds any other file a test puts there. */
const vscodeProject = (on: On, feed: Feed) => {
  assert(feed.latest !== '' && feed.next.length > 0, `vscodeProject was given feed reports ${JSON.stringify(feed.latest)} and ${JSON.stringify(feed.next)}; give it a latest report and at least one more`)
  const clock = mock.clock(on)
  const spawned: string[][] = []
  const written: string[] = []
  const markers: string[] = []
  const reads = new Map<string, string>()
  mock.env(on, { PATH: '/usr/bin', HOME: '/home/me' })
  on('fs.read', ($, e) => {
    if (e.path === `${FEED}.pid`) return { value: '4242\n' }
    if (e.path === `${FEED}.json`) return { value: JSON.stringify({ text: feed.latest }) }
    const text = reads.get(e.path)
    return text === undefined ? { deny: 'no such file' } : { value: text }
  })
  on('fs.write', ($, e) => {
    written.push(e.path)
    if (e.path === `${FEED}.claude`) markers.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: e.path === '/repo/.git' || e.path === '/repo/build.zig' }))
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    if (e.argv[0] === 'kill') return { value: { code: feed.isLive() ? 0 : 1, signal: null } }
    if (e.argv[0] === 'sh') {
      yield { stream: 'stdout' as const, text: '777\n' }
      return { value: { code: 0, signal: null } }
    }
    if (e.argv[0] === 'tail') {
      for (const text of feed.next) {
        await clock.sleep(1000)
        yield { stream: 'stdout' as const, text: `${JSON.stringify({ text })}\n` }
      }
      await clock.sleep(3000)
      if (feed.isLive()) await clock.sleep(60_000)
    }
    if (e.argv[0] === 'zig') await clock.sleep(60_000)
    return { value: { code: 0, signal: null } }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  assert(spawned.length === 0 && written.length === 0, `vscodeProject recorded ${spawned.length} commands and ${written.length} writes before the session started`)
  return { clock, spawned, written, markers, reads }
}

test('a watcher VS Code runs is followed from its feed, not run a second time', async ($, on) => {
  mock.session(on)
  const prompts: string[] = []
  const statuses: (string | undefined)[] = []
  const { clock, spawned, written, markers } = vscodeProject(on, { latest: PASSING, next: [FAILING], isLive: () => true })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.status', ($, e, next) => {
    statuses.push(e.text)
    return next(e)
  })
  await $.session.start(start)
  await clock.advance(2000)
  expect(spawned).toEqual([['kill', '-0', '4242'], ['sh', '-c', 'echo $PPID'], ['tail', '-n', '0', '-F', `${FEED}.jsonl`]])
  expect(statuses).toContain('overwatch zig: following VS Code')
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Failing: `root.test.add`.')
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/main.zig', old_string: 'a', new_string: 'b' })
  expect(written).toContain(`${FEED}.changed`)
  expect(markers).toEqual(['777'])
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1' })
  await clock.advance(70_000)
  await ending
  expect(markers).toEqual(['777', ''])
})

test('a feed whose extension host has gone is left at the next turn for overwatch to run the watcher itself', async ($, on) => {
  let isLive = true
  const { clock, spawned } = vscodeProject(on, { latest: PASSING, next: [PASSING], isLive: () => isLive })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  await $.session.start(start)
  await clock.advance(2000)
  expect(spawned.map(([command]) => command)).toEqual(['kill', 'sh', 'tail'])
  isLive = false
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(4000)
  expect(spawned.at(-1)).toEqual(ZIG_WATCH)
  expect(spawned.filter(([command]) => command === 'zig').length).toBe(1)
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1' })
  await clock.advance(70_000)
  await ending
})

test('a session that started before VS Code follows its feed from the next turn, stopping its own watcher', async ($, on) => {
  let isLive = false
  const { clock, spawned } = vscodeProject(on, { latest: PASSING, next: [PASSING], isLive: () => isLive })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  await $.session.start(start)
  await clock.advance(2000)
  expect(spawned.map(([command]) => command)).toEqual(['kill', 'zig'])
  isLive = true
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(70_000)
  expect(spawned.filter(([command]) => command === 'zig').length).toBe(1)
  expect(spawned.filter(([command]) => command === 'tail').length).toBe(1)
  expect(spawned).toContainEqual(['tail', '-n', '0', '-F', `${FEED}.jsonl`])
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1' })
  await clock.advance(70_000)
  await ending
})

test('a pull while following VS Code takes a fresh baseline, so only a failure that comes after it is reported', async ($, on) => {
  mock.session(on)
  const prompts: string[] = []
  const counts = ['', 'Build Summary: 3/5 steps succeeded (1 failed); 2/3 tests passed (1 failed)\n', 'Build Summary: 3/5 steps succeeded (1 failed); 1/3 tests passed (2 failed)\n', 'Build Summary: 3/5 steps succeeded (1 failed); 0/3 tests passed (3 failed)\n']
  const old = "error: 'root.test.old' failed:\n"
  const pulled = "error: 'root.test.pulled' failed:\n"
  const broken = "error: 'root.test.broken' failed:\n"
  let isLive = true
  const { clock, written, reads } = vscodeProject(on, {
    latest: old + counts[1],
    next: [old + pulled + counts[2], old + pulled + broken + counts[3]],
    isLive: () => isLive,
  })
  reads.set('/repo/.git/HEAD', 'ref: refs/heads/main\n')
  reads.set('/repo/.git/refs/heads/main', `${'a'.repeat(40)}\n`)
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await $.session.start(start)
  await clock.advance(500)
  reads.set('/repo/.git/refs/heads/main', `${'b'.repeat(40)}\n`)
  await $.tool.call({ tool: 'Bash', command: 'git pull' })
  expect(written).toContain(`${FEED}.changed`)
  // Each clock advance waits for the session to settle in real time, so both feed reports arrive in one.
  await clock.advance(3000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).not.toContain('root.test.pulled')
  expect(prompts[0]).toContain('Failing: `root.test.broken`.')
  expect(prompts[0]).toContain('2 more were already failing when the session started.')
  // VS Code closing ends the feed's tail within seconds, so the session ends without waiting out a live extension.
  isLive = false
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1' })
  await clock.advance(5000)
  await ending
})
