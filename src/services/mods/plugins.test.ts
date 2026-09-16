import { describe, expect, test } from 'bun:test'
import type { LoadedPlugin } from '../../types/plugin.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import { prepareModPlugins, type PrepareModPluginsSettings } from './plugins.js'

function loadedPlugin(overrides: Partial<LoadedPlugin> = {}): LoadedPlugin {
  const name = overrides.name ?? 'example'
  const path = overrides.path ?? `/plugins/${name}`
  return {
    name,
    manifest: { name },
    path,
    source: `${name}@marketplace`,
    repository: `${name}@marketplace`,
    enabled: true,
    hookModules: [
      { configPath: `${path}/hooks/hooks.json`, paths: ['./register.ts'] },
    ],
    ...overrides,
  }
}

function settings(
  overrides: Partial<PrepareModPluginsSettings> = {},
): PrepareModPluginsSettings {
  return {
    userSettings: null,
    flagSettings: null,
    policySettings: null,
    hookPolicy: { managedOnly: false, allDisabled: false },
    ...overrides,
  }
}

function source(value: Partial<SettingsJson>): SettingsJson {
  return value as SettingsJson
}

describe('prepareModPlugins', () => {
  test('resolves every module next to its declaring hooks config', () => {
    const plugin = loadedPlugin({
      hookModules: [
        {
          configPath: '/plugins/example/hooks/hooks.json',
          paths: ['./register.ts', '../shared.ts'],
        },
        {
          configPath: '/plugins/example/config/extra.json',
          paths: ['./nested/register.mts', './nested/register.mts'],
        },
      ],
    })

    expect(prepareModPlugins([plugin], settings())).toEqual({
      inputs: [
        {
          name: 'example',
          storageId: 'example@marketplace',
          pluginRoot: '/plugins/example',
          entrypoints: [
            '/plugins/example/hooks/register.ts',
            '/plugins/example/shared.ts',
            '/plugins/example/config/nested/register.mts',
          ],
          options: {},
          tier: 'user',
        },
      ],
      errors: [],
    })
  })

  test('ignores a disabled plugin even when it has modules', () => {
    const result = prepareModPlugins(
      [loadedPlugin({ enabled: false })],
      settings(),
    )

    expect(result).toEqual({ inputs: [], errors: [] })
  })

  test('ignores an enabled plugin with no modules', () => {
    const result = prepareModPlugins(
      [loadedPlugin({ hookModules: undefined })],
      settings(),
    )

    expect(result).toEqual({ inputs: [], errors: [] })
  })

  test('uses only declared user, flag, and policy options with defaults', () => {
    const plugin = loadedPlugin({
      manifest: {
        name: 'example',
        userConfig: {
          mode: {
            type: 'string',
            title: 'Mode',
            description: 'Execution mode',
            default: 'default',
          },
          count: {
            type: 'number',
            title: 'Count',
            description: 'Retry count',
            required: true,
          },
          verbose: {
            type: 'boolean',
            title: 'Verbose',
            description: 'Verbose output',
            default: false,
          },
        },
      },
    })
    const inputSettings = settings({
      userSettings: source({
        pluginConfigs: {
          'example@marketplace': {
            options: { mode: 'user', count: 1, undeclared: 'user' },
          },
        },
      }),
      flagSettings: source({
        pluginConfigs: {
          'example@marketplace': {
            options: { mode: 'flag', undeclared: 'flag' },
          },
        },
      }),
      policySettings: source({
        pluginConfigs: {
          'example@marketplace': {
            options: { count: 3, undeclared: 'policy' },
          },
        },
      }),
    })

    const result = prepareModPlugins([plugin], inputSettings)

    expect(result.errors).toEqual([])
    expect(result.inputs[0]?.options).toEqual({
      mode: 'flag',
      count: 3,
      verbose: false,
    })
  })

  test('honors an explicit trusted option-source selection', () => {
    const plugin = loadedPlugin({
      manifest: {
        name: 'example',
        userConfig: {
          mode: {
            type: 'string',
            title: 'Mode',
            description: 'Execution mode',
            default: 'default',
          },
        },
      },
    })
    const result = prepareModPlugins(
      [plugin],
      settings({
        userSettings: source({
          pluginConfigs: {
            'example@marketplace': { options: { mode: 'user' } },
          },
        }),
        flagSettings: source({
          pluginConfigs: {
            'example@marketplace': { options: { mode: 'flag' } },
          },
        }),
        enabledOptionSources: { user: false, flag: false },
      }),
    )

    expect(result.inputs[0]?.options).toEqual({ mode: 'default' })
  })

  test('never reads project settings as an options source', () => {
    const plugin = loadedPlugin({
      manifest: {
        name: 'example',
        userConfig: {
          mode: {
            type: 'string',
            title: 'Mode',
            description: 'Execution mode',
            default: 'default',
          },
        },
      },
    })
    const inputSettings = {
      ...settings({
        userSettings: source({
          pluginConfigs: {
            'example@marketplace': { options: { mode: 'user' } },
          },
        }),
      }),
      projectSettings: source({
        pluginConfigs: {
          'example@marketplace': { options: { mode: 'project' } },
        },
      }),
    } as PrepareModPluginsSettings

    expect(
      prepareModPlugins([plugin], inputSettings).inputs[0]?.options,
    ).toEqual({
      mode: 'user',
    })
  })

  test('rejects invalid external plugin options before module evaluation', () => {
    const plugin = loadedPlugin({
      manifest: {
        name: 'example',
        userConfig: {
          count: {
            type: 'number',
            title: 'Count',
            description: 'Retry count',
            required: true,
          },
        },
      },
    })
    const result = prepareModPlugins(
      [plugin],
      settings({
        userSettings: source({
          pluginConfigs: {
            'example@marketplace': { options: { count: 'not-a-number' } },
          },
        }),
      }),
    )

    expect(result.inputs).toEqual([])
    expect(result.errors).toEqual([
      {
        plugin: 'example',
        stage: 'options',
        message:
          'Options do not fit plugin.json userConfig: Count must be a number',
      },
    ])
  })

  test('reports sensitive options as unsupported without loading the plugin', () => {
    const plugin = loadedPlugin({
      manifest: {
        name: 'example',
        userConfig: {
          token: {
            type: 'string',
            title: 'Token',
            description: 'API token',
            sensitive: true,
            required: true,
          },
        },
      },
    })
    const result = prepareModPlugins([plugin], settings())

    expect(result.inputs).toEqual([])
    expect(result.errors).toEqual([
      {
        plugin: 'example',
        stage: 'options',
        message:
          'Sensitive plugin options are unsupported by Mods: token; module not loaded',
      },
    ])
  })

  test('allows only policy-enabled plugins when hooks are managed-only', () => {
    const managed = loadedPlugin({
      name: 'managed',
      manifest: { name: 'managed' },
      path: '/plugins/managed',
      source: 'managed@marketplace',
      repository: 'managed@marketplace',
      hookModules: [
        {
          configPath: '/plugins/managed/hooks/hooks.json',
          paths: ['./register.ts'],
        },
      ],
    })
    const ordinary = loadedPlugin()
    const result = prepareModPlugins(
      [ordinary, managed],
      settings({
        policySettings: source({
          enabledPlugins: { 'managed@marketplace': true },
        }),
        hookPolicy: { managedOnly: true, allDisabled: false },
      }),
    )

    expect(result.inputs.map((input) => [input.name, input.tier])).toEqual([
      ['managed', 'prepend'],
    ])
    expect(result.errors).toEqual([
      {
        plugin: 'example',
        stage: 'policy',
        message: 'Hooks modules are restricted to managed plugins',
      },
    ])
  })

  test('managed policy flags remain authoritative over a stale helper snapshot', () => {
    const managed = loadedPlugin({
      source: 'example@marketplace',
      repository: 'example@marketplace',
    })

    const managedOnly = prepareModPlugins(
      [managed],
      settings({
        policySettings: source({ allowManagedHooksOnly: true }),
      }),
    )
    expect(managedOnly.inputs).toEqual([])
    expect(managedOnly.errors[0]?.stage).toBe('policy')

    const allDisabled = prepareModPlugins(
      [managed],
      settings({
        policySettings: source({
          enabledPlugins: { 'example@marketplace': true },
          disableAllHooks: true,
        }),
      }),
    )
    expect(allDisabled.inputs).toEqual([])
    expect(allDisabled.errors[0]?.message).toBe(
      'Hooks modules are disabled by managed policy',
    )
  })

  test('a non-managed disableAllHooks setting preserves managed hooks only', () => {
    const managed = loadedPlugin({
      name: 'managed',
      manifest: { name: 'managed' },
      source: 'managed@marketplace',
      repository: 'managed@marketplace',
    })
    const result = prepareModPlugins(
      [loadedPlugin(), managed],
      settings({
        userSettings: source({ disableAllHooks: true }),
        policySettings: source({
          enabledPlugins: { 'managed@marketplace': true },
        }),
      }),
    )

    expect(result.inputs.map((input) => input.name)).toEqual(['managed'])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.plugin).toBe('example')
  })

  test('external source names cannot promote their tier to builtin or core', () => {
    const builtinSpoof = loadedPlugin({
      name: 'builtin-spoof',
      manifest: { name: 'builtin-spoof' },
      source: 'builtin-spoof@builtin',
      repository: 'builtin-spoof@builtin',
    })
    const coreSpoof = loadedPlugin({
      name: 'core-spoof',
      manifest: { name: 'core-spoof' },
      source: 'core-spoof@core',
      repository: 'core-spoof@core',
    })
    const flagSpoof = loadedPlugin({
      name: 'flag-spoof',
      manifest: { name: 'flag-spoof' },
      source: 'flag-spoof@inline',
      repository: 'flag-spoof@inline',
      isBuiltin: true,
    })
    const builtin = loadedPlugin({
      name: 'trusted-builtin',
      manifest: { name: 'trusted-builtin' },
      source: 'trusted-builtin@builtin',
      repository: 'trusted-builtin@builtin',
      isBuiltin: true,
    })

    expect(
      prepareModPlugins(
        [builtinSpoof, coreSpoof, flagSpoof, builtin],
        settings(),
      ).inputs.map((input) => [input.name, input.tier]),
    ).toEqual([
      ['builtin-spoof', 'user'],
      ['core-spoof', 'user'],
      ['flag-spoof', 'user'],
      ['trusted-builtin', 'builtin'],
    ])
  })

  test('reports configured official ordering as a local schema gap', () => {
    const policySettings = source({
      enabledPlugins: { 'example@marketplace': true },
    }) as SettingsJson & { prependPlugins: string[] }
    policySettings.prependPlugins = ['example@marketplace']

    const result = prepareModPlugins(
      [loadedPlugin()],
      settings({ policySettings }),
    )

    expect(result.inputs.map((input) => input.tier)).toEqual(['prepend'])
    expect(result.errors).toContainEqual({
      plugin: 'mods',
      stage: 'ordering',
      message:
        'prependPlugins/appendPlugins are not available in the local settings schema; configured Mods ordering was not applied',
    })
  })
})
