import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Marketplace and plugin state is process-wide, so the case runs in a child
// whose HOME and config dir are owned by this test.
if (!process.env.PLUGIN_AUTOUPDATE_TEST_CHILD) {
  test('autoupdate refreshes marketplaces whose names are not lowercase', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-autoupdate-')))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: home,
          CLAUDE_CONFIG_DIR: join(home, 'config'),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          FORCE_AUTOUPDATE_PLUGINS: '1',
          PLUGIN_AUTOUPDATE_TEST_CHILD: '1',
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
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 60000)
} else {
  const root = process.env.HOME!
  ;(globalThis as any).MACRO = { VERSION: 'test' }
  const state = await import('../../bootstrap/state.js')
  state.setOriginalCwd(root)
  const mm = await import('./marketplaceManager.js')
  const ops = await import('../../services/plugins/pluginOperations.js')
  const installed = await import('./installedPluginsManager.js')
  const autoupdate = await import('./pluginAutoupdate.js')

  const repo = join(root, 'repo')
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.email=a@b',
        '-c',
        'user.name=n',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: repo, stdio: 'pipe' },
    )
  const publish = (version: string) => {
    writeFileSync(
      join(repo, 'p/.claude-plugin/plugin.json'),
      JSON.stringify({ name: 'p', version }),
    )
    git('add', '-A')
    git('commit', '-qm', version)
  }
  mkdirSync(join(repo, '.claude-plugin'), { recursive: true })
  mkdirSync(join(repo, 'p/.claude-plugin'), { recursive: true })
  writeFileSync(
    join(repo, '.claude-plugin/marketplace.json'),
    JSON.stringify({
      name: 'Mixed-Case',
      owner: { name: 'x' },
      plugins: [{ name: 'p', source: './p' }],
    }),
  )
  git('init', '-q')
  publish('1.0.0')

  test('a plugin from a mixed-case marketplace is updated from the refreshed clone', async () => {
    await mm.addMarketplaceSource({ source: 'git', url: `file://${repo}` })
    await mm.setMarketplaceAutoUpdate('Mixed-Case', true)
    expect((await ops.installPluginOp('p@Mixed-Case', 'user')).success).toBe(
      true,
    )
    publish('2.0.0')

    const updated = new Promise<string[]>(resolve => {
      autoupdate.onPluginsAutoUpdated(resolve)
    })
    autoupdate.autoUpdateMarketplacesAndPluginsInBackground()
    const result = await Promise.race([
      updated,
      new Promise<string>(resolve => setTimeout(() => resolve('timeout'), 15000)),
    ])
    expect(result).toEqual(['p@Mixed-Case'])
    installed.clearInstalledPluginsCache()
    expect(
      installed.loadInstalledPluginsFromDisk().plugins['p@Mixed-Case']![0]!
        .version,
    ).toBe('2.0.0')
  }, 30000)
}
