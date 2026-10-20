-- nvim --headless -l tests/overwatch_spec.lua
vim.opt.rtp:prepend(vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':p:h:h'))
local overwatch = require('overwatch')

local failures = 0
local function test(name, fn)
  local ok, err = pcall(fn)
  print((ok and 'pass ' or 'FAIL ') .. name .. (ok and '' or ('\n  ' .. tostring(err))))
  if not ok then failures = failures + 1 end
end
local function eq(actual, expected)
  if not vim.deep_equal(actual, expected) then error(('expected %s, got %s'):format(vim.inspect(expected), vim.inspect(actual)), 2) end
end

local zig, python = overwatch.WATCHERS[1], overwatch.WATCHERS[2]

local PYTEST_FAILING = [[
tests/test_add.py:9: AssertionError
=========================== short test summary info ============================
FAILED tests/test_add.py::test_add - assert 10 == 11
========================= 1 failed, 2 passed in 0.03s ==========================
]]

test('javascript patterns become very magic vim patterns', function()
  eq(overwatch.vim_regex([[\b(?:failed|errors?)\b]]), [[\v%(<|>)%(failed|errors?)%(<|>)]])
  eq(overwatch.vim_regex('a<b>=c [^]<] .+?'), [[\va\<b\>\=c [^]<] .{-1,}]])
end)

test('the pytest summary line decides pass or fail', function()
  local report = overwatch.read_report(python, PYTEST_FAILING)
  eq(report.is_failed, true)
  eq(overwatch.status_line(python, report), 'overwatch python ✗ 1 failed, 2 passed in 0.03s — tests/test_add.py::test_add')
  eq(overwatch.read_report(python, '=== no tests ran in 0.00s ===').is_failed, false)
  eq(overwatch.read_report(python, '=== 1 error in 0.05s ===').is_failed, true)
  eq(overwatch.read_report(python, 'collected 3 items'), nil)
end)

test('the zig summary line decides pass or fail', function()
  local report = overwatch.read_report(zig, 'Build Summary: 4/4 steps succeeded; 48/48 tests passed\n')
  eq(overwatch.status_line(zig, report), 'overwatch zig ✓ 4/4 steps succeeded; 48/48 tests passed')
  eq(overwatch.read_report(zig, 'Build Summary: 3/5 steps succeeded (1 failed)').is_failed, true)
end)

local function project(override)
  local dir = vim.fn.tempname()
  vim.fn.mkdir(dir, 'p')
  if override then vim.fn.writefile({ vim.json.encode(override) }, dir .. '/.overwatch.json') end
  return dir
end

test('.overwatch.json can turn a marked project off', function()
  local dir = project({ enabled = false })
  vim.fn.writefile({}, dir .. '/build.zig')
  eq(overwatch.find_watchers(dir), {})
end)

test('a project with no marker and no command has no watcher', function()
  eq(overwatch.find_watchers(project({ summary = 'x', failed = 'y' })), {})
  eq(overwatch.find_watchers(project()), {})
end)

local function named(name, marker)
  for _, watcher in ipairs(overwatch.WATCHERS) do
    if watcher.name == name and (marker == nil or watcher.marker == marker) then return watcher end
  end
end

test('each language reads its runner’s report and names what failed', function()
  local function read(watcher, output, code)
    local report = overwatch.read_report(watcher, output, code)
    return { overwatch.status_line(watcher, report), report.failures }
  end
  eq(read(python, PYTEST_FAILING), { 'overwatch python ✗ 1 failed, 2 passed in 0.03s — tests/test_add.py::test_add', { 'tests/test_add.py::test_add' } })
  eq(read(named('vitest'), ' FAIL  calc.test.js > adds\n Test Files  1 failed (1)\n FAIL  Tests failed. Watching for file changes...'),
    { 'overwatch vitest ✗ 1 failed (1) — calc.test.js > adds', { 'calc.test.js > adds' } })
  eq(read(named('jest'), 'FAIL ./calc.test.js\n  ● adds\nTest Suites: 1 failed, 1 total'),
    { 'overwatch jest ✗ 1 failed, 1 total — ./calc.test.js +1 more', { './calc.test.js', 'adds' } })
  eq(read(named('bun'), '(fail) adds [0.53ms]\n\n 1 pass\n 1 fail\n'), { 'overwatch bun ✗ 1 fail — adds', { 'adds' } })
  local deno = 'adds \27[0m\27[38;5;245m=> ./calc_test.ts:1:6\27[0m\n\27[0m\27[31mFAILED\27[0m | 1 passed | 1 failed (2ms)\n'
    .. '\27[0m\27[38;5;12mWatcher\27[0m Test failed. Restarting on file change...'
  eq(read(named('deno'), deno), { 'overwatch deno ✗ 1 passed | 1 failed (2ms) — adds => ./calc_test.ts:1:6', { 'adds => ./calc_test.ts:1:6' } })
  eq(read(named('go', 'go.mod'), '=== FAIL: . TestAdd (0.00s)\n\nDONE 2 tests, 1 failure in 0.184s'),
    { 'overwatch go ✗ 2 tests, 1 failure in 0.184s — . TestAdd', { '. TestAdd' } })
  local go = overwatch.WATCHERS[#overwatch.WATCHERS - 1]
  eq(overwatch.read_report(go, '--- FAIL: TestAdd (0.00s)\nFAIL'), nil)
  eq(read(go, '--- FAIL: TestAdd (0.00s)\nFAIL', 1), { 'overwatch go ✗ 1 failed — TestAdd', { 'TestAdd' } })
  eq(read(go, './calc_test.go:5:1: expected declaration, found syntax', 1)[2], { './calc_test.go:5:1: expected declaration, found syntax' })
  eq(read(named('rust'), 'test tests::adds ... FAILED\ntest result: FAILED.', 101), { 'overwatch rust ✗ 1 failed — tests::adds', { 'tests::adds' } })
  eq(read(named('rust'), 'test result: ok.', 0), { 'overwatch rust ✓ passed', {} })
end)

test('every language in a polyglot project gets its own watcher', function()
  local dir = project()
  for _, marker in ipairs({ 'go.mod', 'Cargo.toml', 'deno.json' }) do vim.fn.writefile({}, dir .. '/' .. marker) end
  local names = vim.tbl_map(function(watcher) return watcher.name end, overwatch.find_watchers(dir))
  eq(names, { 'deno', 'go', 'rust' })
end)

test('a JS project runs the test runner it has installed, ahead of bun', function()
  local dir = project()
  vim.fn.mkdir(dir .. '/node_modules/.bin', 'p')
  vim.fn.writefile({}, dir .. '/bun.lock')
  eq(vim.tbl_map(function(watcher) return watcher.name end, overwatch.find_watchers(dir)), { 'bun' })
  vim.fn.writefile({}, dir .. '/node_modules/.bin/vitest')
  eq(vim.tbl_map(function(watcher) return watcher.name end, overwatch.find_watchers(dir)), { 'vitest' })
end)

test('each watcher in a polyglot project shows in the status line', function()
  local dir = project()
  vim.fn.writefile({}, dir .. '/Cargo.toml')
  vim.fn.writefile({}, dir .. '/go.mod')
  local bin = vim.fn.tempname()
  vim.fn.mkdir(bin, 'p')
  local function tool(name, lines)
    vim.fn.writefile(lines, bin .. '/' .. name)
    vim.fn.setfperm(bin .. '/' .. name, 'rwxr-xr-x')
  end
  tool('go', { '#!/bin/sh', 'echo "--- FAIL: TestAdd (0.00s)"', 'exit 1' })
  tool('cargo', { '#!/bin/sh', 'echo "test result: ok."' })
  local path = vim.env.PATH
  vim.env.PATH = bin .. ':/usr/bin:/bin'
  overwatch.start(dir)
  vim.wait(5000, function() return overwatch.status():find('rust ✓', 1, true) and overwatch.status():find('go ✗', 1, true) end)
  vim.env.PATH = path
  eq(overwatch.status(), 'overwatch go ✗ 1 failed — TestAdd · overwatch rust ✓ passed')
  overwatch.stop()
  eq(overwatch.status(), '')
end)

test('a project with no watch command reruns its suite after each save', function()
  local dir = project({ name = 'sh', baseline = { 'sh', '-c', 'cat result' }, summary = [[^ \d+ fail$]], failed = [[^[1-9]\d* fail$]] })
  vim.fn.writefile({ ' 2 pass', ' 0 fail' }, dir .. '/result')
  overwatch.start(dir)
  vim.wait(2000, function() return overwatch.status():find('✓') ~= nil end)
  eq(overwatch.status(), 'overwatch sh ✓ 0 fail')
  vim.fn.writefile({ 'result:3: adds broke', ' 1 pass', ' 1 fail' }, dir .. '/result')
  overwatch.changed()
  vim.wait(2000, function() return overwatch.status():find('✗') ~= nil end)
  eq(overwatch.status(), 'overwatch sh ✗ 1 fail')
  local qf = vim.fn.getqflist()
  eq(qf[1].lnum, 3)
  eq(qf[1].text, ' adds broke')
  overwatch.stop()
  eq(overwatch.status(), '')
end)

test('a command that gives no summary shows what it printed', function()
  local dir = project({ name = 'sh', baseline = { 'sh', '-c', 'echo error: Failed to parse uv.lock' }, summary = 'x', failed = 'y' })
  local notified = {}
  vim.notify = function(text) notified[#notified + 1] = text end
  overwatch.start(dir)
  vim.wait(2000, function() return #notified > 0 end)
  eq(overwatch.status(), 'overwatch sh: sh -c echo error: Failed to parse uv.lock gave no summary')
  eq(notified[1]:find('error: Failed to parse uv.lock', 1, true) ~= nil, true)
  overwatch.stop()
end)

test('a command that gives no summary and exits nonzero fails', function()
  local dir = project({ name = 'sh', baseline = { 'sh', '-c', 'echo x.py:4: error: Failed to parse uv.lock; exit 2' }, summary = '^SUMMARY$', failed = 'y' })
  overwatch.start(dir)
  vim.wait(2000, function() return overwatch.status():find('✗') ~= nil end)
  eq(overwatch.status(), 'overwatch sh ✗ exited with code 2')
  eq(vim.fn.getqflist()[1].lnum, 4)
  overwatch.stop()
end)

os.exit(failures == 0 and 0 or 1)
