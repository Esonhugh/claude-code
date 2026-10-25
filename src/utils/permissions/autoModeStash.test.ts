import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolPermissionContext } from '../../Tool.js'

// Auto mode stripping is compiled behind TRANSCRIPT_CLASSIFIER; run the assertions in a child with it enabled.
const childFlag = 'CLAUDE_CODE_AUTO_MODE_STASH_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('auto mode dangerous-rule stash (TRANSCRIPT_CLASSIFIER child)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-auto-mode-stash-'))
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
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  const { setSessionSettingsCache } = await import('../settings/settingsCache.js')
  setSessionSettingsCache({ settings: {}, errors: [] })
  const { getEmptyToolPermissionContext } = await import('../../Tool.js')
  const { restoreDangerousPermissions, stripDangerousPermissionsForAutoMode } =
    await import('./permissionSetup.js')

  const withAllow = (
    alwaysAllowRules: ToolPermissionContext['alwaysAllowRules'],
    strippedDangerousRules?: ToolPermissionContext['strippedDangerousRules'],
  ): ToolPermissionContext => ({
    ...getEmptyToolPermissionContext(),
    alwaysAllowRules,
    strippedDangerousRules,
  })

  test('auto mode strips dangerous rules from --settings, managed policy and command sources too', () => {
    const stripped = stripDangerousPermissionsForAutoMode(withAllow({
      flagSettings: ['Bash(python3:*)', 'Read'],
      policySettings: ['Bash(node:*)'],
      command: ['Bash(ruby:*)'],
      localSettings: ['Bash(perl:*)'],
    }))
    expect(stripped.alwaysAllowRules).toMatchObject({
      flagSettings: ['Read'],
      policySettings: [],
      command: [],
      localSettings: [],
    })
    expect(stripped.strippedDangerousRules).toEqual({
      flagSettings: ['Bash(python3:*)'],
      policySettings: ['Bash(node:*)'],
      command: ['Bash(ruby:*)'],
      localSettings: ['Bash(perl:*)'],
    })

    const restored = restoreDangerousPermissions(stripped)
    expect(restored.alwaysAllowRules).toMatchObject({
      flagSettings: ['Read', 'Bash(python3:*)'],
      policySettings: ['Bash(node:*)'],
      command: ['Bash(ruby:*)'],
      localSettings: ['Bash(perl:*)'],
    })
    expect(restored.strippedDangerousRules).toBeUndefined()
  })

  test('stripping again keeps what an earlier strip stashed', () => {
    const stripped = stripDangerousPermissionsForAutoMode(withAllow(
      { localSettings: ['Bash(node:*)', 'Bash(python3:*)'] },
      { cliArg: ['Bash(python3:*)'], localSettings: ['Bash(python3:*)'] },
    ))
    expect(stripped.strippedDangerousRules).toEqual({
      cliArg: ['Bash(python3:*)'],
      localSettings: ['Bash(python3:*)', 'Bash(node:*)'],
    })
  })

  test('restoring skips rules that are already back in place', () => {
    const restored = restoreDangerousPermissions(withAllow(
      { localSettings: ['Bash(python3:*)'] },
      { localSettings: ['Bash(python3:*)', 'Bash(node:*)'] },
    ))
    expect(restored.alwaysAllowRules.localSettings).toEqual(['Bash(python3:*)', 'Bash(node:*)'])
  })
}
