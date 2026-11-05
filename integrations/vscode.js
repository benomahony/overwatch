import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, watch as watchFiles, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, delimiter, dirname, join } from "node:path"

export const OVERRIDE_PATH = ".overwatch.json"
const QUIET_MS = 400
export const RETRY_MS = 30_000
const GIVE_UP_AFTER = 3
const TABLE = JSON.parse(readFileSync(new URL("../watchers.json", import.meta.url), "utf8"))
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version
export const WATCHERS = TABLE.watchers
const SEARCH_SKIP = new Set(TABLE.search.skip)
const ANSI = /\x1b\[[\d;?]*[A-Za-z]/g
const DECORATION = [/^Build Summary:\s*/, /^zanity:\s*/, /^=+\s*/, /\s*=+$/, /^Test Files\s+/, /^Test Suites:\s*/, /^DONE\s+/, /^ok \| /, /^FAILED \| /]

/** Whether name is an executable on PATH. */
function isExecutable(name) {
  assert(typeof name === "string" && name !== "", `isExecutable was given ${name}; name an executable`)
  const extensions = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""]
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(dir => dir !== "")
  const found = dirs.some(dir => extensions.some(extension => isAccessible(join(dir, name + extension))))
  assert(typeof found === "boolean", `isExecutable(${name}) found ${found}, not a yes or no`)
  return found
}

/** Whether path is a file this process may execute; a path that is missing or not executable is not one. */
function isAccessible(path) {
  assert(typeof path === "string" && path !== "", `isAccessible was given ${JSON.stringify(path)}; pass a path to check`)
  if (!existsSync(path)) return false
  let isAllowed = true
  try {
    accessSync(path, constants.X_OK)
  } catch {
    isAllowed = false
  }
  assert(!isAllowed || existsSync(path), `${path} counted as executable but does not exist`)
  return isAllowed
}

/** The language a watcher is an alternative for. */
function languageOf(watcher) {
  assert(typeof watcher?.name === "string", `languageOf was given ${JSON.stringify(watcher)}; pass a watcher with a name`)
  const language = watcher.language ?? watcher.name
  assert(typeof language === "string" && language !== "", `watcher ${watcher.name} has language ${JSON.stringify(language)}; give it a name or a language`)
  return language
}

/** The watcher with the fields override gives replacing its own. */
function applyOverride(watcher, override) {
  assert(override !== null && typeof override === "object", `applyOverride was given override ${JSON.stringify(override)}; pass an object`)
  const applied = {
    ...watcher,
    language: languageOf(watcher),
    name: override.name ?? watcher.name,
    argv: override.argv ?? watcher.argv,
    baseline: override.baseline ?? watcher.baseline,
    summary: override.summary ?? watcher.summary,
    failed: override.failed ?? watcher.failed,
  }
  assert(applied.marker === watcher.marker, `overriding ${watcher.name} changed its marker to ${applied.marker}`)
  return applied
}

/** The first of a language's alternatives whose marker is in dir and whose tool, if it needs one, is on PATH. */
function firstPresent(alternatives, dir) {
  assert(alternatives.length > 0 && typeof dir === "string", `firstPresent was given ${alternatives.length} alternatives in ${dir}; pass a language's watchers and a directory`)
  const present = alternatives.find(watcher => existsSync(join(dir, watcher.marker)) && (watcher.requires === undefined || isExecutable(watcher.requires)))
  assert(present === undefined || alternatives.includes(present), `firstPresent chose ${present?.name}, which is not one of the alternatives`)
  return present
}

/** The directories in dir, relative to cwd, that a search may enter: not hidden and not skipped. */
function searchable(cwd, parent) {
  assert(typeof cwd === "string" && typeof parent === "string", `searchable was given ${cwd} and ${parent}; pass the project and a directory in it`)
  let entries
  try {
    entries = readdirSync(join(cwd, parent), { withFileTypes: true })
  } catch {
    return []
  }
  const names = entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith(".") && !SEARCH_SKIP.has(entry.name))
    .map(entry => parent === "" ? entry.name : `${parent}/${entry.name}`)
  assert(names.every(name => name.startsWith(parent)), `searchable listed ${names} outside ${parent}`)
  return names
}

/** The directories search.depth levels down, relative to cwd, nearest and then alphabetically first. */
function findSubprojects(cwd) {
  assert(typeof cwd === "string" && cwd !== "", `findSubprojects was given ${JSON.stringify(cwd)}; pass the project's directory`)
  const found = []
  let parents = [""]
  for (let depth = 0; depth < TABLE.search.depth; depth++) {
    const level = parents.flatMap(parent => searchable(cwd, parent)).sort()
    found.push(...level)
    parents = level
  }
  assert(found.every(dir => dir.split("/").length <= TABLE.search.depth), `found sub-projects ${found} deeper than ${TABLE.search.depth}`)
  return found
}

/** The project's .overwatch.json, or an empty override when it has none or it is not a JSON object. */
function readOverride(cwd) {
  assert(typeof cwd === "string" && cwd !== "", `readOverride was given ${JSON.stringify(cwd)}; pass the project's directory`)
  const path = join(cwd, OVERRIDE_PATH)
  if (!existsSync(path)) return {}
  let decoded
  try {
    decoded = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return {}
  }
  const override = decoded !== null && typeof decoded === "object" ? decoded : {}
  assert(typeof override === "object", `${path} gave ${JSON.stringify(override)}, not an override object`)
  return override
}

/** Each sub-project of cwd with one of a language's alternatives, as that watcher run there; a sub-project inside one found is left out. */
function inSubprojects(cwd, subprojects, alternatives, language) {
  assert(Array.isArray(subprojects) && alternatives.length > 0, `inSubprojects was given ${subprojects} and ${alternatives.length} alternatives for ${language}`)
  const claimed = []
  const found = []
  for (const dir of subprojects) {
    if (claimed.some(parent => dir.startsWith(`${parent}/`))) continue
    const present = firstPresent(alternatives, join(cwd, dir))
    if (!present) continue
    claimed.push(dir)
    found.push({ ...present, language, name: `${present.name} ${dir}`, dir })
  }
  assert(found.length === claimed.length, `found ${found.length} watchers for ${claimed.length} sub-projects of ${cwd}`)
  return found
}

/** The project's watchers, one for each language it has, or else for each sub-project that has it; empty when it has none or its override turns overwatch off. */
export function findWatchers(cwd) {
  assert(typeof cwd === "string" && cwd !== "", `findWatchers was given ${cwd}; pass the project's directory`)
  const override = readOverride(cwd)
  if (override.enabled === false) return []
  const found = []
  let subprojects
  for (const language of new Set(WATCHERS.map(languageOf))) {
    const alternatives = WATCHERS.filter(each => languageOf(each) === language)
    const atRoot = firstPresent(alternatives, cwd)
    subprojects ??= atRoot ? undefined : findSubprojects(cwd)
    const present = atRoot ? [atRoot] : inSubprojects(cwd, subprojects, alternatives, language)
    for (const each of present) found.push(applyOverride(each, found.length === 0 ? override : {}))
  }
  assert(found.every(watcher => typeof watcher.name === "string"), `findWatchers found watchers without names in ${cwd}`)
  if (found.length > 0) return found
  const hasCommand = override.argv !== undefined || (override.baseline?.length ?? 0) > 0
  if (!hasCommand || override.summary === undefined || override.failed === undefined) return []
  return [applyOverride({ name: "project", language: "project", marker: OVERRIDE_PATH }, override)]
}

/** The first line of output the pattern matches, trimmed. */
function firstLine(pattern, output) {
  assert(typeof pattern === "string" && typeof output === "string", `firstLine was given pattern ${pattern} and output ${typeof output}; pass two strings`)
  const line = new RegExp(pattern, "m").exec(output)?.[0].trim()
  assert(line === undefined || !line.includes("\n"), `pattern ${pattern} matched ${JSON.stringify(line)}, more than one line`)
  return line
}

/** Each failing test or error the output names, once each, in order. */
function failuresIn(watcher, output) {
  assert(typeof output === "string", `failuresIn was given output ${typeof output} for ${watcher.name}; pass what it printed`)
  if (watcher.failure === undefined) return []
  const names = [...output.matchAll(new RegExp(watcher.failure, "gm"))]
    .map(match => match.slice(1).find(group => group !== undefined && group.trim() !== "")?.trim())
    .filter(name => name !== undefined)
  const failures = [...new Set(names)]
  assert(failures.every(name => name !== ""), `${watcher.name}'s failure pattern named an empty failure`)
  return failures
}

/** Reads one build's output: undefined until its summary line has arrived; a run that has exited, given its code, is read by its exit code when it gave no summary. */
export function readReport(watcher, output, code) {
  assert(typeof output === "string", `readReport was given output ${typeof output}; pass what the watcher printed`)
  const clean = output.replace(ANSI, "")
  const failures = failuresIn(watcher, clean)
  const line = watcher.summary && firstLine(watcher.summary, clean)
  let summary
  let isFailed
  if (line) {
    summary = (watcher.result && firstLine(watcher.result, clean)) || line
    isFailed = watcher.failed !== undefined && new RegExp(watcher.failed).test(line)
  } else if (code === undefined || code === null || (code === 0 && watcher.summary !== undefined)) {
    return undefined
  } else {
    isFailed = code !== 0
    summary = !isFailed ? "passed" : failures.length > 0 ? `${failures.length} failed` : `exited with code ${code}`
  }
  const report = { summary, isFailed, text: clean.trim(), failures: isFailed ? failures : [] }
  assert(report.summary !== "" || !report.isFailed, `${watcher.name} failed with an empty summary; make its summary pattern match the line with the counts`)
  return report
}

/** The real path of the git repository holding dir, the nearest directory with a `.git`, as the Claude Code plugin finds it; undefined outside one. */
export function repositoryOf(dir) {
  assert(typeof dir === "string" && dir !== "", `repositoryOf was given ${JSON.stringify(dir)}; pass a directory`)
  if (!existsSync(dir)) return undefined
  let at = realpathSync(dir)
  while (!existsSync(join(at, ".git"))) {
    if (dirname(at) === at) return undefined
    at = dirname(at)
  }
  assert(existsSync(join(at, ".git")), `repository ${at} of ${dir} holds no .git`)
  return at
}

/** Runs a command to its end, resolving its exit code and output; -1 when it could not start. */
function execute(command, args, cwd) {
  assert(typeof command === "string" && Array.isArray(args), `execute was given ${command} ${args}; pass a command and its arguments`)
  return new Promise(resolve => execFile(command, args, { cwd, timeout: 30_000 }, (error, stdout) => {
    const code = error ? (typeof error.code === "number" ? error.code : -1) : 0
    assert(Number.isInteger(code), `${command} ended with code ${code}, not a number`)
    resolve({ code, stdout })
  }))
}

/** The pid of the Claude Code process following feed, from its `.claude` file, while that process runs; undefined otherwise. */
export function followerOf(feed) {
  assert(typeof feed === "string" && feed !== "", `followerOf was given feed ${JSON.stringify(feed)}; pass a feed path`)
  const path = `${feed}.claude`
  const pid = existsSync(path) ? Number(readFileSync(path, "utf8").trim()) : NaN
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const isRunning = isProcess(pid)
  assert(typeof isRunning === "boolean", `checking process ${pid} gave ${isRunning}`)
  return isRunning ? pid : undefined
}

/** Whether a process with this pid runs; one that has gone, or that this user may not signal, does not count. */
function isProcess(pid) {
  assert(Number.isInteger(pid) && pid > 0, `isProcess was given pid ${pid}; pass a positive integer`)
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    assert(typeof error.code === "string", `signalling ${pid} failed with ${error}, which has no error code`)
    return false
  }
}

/** The installed overwatch plugin that `claude plugin list --json` printed, or why its output could not be read. */
function pluginIn(stdout) {
  assert(typeof stdout === "string", `pluginIn was given ${typeof stdout}; pass what claude plugin list printed`)
  let listed
  try {
    listed = JSON.parse(stdout)
  } catch (error) {
    return { error: `claude plugin list printed output that is not JSON (${error.message})` }
  }
  if (!Array.isArray(listed)) return { error: `claude plugin list printed ${typeof listed}, not a list of plugins` }
  const plugin = listed.find(each => typeof each?.id === "string" && each.id.startsWith("overwatch@"))
  assert(plugin === undefined || plugin.id.startsWith("overwatch@"), `pluginIn chose ${plugin?.id}, which is not overwatch`)
  return { plugin }
}

/** One doctor line for each watcher: the tool it runs with and its latest result, or the tool that is missing. */
function watcherLines(runs) {
  assert(Array.isArray(runs), `watcherLines was given ${typeof runs}; pass the running watchers`)
  const lines = runs.map(each => {
    const tool = (each.watcher.argv ?? each.watcher.baseline ?? [])[0]
    const where = each.watcher.dir ? ` in ${each.watcher.dir}` : ""
    const isInstalled = tool === undefined || isExecutable(tool)
    return isInstalled ? `✓ ${each.watcher.name}${where} runs with ${tool}: ${each.status || "starting"}` : `✗ ${each.watcher.name}${where}: ${tool} is not on PATH`
  })
  assert(lines.length === runs.length, `watcherLines wrote ${lines.length} lines for ${runs.length} watchers`)
  return lines
}

/**
 * The doctor's report for the workspace folder: which repository overwatch
 * watches, each watcher and whether its tool is installed, whether the Claude
 * Code plugin is installed and matches, and whether Claude follows each
 * watcher's feed. Each line starts ✓, ⚠ or ✗.
 */
export async function diagnose({ folder, repository, runs, run = execute }) {
  assert(Array.isArray(runs), `diagnose was given runs ${typeof runs}; pass the running watchers`)
  const lines = ["overwatch doctor", "", "VS Code", `✓ overwatch extension ${VERSION}`]
  if (folder === undefined) return [...lines, "✗ no workspace folder is open; open a project folder"]
  const cwd = repository ?? folder
  if (repository === undefined) lines.push(`⚠ ${folder} is not in a git repository, so Claude Code, which watches only inside one, cannot share these watchers`)
  else lines.push(`✓ watching the git repository at ${repository}${realpathSync(folder) === repository ? "" : `, which holds ${folder}`}`)
  lines.push("", "Watchers")
  if (runs.length === 0) lines.push(`✗ no watcher for this project: no marker from watchers.json, and no command in ${OVERRIDE_PATH}`)
  lines.push(...watcherLines(runs), "", "Claude Code")
  const listed = await run("claude", ["plugin", "list", "--json"], cwd)
  if (listed.code === -1) return [...lines, "⚠ claude is not on PATH, so its plugin cannot be checked"]
  const { plugin, error } = pluginIn(listed.stdout)
  if (error !== undefined) return [...lines, `⚠ ${error}, so its plugin cannot be checked`]
  if (plugin === undefined) return [...lines, "✗ the overwatch plugin is not installed; in Claude Code run /plugin install overwatch --marketplace benomahony/overwatch"]
  if (!plugin.enabled) lines.push(`✗ ${plugin.id} ${plugin.version} is installed but disabled; run claude plugin enable ${plugin.id}`)
  else if (plugin.version !== VERSION) lines.push(`⚠ ${plugin.id} ${plugin.version} differs from this extension's ${VERSION}; update the older one so both read the same feeds`)
  else lines.push(`✓ ${plugin.id} ${plugin.version} is installed and enabled`)
  for (const each of runs) {
    const follower = followerOf(each.feed)
    lines.push(follower === undefined
      ? `⚠ Claude is not following ${each.watcher.name}; a Claude Code session in ${cwd} follows it from its next turn`
      : `✓ Claude Code (pid ${follower}) is following ${each.watcher.name}`)
  }
  assert(lines.every(line => line === "" || /^[✓⚠✗]|^overwatch doctor$|^VS Code$|^Watchers$|^Claude Code$/.test(line)), `a doctor line does not start with ✓, ⚠ or ✗`)
  return lines
}

/** Where the Claude Code plugin finds the reports of a watcher run in dir: the same name for the same language and real path, or dir itself when it is gone. */
export function feedOf(watcher, dir) {
  assert(typeof watcher?.language === "string" && typeof dir === "string", `feedOf was given language ${watcher?.language} and dir ${dir}; pass a watcher from findWatchers and its directory`)
  const real = existsSync(dir) ? realpathSync(dir) : dir
  const feed = join(homedir(), ".cache", "overwatch", "feeds", `${watcher.language}:${real}`.replace(/[^\w.-]+/g, "-"))
  assert(dirname(feed) === join(homedir(), ".cache", "overwatch", "feeds"), `feed ${feed} for ${dir} is outside the feeds directory`)
  return feed
}

/** The watcher's part of the status line for report. */
export function statusLine(watcher, report) {
  assert(Array.isArray(report?.failures) && typeof report.summary === "string", `statusLine was given ${JSON.stringify(report)}; pass a report from readReport`)
  const summary = DECORATION.reduce((text, decoration) => text.replace(decoration, ""), report.summary)
  const more = report.failures.length > 1 ? ` +${report.failures.length - 1} more` : ""
  const failing = report.failures.length > 0 ? `: ${report.failures[0]}${more}` : ""
  const line = `overwatch ${watcher.name} ${report.isFailed ? "✗" : "✓"} ${summary}${failing}`
  assert(line.startsWith(`overwatch ${watcher.name} `), `status ${line} does not name ${watcher.name}`)
  return line
}

/**
 * Collects what a watch command prints and hands onReport each build's report, with the text it was read from, once
 * the output goes quiet. `end` stops waiting and gives the report still in the output, if any; `recent` gives the
 * last of what it printed, for saying why it ended.
 */
function reportsOf(watcher, onReport) {
  assert(typeof watcher?.name === "string" && typeof onReport === "function", `reportsOf was given ${watcher?.name} and ${typeof onReport}; pass a watcher and a report handler`)
  let output = ""
  let recent = ""
  let flush
  const pending = () => {
    assert(output === "" || recent !== "", `${watcher.name} holds ${output.length} characters of output it was never given`)
    const report = readReport(watcher, output)
    if (report === undefined) return undefined
    const found = { report, text: output }
    output = ""
    assert(found.text !== "", `${watcher.name}'s report ${report.summary} was read from no output`)
    return found
  }
  const reading = {
    add: data => {
      output += data
      recent = (recent + data).slice(-4000)
      clearTimeout(flush)
      flush = setTimeout(() => {
        const found = pending()
        if (found !== undefined) onReport(found)
      }, QUIET_MS)
    },
    end: () => {
      clearTimeout(flush)
      return pending()
    },
    recent: () => recent,
  }
  assert(typeof reading.add === "function" && typeof reading.end === "function", `reportsOf for ${watcher.name} has nothing to read output with`)
  return reading
}

/** A command as one line, its arguments separated by spaces. */
function commandLine(argv) {
  assert(Array.isArray(argv) && argv.length > 0, `commandLine was given ${JSON.stringify(argv)}; pass a command and its arguments`)
  const line = argv.join(" ")
  assert(line.startsWith(argv[0]), `command line ${line} does not start with its command ${argv[0]}`)
  return line
}

/**
 * Opens a feed for each watcher where the Claude Code plugin reads it, owned by this window's pid, and watches the
 * feeds for the plugin's requests, handing each to onRequest with the run it names. Throws when they cannot be written.
 */
function openFeeds(runs, onRequest) {
  assert(runs.length > 0 && typeof onRequest === "function", `openFeeds was given ${runs.length} watchers and ${typeof onRequest}; pass the running watchers and a handler`)
  const feeds = join(homedir(), ".cache", "overwatch", "feeds")
  mkdirSync(feeds, { recursive: true })
  for (const run of runs) {
    rmSync(`${run.feed}.json`, { force: true })
    writeFileSync(`${run.feed}.jsonl`, "")
    writeFileSync(`${run.feed}.pid`, String(process.pid))
  }
  const requests = watchFiles(feeds, (_event, name) => {
    const run = runs.find(each => name?.startsWith(`${basename(each.feed)}.`))
    if (run !== undefined) onRequest(run, name)
  })
  assert(typeof requests?.close === "function", `watching ${feeds} gave ${typeof requests}, which cannot be closed`)
  return requests
}

/** Removes feed's pid file when this window wrote it, so the plugin stops following; another window's stays. Whether it was removed. */
function releaseFeed(feed) {
  assert(typeof feed === "string" && feed !== "", `releaseFeed was given ${JSON.stringify(feed)}; pass a feed path`)
  const path = `${feed}.pid`
  if (!existsSync(path) || readFileSync(path, "utf8") !== String(process.pid)) return false
  rmSync(path, { force: true })
  assert(!existsSync(path), `${path} is still there after removing it`)
  return true
}

/** Whether run is one of the extension's current runs, not one a restart or stop replaced. */
function isRunning(view, run) {
  assert(Number.isInteger(run?.index), `isRunning was given ${JSON.stringify(run?.watcher?.name)} with index ${run?.index}; pass a run from startWatching`)
  const isCurrent = view.runs[run.index] === run
  assert(!isCurrent || view.runs.includes(run), `run ${run.watcher.name} counts as running but is not one of the runs`)
  return isCurrent
}

/** Shows every run's status in the status bar, red while any build fails, hidden when there is nothing to show. */
function redraw(view) {
  assert(Array.isArray(view.runs), `the runs are ${typeof view.runs}; startWatching keeps them as a list`)
  const text = view.runs.filter(run => run.status !== "").map(run => `${run.status}${run.isFollowed ? " → Claude" : ""}`).join(" · ")
  view.item.text = text
  view.item.tooltip = text
  view.item.backgroundColor = view.runs.some(run => run.failingText) ? new view.ThemeColor("statusBarItem.errorBackground") : undefined
  if (text === "") view.item.hide()
  else view.item.show()
  assert(view.item.text === text, `the status bar shows ${view.item.text}, not ${text}`)
}

/** Sets run's part of the status bar. */
function setStatus(view, run, text) {
  assert(typeof text === "string", `${run.watcher.name}'s status was set to ${typeof text}; pass a line of text`)
  run.status = text
  redraw(view)
  assert(run.status === text, `${run.watcher.name}'s status is ${run.status} after setting ${text}`)
}

/** Shows message as a VS Code error notification, offering the failing builds' report. */
function notify(view, message) {
  assert(typeof view.window.showErrorMessage === "function", `vscode.window.showErrorMessage is ${typeof view.window.showErrorMessage}; pass the vscode window`)
  assert(typeof message === "string" && message !== "", `notify was given message ${JSON.stringify(message)}; pass the text to show`)
  const shown = view.window.showErrorMessage(message, "Show report")
  shown?.then?.(choice => { if (choice === "Show report") view.channel.show(true) })
}

/** Puts every failing build's output in the overwatch output channel. */
function updateChannel(view) {
  const failing = view.runs.filter(run => run.failingText)
  const text = failing.map(run => `overwatch ${run.watcher.name}\n${run.failingText}`).join("\n\n")
  assert(failing.every(run => text.includes(`overwatch ${run.watcher.name}\n`)), `the output channel leaves out a failing watcher`)
  view.channel.replace(text)
  assert(failing.length > 0 || text === "", `the output channel holds ${text.length} characters with nothing failing`)
}

/** Shows a build's report and announces a new failure or a recovery once. */
function deliver(view, run, report) {
  assert(typeof report?.isFailed === "boolean", `${run.watcher.name} delivered ${JSON.stringify(report)}; pass a report from readReport`)
  const line = statusLine(run.watcher, report)
  setStatus(view, run, line)
  run.hasReport = true
  const failing = report.isFailed ? report.failures.join("\n") || report.summary : undefined
  const isNew = failing !== undefined && failing !== run.failing
  const isRecovery = !report.isFailed && run.failing !== undefined
  run.failing = failing
  run.failingText = report.isFailed ? report.text : undefined
  redraw(view)
  if (report.isFailed || isRecovery) updateChannel(view)
  if (isNew) notify(view, line)
  else if (isRecovery) view.window.showInformationMessage(`${line}, green again`)
  assert(run.hasReport && (run.failing === undefined) === !report.isFailed, `${run.watcher.name} is marked failing ${run.failing} after a report that failed ${report.isFailed}`)
}

/** Writes a build's output to run's feed for the Claude Code plugin to read. */
function publish(view, run, text, code) {
  assert(typeof run.feed === "string", `${run.watcher.name} has feed ${run.feed}; startWatching names each run's feed`)
  assert(typeof text === "string", `${run.watcher.name} published ${typeof text}; pass what it printed`)
  try {
    const line = JSON.stringify({ text, code })
    writeFileSync(`${run.feed}.json`, line)
    appendFileSync(`${run.feed}.jsonl`, `${line}\n`)
  } catch (error) {
    view.channel.appendLine(`overwatch: could not write ${run.watcher.name}'s report to ${run.feed} for Claude Code: ${error.message}`)
  }
}

/** Shows that run's command, `argv`, could not give a result, `why`, with the last of the `output` it printed. */
function reportBroken(view, run, { argv, why, output }) {
  assert(typeof why === "string" && typeof output === "string", `reportBroken was given why ${why} and output ${typeof output}; say what went wrong and pass what it printed`)
  const command = commandLine(argv)
  const tail = output.trim().split("\n").slice(-10).join("\n")
  setStatus(view, run, `overwatch ${run.watcher.name}: ${command} ${why}`)
  view.channel.appendLine(`overwatch: ${command} ${why}\n${tail}`)
  notify(view, `overwatch: ${command} ${why}`)
  assert(run.status.endsWith(why), `${run.watcher.name}'s status ${run.status} does not say ${why}`)
}

/** Starts argv for run, handing onOutput what it prints and onExit its code once it ends. */
function launch(view, run, argv, { onOutput, onExit }) {
  assert(Array.isArray(argv) && argv.length > 0, `${run.watcher.name} was asked to launch ${JSON.stringify(argv)}; give it argv or baseline`)
  assert(typeof onOutput === "function" && typeof onExit === "function", `launching ${commandLine(argv)} needs output and exit handlers`)
  const [command, ...args] = argv
  const child = view.start(command, args, { cwd: run.watcher.dir ? join(view.cwd, run.watcher.dir) : view.cwd, stdio: ["ignore", "pipe", "pipe"] })
  let exited = false
  const exit = code => {
    assert(Number.isInteger(code), `${command} ended with code ${code}; pass its exit code, or -1 when it could not start`)
    if (exited) return
    exited = true
    onExit(code)
    assert(exited, `${command}'s exit was handled but is not marked`)
  }
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", onOutput)
  child.stderr?.on("data", onOutput)
  child.on("error", () => exit(-1))
  child.on("close", code => exit(code ?? -1))
  run.process = child
  assert(run.process === child, `${run.watcher.name} does not hold the process it launched`)
  return child
}

/** Runs argv to its end and reports what it printed, unless isStale says a newer run overtook it; then calls done. */
function runOnce(view, run, argv, { done, isStale }) {
  assert(Array.isArray(argv) && argv.length > 0, `${run.watcher.name} was asked to run ${JSON.stringify(argv)} once; give it a baseline`)
  assert(typeof done === "function", `running ${commandLine(argv)} once needs a done handler, not ${typeof done}`)
  let output = ""
  launch(view, run, argv, { onOutput: data => { output += data }, onExit: code => {
    run.process = undefined
    if (!isRunning(view, run)) return
    if (!isStale?.()) {
      const report = readReport(run.watcher, output, code)
      if (report) publish(view, run, output, code)
      if (report) deliver(view, run, report)
      else reportBroken(view, run, { argv, why: code === -1 ? "could not start" : "gave no summary", output })
    }
    done()
  } })
}

/** Gives run a rerun that runs its suite once saves go quiet, one run at a time. */
function rerunOnSave(view, run) {
  const { baseline } = run.watcher
  assert(Array.isArray(baseline) && baseline.length > 0, `${run.watcher.name} reruns on save with baseline ${JSON.stringify(baseline)}; give it one`)
  let timer
  let isBusy = false
  let isPending = false
  const rerun = () => {
    if (!isRunning(view, run)) return
    assert(!isBusy || run.process !== undefined || isPending, `${run.watcher.name} is busy rerunning with no process to stop`)
    if (isBusy) {
      isPending = true
      run.process?.kill("SIGTERM")
      return
    }
    isBusy = true
    isPending = false
    runOnce(view, run, run.watcher.baseline, { done: () => {
      isBusy = false
      if (isPending) rerun()
    }, isStale: () => isPending })
    assert(isBusy || !isRunning(view, run), `${run.watcher.name} started a rerun but is not marked busy`)
  }
  run.rerun = () => {
    clearTimeout(timer)
    timer = setTimeout(rerun, QUIET_MS)
  }
  assert(typeof run.rerun === "function", `${run.watcher.name} has no rerun after rerunOnSave`)
}

/**
 * After run's watcher ended, `what` saying how, having started at `startedAt` and last printed `output`: restarts it
 * with the Neovim plugin's back-off, or gives up after quick exits. It starts again through run.relaunch, set when
 * its run is made, as Claude Code's restarts go through the session.
 */
function restart(view, run, { startedAt, what, output }) {
  assert(typeof run.relaunch === "function", `${run.watcher.name} has no relaunch; startWatching sets one for each run`)
  assert(startedAt <= performance.now(), `${run.watcher.name} started at ${startedAt}, after now`)
  const isQuick = performance.now() - startedAt < RETRY_MS
  run.quickExits = isQuick ? run.quickExits + 1 : 0
  if (run.quickExits >= GIVE_UP_AFTER) {
    reportBroken(view, run, { argv: run.watcher.argv, why: `${what} ${run.quickExits} times in a row; run Overwatch: Start to retry`, output })
    return
  }
  const delay = isQuick ? RETRY_MS * 2 ** (run.quickExits - 1) : 0
  const when = delay === 0 ? "now" : `in ${delay / 1000}s`
  setStatus(view, run, `overwatch ${run.watcher.name}: ${what}, restarting ${when}`)
  view.window.showWarningMessage(`overwatch: ${commandLine(run.watcher.argv)} ${what}, restarting ${when}`)
  setTimeout(() => { if (isRunning(view, run)) run.relaunch() }, delay)
}

/** Runs run's watch command, reporting each build and restarting it when it ends. */
function watch(view, run) {
  const { watcher } = run
  assert(Array.isArray(watcher.argv) && watcher.argv.length > 0, `${watcher.name} is asked to watch with argv ${JSON.stringify(watcher.argv)}; give it a watch command`)
  assert(run.process === undefined, `${watcher.name} starts watching while its last process still runs`)
  const startedAt = performance.now()
  if (!run.hasReport) setStatus(view, run, `overwatch ${watcher.name}: starting ${commandLine(watcher.argv)}`)
  const take = found => {
    assert(typeof found?.text === "string" && found.report !== undefined, `${watcher.name} was handed ${JSON.stringify(found)}; pass a report and the text it was read from`)
    publish(view, run, found.text)
    deliver(view, run, found.report)
    assert(run.hasReport, `${watcher.name} took a report but is not marked as having one`)
  }
  const reports = reportsOf(watcher, take)
  launch(view, run, watcher.argv, { onOutput: reports.add, onExit: code => {
    const last = reports.end()
    if (!isRunning(view, run)) return
    run.process = undefined
    if (last !== undefined) take(last)
    restart(view, run, { startedAt, what: code === -1 ? "could not start" : `exited with code ${code}`, output: reports.recent() })
  } })
}

/** Starts run: its full suite first when it has one, then its watcher or reruns on save. */
function begin(view, run) {
  const { watcher } = run
  assert(isRunning(view, run), `${watcher.name} is asked to begin while not one of the runs`)
  const afterBaseline = () => {
    if (!isRunning(view, run)) return
    assert(run.process === undefined, `${watcher.name}'s full run still runs as its watcher starts`)
    if (watcher.argv) watch(view, run)
    else if (watcher.baseline) rerunOnSave(view, run)
    assert(watcher.argv === undefined || run.process !== undefined, `${watcher.name} has a watch command but no process after starting it`)
  }
  const hasBaseline = (watcher.baseline?.length ?? 0) > 0
  if (hasBaseline) {
    setStatus(view, run, `overwatch ${watcher.name}: running the full suite with ${commandLine(watcher.baseline)}`)
    runOnce(view, run, watcher.baseline, { done: afterBaseline })
  } else {
    afterBaseline()
  }
  assert(!hasBaseline || run.process !== undefined || !isRunning(view, run), `${watcher.name} began its full run without a process`)
}

/** Stops every run and releases the feeds this window wrote. */
function stop(view) {
  const stopping = view.runs
  assert(Array.isArray(stopping), `the runs are ${typeof stopping}; startWatching keeps them as a list`)
  view.runs = []
  view.requests?.close()
  view.requests = undefined
  for (const run of stopping) {
    run.process?.kill("SIGTERM")
    releaseFeed(run.feed)
  }
  redraw(view)
  assert(view.runs.length === 0 && view.requests === undefined, `${view.runs.length} watchers still run after stopping`)
}

/** Answers the Claude Code plugin's request through run's feed: a rerun, or a change in who follows it. */
function onRequest(view, run, name) {
  assert(name.startsWith(`${basename(run.feed)}.`), `request ${name} is not one of ${run.watcher.name}'s feed files`)
  if (name.endsWith(".changed")) run.rerun?.()
  if (!name.endsWith(".claude")) return
  run.isFollowed = followerOf(run.feed) !== undefined
  redraw(view)
  assert(typeof run.isFollowed === "boolean", `${run.watcher.name} is followed ${run.isFollowed}, not yes or no`)
}

/** Starts the watchers of the workspace folder's repository afresh, with a feed for each. */
function startWatching(view) {
  stop(view)
  assert(view.runs.length === 0 && view.requests === undefined, `startWatching found ${view.runs.length} watchers still running after stopping them`)
  view.folder = view.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (view.folder === undefined) return
  view.repository = repositoryOf(view.folder)
  view.cwd = view.repository ?? view.folder
  view.runs = findWatchers(view.cwd).map((watcher, index) => {
    const feed = feedOf(watcher, watcher.dir ? join(view.cwd, watcher.dir) : view.cwd)
    const run = { index, watcher, status: "", quickExits: 0, feed, isFollowed: followerOf(feed) !== undefined }
    run.relaunch = () => begin(view, run)
    return run
  })
  assert(view.runs.every((run, index) => run.index === index), `the runs are not numbered by their place in the list`)
  if (view.runs.length > 0) {
    try {
      view.requests = openFeeds(view.runs, (run, name) => onRequest(view, run, name))
    } catch (error) {
      view.channel.appendLine(`overwatch: could not open the feeds Claude Code follows (${error.message}); Claude Code runs its own watchers`)
    }
  }
  for (const run of view.runs) begin(view, run)
}

/** Reruns each watcher that reruns on save. */
function changed(view) {
  assert(Array.isArray(view.runs), `the runs are ${typeof view.runs}; startWatching keeps them as a list`)
  const rerunning = view.runs.filter(run => run.rerun !== undefined)
  for (const run of rerunning) run.rerun()
  assert(rerunning.every(run => isRunning(view, run)), `a save reran a watcher that is no longer running`)
}

/** Shows and returns the doctor's report for the workspace folder. */
async function doctor(view) {
  assert(Array.isArray(view.runs), `the doctor found runs ${typeof view.runs}; startWatching keeps them as a list`)
  const lines = await diagnose({ folder: view.folder, repository: view.repository, runs: view.runs })
  view.doctorChannel.replace(lines.join("\n"))
  view.doctorChannel.show(true)
  assert(lines[0] === "overwatch doctor", `the doctor's report opens with ${lines[0]}, not its title`)
  return lines
}

/** Runs the project's watchers beside VS Code, showing their results in the status bar and each failing build in the overwatch output channel. */
export function registerVSCode(vscode, context, start = spawn) {
  assert(typeof vscode?.window?.createStatusBarItem === "function", `registerVSCode was given an API whose window.createStatusBarItem is ${typeof vscode?.window?.createStatusBarItem}; pass the vscode module`)
  assert(Array.isArray(context?.subscriptions), `registerVSCode was given a context whose subscriptions are ${typeof context?.subscriptions}; pass activate's context`)
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
  item.command = "overwatch.show"
  const channel = vscode.window.createOutputChannel("overwatch")
  const doctorChannel = vscode.window.createOutputChannel("overwatch doctor")
  // One window's overwatch, which the functions above are given: VS Code's window, workspace and theme colours and how
  // to start a process, the status bar item and output channels, the folder and repository watched, and the runs with
  // the watcher of their feeds.
  const { window, workspace, ThemeColor } = vscode
  const view = { window, workspace, ThemeColor, start, item, channel, doctorChannel, folder: undefined, repository: undefined, cwd: undefined, runs: [], requests: undefined }
  const overwatch = { start: () => startWatching(view), stop: () => stop(view), changed: () => changed(view), doctor: () => doctor(view), status: () => item.text }

  context.subscriptions.push(
    item,
    channel,
    doctorChannel,
    // VS Code calls dispose when the extension stops.
    { dispose: overwatch.stop },
    vscode.commands.registerCommand("overwatch.start", overwatch.start),
    vscode.commands.registerCommand("overwatch.stop", overwatch.stop),
    vscode.commands.registerCommand("overwatch.show", () => channel.show(true)),
    vscode.commands.registerCommand("overwatch.doctor", overwatch.doctor),
    workspace.onDidSaveTextDocument(overwatch.changed),
    workspace.onDidChangeWorkspaceFolders(overwatch.start),
  )
  overwatch.start()
  return overwatch
}

/** VS Code's entry point. */
export async function activate(context) {
  assert(Array.isArray(context?.subscriptions), `activate was given a context whose subscriptions are ${typeof context?.subscriptions}; VS Code passes the extension context`)
  const api = await import("vscode")
  const overwatch = registerVSCode(api.default ?? api, context)
  assert(typeof overwatch.stop === "function", `registerVSCode returned ${typeof overwatch}, which cannot be stopped`)
}
