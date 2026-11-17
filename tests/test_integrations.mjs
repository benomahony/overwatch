/**
 * Tests of overwatch's OpenCode and pi integrations, each given a fake checker in place of engine/engine.py.
 *
 * Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
 */
import assert from "node:assert/strict"
import test from "node:test"

import OpenCode, { OverwatchPlugin, createV1Hooks, setupV2 } from "../integrations/opencode.js"
import { serialChecker } from "../engine/check.js"
import { registerPi } from "../integrations/pi.js"

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

/** What the checker says at a session's start when the project turns TCR on, or when TCR cannot start. */
const TCR_ON = "overwatch: TCR is on: an edit that keeps the checks green is committed, and an edit that adds a failure is reverted."
const TCR_UNAVAILABLE = "overwatch: TCR is unavailable: the working tree has uncommitted changes."

/** The checker's session-start answer carrying the TCR notice text, as the engine shapes it. */
function tcrNotice(text) {
  assert(typeof text === "string" && text.startsWith("overwatch: TCR is "), `notice ${JSON.stringify(text)} is not a TCR notice; pass TCR_ON or TCR_UNAVAILABLE`)
  return { overwatch: { status: "Overwatch: fixture", guarded: false, notices: [text] }, hookSpecificOutput: { additionalContext: text } }
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

test("OpenCode V1 checks a message only after the session's start check ends, so the agent edits after the decision", async () => {
  const log = []
  let endStart
  const startEnds = new Promise(resolve => { endStart = resolve })
  const heldStart = async event => {
    assert(event.session_id === "s1", `event ${event.hook_event_name} names session ${event.session_id}; it belongs to s1`)
    assert(event.cwd === PROJECT, `event ${event.hook_event_name} names ${event.cwd}; it belongs to ${PROJECT}`)
    log.push(`${event.hook_event_name} begins`)
    if (event.hook_event_name === "SessionStart") await startEnds
    log.push(`${event.hook_event_name} ends`)
    return event.hook_event_name === "SessionStart" ? tcrNotice(TCR_ON) : {}
  }
  const hooks = createV1Hooks({ directory: PROJECT, client: { tui: { showToast: async () => undefined } } }, serialChecker(heldStart))
  const started = hooks.event({ event: { type: "session.created", properties: { info: { id: "s1" } } } })
  const messaged = hooks["chat.message"]({ sessionID: "s1" })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(log, ["SessionStart begins"], "the message's check began before the session's start check ended")
  endStart()
  await Promise.all([started, messaged])
  assert.deepEqual(log, ["SessionStart begins", "SessionStart ends", "UserPromptSubmit begins", "UserPromptSubmit ends"])
})

/** The events the hooks of one session send to a checker that answers the session start with startAnswer, in order. */
async function eventsAfterStart(startAnswer) {
  const log = []
  const hooks = createV1Hooks(
    { directory: PROJECT, client: { tui: { showToast: async () => undefined } } },
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

test("OpenCode V1 runs no check for a message when the project does not turn TCR on, but still waits for the start check", async () => {
  const log = []
  let endStart
  const startEnds = new Promise(resolve => { endStart = resolve })
  const hooks = createV1Hooks({ directory: PROJECT, client: { tui: { showToast: async () => undefined } } }, serialChecker(async event => {
    log.push(`${event.hook_event_name} begins`)
    if (event.hook_event_name === "SessionStart") await startEnds
    log.push(`${event.hook_event_name} ends`)
    return {}
  }))
  const started = hooks.event({ event: { type: "session.created", properties: { info: { id: "s1" } } } })
  let messageDone = false
  const messaged = hooks["chat.message"]({ sessionID: "s1" }).then(() => { messageDone = true })
  await new Promise(resolve => setImmediate(resolve))
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
    { directory: PROJECT, client: { tui: { showToast: async () => undefined } } },
    async event => { if (event.hook_event_name === "SessionStart") throw new Error("checker down"); return {} },
  )
  await assert.rejects(hooks.event({ event: { type: "session.created", properties: { info: { id: "s1" } } } }), /checker down/)
  await hooks["chat.message"]({ sessionID: "s1" })
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
    { directory: PROJECT, client: { tui: { showToast: async ({ body }) => { toasts.push(body.message) } } } },
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
