import { expect, spyOn, test } from 'bun:test'
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
if (!process.env.PLUGIN_LIST_TEST_CHILD) {
  test('plugin list, install and marketplace remove report as official 2.1.329', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-list-')))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: home,
          CLAUDE_CONFIG_DIR: join(home, 'config'),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          PLUGIN_LIST_TEST_CHILD: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) console.log(stdout, stderr)
      expect(stderr).toMatch(/(?:^|\n) 4 pass(?:\n|$)/)
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
  const ops = await import('../../services/plugins/pluginOperations.js')
  const { resetSettingsCache } = await import('../../utils/settings/settingsCache.js')
  const { marketplaceRemoveHandler, pluginListHandler } = await import('./plugins.js')

  const market = join(root, 'mk')
  for (const name of ['base', 'child']) {
    mkdirSync(join(market, name, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(market, name, '.claude-plugin/plugin.json'),
      JSON.stringify({ name, version: '1.0.0', description: name }),
    )
  }
  mkdirSync(join(market, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(market, '.claude-plugin/marketplace.json'),
    JSON.stringify({
      name: 'mk',
      owner: { name: 'x' },
      plugins: ['base', 'child'].map(name => ({ name, source: `./${name}` })),
    }),
  )
  await mm.addMarketplaceSource({ source: 'directory', path: market })
  expect((await ops.installPluginOp('base@mk', 'user')).success).toBe(true)
  expect((await ops.installPluginOp('child@mk', 'user')).success).toBe(true)
  expect((await ops.installPluginOp('child@mk', 'project')).success).toBe(true)
  // The user turns child off; the project settings still turn it on.
  const userSettings = join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json')
  const settings = JSON.parse(readFileSync(userSettings, 'utf-8'))
  settings.enabledPlugins['child@mk'] = false
  writeFileSync(userSettings, JSON.stringify(settings))
  resetSettingsCache()

  async function run(handler: () => Promise<void>): Promise<string> {
    let out = ''
    const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => { out += args.join(' ') + '\n' })
    const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { out += chunk; return true }) as never)
    const exit = spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit') }) as never)
    try {
      await handler().catch(error => { if ((error as Error).message !== 'exit') throw error })
    } finally {
      log.mockRestore()
      write.mockRestore()
      exit.mockRestore()
    }
    return out
  }
  const list = (options: { json?: boolean }) => run(() => pluginListHandler(options))

  const note = 'Note: Disabled in ~/.claude/settings.json but still loads \u2014 project settings enable it, which overrides your user setting'

  // As official 2.1.329 (evidence 24-list-after-scopes).
  test('the text listing shows the folder and the override note', async () => {
    expect(await list({})).toBe([
      'Installed plugins:',
      '',
      '  \u276f base@mk', '    Version: 1.0.0', `    Read from: ${market}/base`, '    Scope: user', '    Status: \u2714 enabled', '',
      '  \u276f child@mk', '    Version: 1.0.0', `    Read from: ${market}/child`, '    Scope: user', '    Status: \u2714 enabled', `    ${note}`, '',
      '  \u276f child@mk', '    Version: 1.0.0', `    Read from: ${market}/child`, '    Scope: project', '    Status: \u2714 enabled', `    ${note}`, '',
      '',
    ].join('\n'))
  })

  // As official 2.1.329 (evidence 06-list-json).
  test('the JSON listing carries readFromFolder, folderVersion, notes and projectEnabled', async () => {
    const rows = JSON.parse(await list({ json: true })) as Record<string, unknown>[]
    expect(rows.map(({ id, scope, readFromFolder, folderVersion, notes, projectEnabled }) => ({ id, scope, readFromFolder, folderVersion, notes, projectEnabled }))).toEqual([
      { id: 'base@mk', scope: 'user', readFromFolder: `${market}/base`, folderVersion: '1.0.0', notes: undefined, projectEnabled: false },
      { id: 'child@mk', scope: 'user', readFromFolder: `${market}/child`, folderVersion: '1.0.0', notes: [note.slice('Note: '.length)], projectEnabled: true },
      { id: 'child@mk', scope: 'project', readFromFolder: `${market}/child`, folderVersion: '1.0.0', notes: [note.slice('Note: '.length)], projectEnabled: true },
    ])
    expect(Object.keys(rows[0]!).slice(0, 7)).toEqual(['id', 'version', 'scope', 'enabled', 'installPath', 'readFromFolder', 'folderVersion'])
  })

  // As official 2.1.329 (evidence 20-install-missing, 21-install-nomkt).
  test('a plugin a marketplace does not list points at updating that marketplace', async () => {
    expect((await ops.installPluginOp('nope@mk', 'user')).message).toBe(
      'Plugin "nope" not found in marketplace "mk". Your local copy may be out of date \u2014 try `claude plugin marketplace update mk`.',
    )
    expect((await ops.installPluginOp('nope', 'user')).message).toBe('Plugin "nope" not found in any configured marketplace')
  })

  // As official 2.1.329 (evidence 61-mkt-remove).
  test('removing a marketplace lists the plugins it uninstalled', async () => {
    expect(await run(() => marketplaceRemoveHandler('mk', {}))).toBe([
      '\u2714 Successfully removed marketplace: mk',
      'Also uninstalled 2 plugins from this marketplace:',
      '  base@mk',
      '  child@mk',
      'The removal also deletes their saved options, secrets and data where it can.',
      'To use a plugin again, add the marketplace back and reinstall the plugin.',
      '',
    ].join('\n'))
  })
}
