import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

async function sleepsDuringShutdown(mode: 'none' | 'shell'): Promise<number[]> {
  const root = mkdtempSync(join(tmpdir(), 'shutdown-shell-grace-'))
  const log = join(root, 'sleeps')
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'gracefulShutdown.shellGrace.fixture.ts'), log, mode],
    {
      env: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: join(root, 'config'), DISABLE_TELEMETRY: '1' },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  )
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
  await child.exited
  clearTimeout(timer)
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []
}

// Every -p / SDK run exits through here; the grace for killed shells'
// results must not delay an exit that had no shell running.
test('shutdown without a live shell does not wait the transcript grace', async () => {
  expect(await sleepsDuringShutdown('none')).not.toContain(250)
}, 30_000)

test.skipIf(process.platform === 'win32')(
  'shutdown with a live shell still waits for its result to reach the transcript',
  async () => {
    expect(await sleepsDuringShutdown('shell')).toContain(250)
  },
  30_000,
)
