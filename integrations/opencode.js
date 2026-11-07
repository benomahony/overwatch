/**
 * Overwatch for OpenCode, both plugin APIs. OpenCode 1 calls createV1Hooks, or OverwatchPlugin by name, for a table
 * of hooks; OpenCode 2 calls setupV2 to register them. Either way each tool call, edit, prompt and idle session is
 * sent to overwatch's shared checker, a protected tool is refused while relevant checks fail, and a refused finish
 * is shown as a warning or queued as the next prompt. The events come from the OpenCode process this plugin runs
 * in, which loaded it, so there is no other sender to check.
 *
 * Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
 */
import assert from "node:assert/strict"
import { contextOf, deniedAction, serialChecker } from "../engine/check.js"
import { SessionDelivery } from "../engine/delivery.js"

const EDITING_TOOLS = new Set(["apply_patch", "bash", "edit", "shell", "write"])

/**
 * The checker's hook event for event in cwd's session sessionID: the fields every event the checker answers
 * carries. Each hook below builds its event from this.
 */
function payload(event, cwd, sessionID, integration = "opencode1") {
  assert(typeof event === "string" && event !== "", `payload for event ${event}; name the hook event`)
  assert(typeof cwd === "string" && cwd !== "", `payload for ${event} has cwd ${cwd}; pass OpenCode's directory`)
  return { hook_event_name: event, session_id: sessionID, cwd, integration }
}

/**
 * The session an OpenCode event belongs to. OpenCode's event shape differs between versions, so this reads its
 * published fields in turn: sessionID, then properties.sessionID, then properties.info.id.
 */
function sessionIDOf(event) {
  if (event === null || typeof event !== "object") throw new TypeError(`OpenCode gave event ${String(event)}; pass the event object`)
  const { sessionID: own, properties } = event
  const found = own ?? properties?.sessionID ?? properties?.info?.id
  const sessionID = typeof found === "string" && found !== "" ? found : undefined
  assert(sessionID === undefined || sessionID === found, `event ${event.type} read session ${sessionID} from ${String(found)}; take it as given`)
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

/**
 * OpenCode 1's hooks for the project in directory: before a tool runs, refuse it when the checker denies it; after
 * an editing tool, add what the checker reports to the tool's output; when a session starts or goes idle, warn with
 * the checker's status or refusal through client's toast, once for each event OpenCode sends.
 */
export function createV1Hooks({ directory, client }, checker = serialChecker()) {
  assert(typeof directory === "string" && directory !== "", `OpenCode gave directory ${directory}; the hooks need the project's directory`)
  assert(typeof checker === "function", `checker is ${typeof checker}; pass a function from payload to output`)
  const check = checker
  const sessions = new SessionDelivery()
  // Shows message as a warning toast. A toast that cannot be shown is logged, as OpenCode's own plugins do, since
  // failing the hook would stop the agent for a notice it can do without.
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
      if (event.type === "session.deleted") { sessions.remove(sessionID); return }
      const life = sessions.stateOf(sessionID)
      if (event.type === "session.created") {
        const output = await check({ ...payload("SessionStart", directory, sessionID), source: "startup" })
        if (!life.closed) await warn(output.systemMessage ?? contextOf(output))
      }
      if (event.type === "session.idle") {
        const output = await check(payload("Stop", directory, sessionID))
        if (!life.closed && output.decision === "block") await warn(warningText(output))
      }
    },
    "tool.execute.after": async (input, output) => {
      if (!EDITING_TOOLS.has(input.tool)) return
      const life = sessions.stateOf(input.sessionID)
      const result = await check({
        ...payload("PostToolUse", directory, input.sessionID),
        tool_name: input.tool,
        tool_use_id: input.callID,
        tool_input: input.args,
      })
      const message = contextOf(result)
      if (!life.closed && message) output.output = `${output.output}\n\n${message}`
    },
  }
}

/**
 * OpenCode 2's setup for the project in ctx.location: registers the before and after tool hooks and the session
 * context hook, and follows idle sessions on ctx.event to queue the checker's refusal as the session's next prompt.
 * Resolves to a function that stops following.
 */
export async function setupV2(ctx, checker = serialChecker()) {
  assert(typeof checker === "function", `checker is ${typeof checker}; pass a function from payload to output`)
  const check = checker
  const cwd = ctx.location.directory
  const delivery = new SessionDelivery()
  const controller = new AbortController()
  assert(typeof cwd === "string" && cwd !== "", `OpenCode gave directory ${cwd}; the hooks need the project's directory`)

  await ctx.tool.hook("execute.before", async event => {
    const output = await check({ ...payload("PreToolUse", cwd, event.sessionID, "opencode2"),
      tool_name: event.tool, tool_input: event.input })
    const reason = deniedAction(output)
    if (reason !== undefined) throw new Error(reason)
  })

  await ctx.session.hook("context", async event => {
    const life = delivery.stateOf(event.sessionID)
    const output = await check(payload("UserPromptSubmit", cwd, event.sessionID, "opencode2"))
    if (controller.signal.aborted || life.closed) return
    delivery.observe(event.sessionID, output)
    const message = delivery.take(event.sessionID)
    if (message) event.system.push({ type: "text", text: message })
  })

  await ctx.tool.hook("execute.after", async event => {
    delivery.progressed(event.sessionID)
    const life = delivery.stateOf(event.sessionID)
    if (!EDITING_TOOLS.has(event.tool)) return
    delivery.edited(event.sessionID)
    const output = await check({
      ...payload("PostToolUse", cwd, event.sessionID, "opencode2"),
      tool_name: event.tool,
      tool_use_id: event.id ?? event.callID,
      tool_input: event.input,
    })
    if (!controller.signal.aborted && !life.closed) delivery.observe(event.sessionID, output)
  })

  void followIdle(ctx, check, { cwd, delivery, controller })
  return () => { controller.abort(); delivery.clear() }
}

async function followIdle(ctx, check, { cwd, delivery, controller }) {
  assert(typeof ctx.event.subscribe === 'function', 'OpenCode V2 needs an event subscription')
  assert(!controller.signal.aborted, 'OpenCode V2 cannot start an aborted subscription')
  try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const sessionID = sessionIDOf(event)
        if (!sessionID) continue
        if (event.type === "session.deleted") { delivery.remove(sessionID); continue }
        if (event.type !== "session.idle") continue
        const output = await check(payload("Stop", cwd, sessionID, "opencode2"))
        if (controller.signal.aborted) return
        if (!delivery.correction(sessionID, output)) continue
        await ctx.session.prompt({ sessionID, text: output.reason, delivery: "queue" })
      }
    } catch (error) {
      if (!controller.signal.aborted) console.error("overwatch event loop", error)
    }
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

