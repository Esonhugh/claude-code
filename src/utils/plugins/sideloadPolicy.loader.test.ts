import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.SIDELOAD_POLICY_LOADER_CHILD !== '1') {
  test('late administrator policy blocks inline discovery in an isolated loader', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'sideload-loader-')))
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home,
        CLAUDE_CONFIG_DIR: join(home, 'config'), ANTHROPIC_API_KEY: 'test-only-not-a-real-key',
        SIDELOAD_POLICY_LOADER_CHILD: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    console.log(stdout, stderr)
    expect(code).toBe(0)
    expect(stderr).toMatch(/(?:^|\n) 2 pass(?:\n|$)/)
  })
} else {
  ;(globalThis as typeof globalThis & { MACRO: { VERSION: string } }).MACRO = { VERSION: 'test' }
  const state = await import('../../bootstrap/state.js')
  const settings = await import('../settings/settingsCache.js')
  const loader = await import('./pluginLoader.js')
  const home = process.env.HOME!
  state.setOriginalCwd(home)
  state.setAllowedSettingSources(['flagSettings'])
  const plugin = join(home, 'inline')
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
  writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'policy-owned', version: '1.0.0' }))
  state.setInlinePlugins([plugin])
  for (const restricted of [false, true]) {
    test(`inline loader observes current administrator policy: ${restricted}`, async () => {
      settings.resetSettingsCache()
      settings.setCachedSettingsForSource('policySettings', { disableSideloadFlags: restricted })
      settings.setSessionSettingsCache({ settings: {}, errors: [] })
      const result = await loader.loadPluginsForContractValidation()
      expect(result.errors).toEqual([])
      expect(result.complete).toBe(true)
      expect(result.enabled.some(item => item.name === 'policy-owned')).toBe(!restricted)
      expect(state.getInlinePlugins()).toEqual([plugin])
    })
  }
}
