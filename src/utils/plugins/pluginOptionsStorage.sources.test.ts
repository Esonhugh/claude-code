import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import {
  getAllowedSettingSources,
  setAllowedSettingSources,
} from '../../bootstrap/state.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import * as settings from '../settings/settings.js'
import type { SettingSource } from '../settings/constants.js'
import type { SettingsJson } from '../settings/types.js'

let secrets: Record<string, Record<string, string>> = {}
const secureStorage = {
  read: mock(() => ({ pluginSecrets: secrets })),
  update: mock(() => ({ success: true })),
}
mock.module('../secureStorage/index.js', () => ({
  getSecureStorage: () => secureStorage,
}))

const {
  clearPluginOptionsCache,
  getUnconfiguredOptions,
  loadPluginOptions,
  savePluginOptions,
} = await import('./pluginOptionsStorage.js')
const { loadMcpServerUserConfig, saveMcpServerUserConfig } = await import(
  './mcpbHandler.js'
)

const ID = 'demo@mkt'
let bySource: Partial<Record<SettingSource, SettingsJson | null>> = {}
let writes: Array<{ source: string; values: SettingsJson }> = []
const originalAllowed = getAllowedSettingSources()

function options(values: Record<string, string>, server?: string) {
  return server
    ? { mcpServers: { [server]: values } }
    : { options: values }
}

beforeEach(() => {
  secrets = {}
  writes = []
  bySource = {
    userSettings: { pluginConfigs: { [ID]: options({ url: 'user' }) } },
    projectSettings: {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'project' }] }] },
      pluginConfigs: {
        [ID]: {
          ...options({ url: 'project', token: 'project' }),
          ...options({ url: 'project' }, 'srv'),
        },
      },
    } as SettingsJson,
    localSettings: {
      pluginConfigs: {
        [ID]: { ...options({ cmd: 'local' }), ...options({ cmd: 'local' }, 'srv') },
      },
    },
    flagSettings: null,
    policySettings: null,
  }
  setAllowedSettingSources([
    'userSettings',
    'projectSettings',
    'localSettings',
  ])
  spyOn(settings, 'getSettingsForSource').mockImplementation(
    source => bySource[source] ?? null,
  )
  // The merged view still contains repo-controlled values.
  spyOn(settings, 'getSettings_DEPRECATED').mockImplementation(() => {
    const merged: SettingsJson = { pluginConfigs: {} }
    for (const source of [
      'userSettings',
      'projectSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ] as const) {
      const value = bySource[source]
      if (value?.hooks) merged.hooks = value.hooks
      for (const [id, config] of Object.entries(value?.pluginConfigs ?? {})) {
        const prev = merged.pluginConfigs![id] ?? {}
        merged.pluginConfigs![id] = {
          options: { ...prev.options, ...config.options },
          mcpServers: { ...prev.mcpServers, ...config.mcpServers },
        }
      }
    }
    return merged
  })
  spyOn(settings, 'updateSettingsForSource').mockImplementation(
    (source, values) => {
      writes.push({ source, values })
      return { error: null }
    },
  )
  clearPluginOptionsCache()
})

afterEach(() => {
  setAllowedSettingSources(originalAllowed)
  mock.restore()
})

describe('plugin options setting sources', () => {
  test('ignores project and local pluginConfigs for options and MCP server config', () => {
    expect(loadPluginOptions(ID)).toEqual({ url: 'user' })
    expect(loadMcpServerUserConfig(ID, 'srv')).toBeNull()
  })

  test('layers user, flag and policy settings with secure storage winning', () => {
    bySource.userSettings = {
      pluginConfigs: {
        [ID]: { ...options({ a: 'user', b: 'user', c: 'user' }), ...options({ a: 'user', b: 'user' }, 'srv') },
      },
    }
    bySource.flagSettings = {
      pluginConfigs: {
        [ID]: { ...options({ b: 'flag', c: 'flag' }), ...options({ b: 'flag' }, 'srv') },
      },
    }
    bySource.policySettings = {
      pluginConfigs: { [ID]: options({ c: 'policy' }) },
    }
    secrets = { [ID]: { token: 'secret' }, [`${ID}/srv`]: { token: 'srv-secret' } }
    expect(loadPluginOptions(ID)).toEqual({
      a: 'user',
      b: 'flag',
      c: 'policy',
      token: 'secret',
    })
    expect(loadMcpServerUserConfig(ID, 'srv')).toEqual({
      a: 'user',
      b: 'flag',
      token: 'srv-secret',
    })
  })

  test('skips user settings when that source is disabled', () => {
    setAllowedSettingSources(['projectSettings'])
    bySource.flagSettings = { pluginConfigs: { [ID]: options({ b: 'flag' }) } }
    expect(loadPluginOptions(ID)).toEqual({ b: 'flag' })
  })

  test('reads bare-name aliases for inline plugins', () => {
    bySource.userSettings = {
      pluginConfigs: {
        demo: options({ a: 'bare', b: 'bare' }),
        'demo@inline': options({ b: 'qualified' }),
      },
    }
    expect(loadPluginOptions('demo@inline')).toEqual({ a: 'bare', b: 'qualified' })
    expect(loadPluginOptions('demo@mkt')).toEqual({})
  })

  test('a project-only value does not satisfy a required option', () => {
    const plugin = {
      name: 'demo',
      path: '/plugins/demo',
      source: ID,
      repository: ID,
      manifest: {
        name: 'demo',
        userConfig: {
          token: { type: 'string', title: 'Token', description: 'Token', required: true },
        },
      },
    } as LoadedPlugin
    expect(Object.keys(getUnconfiguredOptions(plugin))).toEqual(['token'])
  })

  test('saving writes only this plugin entry to user settings', () => {
    const schema = {
      url: { type: 'string' as const, title: 'URL', description: 'URL' },
    }
    savePluginOptions(ID, { url: 'saved' }, schema)
    saveMcpServerUserConfig(ID, 'srv', { url: 'saved' }, schema)
    expect(writes).toEqual([
      {
        source: 'userSettings',
        values: { pluginConfigs: { [ID]: { options: { url: 'saved' } } } },
      },
      {
        source: 'userSettings',
        values: { pluginConfigs: { [ID]: { mcpServers: { srv: { url: 'saved' } } } } },
      },
    ])
  })
})
