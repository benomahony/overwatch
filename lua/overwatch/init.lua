-- overwatch for Neovim: runs the project's test watchers beside the editor, one for each language it
-- has, shows the latest results in the status line and loads each failing build into the quickfix list.
local M = {}

M.OVERRIDE_PATH = '.overwatch.json'

local QUIET_MS = 400

-- A watcher that ends within this long of its start counts as a quick exit and waits before it restarts: this long
-- after the first, doubling after each further one. After GIVE_UP_AFTER in a row, only :OverwatchStart restarts it.
M.RETRY_MS = 30000
local GIVE_UP_AFTER = 3

-- The table every runtime reads, watchers.json at the repository's root. Patterns are JavaScript regexes, as in
-- .overwatch.json; vim_regex translates them. Alternatives of one language are tried in order: the first whose
-- marker, and `requires` if it names one, are present runs.
local ROOT = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':p:h:h:h')
M.WATCHERS = vim.json.decode(table.concat(vim.fn.readfile(ROOT .. '/watchers.json'), '\n')).watchers

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

local function language_of(watcher)
  return watcher.language or watcher.name
end

local function apply_override(watcher, override)
  return {
    name = override.name or watcher.name,
    language = language_of(watcher),
    marker = watcher.marker,
    argv = override.argv or watcher.argv,
    baseline = override.baseline or watcher.baseline,
    summary = override.summary or watcher.summary,
    failed = override.failed or watcher.failed,
    result = watcher.result,
    failure = watcher.failure,
  }
end

--- The project's watchers, one for each language it has; empty when it has none or its override turns overwatch off.
--- The override applies to the first language found, and is the watcher when none is.
function M.find_watchers(cwd)
  local override = {}
  local file = io.open(cwd .. '/' .. M.OVERRIDE_PATH)
  if file then
    local ok, decoded = pcall(vim.json.decode, file:read('*a'))
    file:close()
    if ok and type(decoded) == 'table' then override = decoded end
  end
  if override.enabled == false then return {} end
  local found, languages = {}, {}
  for _, watcher in ipairs(M.WATCHERS) do
    local language = language_of(watcher)
    if not languages[language]
      and vim.uv.fs_stat(cwd .. '/' .. watcher.marker)
      and (watcher.requires == nil or vim.fn.executable(watcher.requires) == 1)
    then
      languages[language] = true
      found[#found + 1] = apply_override(watcher, #found == 0 and override or {})
    end
  end
  if #found > 0 then return found end
  local has_command = override.argv ~= nil or (override.baseline ~= nil and #override.baseline > 0)
  if not has_command or override.summary == nil or override.failed == nil then return {} end
  return { apply_override({ name = 'project', language = 'project', marker = M.OVERRIDE_PATH }, override) }
end

--- The first line of output the pattern matches, trimmed; nil when none does.
local function first_line(pattern, output)
  local re = vim.regex(M.vim_regex(pattern))
  for line in vim.gsplit(output, '\n', { plain = true }) do
    local from, to = re:match_str(line)
    if from then return vim.trim(line:sub(from + 1, to)) end
  end
  return nil
end

--- Each failing test or error the output names, once each, in order.
local function failures_in(watcher, output)
  if watcher.failure == nil then return {} end
  local pattern, names, seen = M.vim_regex(watcher.failure), {}, {}
  for line in vim.gsplit(output, '\n', { plain = true }) do
    local groups = vim.fn.matchlist(line, pattern)
    if #groups > 0 then
      local name = ''
      for i = 2, 10 do
        if groups[i] ~= '' then
          name = vim.trim(groups[i])
          break
        end
      end
      if name ~= '' and not seen[name] then
        seen[name] = true
        names[#names + 1] = name
      end
    end
  end
  return names
end

--- Reads one build's output: nil until its summary line has arrived. A run that has exited, given its `code`,
--- is read by its exit code when the watcher has no summary, and as failed when it gave none and exited nonzero.
function M.read_report(watcher, output, code)
  local clean = output:gsub('\27%[[%d;?]*%a', '')
  local failures = failures_in(watcher, clean)
  local line = watcher.summary and first_line(watcher.summary, clean)
  local summary, is_failed
  if line then
    summary = (watcher.result and first_line(watcher.result, clean)) or line
    is_failed = watcher.failed ~= nil and vim.regex(M.vim_regex(watcher.failed)):match_str(line) ~= nil
  elseif code == nil or (code == 0 and watcher.summary ~= nil) then
    return nil
  else
    is_failed = code ~= 0
    summary = not is_failed and 'passed' or (#failures > 0 and ('%d failed'):format(#failures) or ('exited with code %d'):format(code))
  end
  return { summary = summary, is_failed = is_failed, text = vim.trim(clean), failures = is_failed and failures or {} }
end

local DECORATION = { '^Build Summary:%s*', '^zanity:%s*', '^=+%s*', '%s*=+$', '^Test Files%s+', '^Test Suites:%s*', '^DONE%s+', '^ok | ', '^FAILED | ' }

function M.status_line(watcher, report)
  local summary = report.summary
  for _, decoration in ipairs(DECORATION) do
    summary = summary:gsub(decoration, '')
  end
  local failing = ''
  if #report.failures > 0 then
    failing = ' — ' .. report.failures[1] .. (#report.failures > 1 and (' +%d more'):format(#report.failures - 1) or '')
  end
  return ('overwatch %s %s %s%s'):format(watcher.name, report.is_failed and '✗' or '✓', summary, failing)
end

-- Each run is one watcher at work: its process, its part of the status line, and its rerun after saves.
local state = { cwd = nil, runs = {} }

--- The latest results, for a status line component.
function M.status()
  local parts = {}
  for _, run in ipairs(state.runs) do
    if run.status ~= '' then parts[#parts + 1] = run.status end
  end
  return table.concat(parts, ' · ')
end

local function set_status(run, text)
  run.status = text
  vim.cmd.redrawstatus()
end

local function is_running(run)
  return state.runs[run.index] == run
end

local function deliver(run, report)
  local watcher = run.watcher
  set_status(run, M.status_line(watcher, report))
  local is_recovery = not report.is_failed and run.was_failing
  run.was_failing = report.is_failed
  if report.is_failed then
    vim.fn.setqflist({}, 'r', {
      title = 'overwatch ' .. watcher.name,
      lines = vim.split(report.text, '\n', { plain = true }),
      efm = vim.o.errorformat,
    })
    local failing = #report.failures > 0 and (' (%s)'):format(table.concat(vim.list_slice(report.failures, 1, 3), ', ')) or ''
    vim.notify(('overwatch %s: %s%s — :copen for the report'):format(watcher.name, report.summary, failing), vim.log.levels.ERROR)
  elseif is_recovery then
    vim.notify(('overwatch %s: green again. %s'):format(watcher.name, report.summary), vim.log.levels.INFO)
  end
end

local function command_line(argv)
  return table.concat(argv, ' ')
end

--- Tells the user a command gave no result, with the last lines it printed.
local function report_broken(run, argv, why, output)
  local lines = vim.split(vim.trim(output), '\n', { plain = true })
  local tail = table.concat(vim.list_slice(lines, math.max(1, #lines - 9)), '\n')
  set_status(run, ('overwatch %s: %s %s'):format(run.watcher.name, command_line(argv), why))
  vim.notify(('overwatch: %s %s\n%s'):format(command_line(argv), why, tail), vim.log.levels.ERROR)
end

--- Starts argv, handing each chunk of output to on_output on the main loop.
local function spawn(run, argv, on_output, on_exit)
  local function read(_, data)
    if data then vim.schedule(function() on_output(data) end) end
  end
  local ok, process = pcall(vim.system, argv, { cwd = state.cwd, stdout = read, stderr = read }, function(result)
    vim.schedule(function() on_exit(result) end)
  end)
  if not ok then
    set_status(run, ('overwatch %s: could not start %s'):format(run.watcher.name, command_line(argv)))
    return nil
  end
  run.process = process
  return process
end

--- Runs a command to its end and reports what it printed, unless it was stopped for a newer run first.
local function run_once(run, argv, done, is_stale)
  local output = ''
  local process = spawn(run, argv, function(data) output = output .. data end, function(result)
    run.process = nil
    if not is_running(run) then return end
    if not (is_stale and is_stale()) then
      local report = M.read_report(run.watcher, output, result.code)
      if report then
        deliver(run, report)
      else
        report_broken(run, argv, 'gave no summary', output)
      end
    end
    done()
  end)
  if process == nil then done() end
end

--- Reruns the suite once saves go quiet, one run at a time. A save made while it runs stops that run, whose result
--- would already be out of date, and starts another.
local function rerun_on_save(run)
  local timer, is_busy, is_pending = vim.uv.new_timer(), false, false
  local function rerun()
    if not is_running(run) then return end
    if is_busy then
      is_pending = true
      if run.process then run.process:kill(15) end
      return
    end
    is_busy, is_pending = true, false
    run_once(run, run.watcher.baseline, function()
      is_busy = false
      if is_pending then rerun() end
    end, function() return is_pending end)
  end
  run.rerun = function()
    timer:start(QUIET_MS, 0, vim.schedule_wrap(rerun))
  end
end

local begin

--- After a watcher ends of itself: one that ran RETRY_MS or longer restarts at once; a quick exit waits RETRY_MS,
--- doubling with each one in a row, until GIVE_UP_AFTER of them, when it is left stopped with what it last printed.
local function restart(run, started_at, what, output)
  local is_quick = vim.uv.now() - started_at < M.RETRY_MS
  run.quick_exits = is_quick and run.quick_exits + 1 or 0
  if run.quick_exits >= GIVE_UP_AFTER then
    report_broken(run, run.watcher.argv, ('%s %d times in a row; :OverwatchStart to retry'):format(what, run.quick_exits), output)
    return
  end
  local delay = is_quick and M.RETRY_MS * 2 ^ (run.quick_exits - 1) or 0
  local when = delay == 0 and 'now' or ('in %ds'):format(delay / 1000)
  set_status(run, ('overwatch %s: %s, restarting %s'):format(run.watcher.name, what, when))
  vim.notify(('overwatch: %s %s, restarting %s'):format(command_line(run.watcher.argv), what, when), vim.log.levels.WARN)
  vim.defer_fn(function()
    if is_running(run) then begin(run) end
  end, delay)
end

local function watch(run)
  local watcher = run.watcher
  local output, recent, flush = '', '', vim.uv.new_timer()
  local started_at = vim.uv.now()
  set_status(run, ('overwatch %s: starting %s'):format(watcher.name, command_line(watcher.argv)))
  local process = spawn(run, watcher.argv, function(data)
    output, recent = output .. data, (recent .. data):sub(-4000)
    flush:start(QUIET_MS, 0, vim.schedule_wrap(function()
      local report = M.read_report(watcher, output)
      if report == nil then return end
      output = ''
      deliver(run, report)
    end))
  end, function(result)
    flush:stop()
    if not is_running(run) then return end
    run.process = nil
    local report = M.read_report(watcher, output)
    if report then deliver(run, report) end
    restart(run, started_at, ('exited with code %d'):format(result.code), recent)
  end)
  if process == nil then restart(run, started_at, 'could not start', '') end
end

--- Runs one watcher: its full suite first, then its watch command, or its suite again after each save.
function begin(run)
  local watcher = run.watcher
  local function after_baseline()
    if not is_running(run) then return end
    if watcher.argv then
      watch(run)
    elseif watcher.baseline then
      rerun_on_save(run)
    end
  end
  if watcher.baseline and #watcher.baseline > 0 then
    set_status(run, ('overwatch %s: running the full suite with %s'):format(watcher.name, command_line(watcher.baseline)))
    run_once(run, watcher.baseline, after_baseline)
  else
    after_baseline()
  end
end

--- Starts watching cwd (default: the current directory); does nothing when it has no watcher.
function M.start(cwd)
  M.stop()
  state.cwd = cwd or vim.fn.getcwd()
  for index, watcher in ipairs(M.find_watchers(state.cwd)) do
    state.runs[index] = { index = index, watcher = watcher, status = '', was_failing = false, quick_exits = 0 }
  end
  for _, run in ipairs(state.runs) do
    begin(run)
  end
end

function M.stop()
  local runs = state.runs
  state.runs = {}
  for _, run in ipairs(runs) do
    if run.process then run.process:kill(15) end
  end
  vim.cmd.redrawstatus()
end

--- Called after a buffer is written; reruns each watcher that has no watch command of its own.
function M.changed()
  for _, run in ipairs(state.runs) do
    if run.rerun then run.rerun() end
  end
end

return M
