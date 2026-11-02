import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childEnv = 'CLAUDE_CODE_AUTH_STATUS_TEST_CHILD'

if (process.env[childEnv] === '1') {
  test('an API key outranks an OAuth token like it does at request time', async () => {
    const { enableConfigs } = await import('../../utils/config.js')
    enableConfigs()
    const { authStatus } = await import('./auth.js')
    let out = ''
    const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      out += chunk
      return true
    }) as typeof process.stdout.write)
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit)
    try {
      await authStatus({})
    } finally {
      write.mockRestore()
      exit.mockRestore()
    }
    const status = JSON.parse(out)
    expect(status).toMatchObject({
      loggedIn: true,
      authMethod: 'api_key',
      apiKeySource: 'ANTHROPIC_API_KEY',
      configDirectory: process.env.CLAUDE_CONFIG_DIR,
      projectsDirectory: join(process.env.CLAUDE_CONFIG_DIR!, 'projects'),
    })
    expect(typeof status.analyticsDisabled).toBe('boolean')
  })
} else {
  // Fresh process: auth sources and settings are cached per process.
  describe('claude auth status', () => {
    test('passes the isolated suite', async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'auth-status-')))
      try {
        const child = Bun.spawn([process.execPath, 'test', '--no-env-file', import.meta.path], {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            CLAUDE_CONFIG_DIR: join(root, 'config'),
            ANTHROPIC_API_KEY: 'sk-ant-status-placeholder',
            CLAUDE_CODE_OAUTH_TOKEN: 'oauth-status-placeholder',
            [childEnv]: '1',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        })
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
  })
}
