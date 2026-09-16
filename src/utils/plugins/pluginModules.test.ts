import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginHooksSchema } from './schemas.js'

const childFlag = 'CLAUDE_CODE_INLINE_PLUGIN_TEST_CHILD'

if (!process.env[childFlag]) {
  test('inline plugin settings and commands agree across reloads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inline-plugin-toggle-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          CLAUDE_CONFIG_DIR: join(root, 'config'),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          [childFlag]: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      expect(code).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
    VERSION: 'test',
  }
  test('persists inline disable/enable without treating inline as a marketplace', async () => {
    const root = process.env.HOME!
    const plugin = join(root, 'plugin')
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
    mkdirSync(join(plugin, 'hooks'))
    writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'toggle-fixture' }))
    writeFileSync(join(plugin, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))
    writeFileSync(join(plugin, 'hooks/register.ts'), 'export function register() {}')
    const { setOriginalCwd, setInlinePlugins } = await import('../../bootstrap/state.js')
    const { loadAllPluginsCacheOnly, clearPluginCache } = await import('./pluginLoader.js')
    const { getSettingsForSource, updateSettingsForSource } = await import('../settings/settings.js')
    const { disablePluginOp, enablePluginOp } = await import('../../services/plugins/pluginOperations.js')
    setOriginalCwd(root)
    setInlinePlugins([plugin])
    const id = 'toggle-fixture@inline'
    const load = async () => {
      clearPluginCache()
      const result = await loadAllPluginsCacheOnly()
      expect(result.errors).toEqual([])
      return result
    }
    expect((await load()).enabled.map(p => p.source)).toEqual([id])
    expect(updateSettingsForSource('userSettings', { enabledPlugins: { [id]: false } }).error).toBeNull()
    expect((await load()).disabled.map(p => p.source)).toEqual([id])
    expect((await enablePluginOp(id)).success).toBe(true)
    expect((await load()).enabled.map(p => p.source)).toEqual([id])
    // --plugin-dir enables by default even before an editable settings entry exists.
    expect(updateSettingsForSource('userSettings', { enabledPlugins: { [id]: undefined } }).error).toBeNull()
    expect((await load()).enabled.map(p => p.source)).toEqual([id])
    expect((await disablePluginOp('toggle-fixture')).success).toBe(true)
    expect(getSettingsForSource('userSettings')?.enabledPlugins?.[id]).toBe(false)
    expect((await load()).disabled.map(p => p.source)).toEqual([id])
    expect((await disablePluginOp(id)).message).toContain('already disabled')
    expect((await enablePluginOp('toggle-fixture')).success).toBe(true)
    expect((await load()).enabled.map(p => p.source)).toEqual([id])
    expect((await disablePluginOp(id, 'local')).success).toBe(true)
    expect(getSettingsForSource('localSettings')?.enabledPlugins?.[id]).toBe(false)
    expect((await load()).disabled.map(p => p.source)).toEqual([id])
    expect((await enablePluginOp(id)).scope).toBe('local')
    expect((await load()).enabled.map(p => p.source)).toEqual([id])
    setInlinePlugins([])
    expect((await load()).enabled).toEqual([])
    expect((await load()).disabled).toEqual([])
  })
}

describe('plugin module declarations', () => {
  test('retains modules-only declarations', () => {
    expect(PluginHooksSchema().parse({ modules: ['./register.ts'] })).toEqual({ modules: ['./register.ts'] })
  })
  test('keeps classic hooks and module declarations together', () => {
    const input = { hooks: {}, modules: ['./register.ts'] }
    expect(PluginHooksSchema().parse(input)).toEqual(input)
    expect(PluginHooksSchema().parse({ hooks: {} })).toEqual({ hooks: {} })
  })
  test('rejects an empty declaration and non-relative module paths', () => {
    expect(PluginHooksSchema().safeParse({}).success).toBe(false)
    expect(PluginHooksSchema().safeParse({ modules: ['/outside.ts'] }).success).toBe(false)
    expect(PluginHooksSchema().safeParse({ modules: ['node:fs'] }).success).toBe(false)
  })
})
