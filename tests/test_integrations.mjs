import assert from "node:assert/strict"
import test from "node:test"

import OpenCode, { OverwatchPlugin, createV1Hooks, setupV2 } from "../integrations/opencode.js"
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

/** The hooks OpenCode 2's setup registers with checker, by surface and name. */
async function v2Hooks(checker) {
  assert(typeof checker === "function", `checker is ${typeof checker}; pass a function from payload to output`)
  const hooks = {}
  const ctx = {
    location: { directory: "/project" },
    session: {
      hook: async (name, callback) => { hooks[`session:${name}`] = callback },
      prompt: async () => undefined,
    },
    tool: { hook: async (name, callback) => { hooks[`tool:${name}`] = callback } },
    event: { subscribe: async function* () {} },
  }
  await setupV2(ctx, checker)
  assert.deepEqual(Object.keys(hooks).sort(), ["session:context", "tool:execute.after", "tool:execute.before"])
  assert(Object.values(hooks).every(hook => typeof hook === "function"), `setup registered ${Object.keys(hooks)} with a hook that is not a function`)
  return hooks
}

test("the OpenCode package exposes V1 and V2 entrypoints", () => {
  assert.equal(typeof OverwatchPlugin, "function")
  assert.equal(OpenCode.id, "overwatch")
  assert.equal(OpenCode.setup, setupV2)
  assert.equal(OpenCode.server, createV1Hooks)
})

test("OpenCode V1 appends a failed check to an editing tool result", async () => {
  const hooks = createV1Hooks(
    { directory: "/project", client: { tui: { showToast: async () => undefined } } },
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
    location: { directory: "/project" },
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
    cwd: "/project",
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

/** The checker's output for a project whose 29 warnings protect only the publish tool while failing. */
function protectionOutput(event, failing) {
  assert(event.hook_event_name === "PreToolUse", `protection asked of ${event.hook_event_name}; only PreToolUse protects a tool`)
  if (!failing || event.tool_name !== "publish") return {}
  const denial = { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "29 warnings" } }
  assert(event.tool_name === "publish" && failing, `denied ${event.tool_name} while failing=${failing}; deny only publish while failing`)
  return denial
}

test("Pi permits repair tools and blocks a protected tool before it runs", async () => {
  const handlers = {}
  const pi = { on: (name, handler) => { handlers[name] = handler } }
  let failing = true
  registerPi(pi, async event => protectionOutput(event, failing))
  const ctx = { cwd: "/project", sessionManager: { getSessionId: () => "s1" } }
  for (const toolName of ["read", "edit", "bash"]) {
    assert.equal(await handlers.tool_call({ toolName, input: { command: "rg --files" } }, ctx), undefined)
  }
  assert.deepEqual(await handlers.tool_call({ toolName: "publish", input: {} }, ctx), { block: true, reason: "29 warnings" })
  failing = false
  assert.equal(await handlers.tool_call({ toolName: "publish", input: {} }, ctx), undefined)
})

test("OpenCode V1 protects only configured actions in its before-tool hook", async () => {
  let failing = true
  const hooks = createV1Hooks({ directory: "/project" }, async event => protectionOutput(event, failing))
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
