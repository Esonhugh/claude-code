import { expect, test } from 'bun:test'
import { spawn, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { wrapSpawn } from './ShellCommand.js'
import { TaskOutput } from './task/TaskOutput.js'

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test.skipIf(process.platform === 'win32')(
  'kill() reaches the detached shell tree before the process exits',
  async () => {
    // The fixture kills the command and exits immediately, like shutdown does.
    const pidFile = join(mkdtempSync(join(tmpdir(), 'shell-kill-')), 'pid')
    spawnSync(process.execPath, [join(import.meta.dir, 'ShellCommand.kill.fixture.ts'), pidFile], {
      stdio: 'ignore',
    })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(pid).toBeGreaterThan(0)
    // Without the synchronous group kill the sleep lives for 600s; allow time
    // for init to reap it.
    for (let i = 0; i < 30 && isAlive(pid); i++) await new Promise(r => setTimeout(r, 100))
    const alive = isAlive(pid)
    if (alive) process.kill(pid, 'SIGKILL')
    expect(alive).toBe(false)
  },
)

// macOS has no setsid(1) for the fixture.
test.skipIf(process.platform === 'win32' || !Bun.which('setsid'))(
  'kill() reaches a descendant in its own process group before the process exits',
  async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'shell-kill-')), 'pid')
    spawnSync(process.execPath, [join(import.meta.dir, 'ShellCommand.kill.fixture.ts'), pidFile, 'own-group'], {
      stdio: 'ignore',
    })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(pid).toBeGreaterThan(0)
    for (let i = 0; i < 30 && isAlive(pid); i++) await new Promise(r => setTimeout(r, 100))
    const alive = isAlive(pid)
    if (alive) process.kill(pid, 'SIGKILL')
    expect(alive).toBe(false)
  },
)

test.skipIf(process.platform === 'win32')(
  'kill() stops a shell that is not a group leader before it runs its next command',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shell-kill-'))
    const marker = join(dir, 'after-sleep')
    // Like a hook: spawned with shell: true, not detached.
    const child = spawn(`sleep 1; echo done > '${marker}'`, [], { shell: true })
    const cmd = wrapSpawn(child, new AbortController().signal, 600_000, new TaskOutput('kill-shell', null))
    await new Promise(r => setTimeout(r, 200))
    cmd.kill()
    await new Promise(r => setTimeout(r, 1500))
    expect(existsSync(marker)).toBe(false)
  },
)
