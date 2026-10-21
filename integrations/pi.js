import { contextOf, serialChecker } from "./check.js"

const EDITING_TOOLS = new Set(["bash", "edit", "powershell", "write"])

function base(event, ctx) {
  const sessionID = ctx.sessionManager.getSessionId()
  if (!sessionID) throw new Error(`pi gave overwatch ${event} no session ID`)
  return { hook_event_name: event, session_id: sessionID, cwd: ctx.cwd }
}

export function registerPi(pi, checker = serialChecker()) {
  const check = checker
  let startupContext
  let stopBlocked = false

  const showStatus = (ctx, output) => {
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

  pi.on("tool_result", async (event, ctx) => {
    if (!EDITING_TOOLS.has(event.toolName)) return undefined
    const output = await check({
      ...base("PostToolUse", ctx),
      tool_name: event.toolName,
      tool_use_id: event.toolCallId,
      tool_input: event.input,
    })
    stopBlocked = false
    showStatus(ctx, output)
    const message = contextOf(output)
    if (!message) return undefined
    return { content: [...event.content, { type: "text", text: message }] }
  })

  pi.on("agent_before_settle", async (event, ctx) => {
    const output = await check({ ...base("Stop", ctx), stop_hook_active: stopBlocked })
    showStatus(ctx, output)
    if (output.decision !== "block" || stopBlocked) return undefined
    stopBlocked = true
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

