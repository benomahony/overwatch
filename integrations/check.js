import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const HOOK = fileURLToPath(new URL("../hooks/codex.py", import.meta.url))
const TIMEOUT_MS = 550_000

/** Run Overwatch's shared one-shot checker with a harness event. */
export function runCheck(payload, options = {}) {
  const command = options.command ?? "python3"
  const hook = options.hook ?? HOOK
  const timeout = options.timeout ?? TIMEOUT_MS
  assert(typeof payload.hook_event_name === "string" && payload.hook_event_name !== "", `payload names event ${payload.hook_event_name}; pass the hook event's name`)
  assert(Number.isFinite(timeout) && timeout > 0, `timeout ${timeout}ms must be a positive number; pass options.timeout in milliseconds`)

  return new Promise((resolve, reject) => {
    const child = spawn(command, [hook], {
      cwd: payload.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      finish(new Error(`overwatch check timed out after ${timeout}ms`))
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
    child.stdout.on("data", chunk => { stdout += chunk })
    child.stderr.on("data", chunk => { stderr += chunk })
    child.on("error", error => finish(error))
    child.stdin.on("error", error => finish(error))
    child.on("close", code => {
      if (code !== 0) {
        finish(new Error(`overwatch checker exited with code ${code}: ${stderr.trim()}`))
        return
      }
      try {
        finish(undefined, stdout.trim() ? JSON.parse(stdout) : {})
      } catch (error) {
        finish(new Error(`overwatch checker returned invalid JSON: ${String(error)}`))
      }
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

/** Serialize checks because several tools may finish in parallel and share one cached session result. */
export function serialChecker(check = runCheck) {
  assert(typeof check === "function", `serialChecker was given ${typeof check}; pass a function from payload to output`)
  assert(check.length <= 2, `check takes ${check.length} arguments; serialChecker passes only the payload`)
  let tail = Promise.resolve()
  return payload => {
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

