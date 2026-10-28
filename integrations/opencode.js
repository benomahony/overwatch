import assert from "node:assert/strict"
import { contextOf, deniedAction, serialChecker } from "./check.js"

const EDITING_TOOLS = new Set(["apply_patch", "bash", "edit", "shell", "write"])

/** The checker's hook event for event in cwd's session sessionID. */
function payload(event, cwd, sessionID) {
  assert(typeof event === "string" && event !== "", `payload for event ${event}; name the hook event`)
  assert(typeof cwd === "string" && cwd !== "", `payload for ${event} has cwd ${cwd}; pass OpenCode's directory`)
  return { hook_event_name: event, session_id: sessionID, cwd }
}

/** The session an OpenCode event belongs to, wherever that version puts it. */
function sessionIDOf(event) {
  assert(event !== null && typeof event === "object", `OpenCode gave event ${String(event)}; pass the event object`)
  const properties = event.properties
  const info = properties?.info
  const sessionID = event.sessionID ?? properties?.sessionID ?? info?.id
  assert(sessionID === undefined || typeof sessionID === "string", `event ${event.type} has session ID ${String(sessionID)}, not text`)
  return sessionID
}

/** What to show for a refused Stop: the reason, else the status, else the context. */
function warningText(output) {
  assert(output !== null && typeof output === "object", `hook output ${String(output)} is not an object; pass the checker's JSON`)
  const text = output.reason ?? output.systemMessage ?? contextOf(output)
  assert(text === undefined || typeof text === "string", `warning is ${typeof text}; the checker writes it as text`)
  return text
}

export function createV1Hooks({ directory, client }, checker = serialChecker()) {
  assert(typeof directory === "string" && directory !== "", `OpenCode gave directory ${directory}; the hooks need the project's directory`)
  assert(typeof checker === "function", `checker is ${typeof checker}; pass a function from payload to output`)
  const check = checker
  const warn = async message => {
    assert(message === undefined || typeof message === "string", `warning is ${typeof message}; pass text`)
    assert(!message || message.trim() !== "", `warning ${JSON.stringify(message)} is only whitespace; pass the checker's reason or status`)
    if (!message) return
    try {
      await client.tui.showToast({ body: { message, variant: "warning" } })
    } catch (error) {
      console.error("overwatch warning", { message, error: String(error) })
    }
  }

  return {
    "tool.execute.before": async (input, output) => {
      const result = await check({ ...payload("PreToolUse", directory, input.sessionID),
        tool_name: input.tool, tool_input: output.args ?? input.args })
      const reason = deniedAction(result)
      if (reason !== undefined) throw new Error(reason)
    },
    event: async ({ event }) => {
      const sessionID = sessionIDOf(event)
      if (!sessionID) return
      if (event.type === "session.created") {
        const output = await check({ ...payload("SessionStart", directory, sessionID), source: "startup" })
        if (output.systemMessage) await warn(output.systemMessage)
      }
      if (event.type === "session.idle") {
        const output = await check(payload("Stop", directory, sessionID))
        if (output.decision === "block") await warn(warningText(output))
      }
    },
    "tool.execute.after": async (input, output) => {
      if (!EDITING_TOOLS.has(input.tool)) return
      const result = await check({
        ...payload("PostToolUse", directory, input.sessionID),
        tool_name: input.tool,
        tool_use_id: input.callID,
        tool_input: input.args,
      })
      const message = contextOf(result)
      if (message) output.output = `${output.output}\n\n${message}`
    },
  }
}

export async function setupV2(ctx, checker = serialChecker()) {
  assert(typeof checker === "function", `checker is ${typeof checker}; pass a function from payload to output`)
  const check = checker
  const cwd = ctx.location.directory
  assert(typeof cwd === "string" && cwd !== "", `OpenCode gave directory ${cwd}; the hooks need the project's directory`)

  await ctx.tool.hook("execute.before", async event => {
    const output = await check({ ...payload("PreToolUse", cwd, event.sessionID),
      tool_name: event.tool, tool_input: event.input })
    const reason = deniedAction(output)
    if (reason !== undefined) throw new Error(reason)
  })

  await ctx.session.hook("context", async event => {
    const output = await check(payload("UserPromptSubmit", cwd, event.sessionID))
    const message = contextOf(output)
    if (message) event.system.push({ type: "text", text: message })
  })

  await ctx.tool.hook("execute.after", async event => {
    if (!EDITING_TOOLS.has(event.tool)) return
    await check({
      ...payload("PostToolUse", cwd, event.sessionID),
      tool_name: event.tool,
      tool_use_id: event.id ?? event.callID,
      tool_input: event.input,
    })
  })

  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type !== "session.idle") continue
        const sessionID = sessionIDOf(event)
        if (!sessionID) continue
        const output = await check(payload("Stop", cwd, sessionID))
        if (output.decision !== "block") continue
        await ctx.session.prompt({ sessionID, text: output.reason, delivery: "queue" })
      }
    } catch (error) {
      if (!controller.signal.aborted) console.error("overwatch event loop", error)
    }
  })()
  return () => controller.abort()
}

/** OpenCode 1 discovers named plugin functions. */
export async function OverwatchPlugin(context) {
  assert(context !== null && typeof context === "object", `OpenCode gave plugin context ${String(context)}; pass its context object`)
  const hooks = createV1Hooks(context)
  assert(["tool.execute.before", "tool.execute.after", "event"].every(name => typeof hooks[name] === "function"), `hooks ${Object.keys(hooks)} miss one OpenCode 1 calls`)
  return hooks
}

const Overwatch = {
  id: "overwatch",
  setup: setupV2,
  // OpenCode V1 discovers this property by name; V2 discovers setup above.
  server: createV1Hooks,
}

export default Overwatch

