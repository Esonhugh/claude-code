import { describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childEnv = 'CLAUDE_CODE_MCP_GET_TEST_CHILD'
const stdio = (arg: string) => ({ command: 'echo', args: [arg] })

if (process.env[childEnv] === '1') {
  await runChild()
} else {
  // Fresh process: settings and config are cached per process.
  describe('claude mcp get admission', () => {
    test('passes the isolated suite', async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-get-')))
      try {
        const project = join(root, 'project')
        const config = join(root, 'config')
        await mkdir(join(project, '.claude'), { recursive: true })
        await mkdir(config, { recursive: true })
        await writeFile(
          join(project, '.mcp.json'),
          JSON.stringify({
            mcpServers: {
              pending: stdio('pending'),
              rejected: stdio('rejected'),
              disabled: stdio('disabled'),
              denied: stdio('denied'),
              typeless: stdio('typeless'),
              timed: { ...stdio('timed'), timeout: 500 },
            },
          }),
        )
        await writeFile(
          join(project, '.claude', 'settings.local.json'),
          JSON.stringify({
            enabledMcpjsonServers: ['disabled', 'denied', 'typeless', 'timed'],
            disabledMcpjsonServers: ['rejected'],
          }),
        )
        await writeFile(
          join(config, 'settings.json'),
          JSON.stringify({ deniedMcpServers: [{ serverName: 'denied' }] }),
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
  const connected: string[] = []
  const client = await import('../../services/mcp/client.js')
  mock.module('../../services/mcp/client.js', () => ({
    ...client,
    connectToServer: async (name: string) => {
      connected.push(name)
      return { type: 'failed', name }
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
  const { enableConfigs, saveCurrentProjectConfig } = await import(
    '../../utils/config.js'
  )
  enableConfigs()
  saveCurrentProjectConfig(current => ({
    ...current,
    disabledMcpServers: ['disabled'],
  }))
  const { mcpGetHandler } = await import('./mcp.js')

  async function get(name: string) {
    const lines: string[] = []
    const errors: string[] = []
    const exitCodes: number[] = []
    const log = spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '))
    })
    const error = spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args.join(' '))
    })
    const exit = spyOn(process, 'exit').mockImplementation(((code: number) => {
      exitCodes.push(code)
    }) as typeof process.exit)
    try {
      await mcpGetHandler(name)
    } finally {
      log.mockRestore()
      error.mockRestore()
      exit.mockRestore()
    }
    return { output: lines.join('\n'), errors: errors.join('\n'), exitCodes }
  }

  test('pending and rejected .mcp.json servers are shown, not connected', async () => {
    const pending = await get('pending')
    expect(pending.output).toContain('Status: ⏸ Pending approval')
    const rejected = await get('rejected')
    expect(rejected.output).toContain('Status: ✗ Rejected')
    expect(connected).toEqual([])
  })

  test('servers disabled for the project are not connected', async () => {
    const disabled = await get('disabled')
    expect(disabled.output).toContain('Status: ⊘ Disabled for this project')
    expect(connected).toEqual([])
  })

  test('policy-denied servers are not found', async () => {
    const denied = await get('denied')
    expect(denied.exitCodes).toEqual([1])
    expect(denied.errors).toContain('No MCP server named "denied". Configured servers: ')
    expect(denied.errors).not.toContain('denied,')
    expect(connected).toEqual([])
  })

  test('stdio servers without a type show command details', async () => {
    const typeless = await get('typeless')
    expect(connected).toEqual(['typeless'])
    expect(typeless.output).toContain('Type: stdio')
    expect(typeless.output).toContain('Command: echo')
    expect(typeless.output).toContain('Args: typeless')
  })

  test('a per-server timeout is shown, flagged when below the minimum', async () => {
    const timed = await get('timed')
    expect(timed.output).toContain(
      'Timeout: 500ms (ignored: below 1000ms minimum)',
    )
    const typeless = await get('typeless')
    expect(typeless.output).not.toContain('Timeout:')
  })
}
