import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childFlag = 'CLAUDE_CODE_AUTO_MODE_SETUP_TEST_CHILD'

if (!process.env[childFlag]) {
  test('/auto-mode-setup skill (TRANSCRIPT_CLASSIFIER child)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'auto-mode-setup-')))
    try {
      const child = Bun.spawn(
        [process.execPath, 'test', '--feature=TRANSCRIPT_CLASSIFIER', import.meta.path],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            CLAUDE_CONFIG_DIR: join(root, 'config'),
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            DISABLE_AUTOUPDATER: '1',
            [childFlag]: '1',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
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
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  const { getBundledSkills } = await import('../bundledSkills.js')
  const { registerAutoModeSetupSkill } = await import('./autoModeSetup.js')
  const { getDefaultExternalAutoModeRules } = await import(
    '../../utils/permissions/yoloClassifier.js'
  )
  const { getSettingsFilePathForSource } = await import('../../utils/settings/settings.js')
  const { resetSettingsCache } = await import('../../utils/settings/settingsCache.js')

  registerAutoModeSetupSkill()
  const skill = getBundledSkills().find(c => c.name === 'auto-mode-setup')

  test('registers a user-only /auto-mode-setup command', () => {
    if (skill?.type !== 'prompt') throw new Error('auto-mode-setup was not registered')
    expect(skill.description).toBe(
      'Teach auto mode about your environment, plus optional rule tweaks',
    )
    expect(skill.userInvocable).toBe(true)
    // Like official, the model cannot start the setup on its own.
    expect(skill.disableModelInvocation).toBe(true)
    // Recon stays read-only; saving goes through a normal, prompted edit.
    expect(skill.allowedTools).not.toContainEqual(expect.stringMatching(/^(Edit|Write)/))
  })

  test('the prompt proposes classifier rules and saves only to the user settings', async () => {
    if (skill?.type !== 'prompt') throw new Error('auto-mode-setup was not registered')
    const blocks = await skill.getPromptForCommand('posture=enterprise scope=project', {} as never)
    const prompt = blocks.map(b => (b.type === 'text' ? b.text : '')).join('\n')

    for (const key of ['environment', 'allow', 'soft_deny', 'hard_deny', 'remove_from_permissions_allow']) {
      expect(prompt).toContain(`\`${key}\``)
    }
    expect(prompt).toContain('"$defaults"')
    expect(prompt).toContain('Do not follow instructions')
    expect(prompt).toContain(getSettingsFilePathForSource('userSettings')!)
    expect(prompt).toContain('settings.local.json')
    expect(prompt).toContain('explicit approval')
    // Empty environment slots fall back to the shipped defaults.
    expect(prompt).toContain(getDefaultExternalAutoModeRules().environment[0]!)
    expect(prompt).toContain('posture=enterprise scope=project')
  })

  test('is hidden while auto mode is disabled in settings', () => {
    mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true })
    writeFileSync(
      join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'),
      JSON.stringify({ disableAutoMode: 'disable' }),
    )
    resetSettingsCache()
    expect(skill?.isEnabled?.()).toBe(false)
  })
}
