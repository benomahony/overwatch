-- Replay generated build/chunk events through the real Neovim watcher callbacks.
local root = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':p:h:h')
vim.opt.rtp:prepend(root)
package.path = root .. '/tests/?.lua;' .. package.path
local overwatch = require('overwatch')
local fake = require('fake_editor')
local traces = vim.json.decode(table.concat(vim.fn.readfile(root .. '/tests/fixtures/model-traces.json'), '\n'))
for _, walk in ipairs(vim.json.decode(table.concat(vim.fn.readfile(root .. '/tests/fixtures/model-walks.json'), '\n'))) do
  walk.is_walk = true
  traces[#traces + 1] = walk
end
local UNSUPPORTED_EVENTS = { Timeout = 'Neovim has no check timeout' }
local replayed, total = 0, 0
fake.install()

--- What zig prints for one of the model's build events: the failures of the workspace's version, then the summary,
--- or the part of them that event stands for after the partial event before it.
local function build_text(names, event, partial)
  local body = ''
  for _, name in ipairs(names) do body = body .. "error: '" .. name .. "' failed:\n" end
  local summary = #names == 0 and 'Build Summary: 3/3 steps succeeded; 1/1 tests passed\n'
    or ('Build Summary: 2/3 steps succeeded (1 failed); 0/%d tests passed (%d failed)\n'):format(#names, #names)
  if event == 'Partial' then return body end
  if event == 'PartialSummary' then return body .. 'Build Summary:' end
  if partial == 'PartialSummary' then return summary:sub(#'Build Summary:' + 1) end
  return (partial == '' and body or '') .. summary
end

--- Checks the status line against the failures the model expects after event, when it knows them.
local function check_status(trace, event, expected)
  if not expected.known then return end
  local status = overwatch.status()
  local where = trace.name .. ': ' .. event .. ': ' .. status
  assert((status:find(' ✗ ', 1, true) ~= nil) == (#expected.failures > 0), where)
  assert(status:match(': ([ab])') == expected.failures[1], where)
  local more = status:match('%+(%d+) more$')
  assert((more and tonumber(more, 10) or 0) == math.max(0, #expected.failures - 1), where)
end

local function replay_model(trace)
  fake.reset()
  local directory = vim.fn.tempname()
  vim.fn.mkdir(directory, 'p')
  vim.fn.writefile({}, directory .. '/build.zig')
  local version, partial = 1, ''
  if trace.is_walk then total = total + #trace.events end
  overwatch.start(directory)
  local ok, err = pcall(function()
    for index, event in ipairs(trace.events) do
      if UNSUPPORTED_EVENTS[event] then break end
      -- Another process's save is a new version too; the editor sees it like any other.
      if event == 'Edit' or event == 'Move' or event == 'Outside' then version = version + 1 end
      local stale = event:match('^Build@(%d+)$')
      local build = event == 'Build' or stale
      if build or event == 'Partial' or event == 'PartialSummary' then
        local at = stale and tonumber(stale, 10) + 1 or version
        fake.children.zig.output(nil, build_text(trace.truth[at], build and 'Build' or event, partial))
        partial = build and '' or event
      end
      if event == 'Read' or event == 'Poll' then
        local timer = fake.timers[#fake.timers]
        assert(timer.callback, 'model read has no output callback')
        local callback = timer.callback
        timer.callback = nil
        callback()
      end
      check_status(trace, event, trace.expected[index + 1])
      if trace.is_walk then replayed = replayed + 1 end
    end
  end)
  overwatch.stop()
  vim.fn.delete(directory, 'rf')
  assert(ok, err)
end

local failures = 0
for _, trace in ipairs(traces) do
  local ok, err = pcall(replay_model, trace)
  if not ok then failures = failures + 1; print('FAIL ' .. trace.name .. ': ' .. tostring(err)) end
end
fake.restore()
print(('%d Neovim model traces, %d failures'):format(#traces, failures))
print(('walk steps replayed: %d/%d'):format(replayed, total))
for event, reason in pairs(UNSUPPORTED_EVENTS) do print(('walks stop at %s: %s'):format(event, reason)) end
assert(failures == 0, ('%d of %d Neovim model traces failed'):format(failures, #traces))
