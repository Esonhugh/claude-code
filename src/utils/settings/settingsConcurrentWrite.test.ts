import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Separate CLI processes (e.g. parallel `claude plugin install`) each read,
// merge and write settings.json and installed_plugins.json; no write may
// drop another process's entry.
const WRITERS = 6, ROUNDS = 5

if (!process.env.SETTINGS_WRITER) {
  test('concurrent processes keep every settings and registry entry', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'settings-concurrent-')))
    const children = Array.from({ length: WRITERS }, (_, writer) => Bun.spawn([process.execPath, import.meta.path], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, CLAUDE_CONFIG_DIR: join(home, 'config'),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', SETTINGS_WRITER: String(writer) },
      stdout: 'pipe', stderr: 'pipe',
    }))
    const outcomes = await Promise.all(children.map(async child => [await child.exited, await new Response(child.stderr).text()] as const))
    for (const [code, stderr] of outcomes) expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    const expected = Array.from({ length: WRITERS * ROUNDS }, (_, i) => `p${Math.floor(i / ROUNDS)}-${i % ROUNDS}@m`).sort()
    const settings = JSON.parse(readFileSync(join(home, 'config/settings.json'), 'utf8'))
    expect(Object.keys(settings.enabledPlugins).sort()).toEqual(expected)
    const registry = JSON.parse(readFileSync(join(home, 'config/plugins/installed_plugins.json'), 'utf8'))
    expect(Object.keys(registry.plugins).sort()).toEqual(expected)
  }, 60000)
} else {
  ;(globalThis as any).MACRO = { VERSION: 'test' }
  const { setOriginalCwd } = await import('../../bootstrap/state.js')
  setOriginalCwd(process.env.HOME!)
  const { updateSettingsForSource } = await import('./settings.js')
  const { addPluginInstallation } = await import('../plugins/installedPluginsManager.js')
  const writer = process.env.SETTINGS_WRITER
  for (let round = 0; round < ROUNDS; round++) {
    const id = `p${writer}-${round}@m`
    const { error } = updateSettingsForSource('userSettings', { enabledPlugins: { [id]: true } })
    if (error) throw error
    addPluginInstallation(id, 'user', join(process.env.HOME!, 'cache', id), { version: '1.0.0' })
  }
}
