/** The watcher daemons a replay's engine started, stopped when the replay ends. */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * Stops each watcher daemon whose lock in data names it, and waits for it to exit, as tests/daemons.py does. Every
 * replay must have started one, for its watch command, or its checks never went through the daemon.
 */
export async function stopDaemons(data) {
  const locks = existsSync(data) ? readdirSync(data).filter(name => /^daemon-.*\.lock$/.test(name)) : []
  assert(locks.length > 0, `the replay left no daemon lock in ${data}; its checks did not go through the daemon`)
  const pids = locks.map(name => Number(readFileSync(join(data, name), 'utf8').trim())).filter(pid => pid > 0)
  const running = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  for (const pid of pids.filter(running)) process.kill(pid, 'SIGTERM')
  for (let attempt = 0; attempt < 100 && pids.some(running); attempt++) await delay(50)
  assert(!pids.some(running), `daemons ${pids} still serve ${data} after SIGTERM`)
}
