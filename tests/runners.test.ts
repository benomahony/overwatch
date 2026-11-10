import { expect, test } from 'claude-code/testing'
import { CHECKERS, WATCHERS, readReport } from '../hooks/watchers'
import { CARGO_FAILING, GO_FAILING, readResult, watcherNamed } from './fixtures/watchers'

// What `zanity check . --plain` prints for two findings: one record per finding, then the summary.
const ZANITY_FAILING = [
  'path="calc.py"\tline=1\tcolumn=5\tseverity="warning"\trule="dead-symbol"\tmessage="\'f\' is a function that nothing refers to."\tfix="Delete it."\tmatching_total=null\tnext_offset=null\tedit_start=null\tedit_end=null\tedit_text=null\tid="ba4ccb9f687bffd53f6f5176d8eb3ee6263cd74a332002b2b20408e3325566d4"\tclassification="unclassified"',
  'path="calc.py"\tline=4\tcolumn=5\tseverity="warning"\trule="swallowed-error"\tmessage="This error handler does nothing."\tfix="Handle it."\tmatching_total=null\tnext_offset=null\tedit_start=null\tedit_end=null\tedit_text=null\tid="cdde7f46bc45c60ec4c5cab46a974f59403f54448133a3abefc633b26ce88853"\tclassification="unclassified"',
  'zanity: 0 errors and 2 warnings in 1 of 1 file',
  '',
].join('\n')

const VITEST_FAILING = `
 ❯ calc.test.js (2 tests | 1 failed) 4ms
   × adds 4ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  calc.test.js > adds
AssertionError: expected 10 to be 11 // Object.is equality
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Start at  17:00:40
   Duration  99ms
 FAIL  Tests failed. Watching for file changes...
`

const VITEST_BROKEN = `
 FAIL  calc.test.js [ calc.test.js ]
Error: Failed to parse source for import analysis because the content contains invalid JS syntax.
 Test Files  1 failed (1)
      Tests  no tests
 FAIL  Tests failed. Watching for file changes...
`

const JEST_FAILING = `FAIL ./calc.test.js
  ● adds
    expect(received).toBe(expected) // Object.is equality
Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 passed, 2 total
Ran all test suites.
`

const BUN_FAILING = `calc.test.ts:
error: expect(received).toBe(expected)
(fail) adds [0.53ms]

 1 pass
 1 fail
 1 expect() calls
Ran 2 tests across 1 file. [18.00ms]
`

const DENO_FAILING = `\x1b[0m\x1b[38;5;245mrunning 2 tests from ./calc_test.ts\x1b[0m
adds ... \x1b[0m\x1b[31mFAILED\x1b[0m \x1b[0m\x1b[38;5;245m(0ms)\x1b[0m
 ERRORS
adds \x1b[0m\x1b[38;5;245m=> ./calc_test.ts:1:6\x1b[0m
error: Error: 3 + 7 = 10
 FAILURES
adds \x1b[0m\x1b[38;5;245m=> ./calc_test.ts:1:6\x1b[0m
\x1b[0m\x1b[31mFAILED\x1b[0m | 1 passed | 1 failed \x1b[0m\x1b[38;5;245m(2ms)\x1b[0m
error: Test failed
\x1b[0m\x1b[38;5;12mWatcher\x1b[0m Test failed. Restarting on file change...
`

const DENO_BROKEN = `error: The module's source code could not be parsed: Expected ';', '}' or <eof> at file:///p/calc_test.ts:3:8
Watcher Test failed. Restarting on file change...
`

const GOTESTSUM_FAILING = `=== Failed
=== FAIL: . TestAdd (0.00s)
    calc_test.go:3: Add(3, 7) = 10

DONE 2 tests, 1 failure in 0.184s
`

const GO_BROKEN = `# example.com/calc
./calc_test.go:5:1: expected declaration, found syntax
FAIL	example.com/calc [setup failed]
`

const CARGO_BROKEN = `   Compiling calc v0.1.0 (/repo)
error[E0308]: mismatched types
 --> src/lib.rs:8:26
  |
8 | pub fn broken() -> u32 { "x" }
  |                    ---   ^^^ expected \`u32\`, found \`&str\`

For more information about this error, try \`rustc --explain E0308\`.
error: could not compile \`calc\` (lib) due to 1 previous error
error: could not compile \`calc\` (lib test) due to 1 previous error
`

test('JavaScript runners report what failed', () => {
  expect(readResult(watcherNamed('vitest'), VITEST_FAILING)).toEqual(['vitest ✗ 1 failed (1): calc.test.js > adds', ['calc.test.js > adds']])
  expect(readResult(watcherNamed('vitest'), VITEST_BROKEN)[1]).toEqual(['calc.test.js [ calc.test.js ]'])
  expect(readReport(watcherNamed('vitest'), ' Test Files  1 passed (1)\n')?.isFailed).toBe(false)
  expect(readResult(watcherNamed('jest'), JEST_FAILING)).toEqual(['jest ✗ 1 failed, 1 total: ./calc.test.js +1 more', ['./calc.test.js', 'adds']])
  expect(readResult(watcherNamed('bun', 'bun.lock'), BUN_FAILING)).toEqual(['bun ✗ 1 fail: adds', ['adds']])
  expect(readReport(watcherNamed('bun', 'bun.lock'), ' 2 pass\n 0 fail\n')?.isFailed).toBe(false)
  expect(readResult(watcherNamed('deno', 'deno.json'), DENO_FAILING)).toEqual(['deno ✗ 1 passed | 1 failed (2ms): adds => ./calc_test.ts:1:6', ['adds => ./calc_test.ts:1:6']])
  expect(readReport(watcherNamed('deno', 'deno.json'), DENO_BROKEN)?.isFailed).toBe(true)
  expect(readReport(watcherNamed('deno', 'deno.json'), 'ok | 2 passed | 0 failed (2ms)\nWatcher Test finished. Restarting on file change...\n')?.summary).toBe(
    'ok | 2 passed | 0 failed (2ms)',
  )
})

test('Go runners report what failed', () => {
  const gotestsum = WATCHERS.find(watcher => watcher.requires === 'gotestsum')!
  expect(readResult(gotestsum, GOTESTSUM_FAILING)).toEqual(['go ✗ 2 tests, 1 failure in 0.184s: . TestAdd', ['. TestAdd']])
  const go = WATCHERS.find(watcher => watcher.name === 'go' && watcher.requires === undefined)!
  expect(readReport(go, GO_FAILING)).toBeUndefined()
  expect(readResult(go, GO_FAILING, 1)).toEqual(['go ✗ 1 failed: TestAdd', ['TestAdd']])
  expect(readResult(go, GO_BROKEN, 1)[1]).toEqual(['./calc_test.go:5:1: expected declaration, found syntax'])
  expect(readResult(go, 'ok  \texample.com/calc\t0.2s\n', 0)).toEqual(['go ✓ passed', []])
})

test('zanity names each finding by path, rule and an id that survives a line shift', () => {
  const zanity = CHECKERS.find(checker => checker.name === 'zanity')!
  expect(readResult(zanity, ZANITY_FAILING)[1]).toEqual(['calc.py dead-symbol ba4ccb9f687b', 'calc.py swallowed-error cdde7f46bc45'])
  expect(readResult(zanity, 'zanity: checked 1 file, no issues found\n')[1]).toEqual([])
})

test('Rust reports compile and test failures', () => {
  expect(readResult(watcherNamed('rust'), CARGO_FAILING, 101)).toEqual(['rust ✗ 1 failed: tests::adds', ['tests::adds']])
  expect(readResult(watcherNamed('rust'), CARGO_BROKEN, 101)).toEqual([
    'rust ✗ 1 failed: error[E0308]: mismatched types',
    ['error[E0308]: mismatched types'],
  ])
})

test('output holding two builds is read as the later one', () => {
  const zanity = CHECKERS.find(checker => checker.name === 'zanity')!
  const twoRuns = 'zanity: 0 errors, 17 warnings in 1/41 files.\ndead-symbol [warning] 17 in 1 file\nzanity: checked 41 files, no issues found.\n'
  expect(readResult(zanity, twoRuns)).toEqual(['zanity ✓ checked 41 files, no issues found.', []])
  const zig = watcherNamed('zig')
  const old = "error: 'root.test.old' failed:\nBuild Summary: 3/5 steps succeeded (1 failed); 2/3 tests passed (1 failed)\n"
  const fixed = "error: 'root.test.new' failed:\nBuild Summary: 3/5 steps succeeded (1 failed); 2/3 tests passed (1 failed)\n"
  expect(readResult(zig, old + fixed)[1]).toEqual(['root.test.new'])
  const passing = '\x1b[32mBuild Summary: 4/4 steps succeeded; 3/3 tests passed\x1b[0m\n'
  expect(readResult(zig, old + fixed + passing)).toEqual(['zig ✓ 4/4 steps succeeded; 3/3 tests passed', []])
  expect(readResult(zig, passing + fixed)[1]).toEqual(['root.test.new'])
})

test('the latest Deno build supplies both its result and failures', () => {
  const deno = watcherNamed('deno', 'deno.json')
  const passing = 'ok | 2 passed | 0 failed (1ms)\nWatcher Test finished. Restarting on file change...\n'
  expect(readResult(deno, DENO_FAILING + passing)).toEqual(['deno ✓ 2 passed | 0 failed (1ms)', []])
  expect(readResult(deno, passing + DENO_FAILING)).toEqual(readResult(deno, DENO_FAILING))
})
