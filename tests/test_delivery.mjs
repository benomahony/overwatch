// Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
import assert from "node:assert/strict"
import test from "node:test"

import { SessionDelivery } from "../engine/delivery.js"
import { setupV2 } from "../integrations/opencode.js"
import { output, PROJECT } from "./fixtures/checker-output.mjs"

test("a correction that went undelivered after its session was removed leaves no session behind and raises nothing", () => {
  const delivery = new SessionDelivery()
  assert.equal(delivery.correction("session-1", output("same failure")), true, "the result did not ask for a correction pass")
  delivery.remove("session-1")
  assert.doesNotThrow(() => delivery.undelivered("session-1"), "undelivered threw for a session that was deleted while its prompt was pending")
  assert.equal(delivery.sessions.size, 0, "undelivered brought the deleted session back as an empty one")
  assert.equal(delivery.sessions.has("session-1"), false, "the deleted session is in the delivery again")
})

test("a correction that went undelivered after its session was removed and recreated by another event leaves the new session as it was and raises nothing", () => {
  const delivery = new SessionDelivery()
  delivery.correction("session-1", output("same failure"))
  delivery.remove("session-1")
  delivery.stateOf("session-1").notices.push("a notice of the new session")
  assert.doesNotThrow(() => delivery.undelivered("session-1"), "undelivered threw for a session that was recreated while its prompt was pending")
  assert.deepEqual(delivery.stateOf("session-1").notices, ["a notice of the new session"], "undelivered changed the recreated session")
})

test("work in a session the delivery has not met leaves no session behind, and work in a known session still releases its deduplication", () => {
  const delivery = new SessionDelivery()
  assert.doesNotThrow(() => delivery.progressed("session-1"), "progressed threw for a session the delivery has not met")
  assert.equal(delivery.sessions.size, 0, "progressed made a session out of work in one the delivery had not met")
  assert.throws(() => delivery.progressed(""), /session ID/, "progressed took an empty session ID")
  assert.equal(delivery.correction("session-2", output("same failure")), true, "the result did not ask for a correction pass")
  delivery.undelivered("session-2")
  delivery.progressed("session-2")
  assert.equal(delivery.stateOf("session-2").correction, undefined, "work outside a correction pass kept the deduplication")
  assert.equal(delivery.sessions.size, 1, "progressed changed the number of sessions the delivery holds")
})

test("a correction that went undelivered after the plugin was shut down leaves no session behind", () => {
  const delivery = new SessionDelivery()
  delivery.correction("session-1", output("same failure"))
  delivery.clear()
  assert.doesNotThrow(() => delivery.undelivered("session-1"), "undelivered threw after the plugin was shut down")
  assert.equal(delivery.sessions.size, 0, "undelivered brought a session back after shutdown")
})

test("OpenCode V2 handles a session.deleted that follows an idle only after the pending prompt settled, and the next session starts clean", async t => {
  const settled = []
  t.mock.method(console, "error", () => undefined)
  await setupV2({
    location: { directory: PROJECT },
    session: {
      hook: async () => undefined,
      prompt: async request => {
        await new Promise(resolve => setImmediate(resolve))
        settled.push(`prompt ${request.text}`)
        throw new Error("the host refused the prompt")
      },
    },
    tool: { hook: async () => undefined },
    event: {
      subscribe: async function* () {
        yield { type: "session.idle", properties: { sessionID: "session-1" } }
        settled.push("deleted")
        yield { type: "session.deleted", properties: { sessionID: "session-1" } }
        yield { type: "session.idle", properties: { sessionID: "session-1" } }
      },
    },
  }, async event => (event.hook_event_name === "Stop" ? output("same failure") : {}))
  for (let turn = 0; turn < 6; turn += 1) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(settled.slice(0, 2), ["prompt same failure", "deleted"], "the deletion was handled while the prompt was pending")
  assert.equal(settled.filter(entry => entry.startsWith("prompt")).length, 2, "the session created again after its deletion was not asked for a correction as a new one")
})

test("a prompt that OpenCode queued and then reported as failed, as a timeout, is sent again at the next idle, so the agent can read the correction twice", async t => {
  const queued = []
  t.mock.method(console, "error", () => undefined)
  await setupV2({
    location: { directory: PROJECT },
    session: {
      hook: async () => undefined,
      prompt: async request => {
        queued.push(request.text)
        if (queued.length === 1) throw new Error("timed out waiting for the host, after it queued the prompt")
      },
    },
    tool: { hook: async () => undefined },
    event: {
      subscribe: async function* () {
        for (let idle = 0; idle < 2; idle += 1) yield { type: "session.idle", properties: { sessionID: "session-1" } }
      },
    },
  }, async event => (event.hook_event_name === "Stop" ? output("same failure") : {}))
  for (let turn = 0; turn < 4; turn += 1) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(queued, ["same failure", "same failure"], "the accepted limit changed: a prompt reported as failed after it was queued is no longer sent again")
})
