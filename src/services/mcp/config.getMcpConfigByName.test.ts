import { describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childEnv = 'CLAUDE_CODE_MCP_BY_NAME_TEST_CHILD'
const stdio = (arg: string) => ({ command: 'echo', args: [arg] })

if (process.env[childEnv]) {
  await runChild(process.env[childEnv])
} else {
  // Each scenario runs in a fresh process: settings, config and the
  // enterprise-config check are cached per process.
  describe('getMcpConfigByName admission', () => {
    for (const scenario of ['project', 'enterprise']) {
      test(scenario, async () => {
        const root = await realpath(
          await mkdtemp(join(tmpdir(), 'mcp-by-name-')),
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
                rejected: stdio('rejected'),
                approved: stdio('approved'),
                denied: stdio('denied'),
                shadowed: stdio('project'),
              },
            }),
          )
          await writeFile(
            join(project, '.claude', 'settings.local.json'),
            JSON.stringify({
              enabledMcpjsonServers: ['approved', 'denied'],
              disabledMcpjsonServers: ['rejected'],
            }),
          )
          await writeFile(
            join(config, 'settings.json'),
            JSON.stringify({
              deniedMcpServers: [
                { serverName: 'denied' },
                { serverName: 'denied-user' },
              ],
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
                MCP_BY_NAME_ROOT: root,
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
  const root = process.env.MCP_BY_NAME_ROOT!
  const managedPath = await import('../../utils/settings/managedPath.js')
  mock.module('../../utils/settings/managedPath.js', () => ({
    ...managedPath,
    getManagedFilePath: () => join(root, 'managed'),
  }))
  const state = await import('../../bootstrap/state.js')
  state.setOriginalCwd(process.cwd())
  state.setProjectRoot(process.cwd())
  state.setCwdState(process.cwd())
  // Interactive session: .mcp.json servers are not auto-approved.
  state.setIsInteractive(true)
  const { enableConfigs, saveGlobalConfig } = await import(
    '../../utils/config.js'
  )
  enableConfigs()
  // Global config is in-memory under NODE_ENV=test.
  saveGlobalConfig(current => ({
    ...current,
    mcpServers: {
      shadowed: stdio('user'),
      'denied-user': stdio('denied-user'),
    },
  }))
  const { getMcpConfigByName } = await import('./config.js')

  test(`${scenario}: by-name lookup applies admission rules`, () => {
    if (scenario === 'enterprise') {
      expect(getMcpConfigByName('corp')?.scope).toBe('enterprise')
      // Enterprise config has exclusive control, like getClaudeCodeMcpConfigs.
      expect(getMcpConfigByName('shadowed')).toBeNull()
      expect(getMcpConfigByName('approved')).toBeNull()
      return
    }
    expect(getMcpConfigByName('pending')).toBeNull()
    expect(getMcpConfigByName('rejected')).toBeNull()
    expect(getMcpConfigByName('approved')?.scope).toBe('project')
    expect(getMcpConfigByName('denied')).toBeNull()
    expect(getMcpConfigByName('denied-user')).toBeNull()
    // An unapproved .mcp.json entry must not shadow the user server.
    const shadowed = getMcpConfigByName('shadowed')
    expect(shadowed?.scope).toBe('user')

    const withPending = { includeUnapprovedProjectServers: true }
    expect(getMcpConfigByName('pending', withPending)?.scope).toBe('project')
    expect(getMcpConfigByName('rejected', withPending)?.scope).toBe('project')
    expect(getMcpConfigByName('denied', withPending)).toBeNull()
  })
}
