import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const start = { cwd: '/repo', surface: 'terminal' as const, isInteractive: true }
const PASSING = 'Build Summary: 4/4 steps succeeded; 48/48 tests passed\n'
const FAILING = "error: 'root.test.add' failed:\nBuild Summary: 3/5 steps succeeded (1 failed); 2/3 tests passed (1 failed)\n"
const FEED = '/home/me/.cache/overwatch/feeds/zig-repo'
const ZIG_WATCH = ['zig', 'build', '-Doptimize=fast', 'test', '--watch']

/** A zig project whose watcher VS Code's overwatch runs, writing its reports to FEED; `isLive` says whether its extension host still runs. */
const vscodeProject = (on: On, clock: ReturnType<typeof mock.clock>, feed: { latest: string; next: string; isLive: () => boolean }) => {
  const spawned: string[][] = []
  const written: string[] = []
  const markers: string[] = []
  mock.env(on, { PATH: '/usr/bin', HOME: '/home/me' })
  on('fs.read', ($, e) => {
    if (e.path === `${FEED}.pid`) return { value: '4242\n' }
    if (e.path === `${FEED}.json`) return { value: JSON.stringify({ text: feed.latest }) }
    return { deny: 'no such file' }
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
      await clock.sleep(1000)
      yield { stream: 'stdout' as const, text: `${JSON.stringify({ text: feed.next })}\n` }
      await clock.sleep(3000)
      if (feed.isLive()) await clock.sleep(60_000)
    }
    if (e.argv[0] === 'zig') await clock.sleep(60_000)
    return { value: { code: 0, signal: null } }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  return { spawned, written, markers }
}

test('a watcher VS Code runs is followed from its feed, not run a second time', async ($, on) => {
  const clock = mock.clock(on)
  mock.session(on)
  const prompts: string[] = []
  const statuses: (string | undefined)[] = []
  const { spawned, written, markers } = vscodeProject(on, clock, { latest: PASSING, next: FAILING, isLive: () => true })
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
  const clock = mock.clock(on)
  let isLive = true
  const { spawned } = vscodeProject(on, clock, { latest: PASSING, next: PASSING, isLive: () => isLive })
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
  const clock = mock.clock(on)
  let isLive = false
  const { spawned } = vscodeProject(on, clock, { latest: PASSING, next: PASSING, isLive: () => isLive })
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
