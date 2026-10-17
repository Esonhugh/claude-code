import { beforeEach, expect, test } from 'bun:test'
import {
  existsSync,
  rmSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Settings, registry and plugin directories are process-wide, so the cases run
// in a fresh child whose HOME and config dir are owned by this test.
if (!process.env.PL6_COLLISION_TEST_CHILD) {
  test('plugin ids that share a data dir cannot both be installed', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'pl6-collision-')))
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: home,
        CLAUDE_CONFIG_DIR: join(home, 'config'),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        PL6_COLLISION_TEST_CHILD: '1',
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
    expect(stderr).toMatch(/(?:^|\n) 18 pass(?:\n|$)/)
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
  const directories = await import('./pluginDirectories.js')
  const operations = await import('../../services/plugins/pluginOperations.js')
  const marketplace = await import('./marketplaceManager.js')
  const cache = await import('./cacheUtils.js')
  const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value))
  const pluginsDir = join(root, 'config/plugins')
  mkdirSync(pluginsDir, { recursive: true })
  const known: Record<string, unknown> = {}
  const entries = {
    'a@b-c': { name: 'a', source: './a', strict: true },
    'a-b@c': { name: 'a-b', source: './a-b', strict: true },
    'parent@c': { name: 'parent', source: './parent', dependencies: ['a-b'], strict: true },
    'a@b.c': { name: 'a', source: './a', strict: true },
  }
  for (const market of ['b-c', 'c', 'b.c']) {
    const dir = join(root, market)
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    const members = Object.entries(entries).filter(([id]) => id.endsWith(`@${market}`)).map(([,entry]) => entry)
    for (const entry of members) {
      const path = join(dir, entry.name)
      mkdirSync(join(path, '.claude-plugin'), { recursive: true })
      write(join(path, '.claude-plugin/plugin.json'), { name: entry.name, version: '1.0.0' })
    }
    write(join(dir, '.claude-plugin/marketplace.json'), { name: market, owner: { name: 'lab' }, plugins: members, allowCrossMarketplaceDependenciesOn: ['c'] })
    known[market] = { source: { source: 'directory', path: dir }, installLocation: dir, lastUpdated: new Date().toISOString() }
  }
  const settingsPath = join(root, 'config/settings.json')
  const registryPath = installed.getInstalledPluginsFilePath()
  const installedIds = () => Object.keys(installed.loadInstalledPluginsFromDisk().plugins).filter(id => installed.loadInstalledPluginsFromDisk().plugins[id]!.length > 0).sort()
  const dataDir = directories.pluginDataDirPath('a@b-c')
  const putData = () => { mkdirSync(dataDir, { recursive: true }); writeFileSync(join(dataDir, 'state.txt'), 'keep') }
  const expectData = () => expect(readFileSync(join(dataDir, 'state.txt'), 'utf-8')).toBe('keep')
  beforeEach(() => {
    for (const name of ['cache', 'data']) rmSync(join(pluginsDir, name), { recursive: true, force: true })
    mkdirSync(join(pluginsDir, 'cache'))
    write(join(pluginsDir, 'known_marketplaces.json'), known)
    write(registryPath, { version: 2, plugins: {} })
    write(settingsPath, {})
    settingsCache.resetSettingsCache()
    installed.clearInstalledPluginsCache()
    installed.resetMigrationState()
    cache.clearAllCaches()
  })
  const seed = (id: string, scope: 'user' | 'project' | 'local' | 'managed' = 'user', projectPath?: string) => {
    const [name, market] = id.split('@')
    installed.addInstalledPlugin(id, { version: '1.0.0', installedAt: new Date().toISOString(), installPath: join(root, market!, name!) }, scope, projectPath)
  }
  const install = (id: keyof typeof entries, scope: 'user' | 'project' | 'local' = 'user', entry = entries[id]) => helpers.installResolvedPlugin({ pluginId: id, entry, scope, marketplaceInstallLocation: join(root, id.split('@')[1]!) })
  const refusal = (id: string, other: string) => `"${id}" was not installed: it would share its saved data with "${other}", which is installed, because the two ids are the same once "@" and "." are written as "-". Only one of the two can be installed. To install "${id}" instead, first run \`claude plugin uninstall ${other}\`. Uninstalling a plugin also deletes its saved data.`

  test('the second colliding id is refused with nothing written', async () => {
    expect(await install('a@b-c')).toMatchObject({ ok: true })
    const settingsBefore = readFileSync(settingsPath, 'utf-8'), registryBefore = readFileSync(registryPath, 'utf-8')
    await expect(install('a-b@c')).rejects.toThrow(refusal('a-b@c', 'a@b-c'))
    expect(readFileSync(settingsPath, 'utf-8')).toBe(settingsBefore)
    expect(readFileSync(registryPath, 'utf-8')).toBe(registryBefore)
    expect(installedIds()).toEqual(['a@b-c'])
    expect(existsSync(join(pluginsDir, 'cache/c'))).toBe(false)
  })
  test('data dir deletion is skipped while another id still uses it', async () => {
    putData()
    await directories.deletePluginDataDir('a-b@c', ['a@b-c'])
    expectData()
    await directories.deletePluginDataDir('a-b@c', [])
    expect(existsSync(dataDir)).toBe(false)
  })
  test('uninstalling one of two legacy colliding installs keeps the shared data', async () => {
    seed('a@b-c'); seed('a-b@c'); putData()
    expect(await operations.uninstallPluginOp('a-b@c', 'user')).toMatchObject({ success: true })
    expect(installedIds()).toEqual(['a@b-c']); expectData()
    expect(await operations.uninstallPluginOp('a@b-c', 'user')).toMatchObject({ success: true })
    expect(existsSync(dataDir)).toBe(false)
  })
  test('marketplace removal keeps data held by another marketplace', async () => {
    seed('a@b-c'); seed('a-b@c'); putData()
    await marketplace.removeMarketplaceSource('b-c')
    expect(installedIds()).toEqual(['a-b@c']); expectData()
  })
  test('an unshared last installation removes its data', async () => {
    seed('a@b-c'); putData()
    expect(await operations.uninstallPluginOp('a@b-c', 'user')).toMatchObject({ success: true })
    expect(existsSync(dataDir)).toBe(false)
  })
  test('uninstall keeps the data until the last scope is removed', async () => {
    seed('a@b-c'); seed('a@b-c', 'project', root); putData()
    expect(await operations.uninstallPluginOp('a@b-c', 'user')).toMatchObject({ success: true }); expectData()
    expect(await operations.uninstallPluginOp('a@b-c', 'project')).toMatchObject({ success: true })
    expect(existsSync(dataDir)).toBe(false)
  })
  test('case-folded data collisions name the actual owner', async () => {
    seed('A@b-c')
    if (process.platform === 'darwin' || process.platform === 'win32') {
      await expect(install('a-b@c')).rejects.toThrow(refusal('a-b@c', 'A@b-c').replace('written as "-".', 'written as "-" and capitals are ignored.'))
    } else {
      expect(await install('a-b@c')).toMatchObject({ ok: true })
    }
  })
  test('folder collisions caused by dots are refused too', async () => {
    seed('a.b@c')
    await expect(install('a-b@c')).rejects.toThrow('"a-b@c" was not installed: it would share its folder with "a.b@c", which is installed, because the two ids differ only in "." and "-". Only one of the two can be installed. To install "a-b@c" instead, first run `claude plugin uninstall a.b@c`. Uninstalling a plugin also deletes its saved data.')
  })
  test('empty records do not hold a data directory', async () => {
    write(registryPath, { version: 2, plugins: { 'a@b-c': [] } }); installed.clearInstalledPluginsCache()
    expect(await install('a-b@c')).toMatchObject({ ok: true })
  })
  test('an existing id can be reinstalled even with a legacy collision', async () => {
    // 官方 2.1.292 实测: 已有该 id 的安装记录时不拒绝重新安装。
    seed('a@b-c'); seed('a-b@c')
    expect(await install('a-b@c')).toMatchObject({ ok: true })
  })
  test('another project gets a scoped uninstall hint', async () => {
    seed('a@b-c', 'project', '/other/project')
    await expect(install('a-b@c')).rejects.toThrow(refusal('a-b@c', 'a@b-c').replace('which is installed,', 'which is installed in another project,').replace('uninstall a@b-c`.', 'uninstall a@b-c --scope project` in “/other/project”.'))
  })
  test('managed owners direct the user to their administrator', async () => {
    seed('a@b-c', 'managed')
    const expected = refusal('a-b@c', 'a@b-c').split(' To install ')[0]!.replace('which is installed,', 'which your organization installed,') + ' Ask your administrator.'
    await expect(install('a-b@c')).rejects.toThrow(expected)
  })
  test('multiple owners are all named and receive separate uninstall hints', async () => {
    seed('a@b-c'); seed('a-b@c')
    await expect(install('a@b.c')).rejects.toThrow('"a@b.c" was not installed: it would share its folder or its saved data with "a@b-c" and "a-b@c", which are installed, because their ids are the same once "@" and "." are written as "-". To install "a@b.c" instead, first do each of these: run `claude plugin uninstall a@b-c`; run `claude plugin uninstall a-b@c`. Uninstalling a plugin also deletes its saved data.')
  })
  test('two new ids in one dependency closure are refused before any member is written', async () => {
    await expect(install('a@b-c', 'user', { ...entries['a@b-c'], dependencies: ['a-b@c'] })).rejects.toThrow('"a@b-c" was not installed: it needs "a-b@c", which would share its saved data with "a@b-c", because the two ids are the same once "@" and "." are written as "-". Only a maintainer of one of the two marketplaces can fix this, by renaming one of them.')
    expect(installedIds()).toEqual([]); expect(existsSync(join(pluginsDir, 'cache/c'))).toBe(false)
  })
  test('an installed owner refuses a dependency without writing the root', async () => {
    seed('a@b-c')
    const registryBefore = readFileSync(registryPath, 'utf-8')
    await expect(install('parent@c')).rejects.toThrow('"parent@c" was not installed: it needs "a-b@c", which would share its saved data with "a@b-c", which is installed, because the two ids are the same once "@" and "." are written as "-". Only one of the two can be installed. To install "parent@c", first run `claude plugin uninstall a@b-c`. Uninstalling a plugin also deletes its saved data.')
    expect(readFileSync(registryPath, 'utf-8')).toBe(registryBefore); expect(existsSync(join(pluginsDir, 'cache/c'))).toBe(false)
  })
  test('the interactive wrapper returns the UI-specific data deletion hint', async () => {
    seed('a@b-c')
    const result = await helpers.installPluginFromMarketplace({ pluginId: 'a-b@c', entry: entries['a-b@c'], marketplaceName: 'c' })
    expect(result).toMatchObject({ success: false, error: refusal('a-b@c', 'a@b-c').replace('run `claude plugin uninstall a@b-c`', 'uninstall "a@b-c"').replace('Uninstalling a plugin also deletes its saved data.', "When it asks, let it delete the plugin's saved data: the new plugin would otherwise start with it.") })
  })
  test('unknown remaining installs preserve data instead of assuming none', async () => {
    putData()
    await directories.deletePluginDataDir('a@b-c', null)
    expectData()
  })
  test('npm data directory names use official escaping to avoid false collisions', () => {
    // 官方 2.1.292 源码: N()/ueo()，npm 使用字符码编码而非普通 id 的清洗。
    expect(directories.pluginDataDirPath('x.y@npm')).toBe(join(pluginsDir, 'data/x_2ey-npm'))
    expect(directories.pluginDataDirPath('@scope/pkg@npm')).toBe(join(pluginsDir, 'data/_40scope_2fpkg-npm'))
    expect(directories.pluginDataDirPath('a@b-c')).toBe(join(pluginsDir, 'data/a-b-c'))
  })
}
