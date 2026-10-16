-- overwatch for Neovim: runs the project's test watcher beside the editor, shows the latest result
-- in the status line and loads each failing build into the quickfix list.
local M = {}

M.OVERRIDE_PATH = '.overwatch.json'

local QUIET_MS = 400

-- Patterns are JavaScript regexes, as in hooks/watchers.ts and .overwatch.json; vim_regex translates them.
M.WATCHERS = {
  {
    name = 'zig',
    marker = 'build.zig',
    argv = { 'zig', 'build', '-Doptimize=fast', 'test', '--watch' },
    summary = '^Build Summary:.*$',
    failed = 'failed',
  },
  {
    name = 'python',
    marker = 'pyproject.toml',
    argv = { 'uv', 'run', '--with', 'pytest', '--with', 'pytest-watcher', '--with', 'pytest-testmon', 'ptw', '.', '--testmon' },
    baseline = { 'uv', 'run', '--with', 'pytest', '--with', 'pytest-testmon', 'pytest', '--testmon-noselect' },
    summary = [[^=+ .+ in \d+(?:\.\d+)?s(?: \([^)]*\))? =+$]],
    failed = [[\b(?:failed|errors?)\b]],
  },
}

local LAZY = { ['*'] = '{-}', ['+'] = '{-1,}', ['?'] = '{-,1}' }

--- Translates a JavaScript regex into a very magic Vim regex.
function M.vim_regex(js)
  local out, i, in_class = { [[\v]] }, 1, false
  while i <= #js do
    local c, nxt = js:sub(i, i), js:sub(i + 1, i + 1)
    if c == '\\' then
      out[#out + 1] = (not in_class and nxt == 'b') and '%(<|>)' or c .. nxt
      i = i + 2
    elseif in_class then
      if c == ']' then in_class = false end
      out[#out + 1] = c
      i = i + 1
    elseif c == '[' then
      in_class = true
      out[#out + 1] = c
      if nxt == '^' then
        out[#out + 1] = nxt
        i = i + 1
      end
      if js:sub(i + 1, i + 1) == ']' then
        out[#out + 1] = ']'
        i = i + 1
      end
      i = i + 1
    elseif c == '(' and js:sub(i, i + 2) == '(?:' then
      out[#out + 1] = '%('
      i = i + 3
    elseif LAZY[c] and nxt == '?' then
      out[#out + 1] = LAZY[c]
      i = i + 2
    elseif c:match('[<>=@%%~&]') then
      out[#out + 1] = '\\' .. c
      i = i + 1
    else
      out[#out + 1] = c
      i = i + 1
    end
  end
  return table.concat(out)
end

local function apply_override(watcher, override)
  return {
    name = override.name or watcher.name,
    marker = watcher.marker,
    argv = override.argv or watcher.argv,
    baseline = override.baseline or watcher.baseline,
    summary = override.summary or watcher.summary,
    failed = override.failed or watcher.failed,
  }
end

--- The project's watcher, or nil when it has none or its override turns overwatch off.
function M.find_watcher(cwd)
  local override = {}
  local file = io.open(cwd .. '/' .. M.OVERRIDE_PATH)
  if file then
    local ok, decoded = pcall(vim.json.decode, file:read('*a'))
    file:close()
    if ok and type(decoded) == 'table' then override = decoded end
  end
  if override.enabled == false then return nil end
  for _, watcher in ipairs(M.WATCHERS) do
    if vim.uv.fs_stat(cwd .. '/' .. watcher.marker) then return apply_override(watcher, override) end
  end
  local has_command = override.argv ~= nil or (override.baseline ~= nil and #override.baseline > 0)
  if not has_command or override.summary == nil or override.failed == nil then return nil end
  return apply_override({ name = 'project', marker = M.OVERRIDE_PATH }, override)
end

--- Reads one build's output; nil until the summary line has arrived.
function M.read_report(watcher, output)
  local summary_re, summary = vim.regex(M.vim_regex(watcher.summary)), nil
  for line in vim.gsplit(output, '\n', { plain = true }) do
    local from, to = summary_re:match_str(line)
    if from then
      summary = vim.trim(line:sub(from + 1, to))
      break
    end
  end
  if summary == nil then return nil end
  return { summary = summary, is_failed = vim.regex(M.vim_regex(watcher.failed)):match_str(summary) ~= nil, text = vim.trim(output) }
end

function M.status_line(watcher, report)
  local summary = report.summary:gsub('^Build Summary:%s*', ''):gsub('^=+%s*', ''):gsub('%s*=+$', '')
  return ('overwatch %s %s %s'):format(watcher.name, report.is_failed and '✗' or '✓', summary)
end

local state = { watcher = nil, cwd = nil, status = '', process = nil, was_failing = false, rerun = nil }

--- The latest result, for a status line component.
function M.status()
  return state.status
end

local function set_status(text)
  state.status = text
  vim.cmd.redrawstatus()
end

local function deliver(watcher, report)
  set_status(M.status_line(watcher, report))
  local is_recovery = not report.is_failed and state.was_failing
  state.was_failing = report.is_failed
  if report.is_failed then
    vim.fn.setqflist({}, 'r', {
      title = 'overwatch ' .. watcher.name,
      lines = vim.split(report.text, '\n', { plain = true }),
      efm = vim.o.errorformat,
    })
    vim.notify(('overwatch: %s — :copen for the report'):format(report.summary), vim.log.levels.ERROR)
  elseif is_recovery then
    vim.notify('overwatch: green again. ' .. report.summary, vim.log.levels.INFO)
  end
end

local function command_line(argv)
  return table.concat(argv, ' ')
end

--- Starts argv, handing each chunk of output to on_output on the main loop.
local function spawn(argv, on_output, on_exit)
  local function read(_, data)
    if data then vim.schedule(function() on_output(data) end) end
  end
  local ok, process = pcall(vim.system, argv, { cwd = state.cwd, stdout = read, stderr = read }, function(result)
    vim.schedule(function() on_exit(result) end)
  end)
  if not ok then
    set_status(('overwatch %s: could not start %s'):format(state.watcher.name, command_line(argv)))
    return nil
  end
  state.process = process
  return process
end

--- Runs a command to its end and reports what it printed.
local function run_once(watcher, argv, done)
  local output = ''
  spawn(argv, function(data) output = output .. data end, function()
    state.process = nil
    if state.watcher ~= watcher then return end
    local report = M.read_report(watcher, output)
    if report then deliver(watcher, report) end
    if done then done() end
  end)
end

--- Reruns the suite once saves go quiet, one run at a time.
local function rerun_on_save(watcher)
  local timer, is_running, is_pending = vim.uv.new_timer(), false, false
  local function run()
    if state.watcher ~= watcher then return end
    if is_running then
      is_pending = true
      return
    end
    is_running = true
    run_once(watcher, watcher.baseline, function()
      is_running = false
      if not is_pending then return end
      is_pending = false
      run()
    end)
  end
  state.rerun = function()
    timer:start(QUIET_MS, 0, vim.schedule_wrap(run))
  end
end

local function watch(watcher)
  local output, flush = '', vim.uv.new_timer()
  set_status(('overwatch %s: starting %s'):format(watcher.name, command_line(watcher.argv)))
  spawn(watcher.argv, function(data)
    output = output .. data
    flush:start(QUIET_MS, 0, vim.schedule_wrap(function()
      local report = M.read_report(watcher, output)
      if report == nil then return end
      output = ''
      deliver(watcher, report)
    end))
  end, function()
    if state.watcher == watcher then vim.notify('overwatch: ' .. command_line(watcher.argv) .. ' exited', vim.log.levels.WARN) end
  end)
end

--- Starts watching cwd (default: the current directory); does nothing when it has no watcher.
function M.start(cwd)
  M.stop()
  cwd = cwd or vim.fn.getcwd()
  local watcher = M.find_watcher(cwd)
  if watcher == nil then return end
  state.watcher, state.cwd, state.was_failing = watcher, cwd, false
  local function after_baseline()
    if state.watcher ~= watcher then return end
    if watcher.argv then
      watch(watcher)
    elseif watcher.baseline then
      rerun_on_save(watcher)
    end
  end
  if watcher.baseline and #watcher.baseline > 0 then
    set_status(('overwatch %s: running the full suite with %s'):format(watcher.name, command_line(watcher.baseline)))
    run_once(watcher, watcher.baseline, after_baseline)
  else
    after_baseline()
  end
end

function M.stop()
  state.watcher, state.rerun = nil, nil
  if state.process then
    state.process:kill(15)
    state.process = nil
  end
  set_status('')
end

--- Called after a buffer is written; reruns a watcher that has no watch command of its own.
function M.changed()
  if state.rerun then state.rerun() end
end

return M
