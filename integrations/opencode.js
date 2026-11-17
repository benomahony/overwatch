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

/** What to show for a start or a message: the status, else the context. */
function statusWarning(output) {
  assert(output !== null && typeof output === "object", `hook output ${String(output)} is not an object; pass the checker's JSON`)
  const text = output.systemMessage ?? contextOf(output)
  assert(text === undefined || typeof text === "string", `warning is ${typeof text}; the checker writes it as text`)
  return text
}

/** What to show for an idle session: the refusal when the checker blocked the stop, else nothing. */
function blockedWarning(output) {
  assert(output !== null && typeof output === "object", `hook output ${String(output)} is not an object; pass the checker's JSON`)
  const text = output.decision === "block" ? warningText(output) : undefined
  assert((text === undefined) === (output.decision !== "block"), `decision ${output.decision} gave warning ${text}; give one only for block`)
  return text
}

const TCR_NOTICE = /^overwatch: TCR is /

/** Whether the checker's answer tells that TCR is on or cannot start, which only a project that turns TCR on gets. */
function announcesTcr(output) {
  assert(output !== null && typeof output === "object", `hook output ${String(output)} is not an object; pass the checker's JSON`)
  const notices = output.overwatch?.notices
  assert(notices === undefined || Array.isArray(notices), `notices are ${typeof notices}; the checker writes a list`)
  return notices !== undefined && notices.some(notice => TCR_NOTICE.test(notice))
}

/**
 * A session's start check as begin runs it: begin is given a function to call with the checker's answer, and returns
 * the check's promise. The record's announcesTcr is true once the answer announced TCR.
 */
function trackStart(begin) {
  assert(typeof begin === "function", `begin is ${typeof begin}; pass a function that runs the start check`)
  const start = { announcesTcr: false, done: undefined }
  start.done = begin(output => { start.announcesTcr = announcesTcr(output) })
  assert(typeof start.done?.then === "function", `begin gave ${typeof start.done}; it must return the check's promise`)
  return start
}

/**
 * Waits for a session's start check, whether or not it failed, and says whether a message needs a check of its own:
 * when the start check announced TCR, or when this plugin saw no start check for the session.
 */
async function messageNeedsCheck(start) {
  assert(start === undefined || typeof start.done?.then === "function", `start is ${JSON.stringify(start)}; pass the record trackStart gave, or undefined`)
  await start?.done.catch(() => undefined)
  const needed = start === undefined || start.announcesTcr
  assert(needed === (start === undefined || start.announcesTcr === true), `a message's need of a check came out ${needed} for ${JSON.stringify(start)}`)
  return needed
}

/**
 * OpenCode 1's hooks for the project in directory: before a tool runs, refuse it when the checker denies it; after
 * an editing tool, add what the checker reports to the tool's output; when a session starts, receives a message or
 * goes idle, warn with the checker's status or refusal through client's toast, once for each event OpenCode sends.
 * OpenCode waits for chat.message before the model's first call, so a message waits for the session's start check
 * and the agent cannot edit before it ends. A session whose start check announced TCR also has each message checked,
 * as the checker runs the events of one session in order, so TCR decides again at each turn before the agent edits.
 * A session that did not turn TCR on has no check run for a message.
 */
export function createV1Hooks({ directory, client }, checker = serialChecker()) {
  assert(typeof directory === "string" && directory !== "", `OpenCode gave directory ${directory}; the hooks need the project's directory`)
  assert(typeof checker === "function", `checker is ${typeof checker}; pass a function from payload to output`)
  const check = checker
  const sessions = new SessionDelivery()
  const starts = new Map()
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

  const warnAbout = async (life, event, read = statusWarning, observe = () => undefined) => {
    assert(typeof event.hook_event_name === "string", `event ${JSON.stringify(event)} names no hook; build it with payload`)
    assert(typeof read === "function", `read is ${typeof read}; pass a function from the checker's output to text`)
    const output = await check(event)
    observe(output)
    if (!life.closed) await warn(read(output))
  }

  return {
    "tool.execute.before": async (input, output) => {
      const result = await check({ ...payload("PreToolUse", directory, input.sessionID),
        tool_name: input.tool, tool_input: output.args ?? input.args })
      const reason = deniedAction(result)
      if (reason !== undefined) throw new Error(reason)
    },
    "chat.message": async input => {
      if (await messageNeedsCheck(starts.get(input.sessionID))) await warnAbout(sessions.stateOf(input.sessionID), payload("UserPromptSubmit", directory, input.sessionID))
    },
    event: async ({ event }) => {
      const sessionID = sessionIDOf(event)
      if (!sessionID) return
      if (event.type === "session.deleted") { sessions.remove(sessionID); starts.delete(sessionID); return }
      const life = sessions.stateOf(sessionID)
      if (event.type === "session.created") {
        const start = trackStart(observe => warnAbout(life, { ...payload("SessionStart", directory, sessionID), source: "startup" }, statusWarning, observe))
        starts.set(sessionID, start)
        await start.done
      }
      if (event.type === "session.idle") await warnAbout(life, payload("Stop", directory, sessionID), blockedWarning)
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
  assert(["tool.execute.before", "tool.execute.after", "chat.message", "event"].every(name => typeof hooks[name] === "function"), `hooks ${Object.keys(hooks)} miss one OpenCode 1 calls`)
  return hooks
}

const Overwatch = {
  id: "overwatch",
  setup: setupV2,
  // OpenCode V1 discovers this property by name; V2 discovers setup above.
  server: createV1Hooks,
}

export default Overwatch

