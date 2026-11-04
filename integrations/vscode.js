import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, watch as watchFiles, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, delimiter, join } from "node:path"

export const OVERRIDE_PATH = ".overwatch.json"
const QUIET_MS = 400
export const RETRY_MS = 30_000
const GIVE_UP_AFTER = 3
const TABLE = JSON.parse(readFileSync(new URL("../watchers.json", import.meta.url), "utf8"))
export const WATCHERS = TABLE.watchers
const SEARCH_SKIP = new Set(TABLE.search.skip)
const ANSI = /\x1b\[[\d;?]*[A-Za-z]/g
const DECORATION = [/^Build Summary:\s*/, /^zanity:\s*/, /^=+\s*/, /\s*=+$/, /^Test Files\s+/, /^Test Suites:\s*/, /^DONE\s+/, /^ok \| /, /^FAILED \| /]

/** Whether name is an executable on PATH. */
function isExecutable(name) {
  assert(typeof name === "string" && name !== "", `isExecutable was given ${name}; name an executable`)
  const extensions = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""]
  return (process.env.PATH ?? "").split(delimiter).some(dir => extensions.some(extension => {
    try {
      accessSync(join(dir, name + extension), constants.X_OK)
      return true
    } catch {
      return false
    }
  }))
}

/** The language a watcher is an alternative for. */
function languageOf(watcher) {
  return watcher.language ?? watcher.name
}

/** The watcher with the fields override gives replacing its own. */
function applyOverride(watcher, override) {
  return {
    ...watcher,
    language: languageOf(watcher),
    name: override.name ?? watcher.name,
    argv: override.argv ?? watcher.argv,
    baseline: override.baseline ?? watcher.baseline,
    summary: override.summary ?? watcher.summary,
    failed: override.failed ?? watcher.failed,
  }
}

/** The first of a language's alternatives whose marker is in dir and whose tool, if it needs one, is on PATH. */
function firstPresent(alternatives, dir) {
  return alternatives.find(watcher => existsSync(join(dir, watcher.marker)) && (watcher.requires === undefined || isExecutable(watcher.requires)))
}

/** The directories search.depth levels down, relative to cwd, nearest and then alphabetically first. */
function findSubprojects(cwd) {
  const found = []
  let parents = [""]
  for (let depth = 0; depth < TABLE.search.depth; depth++) {
    const level = parents.flatMap(parent => {
      try {
        return readdirSync(join(cwd, parent), { withFileTypes: true })
          .filter(entry => entry.isDirectory() && !entry.name.startsWith(".") && !SEARCH_SKIP.has(entry.name))
          .map(entry => parent === "" ? entry.name : `${parent}/${entry.name}`)
      } catch {
        return []
      }
    }).sort()
    found.push(...level)
    parents = level
  }
  return found
}

/** The project's .overwatch.json, or an empty override when it has none or it is not an object. */
function readOverride(cwd) {
  try {
    const decoded = JSON.parse(readFileSync(join(cwd, OVERRIDE_PATH), "utf8"))
    return decoded !== null && typeof decoded === "object" ? decoded : {}
  } catch {
    return {}
  }
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
    if (atRoot) {
      found.push(applyOverride(atRoot, found.length === 0 ? override : {}))
      continue
    }
    subprojects ??= findSubprojects(cwd)
    const claimed = []
    for (const dir of subprojects) {
      if (claimed.some(parent => dir.startsWith(`${parent}/`))) continue
      const present = firstPresent(alternatives, join(cwd, dir))
      if (!present) continue
      claimed.push(dir)
      found.push(applyOverride({ ...present, language, name: `${present.name} ${dir}`, dir }, found.length === 0 ? override : {}))
    }
  }
  if (found.length > 0) return found
  const hasCommand = override.argv !== undefined || (override.baseline?.length ?? 0) > 0
  if (!hasCommand || override.summary === undefined || override.failed === undefined) return []
  return [applyOverride({ name: "project", language: "project", marker: OVERRIDE_PATH }, override)]
}

/** The first line of output the pattern matches, trimmed. */
function firstLine(pattern, output) {
  const match = new RegExp(pattern, "m").exec(output)
  return match?.[0].trim()
}

/** Each failing test or error the output names, once each, in order. */
function failuresIn(watcher, output) {
  if (watcher.failure === undefined) return []
  const names = [...output.matchAll(new RegExp(watcher.failure, "gm"))]
    .map(match => match.slice(1).find(group => group !== undefined && group.trim() !== "")?.trim())
    .filter(name => name !== undefined)
  return [...new Set(names)]
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
  return { summary, isFailed, text: clean.trim(), failures: isFailed ? failures : [] }
}

/** Where the Claude Code plugin finds the reports of a watcher run in dir: the same name for the same language and real path. */
export function feedOf(watcher, dir) {
  let real = dir
  try {
    real = realpathSync(dir)
  } catch {}
  return join(homedir(), ".cache", "overwatch", "feeds", `${watcher.language}:${real}`.replace(/[^\w.-]+/g, "-"))
}

/** The watcher's part of the status line for report. */
export function statusLine(watcher, report) {
  const summary = DECORATION.reduce((text, decoration) => text.replace(decoration, ""), report.summary)
  const more = report.failures.length > 1 ? ` +${report.failures.length - 1} more` : ""
  const failing = report.failures.length > 0 ? `: ${report.failures[0]}${more}` : ""
  return `overwatch ${watcher.name} ${report.isFailed ? "✗" : "✓"} ${summary}${failing}`
}

/** Runs the project's watchers beside VS Code, showing their results in the status bar and each failing build in the overwatch output channel. */
export function registerVSCode(vscode, context, start = spawn) {
  assert(typeof vscode?.window?.createStatusBarItem === "function", "registerVSCode needs the vscode API; pass the vscode module")
  assert(Array.isArray(context?.subscriptions), "registerVSCode needs the extension context; pass activate's context")
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
  item.command = "overwatch.show"
  const channel = vscode.window.createOutputChannel("overwatch")
  let cwd
  let runs = []
  let requests

  const show = () => channel.show(true)
  const commandLine = argv => argv.join(" ")
  const isRunning = run => runs[run.index] === run

  const redraw = () => {
    const text = runs.map(run => run.status).filter(status => status !== "").join(" · ")
    item.text = text
    item.tooltip = text
    item.backgroundColor = runs.some(run => run.failingText) ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined
    if (text === "") item.hide()
    else item.show()
  }

  const setStatus = (run, text) => {
    run.status = text
    redraw()
  }

  const notify = (level, message) => {
    const shown = vscode.window[level](message, "Show report")
    shown?.then?.(choice => { if (choice === "Show report") show() })
  }

  const updateChannel = () => {
    channel.replace(runs.filter(run => run.failingText).map(run => `overwatch ${run.watcher.name}\n${run.failingText}`).join("\n\n"))
  }

  const deliver = (run, report) => {
    const line = statusLine(run.watcher, report)
    setStatus(run, line)
    run.hasReport = true
    const failing = report.isFailed ? report.failures.join("\n") || report.summary : undefined
    const isNew = failing !== undefined && failing !== run.failing
    const isRecovery = !report.isFailed && run.failing !== undefined
    run.failing = failing
    run.failingText = report.isFailed ? report.text : undefined
    redraw()
    if (report.isFailed || isRecovery) updateChannel()
    if (isNew) notify("showErrorMessage", line)
    else if (isRecovery) vscode.window.showInformationMessage(`${line}, green again`)
  }

  const publish = (run, text, code) => {
    const line = JSON.stringify({ text, code })
    try {
      writeFileSync(`${run.feed}.json`, line)
      appendFileSync(`${run.feed}.jsonl`, `${line}\n`)
    } catch {}
  }

  const reportBroken = (run, argv, why, output) => {
    const tail = output.trim().split("\n").slice(-10).join("\n")
    setStatus(run, `overwatch ${run.watcher.name}: ${commandLine(argv)} ${why}`)
    channel.appendLine(`overwatch: ${commandLine(argv)} ${why}\n${tail}`)
    notify("showErrorMessage", `overwatch: ${commandLine(argv)} ${why}`)
  }

  const launch = (run, argv, onOutput, onExit) => {
    const [command, ...args] = argv
    const child = start(command, args, { cwd: run.watcher.dir ? join(cwd, run.watcher.dir) : cwd, stdio: ["ignore", "pipe", "pipe"] })
    let exited = false
    const exit = code => {
      if (exited) return
      exited = true
      onExit(code)
    }
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", onOutput)
    child.stderr?.on("data", onOutput)
    child.on("error", () => exit(-1))
    child.on("close", code => exit(code ?? -1))
    run.process = child
    return child
  }

  const runOnce = (run, argv, done, isStale) => {
    let output = ""
    launch(run, argv, data => { output += data }, code => {
      run.process = undefined
      if (!isRunning(run)) return
      if (!isStale?.()) {
        const report = readReport(run.watcher, output, code)
        if (report) publish(run, output, code)
        if (report) deliver(run, report)
        else reportBroken(run, argv, code === -1 ? "could not start" : "gave no summary", output)
      }
      done()
    })
  }

  const rerunOnSave = run => {
    let timer
    let isBusy = false
    let isPending = false
    const rerun = () => {
      if (!isRunning(run)) return
      if (isBusy) {
        isPending = true
        run.process?.kill("SIGTERM")
        return
      }
      isBusy = true
      isPending = false
      runOnce(run, run.watcher.baseline, () => {
        isBusy = false
        if (isPending) rerun()
      }, () => isPending)
    }
    run.rerun = () => {
      clearTimeout(timer)
      timer = setTimeout(rerun, QUIET_MS)
    }
  }

  const restart = (run, startedAt, what, output) => {
    const isQuick = Date.now() - startedAt < RETRY_MS
    run.quickExits = isQuick ? run.quickExits + 1 : 0
    if (run.quickExits >= GIVE_UP_AFTER) {
      reportBroken(run, run.watcher.argv, `${what} ${run.quickExits} times in a row; run Overwatch: Start to retry`, output)
      return
    }
    const delay = isQuick ? RETRY_MS * 2 ** (run.quickExits - 1) : 0
    const when = delay === 0 ? "now" : `in ${delay / 1000}s`
    setStatus(run, `overwatch ${run.watcher.name}: ${what}, restarting ${when}`)
    vscode.window.showWarningMessage(`overwatch: ${commandLine(run.watcher.argv)} ${what}, restarting ${when}`)
    setTimeout(() => { if (isRunning(run)) begin(run) }, delay)
  }

  const watch = run => {
    const { watcher } = run
    let output = ""
    let recent = ""
    let flush
    const startedAt = Date.now()
    if (!run.hasReport) setStatus(run, `overwatch ${watcher.name}: starting ${commandLine(watcher.argv)}`)
    launch(run, watcher.argv, data => {
      output += data
      recent = (recent + data).slice(-4000)
      clearTimeout(flush)
      flush = setTimeout(() => {
        const report = readReport(watcher, output)
        if (report === undefined) return
        publish(run, output)
        output = ""
        deliver(run, report)
      }, QUIET_MS)
    }, code => {
      clearTimeout(flush)
      if (!isRunning(run)) return
      run.process = undefined
      const report = readReport(watcher, output)
      if (report) publish(run, output)
      if (report) deliver(run, report)
      restart(run, startedAt, code === -1 ? "could not start" : `exited with code ${code}`, recent)
    })
  }

  const begin = run => {
    const { watcher } = run
    const afterBaseline = () => {
      if (!isRunning(run)) return
      if (watcher.argv) watch(run)
      else if (watcher.baseline) rerunOnSave(run)
    }
    if ((watcher.baseline?.length ?? 0) > 0) {
      setStatus(run, `overwatch ${watcher.name}: running the full suite with ${commandLine(watcher.baseline)}`)
      runOnce(run, watcher.baseline, afterBaseline)
    } else {
      afterBaseline()
    }
  }

  const stop = () => {
    const stopping = runs
    runs = []
    requests?.close()
    requests = undefined
    for (const run of stopping) {
      run.process?.kill("SIGTERM")
      rmSync(`${run.feed}.pid`, { force: true })
    }
    redraw()
  }

  const startWatching = () => {
    stop()
    cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (cwd === undefined) return
    runs = findWatchers(cwd).map((watcher, index) => ({ index, watcher, status: "", quickExits: 0, feed: feedOf(watcher, watcher.dir ? join(cwd, watcher.dir) : cwd) }))
    if (runs.length > 0) {
      try {
        const feeds = join(homedir(), ".cache", "overwatch", "feeds")
        mkdirSync(feeds, { recursive: true })
        for (const run of runs) {
          rmSync(`${run.feed}.json`, { force: true })
          writeFileSync(`${run.feed}.jsonl`, "")
          writeFileSync(`${run.feed}.pid`, String(process.pid))
        }
        requests = watchFiles(feeds, (_event, name) => runs.find(run => name === `${basename(run.feed)}.changed`)?.rerun?.())
      } catch {}
    }
    for (const run of runs) begin(run)
  }

  const changed = () => {
    for (const run of runs) run.rerun?.()
  }

  context.subscriptions.push(
    item,
    channel,
    { dispose: stop },
    vscode.commands.registerCommand("overwatch.start", startWatching),
    vscode.commands.registerCommand("overwatch.stop", stop),
    vscode.commands.registerCommand("overwatch.show", show),
    vscode.workspace.onDidSaveTextDocument(changed),
    vscode.workspace.onDidChangeWorkspaceFolders(startWatching),
  )
  startWatching()
  return { start: startWatching, stop, changed, status: () => item.text }
}

/** VS Code's entry point. */
export async function activate(context) {
  const api = await import("vscode")
  registerVSCode(api.default ?? api, context)
}

export function deactivate() {}
