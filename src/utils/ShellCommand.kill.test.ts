import { expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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
