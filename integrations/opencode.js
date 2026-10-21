import { contextOf, serialChecker } from "./check.js"

const EDITING_TOOLS = new Set(["apply_patch", "bash", "edit", "shell", "write"])

function payload(event, cwd, sessionID) {
  return { hook_event_name: event, session_id: sessionID, cwd }
}

function sessionIDOf(event) {
  const properties = event.properties
  const info = properties?.info
  return event.sessionID ?? properties?.sessionID ?? info?.id
}

function warningText(output) {
  return output?.reason ?? output?.systemMessage ?? contextOf(output)
}

export function createV1Hooks({ directory, client }, checker = serialChecker()) {
  const check = checker
  const warn = async message => {
    if (!message) return
    try {
      await client.tui.showToast({ body: { message, variant: "warning" } })
    } catch (error) {
      console.error("overwatch warning", { message, error: String(error) })
    }
  }

  return {
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
  const check = checker
  const cwd = ctx.location.directory
  const stopBlocked = new Set()

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
    stopBlocked.delete(event.sessionID)
  })

  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type !== "session.idle") continue
        const sessionID = sessionIDOf(event)
        if (!sessionID) continue
        const output = await check(payload("Stop", cwd, sessionID))
        if (output.decision !== "block" || stopBlocked.has(sessionID)) continue
        stopBlocked.add(sessionID)
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
  const hooks = createV1Hooks(context)
  return hooks
}

const Overwatch = {
  id: "overwatch",
  setup: setupV2,
  // OpenCode V1 discovers this property by name; V2 discovers setup above.
  server: createV1Hooks,
}

export default Overwatch

