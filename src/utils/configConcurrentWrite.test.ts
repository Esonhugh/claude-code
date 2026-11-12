import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Separate CLI processes (e.g. parallel `claude mcp add -s user`) each read,
// merge and write ~/.claude.json; no write may drop another process's server.
const WRITERS = 12

if (!process.env.CONFIG_WRITER) {
  test('concurrent processes keep every ~/.claude.json entry', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'config-concurrent-')))
    const configDir = join(home, 'config')
    const children = Array.from({ length: WRITERS }, (_, writer) => Bun.spawn([process.execPath, import.meta.path], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CONFIG_WRITER: String(writer) },
      stdout: 'pipe', stderr: 'pipe',
    }))
    const outcomes = await Promise.all(children.map(async child => [await child.exited, await new Response(child.stderr).text()] as const))
    for (const [code, stderr] of outcomes) expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    const config = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8'))
    expect(Object.keys(config.mcpServers).sort()).toEqual(Array.from({ length: WRITERS }, (_, i) => `srv${i}`).sort())
  }, 60000)
} else {
  ;(globalThis as any).MACRO = { VERSION: 'test' }
  const { enableConfigs, saveGlobalConfig } = await import('./config.js')
  enableConfigs()
  const name = `srv${process.env.CONFIG_WRITER}`
  saveGlobalConfig(current => ({ ...current, mcpServers: { ...current.mcpServers, [name]: { type: 'stdio', command: 'true', args: [] } } }))
}
