import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadSessionOnlyPlugins } from './pluginLoader.js'
import { extractMcpServersFromPlugins, loadPluginMcpServers } from './mcpPluginIntegration.js'
import type { PluginError } from '../../types/plugin.js'

let directory: string | undefined
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

test('skipMcpDiscovery keeps the plugin command while bypassing manifest and file servers', async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'sdk-launch-plugin-')))
  await mkdir(join(directory, '.claude-plugin'))
  await mkdir(join(directory, 'commands'))
  await writeFile(join(directory, '.claude-plugin/plugin.json'), JSON.stringify({
    name: 'launch-probe',
    mcpServers: { manifest: { command: 'must-not-spawn-manifest', args: [] } },
  }))
  await writeFile(join(directory, 'commands/hello.md'), '---\ndescription: Launch probe\n---\nHello')
  await writeFile(join(directory, '.mcp.json'), JSON.stringify({ mcpServers: { file: { command: 'must-not-spawn-file', args: [] } } }))
  const skipped = await loadSessionOnlyPlugins([directory], {}, false, new Set([directory]))
  expect(skipped.errors).toEqual([])
  const plugin = skipped.plugins[0]!
  expect(plugin.skipMcpDiscovery).toBe(true)
  expect(plugin.commandsPath).toBe(join(directory, 'commands'))
  const errors: PluginError[] = []
  expect(await loadPluginMcpServers(plugin, errors)).toBeUndefined()
  expect(await extractMcpServersFromPlugins([plugin], errors)).toEqual({})
  expect(errors).toEqual([])
  const regular = await loadSessionOnlyPlugins([directory], {}, false)
  expect(regular.errors).toEqual([])
  expect(regular.plugins[0]!.skipMcpDiscovery).toBeUndefined()
  expect(Object.keys((await loadPluginMcpServers(regular.plugins[0]!))!)).toEqual(['file', 'manifest'])
})
