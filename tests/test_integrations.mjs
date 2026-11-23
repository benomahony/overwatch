/**
 * Tests of overwatch's OpenCode and pi integrations, each given a fake checker in place of engine/engine.py.
 *
 * Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { after } from "node:test"

import OpenCode, { OverwatchPlugin, createV1Hooks, setupV2 } from "../integrations/opencode.js"
import { serialChecker } from "../engine/check.js"
import { registerPi } from "../integrations/pi.js"
import { withBuggyEngine } from "./fixtures/buggy-engine.mjs"
import { output, PROJECT } from "./fixtures/checker-output.mjs"

const WORKSPACE = mkdtempSync(join(tmpdir(), "overwatch-opencode-"))
const TCR_PROJECT = join(WORKSPACE, "tcr")
const PLAIN_PROJECT = join(WORKSPACE, "plain")
const SETTLE_MS = 100
const HELD_MESSAGE_MS = 2000
const settle = () => new Promise(resolve => setTimeout(resolve, SETTLE_MS))
for (const [directory, override] of [[TCR_PROJECT, { mode: "tcr" }], [PLAIN_PROJECT, { checks: [] }]]) {
  mkdirSync(directory)
  writeFileSync(join(directory, ".overwatch.json"), JSON.stringify(override))
}
after(() => rmSync(WORKSPACE, { recursive: true, force: true }))

const TCR_ON = "overwatch: TCR is on: an edit that keeps the checks green is committed, and an edit that adds a failure is reverted."
const TCR_UNAVAILABLE = "overwatch: TCR is unavailable: the working tree has uncommitted changes."

function tcrNotice(text) {
  assert(typeof text === "string" && text.startsWith("overwatch: TCR is "), `notice ${JSON.stringify(text)} is not a TCR notice; pass TCR_ON or TCR_UNAVAILABLE`)
  return { overwatch: { status: "Overwatch: fixture", guarded: false, notices: [text] }, hookSpecificOutput: { additionalContext: text } }
}

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

async function messageDuringStart(directory) {
  const log = []
  let endStart
  const startEnds = new Promise(resolve => { endStart = resolve })
  const hooks = createV1Hooks({ directory, client: { tui: { showToast: async () => undefined } } }, serialChecker(async event => {
    log.push(`${event.hook_event_name} begins`)
    if (event.hook_event_name === "SessionStart") await startEnds
    return tcrNotice(TCR_ON)
  }))
  const started = hooks.event({ event: { type: "session.created", properties: { info: { id: "s1" } } } })
  const held = new Promise(resolve => setTimeout(() => resolve("held"), HELD_MESSAGE_MS))
  const outcome = await Promise.race([hooks["chat.message"]({ sessionID: "s1" }).then(() => "went on"), held])
  endStart()
  await started
  return { outcome, log }
}

test("OpenCode V1 checks a message only after the session's start check ends, so the agent edits after the decision", async () => {
  const log = []
  let endStart
  const startEnds = new Promise(resolve => { endStart = resolve })
  const heldStart = async event => {
    assert(event.session_id === "s1", `event ${event.hook_event_name} names session ${event.session_id}; it belongs to s1`)
    assert(event.cwd === TCR_PROJECT, `event ${event.hook_event_name} names ${event.cwd}; it belongs to ${TCR_PROJECT}`)
    log.push(`${event.hook_event_name} begins`)
    if (event.hook_event_name === "SessionStart") await startEnds
    log.push(`${event.hook_event_name} ends`)
    return event.hook_event_name === "SessionStart" ? tcrNotice(TCR_ON) : {}
  }
  const hooks = createV1Hooks({ directory: TCR_PROJECT, client: { tui: { showToast: async () => undefined } } }, serialChecker(heldStart))
  const started = hooks.event({ event: { type: "session.created", properties: { info: { id: "s1" } } } })
  const messaged = hooks["chat.message"]({ sessionID: "s1" })
  await settle()
  assert.deepEqual(log, ["SessionStart begins"], "the message's check began before the session's start check ended")
  endStart()
  await Promise.all([started, messaged])
  assert.deepEqual(log, ["SessionStart begins", "SessionStart ends", "UserPromptSubmit begins", "UserPromptSubmit ends"])
})

async function eventsAfterStart(startAnswer) {
  const log = []
  const hooks = createV1Hooks(
    { directory: TCR_PROJECT, client: { tui: { showToast: async () => undefined } } },
    async event => {
      log.push(event.hook_event_name)
      return event.hook_event_name === "SessionStart" ? startAnswer : {}
    },
  )
  await hooks.event({ event: { type: "session.created", properties: { info: { id: "s1" } } } })
  await hooks["chat.message"]({ sessionID: "s1" })
  await hooks["chat.message"]({ sessionID: "s1" })
  return log
}

test("OpenCode V1 runs no check for a message of a TCR project when the start check has no TCR notice, but still waits for the start check", async () => {
  const log = []
  let endStart
  const startEnds = new Promise(resolve => { endStart = resolve })
  const hooks = createV1Hooks({ directory: TCR_PROJECT, client: { tui: { showToast: async () => undefined } } }, serialChecker(async event => {
    log.push(`${event.hook_event_name} begins`)
    if (event.hook_event_name === "SessionStart") await startEnds
    log.push(`${event.hook_event_name} ends`)
    return {}
  }))
  const started = hooks.event({ event: { type: "session.created", properties: { info: { id: "s1" } } } })
  let messageDone = false
  const messaged = hooks["chat.message"]({ sessionID: "s1" }).then(() => { messageDone = true })
  await settle()
  assert.equal(messageDone, false, "the message went on before the session's start check ended")
  endStart()
  await Promise.all([started, messaged])
  assert.deepEqual(log, ["SessionStart begins", "SessionStart ends"], "a message ran a check although TCR is off")
})

test("OpenCode V1 checks every message when the start check says TCR is on", async () => {
  assert.deepEqual(await eventsAfterStart(tcrNotice(TCR_ON)), ["SessionStart", "UserPromptSubmit", "UserPromptSubmit"])
})

test("OpenCode V1 checks every message when the start check says TCR cannot start", async () => {
  assert.deepEqual(await eventsAfterStart(tcrNotice(TCR_UNAVAILABLE)), ["SessionStart", "UserPromptSubmit", "UserPromptSubmit"])
})

test("OpenCode V1 runs no check for any message when the start check has no TCR notice", async () => {
  assert.deepEqual(await eventsAfterStart({ overwatch: { status: "Overwatch: fixture", guarded: false } }), ["SessionStart"])
})

test("OpenCode V1 does not fail a message when the session's start check failed", async () => {
  const hooks = createV1Hooks(
    { directory: TCR_PROJECT, client: { tui: { showToast: async () => undefined } } },
    async event => { if (event.hook_event_name === "SessionStart") throw new Error("checker down"); return {} },
  )
  await assert.rejects(hooks.event({ event: { type: "session.created", properties: { info: { id: "s1" } } } }), /checker down/)
  await hooks["chat.message"]({ sessionID: "s1" })
})

test("OpenCode V1 does not hold a message of a project that has no .overwatch.json, and runs no check for it", async () => {
  assert.deepEqual(await messageDuringStart(PROJECT), { outcome: "went on", log: ["SessionStart begins"] })
})

test("OpenCode V1 does not hold a message of a project whose .overwatch.json sets no mode, and runs no check for it", async () => {
  assert.deepEqual(await messageDuringStart(PLAIN_PROJECT), { outcome: "went on", log: ["SessionStart begins"] })
})

const TCR_OFF = "overwatch: TCR is off: `mode` is no longer set in .overwatch.json, so edits are neither committed nor reverted."

async function toastsAfterTheModeIsRemoved() {
  const directory = mkdtempSync(join(WORKSPACE, "mode-removed-"))
  const override = join(directory, ".overwatch.json")
  writeFileSync(override, JSON.stringify({ mode: "tcr" }))
  const toasts = []
  const hooks = createV1Hooks({ directory, client: { tui: { showToast: async ({ body }) => { toasts.push(body.message) } } } }, async event =>
    event.hook_event_name === "SessionStart" ? tcrNotice(TCR_ON) : { systemMessage: TCR_OFF })
  await hooks.event({ event: { type: "session.created", properties: { info: { id: "s1" } } } })
  rmSync(override)
  await hooks["chat.message"]({ sessionID: "s1" })
  return toasts
}

test("OpenCode V1 still checks a message of a session that announced TCR after the project removes mode, so the user is told TCR is off", async () => {
  assert.deepEqual(await toastsAfterTheModeIsRemoved(), [TCR_ON, TCR_OFF])
})

test("OpenCode V1 warns about an idle session only when the checker blocks the stop", async () => {
  const toasts = []
  const answers = [{ systemMessage: "overwatch: status only" }, output("fix the test")]
  const hooks = createV1Hooks(
    { directory: PROJECT, client: { tui: { showToast: async ({ body }) => { toasts.push(body.message) } } } },
    async () => answers.shift(),
  )
  const idle = { event: { type: "session.idle", properties: { sessionID: "s1" } } }
  await hooks.event(idle)
  assert.deepEqual(toasts, [], "a stop the checker did not block was warned about")
  await hooks.event(idle)
  assert.deepEqual(toasts, ["fix the test"])
})

test("OpenCode V1 tells the user what a message's check says", async () => {
  const toasts = []
  const hooks = createV1Hooks(
    { directory: TCR_PROJECT, client: { tui: { showToast: async ({ body }) => { toasts.push(body.message) } } } },
    async () => ({ systemMessage: "overwatch: TCR is on" }),
  )
  await hooks["chat.message"]({ sessionID: "s1" })
  assert.deepEqual(toasts, ["overwatch: TCR is on"])
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

test("OpenCode V2 delivers a notice that the next check clears no failure for, and not a failure that later passes", async () => {
  const notice = "overwatch: TCR reverted the latest change"
  const nothingGuarded = { overwatch: { guarded: false } }
  const hooks = await v2Hooks(async event => (event.hook_event_name === "PostToolUse"
    ? { hookSpecificOutput: { additionalContext: notice }, overwatch: { guarded: false, notices: [notice] } }
    : nothingGuarded))
  await hooks["tool:execute.after"]({ tool: "write", sessionID: "session-1", id: "call-1", input: {} })
  const delivered = { sessionID: "session-1", system: [] }
  await hooks["session:context"](delivered)
  assert.deepEqual(delivered.system.map(part => part.text), [notice])

  const again = { sessionID: "session-1", system: [] }
  await hooks["session:context"](again)
  assert.deepEqual(again.system, [])

  const failing = await v2Hooks(async event => (event.hook_event_name === "PostToolUse" ? output("fix the test") : nothingGuarded))
  await failing["tool:execute.after"]({ tool: "write", sessionID: "session-2", id: "call-2", input: {} })
  const stale = { sessionID: "session-2", system: [] }
  await failing["session:context"](stale)
  assert.deepEqual(stale.system, [])
})

test("OpenCode V2 delivers a notice made at session.idle to the session's next turn", async () => {
  const hooks = {}
  let stopChecked
  const stopped = new Promise(resolve => { stopChecked = resolve })
  const ctx = {
    location: { directory: PROJECT },
    session: { hook: async (name, callback) => { hooks[`session:${name}`] = callback }, prompt: async () => undefined },
    tool: { hook: async (name, callback) => { hooks[`tool:${name}`] = callback } },
    event: { subscribe: async function* () { yield { type: "session.idle", properties: { sessionID: "session-1" } } } },
  }
  await setupV2(ctx, async event => {
    if (event.hook_event_name !== "Stop") return {}
    stopChecked()
    return tcrNotice(TCR_UNAVAILABLE)
  })
  await stopped
  await new Promise(resolve => setImmediate(resolve))
  const next = { sessionID: "session-1", system: [] }
  await hooks["session:context"](next)
  assert.deepEqual(next.system.map(part => part.text), [TCR_UNAVAILABLE], "the notice made at Stop did not reach the next turn")
  const after = { sessionID: "session-1", system: [] }
  await hooks["session:context"](after)
  assert.deepEqual(after.system, [], "the notice was told again after it was taken")
})

test("OpenCode V2 keeps following session.idle after one check fails", async t => {
  const prompts = []
  const logged = []
  t.mock.method(console, "error", label => logged.push(label))
  let stops = 0
  await setupV2({
    location: { directory: PROJECT },
    session: { hook: async () => undefined, prompt: async request => { prompts.push(request) } },
    tool: { hook: async () => undefined },
    event: {
      subscribe: async function* () {
        yield { type: "session.idle", properties: { sessionID: "session-1" } }
        yield { type: "session.idle", properties: { sessionID: "session-1" } }
      },
    },
  }, async event => {
    if (event.hook_event_name !== "Stop") return {}
    stops += 1
    if (stops === 1) throw new Error("engine bug")
    return output("second failure")
  })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(logged, ["overwatch event loop"], "the failed check was not logged once")
  assert.deepEqual(prompts.map(request => request.text), ["second failure"], "the idle event after the failed check was never checked")
})

test("OpenCode V2 tells the agent of a blocking result again at the next idle after its prompt was rejected", async t => {
  const attempts = []
  const delivered = []
  t.mock.method(console, "error", () => undefined)
  await setupV2({
    location: { directory: PROJECT },
    session: {
      hook: async () => undefined,
      prompt: async request => {
        attempts.push(request.text)
        if (attempts.length === 1) throw new Error("the host refused the prompt")
        delivered.push(request.text)
      },
    },
    tool: { hook: async () => undefined },
    event: {
      subscribe: async function* () {
        for (let idle = 0; idle < 3; idle += 1) yield { type: "session.idle", properties: { sessionID: "session-1" } }
      },
    },
  }, async event => (event.hook_event_name === "Stop" ? output("same failure") : {}))
  for (let turn = 0; turn < 4; turn += 1) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(attempts, ["same failure", "same failure"], "the rejected prompt was not tried again at the next idle, and the delivered one was repeated")
  assert.deepEqual(delivered, ["same failure"], "the agent was never told after its first prompt was rejected")
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

test("the checker rejects with the exit code and traceback when the engine process has a bug, as the host surfaces it", async () => {
  const hookEvent = "PostToolUse"
  await withBuggyEngine(hookEvent, directory => assert.rejects(
    serialChecker()({ hook_event_name: hookEvent, session_id: "s1", cwd: directory }),
    error => /exited with code [1-9]/.test(error.message) && error.message.includes("Traceback") && error.message.includes("AttributeError: probe bug"),
    "a bug in the engine did not reach the host as a rejection with its exit code and traceback",
  ))
})
