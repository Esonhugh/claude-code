import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// useReplBridge only runs under feature('BRIDGE_MODE'), so the cases run in a
// child `bun test --feature=BRIDGE_MODE`.
const childFlag = 'CLAUDE_CODE_REPL_BRIDGE_FAILURE_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('Remote Control failure path (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-repl-bridge-failure-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(
      ([key]) => !/^(?:ANTHROPIC_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_EXPERIMENTAL_CODE_MODE)/.test(key),
    ))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--feature=BRIDGE_MODE', import.meta.path], {
        cwd: join(import.meta.dir, '../..'),
        env: {
          ...env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_API_KEY: 'test-only-not-a-real-key',
          DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)
} else {
  await import('./useReplBridge.failure.cases.js')
}
