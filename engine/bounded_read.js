// Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
import assert from "node:assert/strict"
import { constants } from "node:fs"
import { open } from "node:fs/promises"

export const READ_LIMIT_BYTES = 1024 * 1024
export const READ_TIMEOUT_MS = 1000

export async function within(milliseconds, promise) {
  assert(Number.isFinite(milliseconds) && milliseconds > 0, `timeout ${milliseconds} is not a number of milliseconds above zero`)
  assert(typeof promise?.then === "function", `${String(promise)} is no promise; pass the read to wait for`)
  let timer
  try {
    const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`took more than ${milliseconds} ms`)), milliseconds) })
    return await Promise.race([promise, expired])
  } finally {
    clearTimeout(timer)
  }
}

async function regularFileText(path, limit, opener) {
  assert(typeof path === "string" && path !== "", `path is ${String(path)}; pass the file's path`)
  assert(Number.isInteger(limit) && limit >= 0, `limit ${limit} is not a count of bytes`)
  const handle = await opener(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const status = await handle.stat()
    if (!status.isFile()) throw new TypeError(`${path} is not a regular file`)
    if (status.size > limit) throw new RangeError(`${path} is larger than ${limit} bytes`)
    const buffer = Buffer.alloc(status.size)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    assert(bytesRead <= limit, `${path} gave ${bytesRead} bytes, past the limit of ${limit}`)
    return buffer.toString("utf8", 0, bytesRead)
  } finally {
    await handle.close()
  }
}

export async function readBoundedText(path, { limit = READ_LIMIT_BYTES, timeout = READ_TIMEOUT_MS, opener = open } = {}) {
  assert(typeof path === "string" && path !== "", `path is ${String(path)}; pass the file's path`)
  assert(Number.isInteger(limit) && limit >= 0, `limit ${limit} is not a count of bytes`)
  return within(timeout, regularFileText(path, limit, opener))
}
