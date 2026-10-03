import { expect, test, mock } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  rmdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.P7_CONTRACT_TEST_CHILD) {
  test('isolated contract loader matrix', async () => {
    const home = mkdtempSync(join(tmpdir(), 'p7-contract-process-'))
    console.log(`P7 process HOME retained: ${home}`)
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, 'config'),
        P7_CONTRACT_TEST_CHILD: '1',
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
    expect(code).toBe(0)
  }, 30000)
} else {
  // Run only in an isolated process: no application imports before HOME is replaced.
  const root = mkdtempSync(join(tmpdir(), 'p7-contract-loader-'))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL = '1'
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  console.log(`P7 fixture retained: ${root}`)
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
  const configDir = join(root, 'config/plugins')
  mkdirSync(configDir, { recursive: true })
  const write = (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value))
  const plugin = (name: string) => {
    const path = join(root, name)
    mkdirSync(join(path, '.claude-plugin'), { recursive: true })
    write(join(path, '.claude-plugin/plugin.json'), {
      name: 'example',
      version: name,
    })
    return path
  }
  const catalogPlugin = plugin('catalog')
  const recorded = plugin('recorded')
  writeFileSync(
    join(catalogPlugin, '.claude-plugin/plugin.json'),
    'invalid catalog-source manifest',
  )
  const catalog = join(root, 'marketplace.json')
  write(catalog, {
    name: 'test',
    owner: { name: 'test' },
    plugins: [{ name: 'example', source: './catalog' }],
  })
  write(join(configDir, 'known_marketplaces.json'), {
    test: {
      source: { source: 'file', path: catalog },
      installLocation: catalog,
      lastUpdated: new Date().toISOString(),
    },
  })
  const installedPath = join(configDir, 'installed_plugins.json')
  const record = (installPath: string) =>
    write(installedPath, {
      version: 2,
      plugins: {
        'example@test': [
          {
            scope: 'user',
            installPath,
            version: '1',
            installedAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
          },
        ],
      },
    })
  const configure = (enabledPlugins: Record<string, boolean>) => {
    state.setFlagSettingsInline({ enabledPlugins })
    settingsCache.resetSettingsCache()
  }
  const snapshot = (dir: string): unknown =>
    readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => [
        entry.name,
        entry.isDirectory()
          ? snapshot(join(dir, entry.name))
          : readFileSync(join(dir, entry.name)).toString('base64'),
      ])

  test('contract-only discovery preserves recorded paths and never publishes partial context', async () => {
    record(recorded)
    configure({ 'example@test': true })
    const before = snapshot(root)
    const settingsBase = settingsCache.getPluginSettingsBase()
    const result = await loader.loadPluginsForContractValidation()
    expect(result.enabled.map(p => p.source)).toContain('example@test')
    expect(result.enabled.map(p => p.source)).toContain('diff@builtin')
    expect(result.complete).toBe(true)
    expect(result.errors).toEqual([])
    expect(settingsCache.getPluginSettingsBase()).toBe(settingsBase)
    expect(snapshot(root)).toEqual(before)
  })

  test('installed reader distinguishes absence, corruption and unreadable state without migration', () => {
    writeFileSync(installedPath, '{broken')
    expect(() =>
      installed.readInstalledPluginsForContractValidation(),
    ).toThrow()
    unlinkSync(installedPath)
    expect(installed.readInstalledPluginsForContractValidation()).toEqual({
      version: 2,
      plugins: {},
    })
    mkdirSync(installedPath)
    expect(() =>
      installed.readInstalledPluginsForContractValidation(),
    ).toThrow()
    rmdirSync(installedPath)
    // Restore a valid snapshot for subsequent calls; the strict reader must not cache failure.
    record(recorded)
    expect(
      installed.readInstalledPluginsForContractValidation().plugins[
        'example@test'
      ]?.[0]?.installPath,
    ).toBe(recorded)
  })

  test('corrupt installed state cannot fall back to local catalog source', async () => {
    writeFileSync(installedPath, '{broken')
    const result = await loader.loadPluginsForContractValidation()
    expect(result.enabled).toEqual([])
    expect(result.complete).toBe(false)
    expect(
      result.errors.some(e => e.source.includes('installed_plugins.json')),
    ).toBe(true)
  })

  test('corrupt ZIP preserves diagnostics without extraction, even with SYNC_PLUGIN_INSTALL', async () => {
    const zip = join(root, 'plugin.zip')
    writeFileSync(zip, 'not an archive')
    record(zip)
    const before = snapshot(root)
    const result = await loader.loadPluginsForContractValidation()
    expect(result.enabled).toEqual([])
    expect(
      result.errors.some(
        e => e.type === 'generic-error' && e.error.includes('ZIP'),
      ),
    ).toBe(true)
    expect(snapshot(root)).toEqual(before)
  })

  test('valid ZIP contracts are read in memory without executing modules or writing caches', async () => {
    const { zipSync, strToU8 } = await import('fflate')
    const zip = join(root, 'valid.zip')
    writeFileSync(zip, zipSync({
      '.claude-plugin/plugin.json': strToU8(JSON.stringify({ name: 'example', types: './types.ts' })),
      'types.ts': strToU8("declare module 'claude-code' { interface PluginState { example: { value: string }; forged: { value: string } } }"),
      'hooks/register.ts': strToU8('throw new Error("PLUGIN EXECUTED")'),
    }))
    record(zip)
    const before = snapshot(root)
    const result = await loader.loadPluginsForContractValidation()
    expect(result.complete).toBe(true)
    expect(result.errors).toEqual([])
    const plugin = result.enabled.find(p => p.source === 'example@test')!
    expect(plugin.contractFiles?.['types.ts']).toBeDefined()
    const { resolveForeignModStateDeclarations } = await import('./validatePlugin.js')
    const foreign = await resolveForeignModStateDeclarations([plugin], 'owner')
    expect(foreign.declarations?.map(d => d.plugin)).toEqual(['example'])
    expect(await resolveForeignModStateDeclarations([plugin], 'example')).toEqual({ declarations: [] })
    plugin.manifest.types = '../escape.ts'
    expect((await resolveForeignModStateDeclarations([plugin], 'owner')).warning).toContain('leaves the plugin root')
    plugin.manifest.types = './missing.ts'
    expect((await resolveForeignModStateDeclarations([plugin], 'owner')).declarations).toBeUndefined()
    expect(snapshot(root)).toEqual(before)
  })

  test('builtin archive failures and registry callbacks remain incomplete without partial plugins', async () => {
    const registry = await import('../../plugins/builtinPlugins.js')
    let called = false
    registry.registerBuiltinPlugin({ name: 'dynamic', description: 'dynamic', isAvailable: () => { called = true; return true } })
    const unavailable = await loader.loadPluginsForContractValidation()
    expect(unavailable.complete).toBe(false)
    expect(unavailable.enabled).toEqual([])
    expect(called).toBe(false)
    expect(unavailable.errors.some(e => e.type === 'generic-error' && e.error.includes('availability'))).toBe(true)
    registry.clearBuiltinPlugins()
    for (const archive of [join(root, 'missing.zip'), join(root, 'plugin.zip'), root]) {
      process.env.CLAUDE_CODE_BUILTIN_MODS_ARCHIVE = archive
      const result = await loader.loadPluginsForContractValidation()
      expect(result.complete).toBe(false)
      expect(result.enabled).toEqual([])
      expect(result.errors.some(e => e.source === 'builtin')).toBe(true)
    }
    delete process.env.CLAUDE_CODE_BUILTIN_MODS_ARCHIVE
  })

  test('unsafe ZIP entries discard the complete context without writing anything', async () => {
    const { zipSync, strToU8 } = await import('fflate')
    const zip = join(root, 'unsafe.zip')
    writeFileSync(zip, zipSync({ '../escape': strToU8('bad') }))
    record(zip)
    const before = snapshot(root)
    const result = await loader.loadPluginsForContractValidation()
    expect(result.complete).toBe(false)
    expect(result.enabled).toEqual([])
    expect(result.errors.some(e => e.type === 'generic-error' && e.error.includes('unsafe entry'))).toBe(true)
    expect(snapshot(root)).toEqual(before)
  })

  test('inline contract mode reads manifests without loading hook modules or plugin settings', async () => {
    const path = plugin('inline')
    mkdirSync(join(path, 'hooks'))
    write(join(path, 'hooks/hooks.json'), { modules: ['./register.ts'] })
    writeFileSync(
      join(path, 'hooks/register.ts'),
      'throw new Error("PLUGIN EXECUTED")',
    )
    writeFileSync(join(path, 'settings.json'), '{broken')
    const before = snapshot(root)
    const result = await loader.loadSessionOnlyPlugins([path], {}, true)
    expect(result.errors).toEqual([])
    expect(result.plugins[0]?.source).toBe('example@inline')
    expect(result.plugins[0]?.hookModules).toBeUndefined()
    expect(result.plugins[0]?.settings).toBeUndefined()
    expect(snapshot(root)).toEqual(before)
  })

  test('local discovery shares manifest fallback and strict conflict rules', async () => {
    unlinkSync(installedPath)
    unlinkSync(join(catalogPlugin, '.claude-plugin/plugin.json'))
    const load = () => loader.loadPluginsForContractValidation()
    expect((await load()).errors.map(e => e.source)).toEqual([])
    write(join(catalogPlugin, '.claude-plugin/plugin.json'), {
      name: 'example',
    })
    write(catalog, {
      name: 'test',
      owner: { name: 'test' },
      plugins: [
        {
          name: 'example',
          source: './catalog',
          strict: false,
          commands: './command.md',
        },
      ],
    })
    expect(
      (await load()).errors.some(
        e =>
          e.type === 'generic-error' &&
          e.error.includes('conflicting manifests'),
      ),
    ).toBe(true)
    write(catalog, {
      name: 'test',
      owner: { name: 'test' },
      plugins: [
        {
          name: 'example',
          source: './catalog',
          strict: true,
          commands: './command.md',
        },
      ],
    })
    expect((await load()).errors.map(e => e.source)).toEqual([])
  })

  test('disabled inline shadows installed plugins before dependency verification', async () => {
    const inline = plugin('shadow')
    write(join(catalogPlugin, '.claude-plugin/plugin.json'), { name: 'example', dependencies: ['missing@test'] })
    state.setInlinePlugins([inline])
    configure({ 'example@test': true, 'example@inline': false })
    expect((await loader.loadPluginsForContractValidation()).errors.map(e => e.source)).toEqual([])
    state.setInlinePlugins([])
    const result = await loader.loadPluginsForContractValidation()
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.enabled).toEqual([])
    write(join(catalogPlugin, '.claude-plugin/plugin.json'), { name: 'example' })
  })

  test('settings and add-dir readers preserve invalid and unreadable diagnostics', async () => {
    configure({})
    const dir = join(root, 'add-dir')
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const path = join(dir, '.claude/settings.json')
    state.setAdditionalDirectoriesForClaudeMd([dir])
    writeFileSync(path, '{broken')
    settingsCache.resetSettingsCache()
    expect((await loader.loadPluginsForContractValidation()).errors.some(e => e.source === path)).toBe(true)
    unlinkSync(path)
    mkdirSync(path)
    settingsCache.resetSettingsCache()
    expect((await loader.loadPluginsForContractValidation()).errors.some(e => e.source === path)).toBe(true)
    rmdirSync(path)
    settingsCache.resetSettingsCache()
    expect((await loader.loadPluginsForContractValidation()).errors.map(e => e.source)).toEqual([])
    state.setAdditionalDirectoriesForClaudeMd([])
    configure({ 'example@test': true })
  })

  test('corrupt and unreadable catalogs preserve provenance without partial results', async () => {
    writeFileSync(catalog, '{broken')
    let result = await loader.loadPluginsForContractValidation()
    expect(result.errors.some(e => e.source === catalog)).toBe(true)
    expect(result.enabled).toEqual([])
    unlinkSync(catalog)
    mkdirSync(catalog)
    result = await loader.loadPluginsForContractValidation()
    expect(result.errors.some(e => e.source === catalog)).toBe(true)
    expect(result.enabled).toEqual([])
  })
}
