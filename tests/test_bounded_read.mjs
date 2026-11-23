// Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { after } from "node:test"

import { READ_LIMIT_BYTES, READ_TIMEOUT_MS, readBoundedText, within } from "../engine/bounded_read.js"
import { createV1Hooks } from "../integrations/opencode.js"

const WORKSPACE = mkdtempSync(join(tmpdir(), "overwatch-bounded-"))
const OPEN_SERVERS = []
after(() => {
  OPEN_SERVERS.forEach(server => server.close())
  rmSync(WORKSPACE, { recursive: true, force: true })
})
const HAS_MKFIFO = spawnSync("mkfifo", ["--help"]).error === undefined
const OVERRIDE = ".overwatch.json"
const UTF8_BYTE_ORDER_MARK = "\uFEFF"
const NO_PERMISSION = 0o000
const RUNS_AS_ROOT = process.getuid?.() === 0
const DEADLINE_MS = 500
const SHORT_WAIT_MS = 100
const OVER_THE_LIMIT = READ_LIMIT_BYTES + 1
const LONGEST_DEFAULT_TIMEOUT_MS = 2000
const SLACK_AFTER_DEFAULT_TIMEOUT_MS = 1000
const BYTES_IN_THE_FILE = 10
const TEXT_THE_READ_GIVES = "abc"

const hungAfter = milliseconds => new Promise(resolve => setTimeout(() => resolve("hung"), milliseconds))
const writeOverride = (directory, value) => writeFileSync(join(directory, OVERRIDE), typeof value === "string" ? value : JSON.stringify(value))
const makePipe = path => { execFileSync("mkfifo", [path]) }

const KINDS = {
  "a pipe with no writer": { skip: !HAS_MKFIFO, build: directory => makePipe(join(directory, OVERRIDE)) },
  "a link to a pipe with no writer": { skip: !HAS_MKFIFO, build: directory => { makePipe(join(directory, "pipe")); symlinkSync("pipe", join(directory, OVERRIDE)) } },
  "a directory": { build: directory => mkdirSync(join(directory, OVERRIDE)) },
  "a socket": {
    build: async directory => {
      const server = createServer()
      await new Promise(resolve => server.listen(join(directory, OVERRIDE), resolve))
      OPEN_SERVERS.push(server)
    },
  },
  "a file larger than the read limit": { build: directory => writeOverride(directory, { mode: "tcr", pad: "a".repeat(OVER_THE_LIMIT) }) },
  "a file that is not JSON": { build: directory => writeOverride(directory, "{ mode: tcr") },
  "a file with mode other": { build: directory => writeOverride(directory, { mode: "other" }) },
  "a file with no mode": { build: directory => writeOverride(directory, { checks: [] }) },
  "a file that starts with a UTF-8 byte order mark and sets mode tcr": { build: directory => writeOverride(directory, `${UTF8_BYTE_ORDER_MARK}${JSON.stringify({ mode: "tcr" })}`) },
  "a file that its owner cannot read": { skip: RUNS_AS_ROOT, build: directory => { writeOverride(directory, { mode: "tcr" }); chmodSync(join(directory, OVERRIDE), NO_PERMISSION) } },
  "no file": { build: () => undefined },
}

async function messageInProject(kind) {
  const directory = mkdtempSync(join(WORKSPACE, "project-"))
  await kind.build(directory)
  const log = []
  const hooks = createV1Hooks({ directory, client: { tui: { showToast: async () => undefined } } }, async event => { log.push(event.hook_event_name); return {} })
  const outcome = await Promise.race([hooks["chat.message"]({ sessionID: "s1" }).then(() => "returned"), hungAfter(DEADLINE_MS)])
  return { outcome, log }
}

for (const [name, kind] of Object.entries(KINDS)) {
  test(`OpenCode V1 returns from a message at once and runs no check for it when .overwatch.json is ${name}`, { skip: kind.skip === true }, async () => {
    assert.deepEqual(await messageInProject(kind), { outcome: "returned", log: [] })
  })
}

test("OpenCode V1 checks a message of a project whose .overwatch.json sets mode tcr", async () => {
  const tcr = { build: directory => writeOverride(directory, { mode: "tcr" }) }
  assert.deepEqual(await messageInProject(tcr), { outcome: "returned", log: ["UserPromptSubmit"] })
})

test("the bounded read ends at its deadline when the file never answers", async () => {
  await assert.rejects(within(SHORT_WAIT_MS, new Promise(() => undefined)), /took more than/)
})

function readFixtures() {
  const directory = mkdtempSync(join(WORKSPACE, "read-"))
  if (HAS_MKFIFO) makePipe(join(directory, "pipe"))
  mkdirSync(join(directory, "dir"))
  writeFileSync(join(directory, "over"), "a".repeat(OVER_THE_LIMIT))
  writeFileSync(join(directory, "at"), "a".repeat(READ_LIMIT_BYTES))
  return directory
}

test("the bounded read rejects a directory and a file over the limit, and reads a file at the limit", async () => {
  const directory = readFixtures()
  await assert.rejects(readBoundedText(join(directory, "dir")), /not a regular file/)
  await assert.rejects(readBoundedText(join(directory, "over")), /larger than/)
  assert.equal((await readBoundedText(join(directory, "at"))).length, READ_LIMIT_BYTES)
})

test("the bounded read rejects a pipe with no writer as no regular file", { skip: !HAS_MKFIFO }, async () => {
  await assert.rejects(readBoundedText(join(readFixtures(), "pipe")), /not a regular file/)
})

const stalledOpener = () => new Promise(() => undefined)
const endedWithin = (read, milliseconds) => Promise.race([read.then(() => "returned", error => error.message), hungAfter(milliseconds)])
const handleOf = (size, give) => ({
  stat: async () => ({ isFile: () => true, size }),
  read: async buffer => { buffer.write(give); return { bytesRead: give.length } },
  close: async () => undefined,
})

test("the bounded read ends at the timeout it is given when the file never opens", async () => {
  assert.match(await endedWithin(readBoundedText("any", { timeout: SHORT_WAIT_MS, opener: stalledOpener }), DEADLINE_MS), /took more than/)
})

test("the bounded read ends at its default timeout when the file never opens", async () => {
  assert.match(await endedWithin(readBoundedText("any", { opener: stalledOpener }), READ_TIMEOUT_MS + SLACK_AFTER_DEFAULT_TIMEOUT_MS), /took more than/)
})

test("the default timeout of the bounded read is at most a named bound", () => {
  assert.ok(READ_TIMEOUT_MS <= LONGEST_DEFAULT_TIMEOUT_MS, `${READ_TIMEOUT_MS} ms is over ${LONGEST_DEFAULT_TIMEOUT_MS} ms`)
})

test("the bounded read gives only the bytes that the read returned", async () => {
  assert.equal(await readBoundedText("any", { opener: async () => handleOf(BYTES_IN_THE_FILE, TEXT_THE_READ_GIVES) }), TEXT_THE_READ_GIVES)
})
