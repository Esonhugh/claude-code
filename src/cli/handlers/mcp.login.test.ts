import { describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childEnv = 'CLAUDE_CODE_MCP_LOGIN_TEST_CHILD'

if (process.env[childEnv] === '1') {
  await runChild()
} else {
  // Fresh process: settings and config are cached per process.
  describe('claude mcp login/logout', () => {
    test('passes the isolated suite', async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-login-')))
      try {
        const project = join(root, 'project')
        const config = join(root, 'config')
        await mkdir(join(project, '.claude'), { recursive: true })
        await mkdir(config, { recursive: true })
        const http = (name: string) => ({
          type: 'http',
          url: `https://${name}.invalid/mcp`,
        })
        await writeFile(
          join(project, '.mcp.json'),
          JSON.stringify({
            mcpServers: {
              remote: http('remote'),
              failing: http('failing'),
              pastey: http('pastey'),
              headered: {
                ...http('headered'),
                headers: { authorization: 'Bearer static' },
              },
              local: { command: 'echo', args: [] },
              pending: http('pending'),
              rejected: http('rejected'),
            },
          }),
        )
        await writeFile(
          join(project, '.claude', 'settings.local.json'),
          JSON.stringify({
            enabledMcpjsonServers: [
              'remote',
              'failing',
              'pastey',
              'headered',
              'local',
            ],
            disabledMcpjsonServers: ['rejected'],
          }),
        )
        const child = Bun.spawn(
          [
            process.execPath,
            'test',
            '--no-env-file',
            '--timeout',
            '30000',
            import.meta.path,
          ],
          {
            cwd: project,
            env: {
              PATH: process.env.PATH,
              HOME: join(root, 'home'),
              CLAUDE_CONFIG_DIR: config,
              TMPDIR: root,
              DISABLE_TELEMETRY: '1',
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
              [childEnv]: '1',
            },
            stdin: 'pipe',
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
  })
}

async function runChild(): Promise<void> {
  const flows: Array<{ name: string; skipBrowserOpen?: boolean }> = []
  const revoked: Array<{ name: string; preserveStepUpState?: boolean }> = []
  const auth = await import('../../services/mcp/auth.js')
  mock.module('../../services/mcp/auth.js', () => ({
    ...auth,
    revokeServerTokens: async (
      name: string,
      _config: unknown,
      options?: { preserveStepUpState?: boolean },
    ) => {
      revoked.push({ name, ...options })
    },
    performMCPOAuthFlow: async (
      name: string,
      _config: unknown,
      onAuthorizationUrl: (url: string) => void,
      signal: AbortSignal,
      options?: {
        skipBrowserOpen?: boolean
        onWaitingForCallback?: (submit: (url: string) => boolean) => void
      },
    ) => {
      flows.push({ name, skipBrowserOpen: options?.skipBrowserOpen })
      onAuthorizationUrl(`https://as.invalid/authorize?for=${name}`)
      if (name === 'failing') throw new Error('token endpoint said no')
      if (name === 'pastey') {
        options?.onWaitingForCallback?.(() => false)
        if (signal.aborted) throw new auth.AuthenticationCancelledError()
      }
    },
  }))
  const shutdown = await import('../../utils/gracefulShutdown.js')
  mock.module('../../utils/gracefulShutdown.js', () => ({
    ...shutdown,
    gracefulShutdown: async () => {},
  }))

  const state = await import('../../bootstrap/state.js')
  state.setOriginalCwd(process.cwd())
  state.setProjectRoot(process.cwd())
  state.setCwdState(process.cwd())
  // Interactive session: .mcp.json servers are not auto-approved.
  state.setIsInteractive(true)
  const { enableConfigs } = await import('../../utils/config.js')
  enableConfigs()
  const { mcpLoginHandler, mcpLogoutHandler } = await import('./mcp.js')

  async function run(fn: () => Promise<void>) {
    const out: string[] = []
    const errors: string[] = []
    const exitCodes: number[] = []
    const write = spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string,
    ) => {
      out.push(String(chunk))
      return true
    }) as typeof process.stdout.write)
    const error = spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args.join(' '))
    })
    const exit = spyOn(process, 'exit').mockImplementation(((code: number) => {
      exitCodes.push(code)
    }) as typeof process.exit)
    try {
      await fn()
    } finally {
      write.mockRestore()
      error.mockRestore()
      exit.mockRestore()
    }
    return { output: out.join(''), errors: errors.join('\n'), exitCodes }
  }

  test('login runs the OAuth flow and reports success', async () => {
    const result = await run(() => mcpLoginHandler('remote', { browser: true }))
    expect(revoked).toEqual([{ name: 'remote', preserveStepUpState: true }])
    expect(flows).toEqual([{ name: 'remote', skipBrowserOpen: false }])
    expect(result.output).toContain('Starting authentication for "remote"…')
    expect(result.output).toContain(
      "If the browser didn't open, visit:\n  https://as.invalid/authorize?for=remote\n",
    )
    expect(result.output).toContain(
      'Authenticated with "remote". Its tools are now available in Claude Code.',
    )
    expect(result.exitCodes).toEqual([0])
  })

  test('--no-browser prints the URL without opening a browser', async () => {
    flows.length = 0
    const result = await run(() =>
      mcpLoginHandler('remote', { browser: false }),
    )
    expect(flows).toEqual([{ name: 'remote', skipBrowserOpen: true }])
    expect(result.output).toContain(
      'Visit this URL to authorize:\n  https://as.invalid/authorize?for=remote\n',
    )
  })

  test('a failed flow is reported', async () => {
    const result = await run(() => mcpLoginHandler('failing', { browser: true }))
    expect(result.errors).toBe(
      `Couldn't complete authentication for "failing": token endpoint said no`,
    )
    expect(result.exitCodes).toEqual([1])
  })

  test('without a terminal on stdin the paste fallback cannot work', async () => {
    const result = await run(() => mcpLoginHandler('pastey', { browser: false }))
    expect(result.errors).toContain(
      `Couldn't complete authentication for "pastey": stdin isn't a terminal`,
    )
    expect(result.exitCodes).toEqual([1])
  })

  test('login refuses servers it cannot authenticate', async () => {
    flows.length = 0
    const cases: Array<[string, string]> = [
      ['missing', 'No MCP server found with name: missing'],
      [
        'local',
        `"local" doesn't support OAuth login — it's only available for HTTP and SSE servers.`,
      ],
      [
        'headered',
        `"headered" authenticates with the \`Authorization\` header in its configuration, so there's no separate login. Update that header to change its credentials.`,
      ],
      [
        'pending',
        '"pending" is from .mcp.json and awaiting approval. Run `claude` in this directory to review it first.',
      ],
      [
        'rejected',
        '"rejected" is from .mcp.json and was rejected. Run `claude mcp reset-project-choices` to review it again.',
      ],
    ]
    for (const [name, message] of cases) {
      const result = await run(() => mcpLoginHandler(name, { browser: true }))
      expect(result.errors).toBe(message)
      expect(result.exitCodes[0]).toBe(1)
    }
    expect(flows).toEqual([])
  })

  test('logout clears stored credentials', async () => {
    revoked.length = 0
    const result = await run(() => mcpLogoutHandler('remote'))
    expect(revoked).toEqual([{ name: 'remote' }])
    expect(result.output).toBe(
      'Signed out of "remote". Run `claude mcp login remote` to authenticate again.\n',
    )
    expect(result.exitCodes).toEqual([0])
  })

  test('logout of a static-header server has no login hint', async () => {
    const result = await run(() => mcpLogoutHandler('headered'))
    expect(result.output).toBe('Signed out of "headered".\n')
  })

  test('logout of a non-OAuth server is an error', async () => {
    revoked.length = 0
    const result = await run(() => mcpLogoutHandler('local'))
    expect(result.errors).toBe(
      `"local" doesn't use OAuth — there are no stored credentials to clear.`,
    )
    expect(result.exitCodes).toEqual([1])
    expect(revoked).toEqual([])
  })
}
