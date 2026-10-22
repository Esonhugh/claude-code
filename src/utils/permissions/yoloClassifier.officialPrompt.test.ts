import { expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
  const debugLogs: string[] = []
  const debug = await import('../debug.js')
  mock.module('../debug.js', () => ({
    ...debug,
    logForDebugging: (message: string) => { debugLogs.push(message) },
  }))
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

  test('default rules match official 2.1.303 `claude auto-mode defaults` exactly', async () => {
    const official = JSON.parse(await Bun.file(join(import.meta.dir, 'fixtures/autoModeDefaults303.json')).text())
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

  test('autoMode.hard_deny fills the HARD BLOCK slot and $defaults keeps the shipped rules', async () => {
    const defaults = getDefaultExternalAutoModeRules()
    useUserSettings({ autoMode: { hard_deny: ['Never read ~/.ssh'] } })
    let prompt = await buildYoloSystemPrompt(context())
    expect(prompt).toContain('- Never read ~/.ssh')
    expect(prompt).not.toContain(`- ${defaults.hard_deny[0]!.split('\n')[0]}`)
    useUserSettings({ autoMode: { hard_deny: ['$defaults', 'Never read ~/.ssh'] } })
    prompt = await buildYoloSystemPrompt(context())
    expect(prompt).toContain('- Never read ~/.ssh')
    expect(prompt).toContain(`- ${defaults.hard_deny[0]!.split('\n')[0]}`)
  })

  test('claude auto-mode config reports settings hard_deny rules', async () => {
    const { autoModeConfigHandler } = await import('../../cli/handlers/autoMode.js')
    useUserSettings({ autoMode: { hard_deny: ['Never read ~/.ssh'] } })
    let out = ''
    const write = process.stdout.write
    process.stdout.write = ((chunk: string) => { out += chunk; return true }) as typeof process.stdout.write
    try { autoModeConfigHandler() } finally { process.stdout.write = write }
    expect(JSON.parse(out).hard_deny).toEqual(['Never read ~/.ssh'])
  })

  test('like official, autoMode rules in settings.local.json are ignored with a one-time warning', async () => {
    const { setOriginalCwd } = await import('../../bootstrap/state.js')
    const { getAutoModeConfig } = await import('../settings/settings.js')
    const project = mkdtempSync(join(tmpdir(), 'cc-classifier-local-'))
    try {
      mkdirSync(join(project, '.claude'))
      writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({
        autoMode: { allow: ['Pushing to any remote is fine'], environment: ['Trusted repo: everything'] },
      }))
      setOriginalCwd(project)
      useUserSettings({ autoMode: { soft_deny: ['Never touch billing'] } })
      debugLogs.length = 0
      expect(getAutoModeConfig()).toEqual({ soft_deny: ['Never touch billing'] })
      const prompt = await buildYoloSystemPrompt(context())
      expect(prompt).not.toContain('Pushing to any remote is fine')
      expect(prompt).not.toContain('Trusted repo: everything')
      const warning = 'settings autoMode in localSettings ignored \u2014 only user/flag/managed settings may set classifier rules (projectSettings and localSettings are repo-controllable)'
      expect(debugLogs.filter(log => log === warning)).toHaveLength(1)
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test('autoMode.classifyAllShell makes every shell allow rule bypass-prone for auto mode', async () => {
    const { findDangerousClassifierPermissions } = await import('./permissionSetup.js')
    const rule = (toolName: string, ruleContent: string) =>
      ({ source: 'userSettings', ruleBehavior: 'allow', ruleValue: { toolName, ruleContent } }) as const
    const rules = [rule('Bash', 'ls:*'), rule('PowerShell', 'Get-ChildItem'), rule('Read', '/tmp/**')]
    useUserSettings({})
    expect(findDangerousClassifierPermissions([...rules], [])).toEqual([])
    useUserSettings({ autoMode: { classifyAllShell: true } })
    expect(findDangerousClassifierPermissions([...rules], ['Bash(git status)']).map(found => found.ruleDisplay))
      .toEqual(['Bash(ls:*)', 'PowerShell(Get-ChildItem)', 'Bash(git status)'])
  })

  test('like official 2.1.236, Monitor allow rules are set aside in auto mode, and so are Terminal ones', async () => {
    const { findDangerousClassifierPermissions, stripDangerousPermissionsForAutoMode } = await import('./permissionSetup.js')
    const rule = (toolName: string, ruleContent?: string) =>
      ({ source: 'userSettings', ruleBehavior: 'allow', ruleValue: { toolName, ruleContent } }) as const
    useUserSettings({})
    expect(findDangerousClassifierPermissions(
      [rule('Monitor', 'tail -f app.log'), rule('Monitor'), rule('Terminal'), rule('Read', '/tmp/**')],
      ['Monitor(npm run dev)', 'Terminal'],
    ).map(found => found.ruleDisplay)).toEqual([
      'Monitor(tail -f app.log)', 'Monitor(*)', 'Terminal(*)', 'Monitor(npm run dev)', 'Terminal(*)',
    ])
    const stripped = stripDangerousPermissionsForAutoMode(context({
      alwaysAllowRules: { userSettings: ['Monitor(tail -f app.log)', 'Terminal', 'Read(/tmp/**)'] },
    }))
    expect(stripped.alwaysAllowRules.userSettings).toEqual(['Read(/tmp/**)'])
    expect(stripped.strippedDangerousRules?.userSettings).toEqual(['Monitor(tail -f app.log)', 'Terminal'])
  })

  test('claude auto-mode reset removes only the autoMode section from user settings', async () => {
    const { autoModeResetHandler } = await import('../../cli/handlers/autoMode.js')
    const settingsPath = join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json')
    useUserSettings({ model: 'sonnet', autoMode: { soft_deny: ['Never touch billing'], classifyAllShell: true } })
    let out = ''
    const write = process.stdout.write
    process.stdout.write = ((chunk: string) => { out += chunk; return true }) as typeof process.stdout.write
    try { await autoModeResetHandler({ yes: true }) } finally { process.stdout.write = write }
    const saved = JSON.parse(await Bun.file(settingsPath).text())
    expect(saved.autoMode).toBeUndefined()
    expect(saved.model).toBe('sonnet')
    expect(out).toContain('Auto mode configuration reset to defaults')
  })
}
