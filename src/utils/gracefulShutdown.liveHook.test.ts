import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// A SessionStart hook still running at exit has no cleanup of its own; shutdown
// must stop it instead of waiting out the cleanup budget and leaving it behind.
test.skipIf(process.platform === 'win32')(
  'shutdown stops a live command that registered no cleanup',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'shutdown-live-hook-'))
    const pidFile = join(root, 'pid')
    const started = Date.now()
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, 'gracefulShutdown.shellGrace.fixture.ts'), join(root, 'sleeps'), 'hook', pidFile],
      {
        env: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: join(root, 'config'), DISABLE_TELEMETRY: '1' },
        stdout: 'ignore',
        stderr: 'pipe',
      },
    )
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    await child.exited
    clearTimeout(timer)
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    const left = alive(pid)
    if (left) process.kill(pid, 'SIGKILL')
    expect(left).toBe(false)
    expect(Date.now() - started).toBeLessThan(2000 + 1500)
  },
  30_000,
)
