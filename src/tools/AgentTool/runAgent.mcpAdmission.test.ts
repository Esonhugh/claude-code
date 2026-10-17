import { describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childEnv = 'CLAUDE_CODE_AGENT_MCP_ADMISSION_TEST_CHILD'
const stdio = (arg: string) => ({ command: 'echo', args: [arg] })

if (process.env[childEnv]) {
  await runChild(process.env[childEnv])
} else {
  // Each scenario runs in a fresh process: settings, config and the
  // enterprise-config check are cached per process.
  describe('agent frontmatter MCP admission', () => {
    for (const scenario of ['default', 'enterprise']) {
      test(scenario, async () => {
        const root = await realpath(
          await mkdtemp(join(tmpdir(), 'agent-mcp-admission-')),
        )
        try {
          const project = join(root, 'project')
          const config = join(root, 'config')
          await mkdir(join(project, '.claude'), { recursive: true })
          await mkdir(config, { recursive: true })
          await mkdir(join(root, 'managed'), { recursive: true })
          await writeFile(
            join(project, '.mcp.json'),
            JSON.stringify({
              mcpServers: {
                pending: stdio('pending'),
                approved: stdio('approved'),
              },
            }),
          )
          await writeFile(
            join(project, '.claude', 'settings.local.json'),
            JSON.stringify({ enabledMcpjsonServers: ['approved'] }),
          )
          await writeFile(
            join(config, 'settings.json'),
            JSON.stringify({
              deniedMcpServers: [{ serverName: 'denied-inline' }],
            }),
          )
          if (scenario === 'enterprise') {
            await writeFile(
              join(root, 'managed', 'managed-mcp.json'),
              JSON.stringify({ mcpServers: { corp: stdio('corp') } }),
            )
          }
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
                AGENT_MCP_ADMISSION_ROOT: root,
                [childEnv]: scenario,
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
  })
}

async function runChild(scenario: string): Promise<void> {
  const root = process.env.AGENT_MCP_ADMISSION_ROOT!
  const managedPath = await import('../../utils/settings/managedPath.js')
  mock.module('../../utils/settings/managedPath.js', () => ({
    ...managedPath,
    getManagedFilePath: () => join(root, 'managed'),
  }))
  const connected: Array<{ name: string; scope: string }> = []
  const client = await import('../../services/mcp/client.js')
  mock.module('../../services/mcp/client.js', () => ({
    ...client,
    connectToServer: async (name: string, config: { scope: string }) => {
      connected.push({ name, scope: config.scope })
      return { type: 'connected', name, config, cleanup: async () => {} }
    },
    fetchToolsForClient: async () => [],
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
    disabledMcpServers: ['disabled-inline'],
  }))
  const { initializeAgentMcpServersForTesting } = await import('./runAgent.js')

  test(`${scenario}: frontmatter MCP servers go through admission`, async () => {
    const blocked: Array<[string[], string]> = []
    await initializeAgentMcpServersForTesting(
      {
        agentType: 'mcp-probe',
        whenToUse: 'probe',
        source: 'userSettings',
        getSystemPrompt: () => '',
        mcpServers: [
          'pending',
          'approved',
          { 'denied-inline': stdio('denied') },
          { 'disabled-inline': stdio('disabled') },
          { 'ok-inline': stdio('ok') },
          { 'claude-in-chrome': stdio('reserved') },
          {
            'ide-inline': {
              type: 'sse-ide',
              url: 'http://127.0.0.1:1/sse',
              ideName: 'x',
            },
          },
          {
            'proxy-inline': {
              type: 'claudeai-proxy',
              url: 'http://127.0.0.1:1/mcp',
              id: 'x',
            },
          },
        ],
      } as never,
      [],
      (names, reason) => {
        blocked.push([names, reason])
      },
    )

    if (scenario === 'enterprise') {
      expect(connected).toEqual([])
      expect(blocked).toHaveLength(1)
      expect(blocked[0]![1]).toBe('enterprise MCP config')
      return
    }
    expect(connected.map(c => c.name)).toEqual(['approved', 'ok-inline'])
    expect(blocked).toEqual([
      [['pending'], 'not configured'],
      [['denied-inline'], 'managed settings MCP policy'],
      [['disabled-inline'], 'disabled'],
    ])
  })
}
