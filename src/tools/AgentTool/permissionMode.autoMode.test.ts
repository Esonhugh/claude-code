import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Auto mode is compiled behind TRANSCRIPT_CLASSIFIER; run the assertions in a child with it enabled.
const childFlag = 'CLAUDE_CODE_AGENT_AUTO_MODE_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('subagent permissionMode auto (TRANSCRIPT_CLASSIFIER child)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-agent-auto-mode-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(
      ([key]) => !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_USE_)/.test(key),
    ))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--feature=TRANSCRIPT_CLASSIFIER', import.meta.path], {
        cwd: join(import.meta.dir, '../../..'),
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
  }, 120_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  const { setSessionSettingsCache } = await import('../../utils/settings/settingsCache.js')
  const { setAutoModeCircuitBroken } = await import('../../utils/permissions/autoModeState.js')
  const { resolveDeclaredAgentPermissionMode, withAgentPermissionMode } = await import('./permissionMode.js')
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')

  type SettingsJson = import('../../utils/settings/types.js').SettingsJson
  const withSettings = (settings: SettingsJson) => setSessionSettingsCache({ settings, errors: [] })

  test('a definition declaring auto enters auto mode while it is available', () => {
    withSettings({})
    expect(resolveDeclaredAgentPermissionMode('default', 'auto')).toBe('auto')
  })

  test('like official 2.1.292, a definition declaring auto keeps the parent mode while auto mode is unavailable', () => {
    withSettings({ permissions: { disableAutoMode: 'disable' } })
    expect(resolveDeclaredAgentPermissionMode('default', 'auto')).toBe('default')
    expect(resolveDeclaredAgentPermissionMode('plan', 'auto')).toBe('plan')

    withSettings({})
    setAutoModeCircuitBroken(true)
    try {
      expect(resolveDeclaredAgentPermissionMode('default', 'auto')).toBe('default')
    } finally {
      setAutoModeCircuitBroken(false)
    }

    process.env.ANTHROPIC_MODEL = 'claude-3-5-haiku-20241022'
    try {
      expect(resolveDeclaredAgentPermissionMode('dontAsk', 'auto')).toBe('dontAsk')
    } finally {
      delete process.env.ANTHROPIC_MODEL
    }
    expect(resolveDeclaredAgentPermissionMode('default', 'auto')).toBe('auto')
  })

  test('an agent in auto under a default parent drops allow rules that skip the classifier', () => {
    withSettings({})
    const parent = {
      ...getDefaultAppState().toolPermissionContext,
      mode: 'default' as const,
      alwaysAllowRules: { session: ['Bash(python3:*)', 'Bash(ls:*)'] },
    }
    const agent = withAgentPermissionMode(parent, 'auto')
    expect(agent.mode).toBe('auto')
    expect(agent.alwaysAllowRules.session).toEqual(['Bash(ls:*)'])
    expect(agent.strippedDangerousRules?.session).toEqual(['Bash(python3:*)'])
    expect(parent.alwaysAllowRules.session).toEqual(['Bash(python3:*)', 'Bash(ls:*)'])
    expect(withAgentPermissionMode(parent, 'acceptEdits').alwaysAllowRules.session).toEqual(['Bash(python3:*)', 'Bash(ls:*)'])
    expect(withAgentPermissionMode(parent, 'default')).toBe(parent)
  })
}
