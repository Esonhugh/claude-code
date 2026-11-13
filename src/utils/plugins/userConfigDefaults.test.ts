import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LoadedPlugin } from '../../types/plugin.js'
import { getPluginLspServers } from './lspPluginIntegration.js'
import { getPluginMcpServers } from './mcpPluginIntegration.js'

const root = mkdtempSync(join(tmpdir(), 'plugin-user-config-defaults-'))
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = root

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(root, { recursive: true, force: true })
})

const plugin = {
  name: 'cfg',
  path: root,
  source: 'cfg@inline',
  repository: 'cfg@inline',
  enabled: true,
  manifest: {
    name: 'cfg',
    userConfig: {
      region: { type: 'string', title: 'Region', description: 'r', default: 'eu' },
      opt: { type: 'string', title: 'Opt', description: 'o' },
    },
  },
  mcpServers: {
    srv: { command: 'run', args: ['${user_config.region}', '${user_config.opt}'] },
  },
  lspServers: {
    lsp: {
      command: 'run',
      args: ['${user_config.region}', '${user_config.opt}'],
      extensionToLanguage: { '.x': 'x' },
    },
  },
} as unknown as LoadedPlugin

// Official 2.1.322 starts the server with the declared default and an empty
// string for an unset optional field.
test('plugin MCP servers resolve ${user_config.X} from the declared default when nothing is saved', async () => {
  const errors: unknown[] = []
  const servers = await getPluginMcpServers(plugin, errors as never)
  expect(errors).toEqual([])
  expect(servers?.['plugin:cfg:srv']).toMatchObject({ args: ['eu', ''] })
})

test('plugin LSP servers resolve ${user_config.X} from the declared default when nothing is saved', async () => {
  const servers = await getPluginLspServers(plugin, [])
  expect(servers?.['plugin:cfg:lsp']).toMatchObject({ args: ['eu', ''] })
})
