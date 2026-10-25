import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childKey = 'AUTO_MODE_TAB_TEST_CHILD'

if (!process.env[childKey]) {
  test('auto mode tab rules (isolated settings)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'auto-mode-tab-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--feature=TRANSCRIPT_CLASSIFIER', import.meta.path], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          CLAUDE_CONFIG_DIR: join(root, 'config'),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          [childKey]: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

  test('lists, adds and removes auto mode rules in user settings only', async () => {
    const { setOriginalCwd } = await import('../../../bootstrap/state.js')
    setOriginalCwd(process.cwd())
    const {
      ADD_AUTO_MODE_RULE_VALUE,
      addAutoModeRule,
      getAutoModeRuleEntries,
      getAutoModeRuleOptions,
      removeAutoModeRule,
    } = await import('./AutoModeTab.js')
    const { getSettingsFilePathForSource } = await import('../../../utils/settings/settings.js')
    const { resetSettingsCache } = await import('../../../utils/settings/settingsCache.js')

    // A repository's local settings cannot add classifier rules.
    mkdirSync(join(process.cwd(), '.claude'), { recursive: true })
    writeFileSync(
      join(process.cwd(), '.claude', 'settings.local.json'),
      JSON.stringify({ autoMode: { allow: ['Repo: anything goes'] } }),
    )
    resetSettingsCache()

    const builtinSoftDeny = getAutoModeRuleEntries().filter(
      e => e.section === 'soft_deny' && e.source === 'builtin',
    )
    expect(builtinSoftDeny.length).toBeGreaterThan(0)
    expect(getAutoModeRuleEntries().some(e => e.rule === 'Repo: anything goes')).toBe(false)

    const rule = 'Deploys: never run zebractl apply against prod'
    expect(addAutoModeRule('soft_deny', rule).error).toBeNull()
    const userFile = getSettingsFilePathForSource('userSettings')!
    expect(JSON.parse(readFileSync(userFile, 'utf8')).autoMode.soft_deny).toEqual([
      '$defaults',
      rule,
    ])
    let entries = getAutoModeRuleEntries()
    expect(entries).toContainEqual({ section: 'soft_deny', rule, source: 'userSettings' })
    // The built-ins keep applying next to the new rule.
    expect(entries.filter(e => e.section === 'soft_deny' && e.source === 'builtin').length).toBe(
      builtinSoftDeny.length,
    )

    expect(addAutoModeRule('soft_deny', 'Second rule').error).toBeNull()
    expect(JSON.parse(readFileSync(userFile, 'utf8')).autoMode.soft_deny).toEqual([
      '$defaults',
      rule,
      'Second rule',
    ])

    const options = getAutoModeRuleOptions(entries)
    expect(options[0]?.value).toBe(ADD_AUTO_MODE_RULE_VALUE)
    const filtered = getAutoModeRuleOptions(entries, 'zebractl')
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.description).toBe('Soft deny · From user settings')

    expect(removeAutoModeRule('soft_deny', rule).error).toBeNull()
    expect(removeAutoModeRule('soft_deny', 'Second rule').error).toBeNull()
    expect(JSON.parse(readFileSync(userFile, 'utf8')).autoMode?.soft_deny).toBeUndefined()
    entries = getAutoModeRuleEntries()
    expect(entries.some(e => e.source === 'userSettings')).toBe(false)
  })
}
