import { expect, mock, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Loader state (settings, memoized catalogs) is process-wide, so the cases run
// in a fresh child whose HOME and config dir are owned by this test.
if (!process.env.PL2_SOURCE_PATH_TEST_CHILD) {
  test('marketplace source paths are confined at load time', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'pl2-source-path-')))
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: home,
        CLAUDE_CONFIG_DIR: join(home, 'config'),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        PL2_SOURCE_PATH_TEST_CHILD: '1',
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
    expect(stderr).toMatch(/(?:^|\n) 4 pass(?:\n|$)/)
    expect(code).toBe(0)
  }, 30000)
} else {
  const root = process.env.HOME!
  ;(globalThis as any).MACRO = { VERSION: 'test' }
  mock.module('../execFileNoThrow.js', () => ({
    execSyncWithDefaults_DEPRECATED() {
      throw new Error('Forbidden subprocess')
    },
    execFileNoThrow() {
      throw new Error('Forbidden subprocess')
    },
    execFileNoThrowWithCwd() {
      throw new Error('Forbidden subprocess')
    },
  }))
  globalThis.fetch = (() => {
    throw new Error('Forbidden network')
  }) as unknown as typeof fetch
  const state = await import('../../bootstrap/state.js')
  state.setOriginalCwd(root)
  state.setAllowedSettingSources(['flagSettings'])
  const settingsCache = await import('../settings/settingsCache.js')
  const loader = await import('./pluginLoader.js')
  const installed = await import('./installedPluginsManager.js')
  const operations = await import('../../services/plugins/pluginOperations.js')

  const write = (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value))
  const plugin = (dir: string, name: string) => {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    write(join(dir, '.claude-plugin/plugin.json'), { name, version: '1.0.0' })
    mkdirSync(join(dir, 'skills', `${name}-skill`), { recursive: true })
    writeFileSync(
      join(dir, 'skills', `${name}-skill`, 'SKILL.md'),
      `---\nname: ${name}-skill\ndescription: ${name}\n---\nbody\n`,
    )
  }
  const market = join(root, 'evil')
  plugin(join(root, 'outside'), 'trav')
  plugin(join(market, 'good'), 'good')
  mkdirSync(join(market, '.claude-plugin'), { recursive: true })
  write(join(market, '.claude-plugin/marketplace.json'), {
    name: 'evil',
    owner: { name: 'lab' },
    plugins: [
      { name: 'trav', source: './../outside' },
      { name: 'good', source: './good' },
    ],
  })
  const pluginsDir = join(root, 'config/plugins')
  mkdirSync(pluginsDir, { recursive: true })
  write(join(pluginsDir, 'known_marketplaces.json'), {
    evil: {
      source: { source: 'directory', path: market },
      installLocation: market,
      lastUpdated: new Date().toISOString(),
    },
  })
  state.setFlagSettingsInline({
    enabledPlugins: { 'trav@evil': true, 'good@evil': true },
  })
  settingsCache.resetSettingsCache()

  const refused =
    'Plugin source path refused: ./../outside does not stay inside its marketplace directory. Check that the marketplace entry has a plain relative path.'

  for (const [label, load] of [
    ['cache-only loader', () => loader.loadAllPluginsCacheOnly()],
    ['full loader', () => loader.loadAllPlugins()],
  ] as const) {
    test(`${label} refuses a source that climbs out of the marketplace`, async () => {
      loader.clearPluginCache()
      const result = await load()
      const sources = [...result.enabled, ...result.disabled].map(p => p.source)
      expect(sources).not.toContain('trav@evil')
      expect(sources).toContain('good@evil')
      expect(
        result.errors.filter(e => e.source === 'trav@evil'),
      ).toContainEqual(
        expect.objectContaining({ type: 'generic-error', error: refused }),
      )
      expect(
        result.enabled.some(p => p.path.startsWith(join(root, 'outside'))),
      ).toBe(false)
    })
  }

  test('settings sync does not record a source that climbs out of the marketplace', async () => {
    // The sync reads enablement from user settings, not flag settings.
    write(join(root, 'config/settings.json'), {
      enabledPlugins: { 'trav@evil': true },
    })
    state.setAllowedSettingSources(['userSettings', 'flagSettings'])
    settingsCache.resetSettingsCache()
    await installed.migrateFromEnabledPlugins()
    state.setAllowedSettingSources(['flagSettings'])
    settingsCache.resetSettingsCache()
    installed.clearInstalledPluginsCache()
    expect(Object.keys(installed.loadInstalledPluginsFromDisk().plugins)).not.toContain('trav@evil')
  })

  test('update of a legacy record refuses to copy from outside the marketplace', async () => {
    // Record written by a build without the sync check.
    installed.addInstalledPlugin(
      'trav@evil',
      {
        version: '0.9.0',
        installedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        installPath: loader.getVersionedCachePath('trav@evil', '0.9.0'),
      },
      'user',
    )
    const result = await operations.updatePluginOp('trav@evil', 'user')
    expect(result).toMatchObject({ success: false, message: refused })
    expect(
      installed.loadInstalledPluginsFromDisk().plugins['trav@evil']?.[0]?.version,
    ).toBe('0.9.0')
    expect(existsSync(join(root, 'config/plugins/cache/evil/trav'))).toBe(false)
  })
}