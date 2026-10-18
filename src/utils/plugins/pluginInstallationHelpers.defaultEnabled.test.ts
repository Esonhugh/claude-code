import { beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Official 2.1.292 installResolvedPlugin/Hgn: a closure member whose manifest has
// defaultEnabled:false is written disabled unless it already has a value, is set
// in any settings source, or is required by an enabled dependent.
if (!process.env.DEFAULT_ENABLED_INSTALL_TEST_CHILD) {
  test('install applies manifest defaultEnabled to the dependency closure', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'default-enabled-install-')))
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: home,
        CLAUDE_CONFIG_DIR: join(home, 'config'),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DEFAULT_ENABLED_INSTALL_TEST_CHILD: '1',
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
    expect(stderr).toMatch(/(?:^|\n) 6 pass(?:\n|$)/)
    expect(code).toBe(0)
  }, 60000)
} else {
  const root = process.env.HOME!
  ;(globalThis as any).MACRO = { VERSION: 'test' }
  const state = await import('../../bootstrap/state.js')
  state.setOriginalCwd(root)
  const settingsCache = await import('../settings/settingsCache.js')
  const helpers = await import('./pluginInstallationHelpers.js')
  const installed = await import('./installedPluginsManager.js')
  const { clearAllCaches } = await import('./cacheUtils.js')

  const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value))
  const market = join(root, 'market')
  const entries: Array<{ name: string; source: string; dependencies?: string[] }> = []
  const plugin = (name: string, manifest: { defaultEnabled?: boolean; dependencies?: string[] } = {}) => {
    const dir = join(market, name)
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    write(join(dir, '.claude-plugin/plugin.json'), { name, version: '1.0.0', ...manifest })
    entries.push({ name, source: `./${name}`, ...(manifest.dependencies && { dependencies: manifest.dependencies }) })
  }
  plugin('off', { defaultEnabled: false })
  plugin('off-dep', { defaultEnabled: false })
  plugin('parent', { dependencies: ['off-dep'] })
  plugin('plain-dep')
  plugin('off-parent', { defaultEnabled: false, dependencies: ['plain-dep'] })
  plugin('off-dep2', { defaultEnabled: false })
  plugin('off-parent2', { defaultEnabled: false, dependencies: ['off-dep2'] })
  plugin('late-off', { defaultEnabled: false })
  plugin('needs-late', { dependencies: ['late-off'] })
  mkdirSync(join(market, '.claude-plugin'), { recursive: true })
  write(join(market, '.claude-plugin/marketplace.json'), { name: 'm', owner: { name: 'lab' }, plugins: entries })
  const pluginsDir = join(root, 'config/plugins')
  mkdirSync(pluginsDir, { recursive: true })
  write(join(pluginsDir, 'known_marketplaces.json'), {
    m: { source: { source: 'directory', path: market }, installLocation: market, lastUpdated: new Date().toISOString() },
  })
  const registryPath = join(pluginsDir, 'installed_plugins.json')
  const settingsPath = join(root, 'config/settings.json')
  const projectSettingsPath = join(root, '.claude/settings.json')
  mkdirSync(join(root, '.claude'), { recursive: true })

  const reset = (enabledPlugins: Record<string, boolean>, project: Record<string, boolean> = {}) => {
    write(settingsPath, { enabledPlugins })
    write(projectSettingsPath, { enabledPlugins: project })
    settingsCache.resetSettingsCache()
    installed.clearInstalledPluginsCache()
    clearAllCaches()
  }
  const install = (name: string) =>
    helpers.installResolvedPlugin({
      pluginId: `${name}@m`,
      entry: entries.find(e => e.name === name)! as never,
      scope: 'user',
      marketplaceInstallLocation: market,
    })
  const enabledPlugins = () => JSON.parse(readFileSync(settingsPath, 'utf-8')).enabledPlugins

  beforeEach(() => {
    write(registryPath, { version: 2, plugins: {} })
    reset({})
  })

  test('a defaultEnabled:false plugin installs disabled', async () => {
    expect(await install('off')).toMatchObject({ ok: true })
    expect(enabledPlugins()).toEqual({ 'off@m': false })
  })

  test('a defaultEnabled:false dependency of an enabled plugin installs enabled', async () => {
    expect(await install('parent')).toMatchObject({ ok: true })
    expect(enabledPlugins()).toEqual({ 'parent@m': true, 'off-dep@m': true })
  })

  test('a disabled-by-default root does not force its dependencies either way', async () => {
    expect(await install('off-parent')).toMatchObject({ ok: true })
    expect(enabledPlugins()).toEqual({ 'off-parent@m': false, 'plain-dep@m': true })
    expect(await install('off-parent2')).toMatchObject({ ok: true })
    expect(enabledPlugins()).toMatchObject({ 'off-parent2@m': false, 'off-dep2@m': false })
  })

  test('an existing value in the target scope is kept', async () => {
    reset({ 'off@m': true })
    expect(await install('off')).toMatchObject({ ok: true })
    expect(enabledPlugins()).toEqual({ 'off@m': true })
  })

  test('a value set in another settings source enables the install', async () => {
    reset({}, { 'off@m': true })
    expect(await install('off')).toMatchObject({ ok: true })
    expect(enabledPlugins()).toEqual({ 'off@m': true })
  })

  test('a root required by an enabled installed dependent installs enabled', async () => {
    expect(await install('needs-late')).toMatchObject({ ok: true })
    reset({ 'needs-late@m': true })
    expect(await install('late-off')).toMatchObject({ ok: true })
    expect(enabledPlugins()).toEqual({ 'needs-late@m': true, 'late-off@m': true })
  })
}
