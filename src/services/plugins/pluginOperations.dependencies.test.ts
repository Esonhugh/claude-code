import { expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Plugin registry, settings and cache paths are process-wide, so the cases run
// in a child whose HOME and config dir are owned by this test.
if (!process.env.PLUGIN_OPS_DEPENDENCIES_TEST_CHILD) {
  test('plugin dependencies are installed, protected and pruned', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-deps-')))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: home,
          CLAUDE_CONFIG_DIR: join(home, 'config'),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          PLUGIN_OPS_DEPENDENCIES_TEST_CHILD: '1',
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
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 60000)
} else {
  const root = process.env.HOME!
  ;(globalThis as any).MACRO = { VERSION: 'test' }
  const state = await import('../../bootstrap/state.js')
  state.setOriginalCwd(root)
  state.setCwdState(root)
  const mm = await import('../../utils/plugins/marketplaceManager.js')
  const ops = await import('./pluginOperations.js')
  const installed = await import(
    '../../utils/plugins/installedPluginsManager.js'
  )

  const market = join(root, 'mk')
  const names: Record<string, string[] | undefined> = {
    base: undefined,
    child: ['base'],
    chain: ['child'],
    ghost: ['nope'],
    cyca: ['cycb'],
    cycb: ['cyca'],
    lone: undefined,
    two: ['base', 'lone'],
  }
  for (const [name, dependencies] of Object.entries(names)) {
    mkdirSync(join(market, name, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(market, name, '.claude-plugin/plugin.json'),
      JSON.stringify({ name, version: '1.0.0', dependencies }),
    )
  }
  mkdirSync(join(market, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(market, '.claude-plugin/marketplace.json'),
    JSON.stringify({
      name: 'mk',
      owner: { name: 'x' },
      plugins: Object.keys(names).map(name => ({ name, source: `./${name}` })),
    }),
  )
  await mm.addMarketplaceSource({ source: 'directory', path: market })

  const enabled = () =>
    JSON.parse(
      readFileSync(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf-8'),
    ).enabledPlugins
  const auto = () => {
    installed.clearInstalledPluginsCache()
    return Object.fromEntries(
      Object.entries(installed.loadInstalledPluginsFromDisk().plugins).map(
        ([id, records]) => [id, records[0]?.auto === true],
      ),
    )
  }

  test('install brings in the dependencies plugin.json declares and marks them auto', async () => {
    expect(await ops.installPluginOp('child@mk', 'user')).toMatchObject({
      success: true,
      message:
        'Successfully installed plugin: child@mk (scope: user) (+ 1 dependency: base)',
    })
    expect(enabled()).toEqual({ 'base@mk': true, 'child@mk': true })
    expect(auto()).toEqual({ 'base@mk': true, 'child@mk': false })

    expect((await ops.installPluginOp('two@mk', 'user')).message).toBe(
      'Successfully installed plugin: two@mk (scope: user) (+ 1 dependency: lone)',
    )
    expect((await ops.installPluginOp('cyca@mk', 'user')).message).toBe(
      'Successfully installed plugin: cyca@mk (scope: user) (+ 1 dependency: cycb)',
    )
    expect((await ops.installPluginOp('ghost@mk', 'user')).message).toBe(
      'Successfully installed plugin: ghost@mk (scope: user). Warning: dependency "nope@mk" was not installed (no marketplace you have added lists it). "ghost" will not load without it',
    )
    expect(auto()).toMatchObject({
      'lone@mk': true,
      'two@mk': false,
      'cyca@mk': false,
      'cycb@mk': true,
      'ghost@mk': false,
    })
  })

  test('a plugin other enabled plugins depend on cannot be disabled alone', async () => {
    expect(await ops.disablePluginOp('base@mk')).toEqual({
      reverseDependents: ['child', 'two'],
      success: false,
      message:
        'base is still required by child, two. Disable those plugins first, or disable everything together: claude plugin disable child@mk && claude plugin disable two@mk && claude plugin disable base@mk',
    })
    expect(enabled()['base@mk']).toBe(true)
    expect((await ops.disablePluginOp('two@mk')).success).toBe(true)
    expect((await ops.disablePluginOp('child@mk')).success).toBe(true)
    expect((await ops.disablePluginOp('base@mk')).success).toBe(true)
  })

  test('enabling a plugin also enables its installed dependencies', async () => {
    expect(await ops.enablePluginOp('child@mk')).toMatchObject({
      success: true,
      message:
        'Successfully enabled plugin: child (scope: user) (also enabled 1 dependency: base)',
    })
    expect(enabled()).toMatchObject({ 'base@mk': true, 'child@mk': true })
    expect((await ops.disablePluginOp('ghost@mk')).success).toBe(true)
    expect(await ops.enablePluginOp('ghost@mk')).toEqual({
      success: false,
      message:
        'ghost depends on nope@mk, which is not installed. Install it first: claude plugin install nope@mk',
    })
  })

  test('uninstall reports dependencies it left behind and prune removes them', async () => {
    expect((await ops.findPrunablePlugins('user')).orphans).toEqual([])
    expect((await ops.uninstallPluginOp('two@mk', 'user')).message).toBe(
      'Successfully uninstalled plugin: two (scope: user)',
    )
    expect((await ops.findPrunablePlugins('user')).orphans).toEqual(['lone@mk'])
    expect(await ops.prunePluginsOp('user', { dryRun: true })).toBe(
      '1 auto-installed plugin no longer needed at user scope:\n  lone@mk (1.0.0)\n(dry run \u2014 nothing removed)',
    )
    expect(await ops.prunePluginsOp('user')).toBe(
      '1 auto-installed plugin no longer needed at user scope:\n  lone@mk (1.0.0)\nNot a TTY \u2014 run `claude plugin prune -y` to remove.',
    )
    expect(auto()['lone@mk']).toBe(true)
    expect(await ops.prunePluginsOp('user', { yes: true })).toBe(
      'Removed 1 auto-installed plugin: lone',
    )
    expect(auto()['lone@mk']).toBeUndefined()
    expect(enabled()['lone@mk']).toBeUndefined()
    expect(await ops.prunePluginsOp('user', { yes: true })).toBe(
      'Nothing to prune (2 auto-installed plugins at user scope, all still needed).',
    )
    expect(await ops.prunePluginsOp('project')).toBe(
      'Nothing to prune (no auto-installed plugins at project scope).',
    )
  })

  test('installing an auto-installed dependency by name makes it a manual install', async () => {
    expect((await ops.installPluginOp('base@mk', 'user')).success).toBe(true)
    expect(auto()['base@mk']).toBe(false)
    expect((await ops.uninstallPluginOp('child@mk', 'user')).message).toBe(
      'Successfully uninstalled plugin: child (scope: user)',
    )
  })

  test('a reload installs the dependencies enabled plugins are missing', async () => {
    const loader = await import('../../utils/plugins/pluginLoader.js')
    const helpers = await import(
      '../../utils/plugins/pluginInstallationHelpers.js'
    )
    expect((await ops.uninstallPluginOp('cycb@mk', 'user')).success).toBe(true)
    expect(enabled()['cycb@mk']).toBeUndefined()
    loader.clearPluginCache()
    const { errors } = await loader.loadAllPlugins()
    expect(errors).toMatchObject([
      { type: 'dependency-unsatisfied', source: 'cyca@mk', reason: 'not-found' },
    ])

    expect(await helpers.installMissingDependencies(errors)).toEqual([
      'cycb@mk',
    ])
    expect(enabled()['cycb@mk']).toBe(true)
    expect(auto()['cycb@mk']).toBe(true)
    loader.clearPluginCache()
    expect((await loader.loadAllPlugins()).errors).toEqual([])
  })
}
