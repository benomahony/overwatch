/**
 * Tests that a host tells each notice of TCR mode once, with the output engine/tcr.py makes.
 *
 * Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

import { SessionDelivery } from "../engine/delivery.js"

const TOLD_SCRIPT = [
  "import json, sys",
  "sys.path.insert(0, 'engine')",
  "import tcr, records",
  "step = tcr.TcrStep(records.State(), notices=(sys.argv[1],))",
  "print(json.dumps(tcr.told({'overwatch': {'guarded': False}}, 'PostToolUse', step)))",
].join("\n")

/** What engine/tcr.py told() emits for a notice: the notice in the context and in overwatch.notices. */
function noticeOutput(notice) {
  assert(typeof notice === "string" && notice !== "", `notice ${JSON.stringify(notice)}; give the output some text`)
  const run = spawnSync("python3", ["-c", TOLD_SCRIPT, notice], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" })
  assert(run.status === 0, `engine/tcr.py told() failed for ${JSON.stringify(notice)}: ${run.stderr}`)
  const emitted = JSON.parse(run.stdout)
  assert(emitted.hookSpecificOutput.additionalContext === notice, `told() output ${run.stdout} does not carry the notice in its context`)
  const { notices } = emitted.overwatch
  assert(notices.length === 1 && notices[0] === notice, `told() output ${run.stdout} does not list the notice`)
  return emitted
}

const REVERT_NOTICE = "overwatch: TCR reverted the latest change"
const HOLD_NOTICE = "overwatch: TCR held the latest change"

function told(outputs) {
  const delivery = new SessionDelivery()
  for (const emitted of outputs) delivery.observe("s", emitted)
  return delivery.take("s")
}

test("delivery tells two identical notices once", () => {
  assert.equal(told([noticeOutput(REVERT_NOTICE), noticeOutput(REVERT_NOTICE)]), REVERT_NOTICE)
})

test("delivery tells two different notices both", () => {
  assert.equal(told([noticeOutput(REVERT_NOTICE), noticeOutput(HOLD_NOTICE)]), `${REVERT_NOTICE}\n\n${HOLD_NOTICE}`)
})

test("delivery still tells a notice after a recovery output", () => {
  assert.equal(told([noticeOutput(REVERT_NOTICE), { overwatch: { guarded: false } }]), REVERT_NOTICE)
})
