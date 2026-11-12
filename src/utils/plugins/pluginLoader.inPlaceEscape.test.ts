import { expect, mock, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Loader state (settings, memoized catalogs) is process-wide, so the cases run
// in a fresh child whose HOME and config dir are owned by this test.
if (!process.env.PL2_IN_PLACE_ESCAPE_TEST_CHILD) {
  test('plugins loaded in place do not follow links out of their marketplace', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'pl2-in-place-escape-')))
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: home,
        CLAUDE_CONFIG_DIR: join(home, 'config'),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        PL2_IN_PLACE_ESCAPE_TEST_CHILD: '1',
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
    expect(stderr).toMatch(/(?:^|\n) 3 pass(?:\n|$)/)
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
  const commands = await import('./loadPluginCommands.js')
  const mcp = await import('./mcpPluginIntegration.js')

  const write = (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value))
  const skill = (dir: string, name: string) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name}\n---\nbody\n`,
    )
  }

  const outside = join(root, 'outside')
  skill(join(outside, 'leak'), 'leak')
  mkdirSync(join(outside, 'agents'))
  writeFileSync(
    join(outside, 'agents', 'spy.md'),
    '---\nname: spy\ndescription: spy\n---\nbody\n',
  )
  write(join(outside, 'hooks.json'), {
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] },
  })
  write(join(outside, 'mcp.json'), {
    mcpServers: { spy: { command: 'true' } },
  })

  const market = join(root, 'mkt')
  const linky = join(market, 'linky')
  mkdirSync(join(market, '.claude-plugin'), { recursive: true })
  write(join(market, '.claude-plugin/marketplace.json'), {
    name: 'mkt',
    owner: { name: 'lab' },
    plugins: [{ name: 'linky', source: './linky' }],
  })
  skill(join(market, 'shared'), 'shared')
  mkdirSync(join(linky, '.claude-plugin'), { recursive: true })
  write(join(linky, '.claude-plugin/plugin.json'), { name: 'linky' })
  skill(join(linky, 'skills', 'ok'), 'ok')
  symlinkSync(join(outside, 'leak'), join(linky, 'skills', 'leak'))
  mkdirSync(join(linky, 'skills', 'viafile'))
  symlinkSync(
    join(outside, 'leak', 'SKILL.md'),
    join(linky, 'skills', 'viafile', 'SKILL.md'),
  )
  symlinkSync('../../shared', join(linky, 'skills', 'shared'))
  symlinkSync(join(outside, 'agents'), join(linky, 'agents'))
  mkdirSync(join(linky, 'hooks'))
  symlinkSync(join(outside, 'hooks.json'), join(linky, 'hooks', 'hooks.json'))
  symlinkSync(join(outside, 'mcp.json'), join(linky, '.mcp.json'))

  const pluginsDir = join(root, 'config/plugins')
  mkdirSync(pluginsDir, { recursive: true })
  write(join(pluginsDir, 'known_marketplaces.json'), {
    mkt: {
      source: { source: 'directory', path: market },
      installLocation: market,
      lastUpdated: new Date().toISOString(),
    },
  })
  state.setFlagSettingsInline({ enabledPlugins: { 'linky@mkt': true } })
  settingsCache.resetSettingsCache()

  test('reports each component that escapes the plugin directory', async () => {
    loader.clearPluginCache()
    const { errors } = await loader.loadAllPlugins()
    const messages = errors
      .filter(e => e.source === 'linky@mkt' && e.type === 'generic-error')
      .map(e => (e as { error: string }).error)
    expect(messages).toEqual(
      expect.arrayContaining([
        `Path escapes plugin directory: ${join(linky, 'agents')} (agents)`,
        `Path escapes plugin directory: ${join(linky, 'hooks', 'hooks.json')} (hooks)`,
        `Path escapes plugin directory: ${join(linky, 'skills', 'leak', 'SKILL.md')} (skills)`,
        `Path escapes plugin directory: ${join(linky, 'skills', 'viafile', 'SKILL.md')} (skills)`,
      ]),
    )
  })

  test('loads none of the outside agents, hooks or MCP servers', async () => {
    loader.clearPluginCache()
    const { enabled } = await loader.loadAllPlugins()
    const plugin = enabled.find(p => p.source === 'linky@mkt')!
    expect(plugin.agentsPath).toBeUndefined()
    expect(plugin.hooksConfig).toBeUndefined()
    expect(await mcp.loadPluginMcpServers(plugin)).toBeUndefined()
  })

  test('loads only skills inside the marketplace', async () => {
    loader.clearPluginCache()
    commands.clearPluginSkillsCache()
    const names = (await commands.getPluginSkills()).map(c => c.name).sort()
    expect(names).toEqual(['linky:ok', 'linky:shared'])
  })
}
