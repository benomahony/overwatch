import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const HOOK = fileURLToPath(new URL("../hooks/codex.py", import.meta.url))
const TIMEOUT_MS = 550_000

/** Run Overwatch's shared one-shot checker with a harness event. */
export function runCheck(payload, options = {}) {
  const command = options.command ?? "python3"
  const hook = options.hook ?? HOOK
  const timeout = options.timeout ?? TIMEOUT_MS

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

    function finish(error, value) {
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
  let tail = Promise.resolve()
  return payload => {
    const current = tail.then(() => check(payload), () => check(payload))
    tail = current.catch(() => undefined)
    return current
  }
}

export function contextOf(output) {
  return output?.hookSpecificOutput?.additionalContext
}

