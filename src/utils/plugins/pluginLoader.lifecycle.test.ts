import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Loader state (settings, installed registry, memoized loads) is process-wide,
// so the cases run in a fresh child whose HOME and config dir are owned here.
if (!process.env.PL_LIFECYCLE_TEST_CHILD) {
  test('plugin loader lifecycle', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'pl-lifecycle-')))
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: home,
        CLAUDE_CONFIG_DIR: join(home, 'config'),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
        PL_LIFECYCLE_TEST_CHILD: '1',
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
  }, 60000)
} else {
  const root = process.env.HOME!
  ;(globalThis as any).MACRO = { VERSION: 'test' }
  const state = await import('../../bootstrap/state.js')
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  state.setOriginalCwd(project)
  const loader = await import('./pluginLoader.js')
  const installed = await import('./installedPluginsManager.js')
  const { addMarketplaceSource } = await import('./marketplaceManager.js')
  const { installPluginOp } = await import(
    '../../services/plugins/pluginOperations.js'
  )
  const { getSettings_DEPRECATED } = await import('../settings/settings.js')

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
  const manifest = (dir: string, content: Record<string, unknown>) =>
    write(join(dir, '.claude-plugin', 'plugin.json'), content)

  test('loads the installation recorded for this project, not one from another project', async () => {
    const pluginRepo = join(root, 'plugin-repo')
    manifest(pluginRepo, { name: 'rp', version: '1.0.0' })
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
    await addMarketplaceSource({ source: 'git', url: `file://${marketplace}` })
    expect((await installPluginOp('rp@gm', 'user')).success).toBe(true)

    const copy = (version: string) => {
      const path = loader.getVersionedCachePath('rp@gm', version)
      manifest(path, { name: 'rp', version })
      return path
    }
    const record = (entry: Record<string, unknown>) => {
      const data = installed.loadInstalledPluginsFromDisk()
      data.plugins['rp@gm']!.unshift({
        installedAt: '2026-09-01T00:00:00.000Z',
        lastUpdated: '2026-09-01T00:00:00.000Z',
        ...entry,
      } as never)
      writeFileSync(installed.getInstalledPluginsFilePath(), JSON.stringify(data))
      installed.clearInstalledPluginsCache()
    }
    const versions = async () => {
      loader.clearPluginCache()
      const cacheOnly = await loader.loadAllPluginsCacheOnly()
      loader.clearPluginCache()
      const full = await loader.loadAllPlugins()
      return [cacheOnly, full].map(result => {
        expect(result.errors).toEqual([])
        return result.enabled.find(plugin => plugin.name === 'rp')?.manifest
          .version
      })
    }

    record({
      scope: 'project',
      projectPath: join(root, 'other-project'),
      installPath: copy('0.0.1'),
      version: '0.0.1',
    })
    expect(await versions()).toEqual(['1.0.0', '1.0.0'])

    record({
      scope: 'local',
      projectPath: project,
      installPath: copy('3.0.0'),
      version: '3.0.0',
    })
    expect(await versions()).toEqual(['3.0.0', '3.0.0'])
  })

  test('disabling the last plugin that supplies settings drops them', () => {
    loader.cachePluginSettings([
      { name: 'p', settings: { agent: 'plugin-agent' } } as never,
    ])
    expect(getSettings_DEPRECATED().agent).toBe('plugin-agent')
    loader.cachePluginSettings([])
    expect(getSettings_DEPRECATED().agent).toBeUndefined()
  })

  test('manifest defaultEnabled applies only without an explicit setting', async () => {
    const dir = (name: string, extra: Record<string, unknown>) => {
      const path = join(root, 'inline', name)
      manifest(path, { name, ...extra })
      return path
    }
    const off = dir('off', { defaultEnabled: false })
    const on = dir('on', {})
    const load = async (enabledPlugins: Record<string, boolean>) =>
      Object.fromEntries(
        (await loader.loadSessionOnlyPlugins([off, on], enabledPlugins)).plugins.map(
          plugin => [plugin.name, plugin.enabled],
        ),
      )
    expect(await load({})).toEqual({ off: false, on: true })
    expect(await load({ 'off@inline': true, 'on@inline': false })).toEqual({
      off: true,
      on: false,
    })
  })
}
