import { describe, expect, mock, spyOn, test } from 'bun:test'
import figures from 'figures'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childEnv = 'CLAUDE_CODE_MCP_LIST_TEST_CHILD'
const stdio = (arg: string) => ({ command: 'echo', args: [arg] })

if (process.env[childEnv] === '1') {
  await runChild()
} else {
  // Fresh process: settings and config are cached per process.
  describe('claude mcp list admission', () => {
    test('passes the isolated suite', async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-list-')))
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
              approved: stdio('approved'),
              broken: { type: 'stdio', command: '' },
            },
          }),
        )
        await writeFile(
          join(project, '.claude', 'settings.local.json'),
          JSON.stringify({
            enabledMcpjsonServers: ['disabled', 'approved', 'broken'],
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
      return { type: 'connected', name }
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
  const { mcpListHandler } = await import('./mcp.js')

  const lines: string[] = []
  const log = spyOn(console, 'log').mockImplementation((...args) => {
    lines.push(args.join(' '))
  })
  try {
    await mcpListHandler()
  } finally {
    log.mockRestore()
  }
  const output = lines.join('\n')

  test('only approved, enabled servers are health-checked', () => {
    expect(connected).toEqual(['approved'])
    expect(output).toContain(`approved: echo approved - ${figures.tick} Connected`)
  })

  test('pending servers are listed as pending approval', () => {
    expect(output).toContain(
      'pending: echo pending - ⏸ Pending approval (run `claude` to approve)',
    )
  })

  test('disabled servers are listed as disabled', () => {
    expect(output).toContain(
      'disabled: echo disabled - ⊘ Disabled for this project (re-enable via /mcp)',
    )
  })

  test('rejected servers are not listed', () => {
    expect(output).not.toContain('rejected:')
  })

  test('an invalid entry is reported, not fatal for the file', () => {
    expect(output).toContain('MCP Config Diagnostics')
    // Diagnostics wrap at the terminal width.
    expect(output.replace(/\s+/g, ' ')).toContain(
      'Skipped — invalid MCP server config for "broken": command: Command cannot be empty',
    )
  })
}
