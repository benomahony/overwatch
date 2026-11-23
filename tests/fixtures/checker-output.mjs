// Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
import assert from "node:assert/strict"

export function output(message, failed = true) {
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

export const PROJECT = "/project"
