import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childFlag = 'CLAUDE_CODE_MCP_PROJECT_APPROVAL_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('project MCP approval in untrusted workspaces (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-mcp-approval-home-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE|CLAUDE_CODE_ENTRYPOINT)/.test(key)))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: join(import.meta.dir, '../../..'),
        env: { ...env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home,
          DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 120_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' } as MacroGlobals
  const { setCwdState, setIsInteractive, setOriginalCwd, setSessionTrustAccepted } = await import('../../bootstrap/state.js')
  const { resetTrustDialogAcceptedCacheForTesting } = await import('../../utils/config.js')
  const { resetSettingsCache } = await import('../../utils/settings/settingsCache.js')
  const { getProjectMcpServerStatus } = await import('./utils.js')

  function project(settings: { project?: object; local?: object; trackLocal?: boolean }) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-mcp-approval-project-')))
    mkdirSync(join(dir, '.claude'))
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { srv: { command: 'true' } } }))
    if (settings.project) writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify(settings.project))
    if (settings.local) writeFileSync(join(dir, '.claude/settings.local.json'), JSON.stringify(settings.local))
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'ignore', stderr: 'pipe' })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    }
    git('init', '-q')
    if (settings.trackLocal) git('add', '-f', '.claude/settings.local.json')
    setOriginalCwd(dir)
    setCwdState(dir)
    process.chdir(dir)
    resetSettingsCache()
    return dir
  }

  setIsInteractive(true)

  test('an untrusted workspace cannot approve its own servers from .claude/settings.json', () => {
    project({ project: { enableAllProjectMcpServers: true } })
    expect(getProjectMcpServerStatus('srv')).toBe('pending')
    project({ project: { enabledMcpjsonServers: ['srv'] } })
    expect(getProjectMcpServerStatus('srv')).toBe('pending')
  })

  test('an untracked settings.local.json still approves servers before trust', () => {
    project({ local: { enabledMcpjsonServers: ['srv'] } })
    expect(getProjectMcpServerStatus('srv')).toBe('approved')
  })

  test('a git-tracked settings.local.json is repo content and cannot approve servers', () => {
    project({ local: { enableAllProjectMcpServers: true }, trackLocal: true })
    expect(getProjectMcpServerStatus('srv')).toBe('pending')
  })

  test('a trusted workspace keeps project approvals', () => {
    project({ project: { enableAllProjectMcpServers: true }, local: { enabledMcpjsonServers: ['other'] }, trackLocal: true })
    setSessionTrustAccepted(true)
    try {
      expect(getProjectMcpServerStatus('srv')).toBe('approved')
    } finally {
      setSessionTrustAccepted(false)
      resetTrustDialogAcceptedCacheForTesting()
    }
  })

  test('disabledMcpjsonServers still rejects before trust', () => {
    project({ project: { disabledMcpjsonServers: ['srv'] } })
    expect(getProjectMcpServerStatus('srv')).toBe('rejected')
  })
}
