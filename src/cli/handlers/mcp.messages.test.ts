import { describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childEnv = 'CLAUDE_CODE_MCP_MESSAGES_TEST_CHILD'

if (process.env[childEnv]) {
  await runChild()
} else {
  // Runs in a fresh process: settings and config are cached per process.
  describe('claude mcp messages', () => {
    test('passes the isolated suite', async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-messages-')))
      try {
        const project = join(root, 'project')
        const config = join(root, 'config')
        await mkdir(project, { recursive: true })
        await mkdir(config, { recursive: true })
        await writeFile(
          join(project, '.mcp.json'),
          JSON.stringify({ mcpServers: { pending: { command: 'echo' } } }),
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
  const shutdown = await import('../../utils/gracefulShutdown.js')
  mock.module('../../utils/gracefulShutdown.js', () => ({
    ...shutdown,
    gracefulShutdown: async () => {},
  }))
  const state = await import('../../bootstrap/state.js')
  state.setOriginalCwd(process.cwd())
  state.setProjectRoot(process.cwd())
  state.setCwdState(process.cwd())
  state.setIsInteractive(false)
  const { enableConfigs, getGlobalConfig } = await import(
    '../../utils/config.js'
  )
  enableConfigs()
  const { Command } = await import('@commander-js/extra-typings')
  const { registerMcpAddCommand } = await import(
    '../../commands/mcp/addCommand.js'
  )
  const { mcpAddJsonHandler, mcpRemoveHandler, mcpResetChoicesHandler } =
    await import('./mcp.js')

  async function capture(run: () => Promise<unknown>) {
    let stdout = ''
    let stderr = ''
    const exitCodes: number[] = []
    const out = spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string,
    ) => {
      stdout += chunk
      return true
    }) as typeof process.stdout.write)
    const err = spyOn(process.stderr, 'write').mockImplementation(((
      chunk: string,
    ) => {
      stderr += chunk
      return true
    }) as typeof process.stderr.write)
    const error = spyOn(console, 'error').mockImplementation((...args) => {
      stderr += `${args.join(' ')}\n`
    })
    const exit = spyOn(process, 'exit').mockImplementation(((code: number) => {
      exitCodes.push(code)
    }) as typeof process.exit)
    try {
      await run()
    } finally {
      out.mockRestore()
      err.mockRestore()
      error.mockRestore()
      exit.mockRestore()
    }
    return { stdout, stderr, exitCode: exitCodes[0] }
  }

  const add = (...args: string[]) =>
    capture(() => {
      const mcp = new Command('mcp')
      registerMcpAddCommand(mcp)
      return mcp.parseAsync(['add', '-s', 'user', ...args], { from: 'user' })
    })
  const addJson = (name: string, json: string) =>
    capture(() => mcpAddJsonHandler(name, json, { scope: 'user' }))

  // Expected texts are official 2.1.329 output.
  test('mcp add does not echo credential headers', async () => {
    for (const transport of ['http', 'sse']) {
      const { stdout, exitCode } = await add(
        '-t',
        transport,
        `h-${transport}`,
        'http://127.0.0.1:1/mcp',
        '-H',
        'Authorization: Bearer abc123',
        '-H',
        'X-Api-Key: k123',
        '-H',
        'X-Other: plain',
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain(
        'Headers: {\n  "Authorization": "[REDACTED]",\n  "X-Api-Key": "[REDACTED]",\n  "X-Other": "plain"\n}\n',
      )
      expect(stdout).not.toContain('abc123')
      expect(stdout).not.toContain('k123')
      // The stored config keeps the real values.
      expect(getGlobalConfig().mcpServers?.[`h-${transport}`]).toMatchObject({
        headers: { Authorization: 'Bearer abc123', 'X-Api-Key': 'k123' },
      })
    }
  })

  test('mcp add warns when a URL is added as a stdio command', async () => {
    const { stderr } = await add('urlish', 'http://example.com/mcp')
    expect(stderr).toContain(
      'Warning: The command "http://example.com/mcp" looks like a URL, but is treated as a stdio server because --transport wasn\'t set.\n',
    )
  })

  test('mcp add-json refuses server types the host registers', async () => {
    for (const [json, reason] of [
      [
        '{"type":"sdk","name":"x"}',
        'type "sdk" servers are registered by the host application at runtime, not stored in configuration',
      ],
      [
        '{"type":"sse-ide","url":"http://127.0.0.1:1/sse","ideName":"x"}',
        'type "sse-ide" servers are registered by the host application at runtime, not stored in configuration',
      ],
      [
        '{"type":"claudeai-proxy","url":"https://x.example/mcp","id":"a"}',
        'type "claudeai-proxy" is used only by claude.ai connectors — connect the service at claude.ai/customize/connectors, or add it with type "http"',
      ],
    ] as const) {
      const { stderr, exitCode } = await addJson('hosted', json)
      expect(stderr).toBe(`Cannot add MCP server "hosted": ${reason}\n`)
      expect(exitCode).toBe(1)
    }
    expect(getGlobalConfig().mcpServers?.hosted).toBeUndefined()
  })

  test('mcp add-json names the invalid field', async () => {
    for (const [json, reason] of [
      ['{"type":"http"}', 'url: expected string, received undefined'],
      ['{"type":"stdio"}', 'command: expected string, received undefined'],
      [
        '{"type":"http","url":1,"headers":{"a":1}}',
        'url: expected string, received number, headers.a: expected string, received number',
      ],
      ['{"type":"sdk"}', 'name: expected string, received undefined'],
      [
        '{"type":"nope"}',
        'unknown "type". Use "stdio", "sse", "http" (or "streamable-http") or "ws".',
      ],
      ['[1]', 'not a JSON object. Check its quotes, commas and braces.'],
      ['{bad', 'not a JSON object. Check its quotes, commas and braces.'],
      [
        '{"url":"http://a/b"}',
        'it has a "url" but no "type". Add "type": "http" (or "sse" / "ws").',
      ],
      [
        '{"mcpServers":{}}',
        'leave out the "mcpServers" wrapper and the server name. Pass only the settings inside them.',
      ],
      [
        '{}',
        'it needs a "command" for a local server, or a "type" and a "url" for a remote one.',
      ],
    ] as const) {
      const { stderr, exitCode } = await addJson('bad', json)
      expect(stderr).toBe(`Invalid configuration: ${reason}\n`)
      expect(exitCode).toBe(1)
    }
  })

  test('mcp remove names the scope that lacks the server', async () => {
    for (const [scope, where] of [
      ['user', 'user scope'],
      ['project', '.mcp.json'],
      ['local', 'local scope'],
    ] as const) {
      const { stderr, exitCode } = await capture(() =>
        mcpRemoveHandler('nope', { scope }),
      )
      expect(stderr).toBe(`No MCP server named "nope" in ${where}\n`)
      expect(exitCode).toBe(1)
    }
  })

  test('mcp reset-project-choices says pending servers will prompt', async () => {
    const { stdout, exitCode } = await capture(mcpResetChoicesHandler)
    expect(stdout).toBe(
      'Project-scoped (.mcp.json) server approvals and rejections stored for this project have been reset.\nYou will be prompted for approval next time you start Claude Code.\n',
    )
    expect(exitCode).toBe(0)
  })
}
