import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolPermissionContext } from '../../Tool.js'

// The classifier prompts are compiled behind TRANSCRIPT_CLASSIFIER; assert in a child with it enabled.
const childFlag = 'CLAUDE_CODE_OFFICIAL_CLASSIFIER_PROMPT_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('auto mode classifier prompt (TRANSCRIPT_CLASSIFIER child)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-classifier-prompt-'))
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
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  const { resetSettingsCache } = await import('../settings/settingsCache.js')
  const { writeFileSync } = await import('node:fs')
  // autoMode rules are read from the per-source settings files, not the session cache.
  const useUserSettings = (settings: object) => {
    writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify(settings))
    resetSettingsCache()
  }
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { buildYoloSystemPrompt, getDefaultExternalAutoModeRules } = await import('./yoloClassifier.js')

  const context = (permission: Partial<ToolPermissionContext> = {}) =>
    ({ ...getDefaultAppState().toolPermissionContext, ...permission }) as ToolPermissionContext
  // The official template itself mentions `${VAR}` as a shell example, so only slot markers are leftovers.
  const leftovers = ['_to_replace>', '<permissions_template>', '<settings_deny_rules>', '<cross_session_messages_rule>']

  test('the classifier uses the official 2.1.292 policy with every slot filled', async () => {
    useUserSettings({})
    const prompt = await buildYoloSystemPrompt(context())
    expect(prompt.startsWith('You are a security monitor for autonomous AI coding agents.')).toBe(true)
    expect(prompt).toContain('<cc_automode_permissions>')
    expect(prompt).toContain('<block>yes</block>')
    for (const leftover of leftovers) expect(prompt).not.toContain(leftover)
    const defaults = getDefaultExternalAutoModeRules()
    expect(defaults.allow.length).toBeGreaterThan(10)
    expect(defaults.soft_deny.length).toBeGreaterThan(50)
    expect(defaults.environment.length).toBeGreaterThan(10)
    expect(prompt).toContain(`- ${defaults.soft_deny[0]!.split('\n')[0]}`)
  })

  test('default rules match official 2.1.292 `claude auto-mode defaults` exactly', async () => {
    const official = JSON.parse(await Bun.file(join(import.meta.dir, 'fixtures/autoModeDefaults292.json')).text())
    expect(getDefaultExternalAutoModeRules()).toEqual(official)
  })

  test('settings rules replace the matching defaults and deny rules are named', async () => {
    useUserSettings({ autoMode: { soft_deny: ['Never touch the billing database'] } })
    const prompt = await buildYoloSystemPrompt(context({ alwaysDenyRules: { userSettings: ['Edit(/etc/**)'] } }))
    const defaults = getDefaultExternalAutoModeRules()
    expect(prompt).toContain('- Never touch the billing database')
    expect(prompt).not.toContain(`- ${defaults.soft_deny[0]!.split('\n')[0]}`)
    expect(prompt).toContain('User Deny Rules')
    expect(prompt).toContain('`Edit(/etc/**)`')
    for (const leftover of leftovers) expect(prompt).not.toContain(leftover)
  })
}
