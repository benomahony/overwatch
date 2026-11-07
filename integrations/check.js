/**
 * Overwatch's shared checker for the agent integrations in this directory. Each event runs the engine,
 * hooks/engine.py, once and reads its JSON answer, so every integration reports exactly what the engine does.
 *
 * Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const HOOK = fileURLToPath(new URL("../hooks/engine.py", import.meta.url))
const TIMEOUT_MS = 550_000

/**
 * The fields of a harness event the checker reads, and only those, each checked: the event's name and the project
 * directory as non-empty strings, the session's ID and the tool's name as strings when given, and the tool's input
 * as it came. Throws a TypeError naming the field.
 */
function checkedPayload(payload) {
  if (payload === null || typeof payload !== "object") throw new TypeError(`the hook event is ${String(payload)}; pass an object`)
  const { hook_event_name: event, cwd, session_id: session } = payload
  if (typeof event !== "string" || event === "") throw new TypeError(`the hook event's name is ${String(event)}; set hook_event_name`)
  if (typeof cwd !== "string" || cwd === "") throw new TypeError(`the ${event} event's cwd is ${String(cwd)}; set it to the project's directory`)
  if (session !== undefined && typeof session !== "string") throw new TypeError(`the ${event} event's session_id is ${typeof session}; pass it as text`)
  const { tool_name: tool, tool_input: input } = payload
  if (tool !== undefined && typeof tool !== "string") throw new TypeError(`the ${event} event's tool_name is ${typeof tool}; pass it as text`)
  const checked = { hook_event_name: event, session_id: session, cwd, tool_name: tool, tool_input: input }
  if (payload.integration !== undefined) {
    if (typeof payload.integration !== "string") throw new TypeError(`integration is ${typeof payload.integration}; pass its name`)
    checked.integration = payload.integration
  }
  assert(checked.hook_event_name === event && checked.cwd === cwd, `checked event ${JSON.stringify(checked)} lost its name or cwd; copy both`)
  assert(Object.keys(checked).length === (payload.integration === undefined ? 5 : 6), `checked event has fields ${Object.keys(checked)}; forward only fields the checker reads`)
  return checked
}

/**
 * Runs overwatch's checker on one harness event and resolves to its JSON output. Private to this module, which
 * calls it only through serialChecker. It always runs hooks/engine.py with the python3 on PATH, in the event's
 * project directory, with the environment of the agent the user started: nothing a caller passes chooses what runs.
 */
function runCheck(payload, timeout = TIMEOUT_MS) {
  const event = checkedPayload(payload)
  assert(Number.isFinite(timeout) && timeout > 0, `timeout ${timeout}ms must be a positive number; pass it in milliseconds`)
  assert(HOOK.endsWith("engine.py"), `the checker is ${HOOK}, not hooks/engine.py; resolve it beside this file`)

  return new Promise((resolve, reject) => {
    const child = spawn("python3", [HOOK], {
      cwd: event.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = []
    const stderr = []
    let settled = false
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      finish(new Error(`overwatch check timed out after ${timeout}ms; raise the timeout or speed up the project's checks`))
    }, timeout)

    /** Settles the check once, with error or else value, and stops its timer. */
    function finish(error, value) {
      assert(error === undefined || error instanceof Error, `finish was given ${String(error)}; reject with an Error`)
      assert(error === undefined || value === undefined, `finish was given an error and the value ${JSON.stringify(value)}; pass one`)
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", chunk => stdout.push(chunk))
    child.stderr.on("data", chunk => stderr.push(chunk))
    child.on("error", error => finish(error))
    child.stdin.on("error", error => finish(error))
    child.on("close", code => {
      if (code !== 0) {
        finish(new Error(`overwatch checker exited with code ${code}: ${stderr.join("").trim()}; run hooks/engine.py with this event to see why`))
        return
      }
      try {
        const text = stdout.join("").trim()
        finish(undefined, text ? JSON.parse(text) : {})
      } catch (error) {
        finish(new Error(`overwatch checker returned invalid JSON: ${String(error)}; run hooks/engine.py with this event to see its output`))
      }
    })
    child.stdin.end(JSON.stringify(event))
  })
}

/** Serialize checks because several tools may finish in parallel and share one cached session result. */
export function serialChecker(check = runCheck) {
  assert(typeof check === "function", `serialChecker was given ${typeof check}; pass a function from payload to output`)
  assert(check.length <= 2, `check takes ${check.length} arguments; serialChecker passes only the payload`)
  let tail = Promise.resolve()
  return payload => {
    // Let the backend decide protection before joining a long-running check.
    // Protected calls still take its session lock; ordinary calls need no state.
    if (payload.hook_event_name === "PreToolUse") return check(payload)
    const current = tail.then(() => check(payload), () => check(payload))
    tail = current.catch(() => undefined)
    return current
  }
}

/** The text a hook output adds to the agent's context, if any. */
export function contextOf(output) {
  assert(output === undefined || output === null || typeof output === "object", `hook output ${String(output)} is not an object; pass the checker's JSON`)
  const context = output?.hookSpecificOutput?.additionalContext
  assert(context === undefined || typeof context === "string", `additionalContext is ${typeof context}; the checker writes it as text`)
  return context
}

/** A pre-tool permission decision is separate from a completion decision or a notification. */
export function deniedAction(output) {
  const permission = output?.hookSpecificOutput
  const reason = permission?.permissionDecision === "deny"
    ? permission.permissionDecisionReason ?? "overwatch: relevant checks block this protected action"
    : undefined
  assert(reason !== "", `the checker denied the call with reason ${JSON.stringify(reason)}; give permissionDecisionReason text`)
  assert((reason !== undefined) === (permission?.permissionDecision === "deny"), `decision ${permission?.permissionDecision} gave reason ${reason}; give one only for deny`)
  return reason
}

