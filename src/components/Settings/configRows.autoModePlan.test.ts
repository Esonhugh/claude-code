import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppState } from '../../state/AppStateStore.js'

// The row is compiled behind TRANSCRIPT_CLASSIFIER; run the assertions in a child with it enabled.
const childFlag = 'CLAUDE_CODE_CONFIG_ROWS_AUTO_MODE_PLAN_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('useAutoModeDuringPlan row (TRANSCRIPT_CLASSIFIER child)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'config-rows-auto-mode-plan-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(
      ([key]) => !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_USE_)/.test(key),
    ))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--feature=TRANSCRIPT_CLASSIFIER', import.meta.path], {
        cwd: join(import.meta.dir, '../../..'),
        env: { ...env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home },
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
  process.chdir(home)
  process.env.NODE_ENV = 'test'
  // The Dynamic workflows rows read the subscription; an env OAuth token has none (default on).
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-only-not-a-real-token'
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  Object.defineProperty(globalThis, 'MACRO', { configurable: true, value: { VERSION: 'test' } })
  const managedPath = await import('../../utils/settings/managedPath.js')
  managedPath.getManagedFilePath.cache = new Map([[undefined, home]])
  managedPath.getManagedSettingsDropInDir.cache = new Map()
  const bootstrap = await import('../../bootstrap/state.js')
  bootstrap.setOriginalCwd(home)
  const { resetSettingsCache, setCachedSettingsForSource } = await import('../../utils/settings/settingsCache.js')
  const { updateSettingsForSource } = await import('../../utils/settings/settings.js')
  const { getConfigRows } = await import('./configRows.js')
  const context = {
    getAppState: () => ({ settings: {}, verbose: false, thinkingEnabled: true, mainLoopModel: null } as AppState),
    setAppState: () => {},
  }
  const row = () => getConfigRows(context).find(row => row.key === 'useAutoModeDuringPlan')!

  test('project settings cannot turn plan auto mode off', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ useAutoModeDuringPlan: false }))
    resetSettingsCache()
    expect(row()).toMatchObject({ label: 'Use auto mode during plan', value: true, isLocked: false })
  })

  test('any trusted source set to false turns plan auto mode off, whatever a later source says', () => {
    updateSettingsForSource('userSettings', { useAutoModeDuringPlan: false })
    updateSettingsForSource('localSettings', { useAutoModeDuringPlan: true })
    expect(row()).toMatchObject({ value: false, isLocked: false })
    updateSettingsForSource('userSettings', { useAutoModeDuringPlan: undefined })
    expect(row()).toMatchObject({ value: true, isLocked: false })
  })

  test('flag or policy settings forcing false lock the row', () => {
    setCachedSettingsForSource('flagSettings', { useAutoModeDuringPlan: false })
    expect(row()).toMatchObject({ value: false, isLocked: true })
    resetSettingsCache()
    expect(row()).toMatchObject({ value: true, isLocked: false })
    writeFileSync(join(home, 'managed-settings.json'), JSON.stringify({ useAutoModeDuringPlan: false }))
    resetSettingsCache()
    expect(row()).toMatchObject({ value: false, isLocked: true })
    expect(() => row().set!(true)).toThrow('locked')
  })
}
