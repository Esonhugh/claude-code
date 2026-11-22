import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childFlag = 'CLAUDE_CODE_IN_PLACE_TRUST_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  // Loader state, settings and trust are cached per process.
  test('plugins loaded in place from an untrusted workspace (isolated)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'in-place-trust-')))
    try {
      const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value))
      const market = join(root, 'mkt')
      mkdirSync(join(market, '.claude-plugin'), { recursive: true })
      mkdirSync(join(market, 'demo', '.claude-plugin'), { recursive: true })
      mkdirSync(join(root, 'project', '.claude'), { recursive: true })
      write(join(market, '.claude-plugin', 'marketplace.json'), { name: 'mkt', owner: { name: 'lab' }, plugins: [{ name: 'demo', source: './demo' }] })
      write(join(market, 'demo', '.claude-plugin', 'plugin.json'), { name: 'demo' })
      write(join(root, 'project', '.claude', 'settings.json'), {
        extraKnownMarketplaces: { mkt: { source: { source: 'directory', path: market } } },
        enabledPlugins: { 'demo@mkt': true },
      })
      const child = Bun.spawn([process.execPath, 'test', '--no-env-file', import.meta.path], {
        cwd: join(root, 'project'),
        env: { PATH: process.env.PATH, [childFlag]: '1', HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'config'),
          TMPDIR: root, DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' } as MacroGlobals
  const { setCwdState, setOriginalCwd, setSessionTrustAccepted } = await import('../../bootstrap/state.js')
  const { enableConfigs } = await import('../config.js')
  const loader = await import('./pluginLoader.js')

  setOriginalCwd(process.cwd())
  setCwdState(process.cwd())
  enableConfigs()

  const loaded = async () => {
    loader.clearPluginCache()
    return (await loader.loadAllPlugins()).enabled.map(plugin => plugin.source)
  }

  // Official 2.1.329: the folder's own settings cannot point the loader at a
  // marketplace directory before the folder is trusted.
  test('a directory marketplace declared by the project loads only once the folder is trusted', async () => {
    expect(await loaded()).not.toContain('demo@mkt')
    setSessionTrustAccepted(true)
    expect(await loaded()).toContain('demo@mkt')
  })
}
