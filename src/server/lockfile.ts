import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'

/** Written to <config dir>/<name> while `claude server` or `claude web` runs. No secrets. */
export type ServerLock = {
  pid: number
  port?: number
  host?: string
  httpUrl: string
  startedAt?: number
}

function lockPath(name: string): string {
  return join(getClaudeConfigHomeDir(), name)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readLock(name: string): Promise<ServerLock | undefined> {
  try {
    const lock = JSON.parse(await readFile(lockPath(name), 'utf8')) as ServerLock
    return typeof lock.pid === 'number' ? lock : undefined
  } catch {
    return undefined
  }
}

export async function writeServerLock(
  lock: ServerLock,
  name = 'server.lock',
): Promise<void> {
  await mkdir(getClaudeConfigHomeDir(), { recursive: true })
  await writeFile(lockPath(name), JSON.stringify(lock), { mode: 0o600 })
}

export async function removeServerLock(name = 'server.lock'): Promise<void> {
  const lock = await readLock(name)
  if (lock && lock.pid !== process.pid) return
  await unlink(lockPath(name)).catch(() => {})
}

/** The lock of a live server, or undefined (a stale lock is removed). */
export async function probeRunningServer(
  name = 'server.lock',
): Promise<ServerLock | undefined> {
  const lock = await readLock(name)
  if (!lock) return undefined
  if (lock.pid !== process.pid && isAlive(lock.pid)) return lock
  await unlink(lockPath(name)).catch(() => {})
  return undefined
}
