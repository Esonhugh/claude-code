import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Plugin registry, settings and cache paths are process-wide, so the cases run
// in a child whose HOME and config dir are owned by this test.
if (!process.env.PLUGIN_OPS_LIFECYCLE_TEST_CHILD) {
  test('plugin update and project installs keep their records consistent', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-ops-')))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: home,
          CLAUDE_CONFIG_DIR: join(home, 'config'),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          PLUGIN_OPS_LIFECYCLE_TEST_CHILD: '1',
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
      expect(stderr).toMatch(/(?:^|\n) 5 pass(?:\n|$)/)
      expect(code).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 60000)
} else {
  const root = process.env.HOME!
  ;(globalThis as any).MACRO = { VERSION: 'test' }
  const project = join(root, 'project')
  mkdirSync(join(project, 'sub'), { recursive: true })
  const state = await import('../../bootstrap/state.js')
  state.setOriginalCwd(project)
  state.setCwdState(project)
  const mm = await import('../../utils/plugins/marketplaceManager.js')
  const ops = await import('./pluginOperations.js')
  const installed = await import(
    '../../utils/plugins/installedPluginsManager.js'
  )
  const settingsCache = await import('../../utils/settings/settingsCache.js')

  const market = join(root, 'mkt')
  mkdirSync(join(market, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(market, '.claude-plugin/marketplace.json'),
    JSON.stringify({
      name: 'mkt',
      owner: { name: 'x' },
      plugins: [{ name: 'p', source: './p' }],
    }),
  )
  mkdirSync(join(market, 'p/.claude-plugin'), { recursive: true })
  writeFileSync(
    join(market, 'p/.claude-plugin/plugin.json'),
    JSON.stringify({ name: 'p', version: '1.0.0' }),
  )
  mkdirSync(join(market, 'p/skills/s'), { recursive: true })
  writeFileSync(
    join(market, 'p/skills/s/SKILL.md'),
    '---\nname: s\ndescription: d\n---\nbody',
  )
  await mm.addMarketplaceSource({ source: 'directory', path: market })

  const records = () => {
    installed.clearInstalledPluginsCache()
    return installed.loadInstalledPluginsFromDisk().plugins['p@mkt'] ?? []
  }

  test('an up-to-date update leaves the installed version directory alone', async () => {
    expect((await ops.installPluginOp('p@mkt', 'user')).success).toBe(true)
    const installPath = records().find(r => r.scope === 'user')!.installPath
    const inode = statSync(installPath).ino
    // A file only the live directory has: a rebuild from source drops it.
    writeFileSync(join(installPath, 'live-marker'), '')
    const result = await ops.updatePluginOp('p@mkt', 'user')
    expect(result).toMatchObject({ success: true, alreadyUpToDate: true })
    expect(statSync(installPath).ino).toBe(inode)
    expect(existsSync(join(installPath, 'live-marker'))).toBe(true)
  })

  test('an up-to-date update restores a missing version directory', async () => {
    const installPath = records().find(r => r.scope === 'user')!.installPath
    rmSync(installPath, { recursive: true, force: true })
    const result = await ops.updatePluginOp('p@mkt', 'user')
    expect(result).toMatchObject({ success: true, alreadyUpToDate: true })
    expect(
      existsSync(join(installPath, '.claude-plugin/plugin.json')),
    ).toBe(true)
  })

  test('installing an installed version at another scope reuses its directory', async () => {
    const installPath = records().find(r => r.scope === 'user')!.installPath
    const inode = statSync(installPath).ino
    writeFileSync(join(installPath, 'live-marker'), '')
    expect((await ops.installPluginOp('p@mkt', 'project')).success).toBe(true)
    expect(
      records().find(r => r.scope === 'project')!.installPath,
    ).toBe(installPath)
    expect(statSync(installPath).ino).toBe(inode)
    expect(existsSync(join(installPath, 'live-marker'))).toBe(true)
    expect((await ops.uninstallPluginOp('p@mkt', 'project')).success).toBe(
      true,
    )
    expect(existsSync(installPath)).toBe(true)
  })

  test('a project install after the working directory moved stays manageable', async () => {
    state.setCwdState(join(project, 'sub'))
    try {
      expect((await ops.installPluginOp('p@mkt', 'project')).success).toBe(
        true,
      )
      expect(
        records()
          .filter(r => r.scope === 'project')
          .map(r => r.projectPath),
      ).toEqual([project])
      expect(await ops.updatePluginOp('p@mkt', 'project')).toMatchObject({
        success: true,
        alreadyUpToDate: true,
      })
      expect((await ops.uninstallPluginOp('p@mkt', 'project')).success).toBe(
        true,
      )
      expect(records().filter(r => r.scope === 'project')).toEqual([])
    } finally {
      state.setCwdState(project)
    }
  })

  test('settings migration records project installs under the original project', async () => {
    mkdirSync(join(project, '.claude'), { recursive: true })
    writeFileSync(
      join(project, '.claude/settings.json'),
      // The unknown plugin forces the sync past its "all present" shortcut.
      JSON.stringify({ enabledPlugins: { 'p@mkt': true, 'q@absent': true } }),
    )
    settingsCache.resetSettingsCache()
    state.setCwdState(join(project, 'sub'))
    try {
      await installed.migrateFromEnabledPlugins()
    } finally {
      state.setCwdState(project)
    }
    const registry = JSON.parse(
      readFileSync(installed.getInstalledPluginsFilePath(), 'utf-8'),
    )
    expect(
      registry.plugins['p@mkt'].map(
        (r: { scope: string; projectPath?: string }) => [
          r.scope,
          r.projectPath,
        ],
      ),
    ).toEqual([['project', project]])
  })
}
