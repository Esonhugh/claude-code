import { expect, mock, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Registered hooks and the module mock are process-wide, so the case runs in
// a fresh child.
if (!process.env.PLUGIN_HOOKS_DUPLICATE_NAME_TEST_CHILD) {
  test('same-named plugins from two marketplaces register hooks once', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-hooks-dup-')))
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: home,
        CLAUDE_CONFIG_DIR: join(home, 'config'),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        PLUGIN_HOOKS_DUPLICATE_NAME_TEST_CHILD: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    console.log(stdout, stderr)
    expect(stderr).toMatch(/(?:^|\n) 2 pass(?:\n|$)/)
    expect(code).toBe(0)
  }, 30000)
} else {
  ;(globalThis as any).MACRO = { VERSION: 'test' }
  const plugin = (name: string, marketplace: string, hooks = true) => ({
    name,
    source: `${name}@${marketplace}`,
    path: join(process.env.HOME!, marketplace, name),
    repository: `${name}@${marketplace}`,
    manifest: { name },
    enabled: true,
    ...(hooks && {
      hooksConfig: {
        SessionStart: [
          { hooks: [{ type: 'command', command: `echo ${name}` }] },
        ],
      },
    }),
  })
  const pluginLoader = await import('./pluginLoader.js')
  mock.module('./pluginLoader.js', () => ({
    ...pluginLoader,
    loadAllPluginsCacheOnly: async () => ({
      enabled: [
        plugin('demo', 'mkt5'),
        plugin('demo', 'mkt2'),
        plugin('other', 'mkt2'),
        plugin('plain', 'mkt5', false),
        plugin('plain', 'mkt2'),
        plugin('org', 'mkt5'),
        plugin('org', 'mkt2'),
      ],
      disabled: [],
      errors: [],
    }),
  }))
  const policyEnabled: Record<string, boolean> = { 'org@mkt2': true }
  const settings = await import('../settings/settings.js')
  mock.module('../settings/settings.js', () => ({
    ...settings,
    getSettingsForSource: (source: string) =>
      source === 'policySettings' ? { enabledPlugins: policyEnabled } : null,
  }))
  const state = await import('../../bootstrap/state.js')
  const { getPluginAffectingSettingsSnapshot, loadPluginHooks } = await import(
    './loadPluginHooks.js'
  )

  test('child: the first source of a plugin name keeps its hooks, managed sources first', async () => {
    await loadPluginHooks()
    expect(
      state
        .getRegisteredHooks()
        ?.SessionStart?.map((matcher) =>
          'pluginId' in matcher ? matcher.pluginId : undefined,
        ),
    ).toEqual(['org@mkt2', 'demo@mkt5', 'other@mkt2', 'plain@mkt2'])
  })

  test('child: the hot reload snapshot changes when the organization enables a plugin a user already enabled', () => {
    const before = getPluginAffectingSettingsSnapshot()
    policyEnabled['demo@mkt2'] = true
    expect(getPluginAffectingSettingsSnapshot()).not.toBe(before)
  })
}
