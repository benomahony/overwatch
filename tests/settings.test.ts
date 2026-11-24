import { expect, mock } from 'claude-code/testing'
import { CHECKERS } from '../hooks/watchers'
import { longTest } from './fixtures/tcr-session'

const start = { cwd: '/repo', surface: 'terminal' as const, isInteractive: true }
const PASSING = 'Build Summary: 4/4 steps succeeded; 48/48 tests passed\n'

longTest('.overwatch.json settings under watchers configure each entry by name', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { PATH: '/usr/bin' })
  const override = {
    watchers: {
      zanity: { enabled: false },
      git: { env: { OVERWATCH_GIT_INTERVAL: '300' } },
      zig: { argv: ['zig', 'build', 'test', '--watch'], env: { ZIG_GLOBAL_CACHE_DIR: '/tmp/zig' } },
    },
  }
  const spawned: { argv: string[]; env?: Record<string, string> }[] = []
  on('fs.read', ($, e) => (e.path === '/repo/.overwatch.json' ? { value: JSON.stringify(override) } : { deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: ['/repo/.git', '/repo/build.zig', '/usr/bin/zanity', '/usr/bin/git'].includes(e.path) }))
  on('process.spawn', async function* ($, e) {
    spawned.push({ argv: [...e.argv], ...(e.env === undefined ? {} : { env: { ...e.env } }) })
    yield { stream: 'stdout' as const, text: e.argv[0] === 'sh' ? 'up to date with origin/main\n' : PASSING }
    await clock.sleep(600_000)
    return { value: { code: 0, signal: null } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(start)
  await clock.advance(1000)
  const git = CHECKERS.find(checker => checker.name === 'git')!
  expect(spawned.find(each => each.argv[0] === 'zig')).toEqual({ argv: ['zig', 'build', 'test', '--watch'], env: { ZIG_GLOBAL_CACHE_DIR: '/tmp/zig' } })
  expect(spawned.find(each => each.argv[0] === 'sh')).toEqual({ argv: [...git.argv!], env: { OVERWATCH_GIT_INTERVAL: '300' } })
  expect(spawned.map(each => each.argv[0]).sort()).toEqual(['sh', 'zig'])
})

longTest('a watchers entry turned off gives way to the next alternative of its language', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { PATH: '/usr/bin' })
  const spawned: string[][] = []
  on('fs.read', ($, e) => (e.path === '/repo/.overwatch.json' ? { value: JSON.stringify({ watchers: { vitest: { enabled: false } } }) } : { deny: 'no such file' }))
  on('fs.exists', ($, e) => ({ value: ['/repo/.git', '/repo/node_modules/.bin/vitest', '/repo/bun.lock'].includes(e.path) }))
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    yield { stream: 'stdout' as const, text: ' 0 fail\n' }
    await clock.sleep(600_000)
    return { value: { code: 0, signal: null } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start(start)
  await clock.advance(1000)
  expect(spawned).toEqual([['bun', 'test', '--watch']])
})
