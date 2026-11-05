/**
 * Tests of overwatch's OpenCode and pi integrations, each given a fake checker in place of hooks/codex.py.
 *
 * Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
 */
import assert from "node:assert/strict"
import test from "node:test"

import OpenCode, { OverwatchPlugin, createV1Hooks, setupV2 } from "../integrations/opencode.js"
import { registerPi } from "../integrations/pi.js"
import { WATCHERS, diagnose, feedOf, findWatchers, readReport, registerVSCode, repositoryOf, statusLine } from "../integrations/vscode.js"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** The checker's output for a failing fixture that tells message, or a passing one. */
function output(message, failed = true) {
  assert(typeof message === "string" && message !== "", `fixture message ${JSON.stringify(message)}; give the failure some text`)
  const result = failed
    ? {
        decision: "block",
        reason: message,
        systemMessage: "Overwatch: fixture failed",
        hookSpecificOutput: { additionalContext: message },
      }
    : {}
  assert((result.decision === "block") === failed, `fixture output ${JSON.stringify(result)} for failed=${failed}; block only a failure`)
  return result
}

/** The project directory every fixture event names; the fake checkers never read it. */
const PROJECT = "/project"

/** A copy of the hooks OpenCode 2's setup registers with checker, by surface and name. */
async function v2Hooks(checker) {
  assert(typeof checker === "function", `checker is ${typeof checker}; pass a function from payload to output`)
  const hooks = {}
  const ctx = {
    location: { directory: PROJECT },
    session: {
      hook: async (name, callback) => { hooks[`session:${name}`] = callback },
      prompt: async () => undefined,
    },
    tool: { hook: async (name, callback) => { hooks[`tool:${name}`] = callback } },
    event: { subscribe: async function* () {} },
  }
  await setupV2(ctx, checker)
  assert.deepEqual(Object.keys(hooks).sort(), ["session:context", "tool:execute.after", "tool:execute.before"])
  assert(Object.values(hooks).every(hook => typeof hook === "function"), `setup registered ${Object.keys(hooks)} with a hook that is not a function; register functions`)
  return { ...hooks }
}

test("the OpenCode package exposes V1 and V2 entrypoints", () => {
  assert.equal(typeof OverwatchPlugin, "function")
  assert.equal(OpenCode.id, "overwatch")
  assert.equal(OpenCode.setup, setupV2)
  assert.equal(OpenCode.server, createV1Hooks)
})

test("OpenCode V1 appends a failed check to an editing tool result", async () => {
  const hooks = createV1Hooks(
    { directory: PROJECT, client: { tui: { showToast: async () => undefined } } },
    async event => output(`failure after ${event.tool_name}`),
  )
  const result = { output: "edited file" }
  await hooks["tool.execute.after"](
    { tool: "edit", sessionID: "session-1", callID: "call-1", args: { path: "x" } },
    result,
  )
  assert.match(result.output, /failure after edit/)
})

test("OpenCode V2 checks edits and adds a cached failure to model context", async () => {
  const hooks = {}
  const checks = []
  const ctx = {
    location: { directory: PROJECT },
    session: {
      hook: async (name, callback) => { hooks[`session:${name}`] = callback },
      prompt: async () => undefined,
    },
    tool: { hook: async (name, callback) => { hooks[`tool:${name}`] = callback } },
    event: { subscribe: async function* () {} },
  }
  await setupV2(ctx, async event => {
    checks.push(event)
    return output("fix the test")
  })
  await hooks["tool:execute.after"]({ tool: "write", sessionID: "session-1", id: "call-1", input: {} })
  const event = { sessionID: "session-1", system: [] }
  await hooks["session:context"](event)
  assert.deepEqual(checks.map(each => each.hook_event_name), ["PostToolUse", "UserPromptSubmit"])
  assert.equal(event.system.at(-1).text, "fix the test")
})

test("Pi appends failures and guards settlement until the check passes", async () => {
  const handlers = {}
  const pi = { on: (name, handler) => { handlers[name] = handler } }
  let failing = true
  registerPi(pi, async event => output(`failure at ${event.hook_event_name}`, failing))
  const statuses = []
  const ctx = {
    cwd: PROJECT,
    sessionManager: { getSessionId: () => "session-1" },
    ui: { setStatus: (_key, value) => statuses.push(value) },
  }
  const changed = await handlers.tool_result(
    { toolName: "edit", toolCallId: "call-1", input: {}, content: [{ type: "text", text: "done" }] },
    ctx,
  )
  assert.equal(changed.content.at(-1).text, "failure at PostToolUse")

  const settling = { entries: [], continue: false }
  const first = await handlers.agent_before_settle(settling, ctx)
  const second = await handlers.agent_before_settle(settling, ctx)
  assert.equal(first.continue, true)
  assert.equal(first.entries[0].customType, "overwatch")
  assert.equal(second.continue, true)
  assert.match(statuses.at(-1), /fixture failed/)
  failing = false
  assert.equal(await handlers.agent_before_settle(settling, ctx), undefined)
})

/**
 * The fake checker's output for a project whose 29 warnings protect only the publish tool while failing. The
 * integrations under test build every event, so a field of another type is a bug in them, reported as such.
 */
function protectionOutput(event, failing) {
  if (event?.hook_event_name !== "PreToolUse") throw new TypeError(`protection asked of ${event?.hook_event_name}; only send PreToolUse to protect a tool`)
  if (typeof event.tool_name !== "string") throw new TypeError(`PreToolUse names tool ${String(event.tool_name)}; set tool_name`)
  if (!failing || event.tool_name !== "publish") return {}
  const denial = { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "29 warnings" } }
  assert(event.tool_name === "publish" && failing, `denied ${event.tool_name} while failing=${failing}; deny only publish while failing`)
  assert(denial.hookSpecificOutput.permissionDecision === "deny", `denial ${JSON.stringify(denial)} does not deny; set permissionDecision`)
  return denial
}

test("Pi refuses a tool the checker denies and runs the tools it allows", async () => {
  const handlers = {}
  const pi = { on: (name, handler) => { handlers[name] = handler } }
  let failing = true
  registerPi(pi, async event => protectionOutput(event, failing))
  const ctx = { cwd: PROJECT, sessionManager: { getSessionId: () => "s1" } }
  for (const toolName of ["read", "edit", "bash"]) {
    assert.equal(await handlers.tool_call({ toolName, input: { command: "rg --files" } }, ctx), undefined)
  }
  assert.deepEqual(await handlers.tool_call({ toolName: "publish", input: {} }, ctx), { block: true, reason: "29 warnings" })
  failing = false
  assert.equal(await handlers.tool_call({ toolName: "publish", input: {} }, ctx), undefined)
})

test("OpenCode V1 protects only configured actions in its before-tool hook", async () => {
  let failing = true
  const hooks = createV1Hooks({ directory: PROJECT }, async event => protectionOutput(event, failing))
  await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s1" }, { args: { command: "cat example.py" } })
  await assert.rejects(hooks["tool.execute.before"]({ tool: "publish", sessionID: "s1" }, { args: {} }), /29 warnings/)
  failing = false
  await hooks["tool.execute.before"]({ tool: "publish", sessionID: "s1" }, { args: {} })
})

test("OpenCode V2 allows diagnostics while protecting publication until recovery", async () => {
  let failing = true
  const hooks = await v2Hooks(async event => protectionOutput(event, failing))
  await hooks["tool:execute.before"]({ tool: "bash", sessionID: "s1", input: { command: "rg --files" } })
  await assert.rejects(hooks["tool:execute.before"]({ tool: "publish", sessionID: "s1", input: {} }), /29 warnings/)
  failing = false
  await hooks["tool:execute.before"]({ tool: "publish", sessionID: "s1", input: {} })
})

const PYTEST_FAILING = `tests/test_add.py:9: AssertionError
=========================== short test summary info ============================
FAILED tests/test_add.py::test_add - assert 10 == 11
========================= 1 failed, 2 passed in 0.03s ==========================
`

/** How long a test waits for the extension to show a result, polling as `t.waitFor` does. */
const WAIT = { interval: 20, timeout: 5000 }

/** The path of `name` inside dir, which a fixture's reads and writes may not leave. */
function within(dir, name) {
  assert(name !== "" && !name.startsWith("/") && !name.split("/").includes(".."), `${JSON.stringify(name)} is not a path inside ${dir}; name a file relative to it`)
  const path = join(dir, name)
  assert(path.startsWith(`${dir}/`), `${name} resolves to ${path}, outside ${dir}`)
  return path
}

/** The file at path, a temporary one a fixture placed, to read, write, or check for. */
function fileAt(path) {
  assert(path.startsWith(`${tmpdir()}/`) || path.startsWith(`${realpathSync(tmpdir())}/`), `${path} is not under ${tmpdir()}; tests touch only temporary files`)
  const file = {
    read: () => readFileSync(path, "utf8"),
    write: text => {
      mkdirSync(join(path, ".."), { recursive: true })
      writeFileSync(path, text)
    },
    has: () => existsSync(path),
  }
  assert(!path.endsWith("/"), `${path} names a directory, not a file`)
  return file
}

/** A temporary project holding files, by path relative to its root, with each file inside it to read or write. */
function project(files) {
  const dir = mkdtempSync(join(tmpdir(), "overwatch-vscode-"))
  const fixture = { dir, file: name => fileAt(within(dir, name)) }
  for (const [name, text] of Object.entries(files)) fixture.file(name).write(text)
  assert(existsSync(dir), `the temporary project ${dir} was not made`)
  assert(Object.keys(files).every(name => fixture.file(name).has()), `project ${dir} is missing some of ${Object.keys(files)}`)
  return fixture
}

/** One of the files of a feed VS Code's overwatch keeps for the Claude Code plugin, by extension: pid, claude, json, jsonl or changed. */
function feedFile(feed, extension) {
  assert(feed.startsWith(join(process.env.HOME, ".cache", "overwatch", "feeds")), `feed ${feed} is outside this test's home ${process.env.HOME}`)
  assert(["pid", "claude", "json", "jsonl", "changed"].includes(extension), `${extension} is not one of a feed's files`)
  return fileAt(`${feed}.${extension}`)
}

/** VS Code's ThemeColor, naming one of the theme's colours by id. */
class ThemeColor {
  constructor(id) {
    assert(typeof id === "string" && id !== "", `ThemeColor was given ${JSON.stringify(id)}; name a theme colour`)
    this.id = id
    assert(this.id === id, `ThemeColor kept ${this.id}, not ${id}`)
  }
}

/** A fake of the vscode API with a workspace at cwd, recording its status bar, output channel and messages. */
function fakeVSCode(cwd) {
  assert(existsSync(cwd), `fakeVSCode was given workspace ${cwd}, which does not exist; make it with project()`)
  process.env.HOME = mkdtempSync(join(tmpdir(), "overwatch-home-"))
  const seen = { commands: {}, messages: [], channel: "", onSave: undefined }
  const item = { text: "", show: () => undefined, hide: () => undefined, dispose: () => undefined }
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    ThemeColor,
    window: {
      createStatusBarItem: () => item,
      createOutputChannel: () => ({ replace: text => { seen.channel = text }, appendLine: text => { seen.channel += text }, show: () => undefined, dispose: () => undefined }),
      showErrorMessage: async message => { seen.messages.push(message) },
      showInformationMessage: async message => { seen.messages.push(message) },
      showWarningMessage: async message => { seen.messages.push(message) },
    },
    commands: { registerCommand: (name, callback) => { seen.commands[name] = callback; return { dispose: () => undefined } } },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: cwd } }],
      onDidSaveTextDocument: callback => { seen.onSave = callback; return { dispose: () => undefined } },
      onDidChangeWorkspaceFolders: () => ({ dispose: () => undefined }),
    },
  }
  assert(vscode.workspace.workspaceFolders[0].uri.fsPath === cwd, `the fake workspace is not at ${cwd}`)
  return { vscode, item, seen }
}

test("VS Code reads the pytest summary line and names what failed", () => {
  const python = WATCHERS.find(watcher => watcher.name === "python")
  const report = readReport(python, PYTEST_FAILING)
  assert.equal(report.isFailed, true)
  assert.equal(statusLine(python, report), "overwatch python ✗ 1 failed, 2 passed in 0.03s: tests/test_add.py::test_add")
  assert.equal(readReport(python, "=== no tests ran in 0.00s ===").isFailed, false)
  assert.equal(readReport(python, "collected 3 items"), undefined)
})

test("VS Code watches each language, in its sub-project when the root lacks it, unless the override turns it off", () => {
  const workspace = project({ "Cargo.toml": "", "services/api/go.mod": "" })
  assert.deepEqual(findWatchers(workspace.dir).map(watcher => [watcher.name, watcher.dir]), [["go services/api", "services/api"], ["rust", undefined]])
  workspace.file(".overwatch.json").write(JSON.stringify({ enabled: false }))
  assert.deepEqual(findWatchers(workspace.dir), [])
})

test("VS Code reruns a suite with no watch command after each save and shows it in the status bar", async t => {
  const workspace = project({
    ".overwatch.json": JSON.stringify({ baseline: ["sh", "-c", "cat result"], summary: "^(?:pass|fail)$", failed: "fail" }),
    result: "pass\n",
  })
  const { vscode, item, seen } = fakeVSCode(workspace.dir)
  const subscriptions = []
  const overwatch = registerVSCode(vscode, { subscriptions })
  const feed = feedOf({ language: "project" }, workspace.dir)
  assert.deepEqual(Object.keys(seen.commands).sort(), ["overwatch.doctor", "overwatch.show", "overwatch.start", "overwatch.stop"])
  await t.waitFor(() => assert.equal(item.text, "overwatch project ✓ pass"), WAIT)
  workspace.file("result").write("fail\n")
  seen.onSave()
  await t.waitFor(() => assert.equal(item.text, "overwatch project ✗ fail"), WAIT)
  assert.match(seen.channel, /overwatch project\nfail/)
  assert.equal(item.backgroundColor.id, "statusBarItem.errorBackground")
  assert.deepEqual(seen.messages, ["overwatch project ✗ fail"])
  seen.onSave()
  // Each report is written to the feed just before it is shown, so the third entry means the rerun's report is in.
  await t.waitFor(() => assert.equal(feedFile(feed, "jsonl").read().trim().split("\n").length, 3), WAIT)
  assert.deepEqual(seen.messages, ["overwatch project ✗ fail"])
  workspace.file("result").write("pass\n")
  seen.onSave()
  await t.waitFor(() => assert.equal(item.text, "overwatch project ✓ pass"), WAIT)
  assert.equal(seen.messages.at(-1), "overwatch project ✓ pass, green again")
  overwatch.stop()
})

test("VS Code keeps the full run's result in the status bar while the watcher it starts is quiet", async t => {
  const workspace = project({
    ".overwatch.json": JSON.stringify({ argv: ["sh", "-c", "echo started > watching; exec sleep 30"], baseline: ["sh", "-c", "cat result"], summary: "^(?:pass|fail)$", failed: "fail" }),
    result: "fail\n",
  })
  const { vscode, item } = fakeVSCode(workspace.dir)
  const overwatch = registerVSCode(vscode, { subscriptions: [] })
  try {
    await t.waitFor(() => assert(workspace.file("watching").has(), "the watcher has not started"), WAIT)
    assert.equal(item.text, "overwatch project ✗ fail")
  } finally {
    overwatch.stop()
  }
})

test("VS Code writes each watcher's reports where the Claude Code plugin follows them, and reruns when it asks", async t => {
  const workspace = project({
    ".overwatch.json": JSON.stringify({ baseline: ["sh", "-c", "cat result"], summary: "^(?:pass|fail)$", failed: "fail" }),
    result: "fail\n",
  })
  const { vscode, item } = fakeVSCode(workspace.dir)
  const overwatch = registerVSCode(vscode, { subscriptions: [] })
  const feed = feedOf({ language: "project" }, workspace.dir)
  try {
    assert.equal(feed, join(process.env.HOME, ".cache", "overwatch", "feeds", `project:${realpathSync(workspace.dir)}`.replace(/[^\w.-]+/g, "-")))
    assert.equal(feedFile(feed, "pid").read(), String(process.pid))
    await t.waitFor(() => assert.equal(item.text, "overwatch project ✗ fail"), WAIT)
    assert.deepEqual(JSON.parse(feedFile(feed, "json").read()), { text: "fail\n", code: 0 })
    workspace.file("result").write("pass\n")
    feedFile(feed, "changed").write("")
    await t.waitFor(() => assert.equal(item.text, "overwatch project ✓ pass"), WAIT)
    assert.deepEqual(feedFile(feed, "jsonl").read().trim().split("\n").map(line => JSON.parse(line).text), ["fail\n", "pass\n"])
  } finally {
    overwatch.stop()
  }
  assert.equal(feedFile(feed, "pid").has(), false)
})

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version

/** A doctor's view of a git project with one watcher, its plugin list answered by `plugins`, its feed followed by Claude when `isFollowed`. */
async function doctor({ plugins, isFollowed = true, isGit = true, tool = "sh" }) {
  assert(plugins === undefined || Array.isArray(plugins), `doctor was given plugins ${JSON.stringify(plugins)}; pass a plugin list, or none for claude missing`)
  process.env.HOME = mkdtempSync(join(tmpdir(), "overwatch-home-"))
  const folder = project(isGit ? { ".git/HEAD": "" } : {}).dir
  const watcher = { name: "project", language: "project", baseline: [tool, "-c", "cat result"] }
  const feed = feedOf(watcher, folder)
  feedFile(feed, "claude").write(isFollowed === true ? String(process.pid) : isFollowed || "")
  const runs = [{ watcher, status: "overwatch project ✓ pass", feed }]
  const report = await diagnose({
    folder,
    repository: repositoryOf(folder),
    runs,
    run: async () => plugins === undefined ? { code: -1, stdout: "" } : { code: 0, stdout: JSON.stringify(plugins) },
  })
  assert(report[0] === "overwatch doctor", `the doctor's report opens with ${report[0]}, not its title`)
  return report.join("\n")
}

test("the VS Code doctor finds a git project's watcher, the matching Claude Code plugin, and Claude following it", async () => {
  const report = await doctor({ plugins: [{ id: "overwatch@overwatch", version: VERSION, enabled: true }] })
  assert.match(report, /✓ watching the git repository at /)
  assert.match(report, /✓ project runs with sh: overwatch project ✓ pass/)
  assert.match(report, new RegExp(`✓ overwatch@overwatch ${VERSION.replaceAll(".", "\\.")} is installed and enabled`))
  assert.match(report, new RegExp(`✓ Claude Code \\(pid ${process.pid}\\) is following project`))
  assert.doesNotMatch(report, /[⚠✗]/)
})

test("the VS Code doctor names each thing that stops Claude sharing VS Code's watchers", async () => {
  assert.match(await doctor({ plugins: [], isGit: false }), /⚠ .+ is not in a git repository/)
  assert.match(await doctor({ plugins: [], tool: "no-such-tool-anywhere" }), /✗ project: no-such-tool-anywhere is not on PATH/)
  assert.match(await doctor({ plugins: [{ id: "overwatch@overwatch", version: "0.0.1", enabled: true }] }), /⚠ overwatch@overwatch 0\.0\.1 differs from this extension's/)
  assert.match(await doctor({ plugins: [{ id: "overwatch@overwatch", version: VERSION, enabled: false }] }), /✗ overwatch@overwatch .+ is installed but disabled/)
  assert.match(await doctor({ plugins: [] }), /✗ the overwatch plugin is not installed; in Claude Code run \/plugin install overwatch/)
  assert.match(await doctor({ plugins: undefined }), /⚠ claude is not on PATH/)
  assert.match(await doctor({ plugins: [{ id: "overwatch@overwatch", version: VERSION, enabled: true }], isFollowed: false }), /⚠ Claude is not following project; a Claude Code session in .+ follows it from its next turn/)
  assert.match(await doctor({ plugins: [{ id: "overwatch@overwatch", version: VERSION, enabled: true }], isFollowed: "2147483646" }), /⚠ Claude is not following project/)
})

test("VS Code's status bar shows when Claude is following a watcher", async t => {
  const workspace = project({
    ".overwatch.json": JSON.stringify({ baseline: ["sh", "-c", "cat result"], summary: "^(?:pass|fail)$", failed: "fail" }),
    result: "pass\n",
  })
  const { vscode, item } = fakeVSCode(workspace.dir)
  const feed = feedOf({ language: "project" }, workspace.dir)
  feedFile(feed, "claude").write(String(process.pid))
  const overwatch = registerVSCode(vscode, { subscriptions: [] })
  try {
    await t.waitFor(() => assert.equal(item.text, "overwatch project ✓ pass → Claude"), WAIT)
    feedFile(feed, "claude").write("")
    await t.waitFor(() => assert.equal(item.text, "overwatch project ✓ pass"), WAIT)
    feedFile(feed, "claude").write(String(process.pid))
    await t.waitFor(() => assert.equal(item.text, "overwatch project ✓ pass → Claude"), WAIT)
  } finally {
    feedFile(feed, "pid").write("1")
    overwatch.stop()
  }
  assert.equal(feedFile(feed, "pid").read(), "1")
})
