import assert from "node:assert/strict"
import { contextOf, deniedAction, serialChecker } from "./check.js"

const EDITING_TOOLS = new Set(["bash", "edit", "powershell", "write"])

/** The checker's hook event for event in pi's current session. */
function base(event, ctx) {
  assert(typeof event === "string" && event !== "", `base for event ${event}; name the hook event`)
  const sessionID = ctx.sessionManager.getSessionId()
  if (!sessionID) throw new Error(`pi gave overwatch ${event} no session ID`)
  const payload = { hook_event_name: event, session_id: sessionID, cwd: ctx.cwd }
  assert(typeof payload.cwd === "string" && payload.cwd !== "", `pi gave ${event} cwd ${payload.cwd}; the checker needs the project's directory`)
  return payload
}

/** Hooks overwatch's checker into pi's session, tool and settle events. */
export function registerPi(pi, checker = serialChecker()) {
  assert(typeof pi?.on === "function", "pi has no on() to register events with; pass pi's extension API")
  assert(typeof checker === "function", `checker is ${typeof checker}; pass a function from payload to output`)
  const check = checker
  let startupContext

  const showStatus = (ctx, output) => {
    assert(typeof ctx.ui?.setStatus === "function", "pi's context has no ui.setStatus; pass the event's context")
    assert(output.systemMessage === undefined || typeof output.systemMessage === "string", `status is ${typeof output.systemMessage}; the checker writes it as text`)
    ctx.ui.setStatus("overwatch", output.systemMessage)
  }

  pi.on("session_start", async (event, ctx) => {
    const output = await check({ ...base("SessionStart", ctx), source: event.reason })
    startupContext = contextOf(output)
    showStatus(ctx, output)
  })

  pi.on("before_agent_start", async () => {
    if (!startupContext) return undefined
    const message = { customType: "overwatch", content: startupContext, display: false }
    startupContext = undefined
    return { message }
  })

  pi.on("tool_call", async (event, ctx) => {
    const output = await check({ ...base("PreToolUse", ctx), tool_name: event.toolName, tool_input: event.input })
    const reason = deniedAction(output)
    return reason === undefined ? undefined : { block: true, reason }
  })

  pi.on("tool_result", async (event, ctx) => {
    if (!EDITING_TOOLS.has(event.toolName)) return undefined
    const output = await check({
      ...base("PostToolUse", ctx),
      tool_name: event.toolName,
      tool_use_id: event.toolCallId,
      tool_input: event.input,
    })
    showStatus(ctx, output)
    const message = contextOf(output)
    if (!message) return undefined
    return { content: [...event.content, { type: "text", text: message }] }
  })

  pi.on("agent_before_settle", async (event, ctx) => {
    const output = await check(base("Stop", ctx))
    showStatus(ctx, output)
    if (output.decision !== "block") return undefined
    return {
      entries: [
        ...event.entries,
        { type: "custom_message", customType: "overwatch", content: output.reason, display: true },
      ],
      continue: true,
    }
  })

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("overwatch", undefined)
  })
}

export default registerPi

