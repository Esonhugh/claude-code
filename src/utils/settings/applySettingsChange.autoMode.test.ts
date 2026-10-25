import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppState } from '../../state/AppStateStore.js'
import type { ToolPermissionContext } from '../../Tool.js'

// Auto mode stripping is compiled behind TRANSCRIPT_CLASSIFIER; run the assertions in a child with it enabled.
const childFlag = 'CLAUDE_CODE_APPLY_SETTINGS_AUTO_MODE_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('settings change while auto mode is on (TRANSCRIPT_CLASSIFIER child)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-apply-settings-auto-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(
      ([key]) => !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_USE_)/.test(key),
    ))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--feature=TRANSCRIPT_CLASSIFIER', '--timeout', '30000', import.meta.path], {
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
  const home = process.env.HOME!
  const project = join(home, 'project')
  mkdirSync(join(project, '.claude'), { recursive: true })
  process.chdir(project)
  process.env.NODE_ENV = 'test'
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  const managedPath = await import('./managedPath.js')
  managedPath.getManagedFilePath.cache = new Map([[undefined, join(home, 'managed')]])
  managedPath.getManagedSettingsDropInDir.cache = new Map()
  const bootstrap = await import('../../bootstrap/state.js')
  bootstrap.setOriginalCwd(project)
  bootstrap.setCwdState(project)
  const { resetSettingsCache } = await import('./settingsCache.js')
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { applySettingsChange } = await import('./applySettingsChange.js')
  const { restoreDangerousPermissions } = await import('../permissions/permissionSetup.js')
  const { setAutoModeActive } = await import('../permissions/autoModeState.js')

  function writeLocalAllow(allow: string[]): void {
    writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow } }))
    resetSettingsCache()
  }

  function applyChange(permission: Partial<ToolPermissionContext>): ToolPermissionContext {
    const initial = getDefaultAppState()
    let state: AppState = {
      ...initial,
      toolPermissionContext: { ...initial.toolPermissionContext, ...permission },
    }
    applySettingsChange('localSettings', update => { state = update(state) })
    return state.toolPermissionContext
  }

  test('a settings edit in auto mode does not bring a stripped dangerous rule back', () => {
    setAutoModeActive(true)
    writeLocalAllow(['Bash(python3:*)', 'Bash(node:*)'])
    const next = applyChange({
      mode: 'auto',
      alwaysAllowRules: { localSettings: [] },
      strippedDangerousRules: { localSettings: ['Bash(python3:*)'] },
    })
    expect(next.alwaysAllowRules.localSettings).toEqual([])
    expect(next.strippedDangerousRules).toEqual({ localSettings: ['Bash(python3:*)', 'Bash(node:*)'] })
  })

  test('a settings edit in plan with auto active re-strips too', () => {
    setAutoModeActive(true)
    writeLocalAllow(['Bash(python3:*)'])
    const next = applyChange({
      mode: 'plan',
      prePlanMode: 'auto',
      alwaysAllowRules: { localSettings: [] },
      strippedDangerousRules: { localSettings: ['Bash(python3:*)'] },
    })
    expect(next.alwaysAllowRules.localSettings).toEqual([])
    expect(next.strippedDangerousRules).toEqual({ localSettings: ['Bash(python3:*)'] })
  })

  test('a rule deleted from disk while in auto mode is not restored on exit', () => {
    setAutoModeActive(true)
    writeLocalAllow(['Bash(node:*)'])
    const next = applyChange({
      mode: 'auto',
      alwaysAllowRules: { localSettings: [], cliArg: [] },
      strippedDangerousRules: { localSettings: ['Bash(python3:*)'], cliArg: ['Bash(ruby:*)'] },
    })
    expect(next.strippedDangerousRules).toEqual({ cliArg: ['Bash(ruby:*)'], localSettings: ['Bash(node:*)'] })
    const restored = restoreDangerousPermissions(next)
    expect(restored.alwaysAllowRules.localSettings).toEqual(['Bash(node:*)'])
    expect(restored.alwaysAllowRules.cliArg).toEqual(['Bash(ruby:*)'])
  })

  test('outside auto mode a settings edit leaves the rules alone', () => {
    setAutoModeActive(false)
    writeLocalAllow(['Bash(python3:*)'])
    const next = applyChange({ mode: 'default', alwaysAllowRules: { localSettings: [] } })
    expect(next.alwaysAllowRules.localSettings).toEqual(['Bash(python3:*)'])
    expect(next.strippedDangerousRules).toBeUndefined()
  })
}
