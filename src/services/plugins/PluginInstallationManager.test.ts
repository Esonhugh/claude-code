import { expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppState } from '../../state/AppState.js'

// Plugin and settings state is process-wide, so the case runs in a fresh child
// whose HOME and config dir are owned by this test.
if (!process.env.PIM_BACKGROUND_TEST_CHILD) {
  test('background marketplace install', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'pim-background-')))
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: home,
        CLAUDE_CONFIG_DIR: join(home, 'config'),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
        PIM_BACKGROUND_TEST_CHILD: '1',
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
    expect(stderr).toMatch(/(?:^|\n) 1 pass(?:\n|$)/)
    expect(code).toBe(0)
  }, 60000)
} else {
  const root = process.env.HOME!
  ;(globalThis as any).MACRO = { VERSION: 'test' }
  const { setOriginalCwd } = await import('../../bootstrap/state.js')
  setOriginalCwd(root)
  const { addMarketplaceSource } = await import(
    '../../utils/plugins/marketplaceManager.js'
  )
  const { updateSettingsForSource } = await import(
    '../../utils/settings/settings.js'
  )
  const reconciler = await import('../../utils/plugins/reconciler.js')

  const write = (path: string, content: unknown) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(content))
  }
  const commit = (dir: string) =>
    execFileSync(
      'sh',
      [
        '-c',
        'git init -q && git add -A && git -c user.email=a@b -c user.name=n commit -qm init',
      ],
      { cwd: dir },
    )

  test('plugins of a newly installed marketplace load without a restart, remote sources included', async () => {
    const pluginRepo = join(root, 'plugin-repo')
    write(join(pluginRepo, '.claude-plugin', 'plugin.json'), {
      name: 'rp',
      version: '1.0.0',
    })
    write(join(pluginRepo, 'commands', 'hello.md'), 'hello')
    commit(pluginRepo)
    const marketplace = join(root, 'marketplace')
    write(join(marketplace, '.claude-plugin', 'marketplace.json'), {
      name: 'gm',
      owner: { name: 'fixture' },
      plugins: [
        { name: 'rp', source: { source: 'url', url: `file://${pluginRepo}` } },
      ],
    })
    commit(marketplace)
    updateSettingsForSource('userSettings', {
      enabledPlugins: { 'rp@gm': true },
    })
    // Materialize only the fixture marketplace; implicitly declared remote
    // marketplaces stay untouched so the test never reaches the network.
    mock.module('../../utils/plugins/reconciler.js', () => ({
      ...reconciler,
      reconcileMarketplaces: async () => {
        await addMarketplaceSource({
          source: 'git',
          url: `file://${marketplace}`,
        })
        return { installed: ['gm'], updated: [], failed: [], upToDate: [], skipped: [] }
      },
    }))
    const { performBackgroundPluginInstallations } = await import(
      './PluginInstallationManager.js'
    )
    let state = {
      plugins: {
        enabled: [],
        disabled: [],
        commands: [],
        errors: [],
        needsRefresh: false,
        installationStatus: { marketplaces: [], plugins: [] },
      },
      mcp: {
        pluginReconnectKey: 0,
        clients: [],
        tools: [],
        commands: [],
        resources: {},
      },
      agentDefinitions: { allAgents: [], activeAgents: [] },
    } as unknown as AppState
    await performBackgroundPluginInstallations(update => {
      state = update(state)
    })
    expect(state.plugins.errors).toEqual([])
    expect(state.plugins.enabled.map(plugin => plugin.name)).toContain('rp')
    expect(state.plugins.commands.map(command => command.name)).toContain(
      'rp:hello',
    )
    expect(state.plugins.needsRefresh).toBe(false)
  })
}
