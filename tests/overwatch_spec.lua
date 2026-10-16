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
  eq(overwatch.status_line(python, report), 'overwatch python ✗ 1 failed, 2 passed in 0.03s')
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
  eq(overwatch.find_watcher(dir), nil)
end)

test('a project with no marker and no command has no watcher', function()
  eq(overwatch.find_watcher(project({ summary = 'x', failed = 'y' })), nil)
  eq(overwatch.find_watcher(project()), nil)
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
  local dir = project({ name = 'sh', baseline = { 'sh', '-c', 'echo error: Failed to parse uv.lock; exit 2' }, summary = 'x', failed = 'y' })
  local notified = {}
  vim.notify = function(text) notified[#notified + 1] = text end
  overwatch.start(dir)
  vim.wait(2000, function() return #notified > 0 end)
  eq(overwatch.status(), 'overwatch sh: sh -c echo error: Failed to parse uv.lock; exit 2 gave no summary')
  eq(notified[1]:find('error: Failed to parse uv.lock', 1, true) ~= nil, true)
  overwatch.stop()
end)

os.exit(failures == 0 and 0 or 1)
