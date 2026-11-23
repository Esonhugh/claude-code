import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childEnv = 'CLAUDE_CODE_TEST_SETUP_CHILD'

if (process.env[childEnv] === '1') {
  test('a credential lookup does not throw', async () => {
    const { getAnthropicApiKeyWithSource } = await import('./utils/auth.js')
    expect(getAnthropicApiKeyWithSource()).toEqual({
      key: 'sk-ant-test-placeholder',
      source: 'ANTHROPIC_API_KEY',
    })
  })
} else {
  // Fresh process: the credential variables of this one may come from the shell.
  test('bun test needs no Claude credential from the shell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'test-setup-'))
    try {
      const child = Bun.spawn(
        [process.execPath, 'test', '--no-env-file', import.meta.path],
        {
          cwd: join(import.meta.dir, '..'),
          env: {
            PATH: process.env.PATH,
            HOME: join(root, 'home'),
            CLAUDE_CONFIG_DIR: join(root, 'config'),
            TMPDIR: root,
            [childEnv]: '1',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`child failed (${code})\n${out}\n${err}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
}
