import { beforeEach, expect, spyOn, test } from 'bun:test'
import * as asyncFs from 'node:fs/promises'
import * as syncFs from 'node:fs'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Settings and plugin directories are process-wide, so the cases run in a
// fresh child whose HOME and config dir are owned by this test.
if (!process.env.PL3_INSTALL_TEST_CHILD) {
  test('install writes settings only after every closure member is cached', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'pl3-install-')))
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: home,
        CLAUDE_CONFIG_DIR: join(home, 'config'),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        PL3_INSTALL_TEST_CHILD: '1',
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
    expect(stderr).toMatch(/(?:^|\n) 13 pass(?:\n|$)/)
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

  const write = (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value))
  const plugin = (dir: string, name: string, version: string) => {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    write(join(dir, '.claude-plugin/plugin.json'), { name, version })
    mkdirSync(join(dir, 'skills', name), { recursive: true })
    writeFileSync(join(dir, 'skills', name, 'SKILL.md'), `${name} ${version}`)
  }
  const market = join(root, 'evil')
  const entries = [
    { name: 'trav', source: './../outside', strict: true },
    { name: 'missing', source: './does-not-exist', strict: true },
    { name: 'good', source: './good', strict: true },
    { name: 'broken', source: './broken', strict: true },
    { name: 'dep-good', source: './dep-good', strict: true },
    {
      name: 'parent-trav',
      source: './parent-trav',
      dependencies: ['dep-good', 'trav'],
      strict: true,
    },
    { name: 'dep-late', source: './dep-late', strict: true },
    {
      name: 'parent-missing',
      source: './parent-missing',
      dependencies: ['dep-late'],
      strict: true,
    },
    { name: 'evil', source: './self', strict: true },
    { name: 'recover', source: './recover', strict: true },
    { name: 'readonly', source: './readonly', strict: true },
  ]
  plugin(join(root, 'outside'), 'trav', '1.0.0')
  plugin(join(market, 'good'), 'good', '1.0.0')
  for (const name of [
    'broken',
    'dep-good',
    'parent-trav',
    'dep-late',
    'recover',
    'readonly',
  ])
    plugin(join(market, name), name, '1.0.0')
  plugin(join(market, 'self'), 'evil', '1.0.0')
  write(join(market, 'broken/.claude-plugin/plugin.json'), {
    name: 'invalid name',
    version: '1.0.0',
  })
  mkdirSync(join(market, '.claude-plugin'), { recursive: true })
  write(join(market, '.claude-plugin/marketplace.json'), {
    name: 'evil',
    owner: { name: 'lab' },
    plugins: entries,
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
  const registryPath = join(pluginsDir, 'installed_plugins.json')
  const settingsPath = join(root, 'config/settings.json')
  write(settingsPath, { enabledPlugins: { 'keep@evil': true } })
  settingsCache.resetSettingsCache()

  const install = (name: string) =>
    helpers.installResolvedPlugin({
      pluginId: `${name}@evil`,
      entry: entries.find(e => e.name === name)!,
      scope: 'user',
      marketplaceInstallLocation: market,
    })
  const enabledPlugins = () =>
    JSON.parse(readFileSync(settingsPath, 'utf-8')).enabledPlugins
  const installedIds = () => {
    installed.clearInstalledPluginsCache()
    return Object.keys(installed.loadInstalledPluginsV2().plugins)
  }

  beforeEach(() => {
    write(settingsPath, { enabledPlugins: { 'keep@evil': true } })
    write(registryPath, { version: 2, plugins: {} })
    settingsCache.resetSettingsCache()
    installed.clearInstalledPluginsCache()
  })

  for (const name of ['trav', 'missing']) {
    test(`failed install of ${name} leaves settings, registry and cache unchanged`, async () => {
      const before = readFileSync(settingsPath, 'utf-8')
      // 官方 2.1.292 tmux 实测：越界安装返回该拒绝文案。
      await expect(install(name)).rejects.toThrow(
        name === 'trav'
          ? 'Cannot install trav@evil: its marketplace entry path does not stay inside the marketplace directory (an absolute, climbing, network-shaped, backslash-containing or link-traversing entry, an entry of a fetched marketplace that resolves or opens outside its tree — or a relative entry in a url-catalog marketplace, which has no local directory)'
          : undefined,
      )
      expect(readFileSync(settingsPath, 'utf-8')).toBe(before)
      expect(enabledPlugins()).toEqual({ 'keep@evil': true })
      expect(installedIds()).not.toContain(`${name}@evil`)
      expect(existsSync(join(pluginsDir, 'cache/evil', name))).toBe(false)
    })
  }

  test('reinstall publishes the new content and records state last', async () => {
    expect(await install('good')).toMatchObject({ ok: true })
    plugin(join(market, 'good'), 'good', '1.0.0')
    writeFileSync(join(market, 'good/skills/good/SKILL.md'), 'good updated')
    expect(await install('good')).toMatchObject({ ok: true })
    const versionDir = join(pluginsDir, 'cache/evil/good/1.0.0')
    expect(
      readFileSync(join(versionDir, 'skills/good/SKILL.md'), 'utf-8'),
    ).toBe('good updated')
    expect(
      readdirSync(join(pluginsDir, 'cache/evil/good')).filter(n =>
        n.includes('.tmp.'),
      ),
    ).toEqual([])
    expect(enabledPlugins()).toEqual({ 'keep@evil': true, 'good@evil': true })
    expect(installedIds()).toContain('good@evil')
  })

  const temporaryEntries = () =>
    readdirSync(join(pluginsDir, 'cache'))
      .filter(name => name.startsWith('temp_'))
      .sort()

  test('invalid manifests leave settings unchanged and remove owned temporary copies', async () => {
    const before = readFileSync(settingsPath, 'utf8')
    mkdirSync(join(pluginsDir, 'cache'), { recursive: true })
    const stagingBefore = temporaryEntries()
    await expect(install('broken')).rejects.toThrow('invalid manifest')
    expect(readFileSync(settingsPath, 'utf8')).toBe(before)
    expect(installedIds()).not.toContain('broken@evil')
    expect(temporaryEntries()).toEqual(stagingBefore)
  })

  test('validates the entire dependency closure before caching any member', async () => {
    const before = readFileSync(settingsPath, 'utf8')
    await expect(install('parent-trav')).rejects.toThrow()
    expect(readFileSync(settingsPath, 'utf8')).toBe(before)
    expect(installedIds()).toEqual([])
    expect(existsSync(join(pluginsDir, 'cache/evil/dep-good/1.0.0'))).toBe(
      false,
    )
  })

  test('a later materialization failure does not enable any closure member', async () => {
    const before = readFileSync(settingsPath, 'utf8')
    await expect(install('parent-missing')).rejects.toThrow(
      'Source path does not exist',
    )
    expect(readFileSync(settingsPath, 'utf8')).toBe(before)
    expect(enabledPlugins()).toEqual({ 'keep@evil': true })
    expect(installedIds()).not.toContain('parent-missing@evil')
  })

  test('matching marketplace and plugin names preserve unrelated and previous versions', async () => {
    const previous = join(pluginsDir, 'cache/evil/evil/0.9.0')
    const unrelated = join(pluginsDir, 'cache/evil/unrelated/1.0.0')
    for (const dir of [previous, unrelated]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'keep'), 'preserved')
    }
    expect(await install('evil')).toMatchObject({ ok: true })
    expect(readFileSync(join(previous, 'keep'), 'utf8')).toBe('preserved')
    expect(readFileSync(join(unrelated, 'keep'), 'utf8')).toBe('preserved')
    expect(
      readFileSync(
        join(pluginsDir, 'cache/evil/evil/1.0.0/skills/evil/SKILL.md'),
        'utf8',
      ),
    ).toBe('evil 1.0.0')
  })

  test('failed publication restores the previous cache and preserves settings and registry', async () => {
    const final = join(pluginsDir, 'cache/evil/recover/1.0.0')
    plugin(final, 'recover', '1.0.0')
    writeFileSync(join(final, 'skills/recover/SKILL.md'), 'old content')
    const settingsBefore = readFileSync(settingsPath, 'utf8')
    const registryBefore = readFileSync(registryPath, 'utf8')
    const failure = Object.assign(new Error('publication refused'), {
      code: 'EIO',
    })
    const rename = asyncFs.rename
    const stub = spyOn(asyncFs, 'rename').mockImplementation(
      async (from, to) => {
        if (to === final && !String(from).includes('.rollback.')) throw failure
        return rename(from, to)
      },
    )
    try {
      await expect(install('recover')).rejects.toBe(failure)
    } finally {
      stub.mockRestore()
    }
    expect(readFileSync(join(final, 'skills/recover/SKILL.md'), 'utf8')).toBe(
      'old content',
    )
    expect(readFileSync(settingsPath, 'utf8')).toBe(settingsBefore)
    expect(readFileSync(registryPath, 'utf8')).toBe(registryBefore)
    expect(readdirSync(join(final, '..'))).toEqual(['1.0.0'])
  })

  test('a settings write refusal leaves the fully installed plugin disabled', async () => {
    const before = readFileSync(settingsPath, 'utf8')
    chmodSync(settingsPath, 0o400)
    chmodSync(join(root, 'config'), 0o500)
    let result: Awaited<ReturnType<typeof helpers.installResolvedPlugin>>
    try {
      result = await install('readonly')
    } finally {
      chmodSync(join(root, 'config'), 0o700)
      chmodSync(settingsPath, 0o600)
    }
    expect(result!).toMatchObject({
      ok: false,
      reason: 'settings-write-failed',
    })
    expect(readFileSync(settingsPath, 'utf8')).toBe(before)
    expect(
      existsSync(
        join(pluginsDir, 'cache/evil/readonly/1.0.0/skills/readonly/SKILL.md'),
      ),
    ).toBe(true)
    expect(installedIds()).toContain('readonly@evil')
    expect(enabledPlugins()).toEqual({ 'keep@evil': true })
  })

  test('a partial settings write failure restores the exact previous contents', async () => {
    const settings = await import('../settings/settings.js')
    const before = readFileSync(settingsPath, 'utf8')
    const failure = new Error('settings interrupted after truncation')
    const stub = spyOn(settings, 'updateSettingsForSource').mockImplementation(
      () => {
        writeFileSync(settingsPath, '{partial')
        return { error: failure }
      },
    )
    try {
      expect(await install('good')).toMatchObject({
        ok: false,
        reason: 'settings-write-failed',
        message: failure.message,
      })
    } finally {
      stub.mockRestore()
    }
    expect(readFileSync(settingsPath, 'utf8')).toBe(before)
    expect(
      existsSync(
        join(pluginsDir, 'cache/evil/good/1.0.0/skills/good/SKILL.md'),
      ),
    ).toBe(true)
  })

  test('failed atomic settings publication never falls back to an in-place write', async () => {
    const before = readFileSync(settingsPath, 'utf8')
    const rename = syncFs.renameSync
    const failure = Object.assign(new Error('atomic publication refused'), {
      code: 'EACCES',
    })
    const stub = spyOn(syncFs, 'renameSync').mockImplementation((from, to) => {
      if (to === settingsPath) throw failure
      return rename(from, to)
    })
    try {
      expect(await install('good')).toMatchObject({
        ok: false,
        reason: 'settings-write-failed',
      })
    } finally {
      stub.mockRestore()
    }
    expect(readFileSync(settingsPath, 'utf8')).toBe(before)
    expect(installedIds()).toContain('good@evil')
  })

  test('install cache refresh observes the newly committed enabled settings', async () => {
    const settings = await import('../settings/settings.js')
    const cache = await import('./cacheUtils.js')
    const seen: boolean[] = []
    const stop = cache.subscribePluginRefresh(() => {
      seen.push(
        settings.getSettingsForSource('userSettings')?.enabledPlugins?.[
          'good@evil'
        ] === true,
      )
    })
    try {
      expect(await install('good')).toMatchObject({ ok: true })
    } finally {
      stop()
    }
    expect(seen.at(-1)).toBe(true)
  })

  test('a synchronous refresh failure restores the committed settings snapshot', async () => {
    const cache = await import('./cacheUtils.js')
    const before = readFileSync(settingsPath, 'utf8')
    const failure = new Error('refresh failed after settings commit')
    const stop = cache.subscribePluginRefresh(() => {
      throw failure
    })
    try {
      await expect(install('good')).rejects.toBe(failure)
    } finally {
      stop()
    }
    expect(readFileSync(settingsPath, 'utf8')).toBe(before)
  })
}
