import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

test('shutdown still runs cleanup when the terminal is gone before the memory flush', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shutdown-tty-gone-'))
  const marker = join(root, 'cleaned')
  const child = Bun.spawn(
    [process.execPath, '--feature=EXTRACT_MEMORIES', join(import.meta.dir, 'gracefulShutdown.ttyGone.fixture.ts'), marker],
    {
      env: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: join(root, 'config'), DISABLE_TELEMETRY: '1' },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  )
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000)
  await child.exited
  clearTimeout(timer)
  expect(existsSync(marker)).toBe(true)
}, 15_000)
