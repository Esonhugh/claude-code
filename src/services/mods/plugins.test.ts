import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { LoadedPlugin } from '../../types/plugin.js'
import { SettingsSchema, type SettingsJson } from '../../utils/settings/types.js'
import type { PrepareModPluginsSettings } from './plugins.js'
import type { ModTier } from './types.js'

let secureStorageData: { pluginSecrets?: Record<string, Record<string, unknown>> } = {}
const secureStorage = {
  read: mock(() => secureStorageData),
  update: mock(() => ({ success: true })),
}
mock.module('../../utils/secureStorage/index.js', () => ({
  getSecureStorage: () => secureStorage,
}))

const { clearPluginOptionsCache } = await import('../../utils/plugins/pluginOptionsStorage.js')
const { getModPluginOrigin, prepareModPlugins } = await import('./plugins.js')

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
  beforeEach(() => {
    secureStorageData = {}
    secureStorage.read.mockClear()
    secureStorage.update.mockClear()
    clearPluginOptionsCache()
  })
  test('provider provenance uses the same effective tier even without an admitted hook module', () => {
    const plugin = loadedPlugin()
    const cases: Array<[Partial<PrepareModPluginsSettings>, ModTier]> = [
      [{}, 'user'],
      [{userSettings:source({appendPlugins:['example@marketplace']})}, 'append'],
      [{userSettings:source({prependPlugins:['example@marketplace'],appendPlugins:['example@marketplace']})}, 'prepend'],
      [{userSettings:source({prependPlugins:['example@marketplace']}),enabledOptionSources:{user:false,flag:true}}, 'user'],
      [{flagSettings:source({prependPlugins:['example@marketplace']})}, 'user'],
      [{hasManagedSettings:true,userSettings:source({appendPlugins:['example@marketplace']})}, 'user'],
      [{policySettings:source({enabledPlugins:{'example@marketplace':true}})}, 'prepend'],
      [{policySettings:source({enabledPlugins:{'example@marketplace':true},appendPlugins:['example@marketplace']})}, 'append'],
      [{policySettings:source({appendPlugins:['example@marketplace']})}, 'user'],
    ]
    for (const [config,tier] of cases) {
      const value = settings(config)
      expect(getModPluginOrigin({...plugin,hookModules:undefined},value)).toEqual({plugin:'example@marketplace',tier})
      expect(prepareModPlugins([plugin],value).inputs[0]?.tier).toBe(tier)
    }
    expect(getModPluginOrigin(loadedPlugin({isBuiltin:true,source:'example@builtin',repository:'example@builtin',hookModules:undefined}),settings())).toEqual({plugin:'example@builtin',tier:'builtin'})
    expect(getModPluginOrigin(loadedPlugin({source:'example@builtin',repository:'example@builtin',hookModules:undefined}),settings())).toEqual({plugin:'example@builtin',tier:'user'})
  })

  test('passes manifest version without treating builtin tier or manifest metadata as native identity', () => {
    const plugin = loadedPlugin({ isBuiltin: true, source: 'example@builtin', repository: 'example@builtin', manifest: { name: 'example', version: '1.2.3', isNative: true } as LoadedPlugin['manifest'] })
    const result = prepareModPlugins([plugin], settings())
    expect(result.errors).toEqual([])
    expect(result.inputs[0]?.version).toBe('1.2.3')
    expect(result.inputs[0]?.tier).toBe('builtin')
    expect(result.inputs[0]?.isNative).not.toBe(true)
  })

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


  test('loads and validates required sensitive options from secure storage before admission', () => {
    const secret = 'offline-secret-value'
    secureStorageData = {
      pluginSecrets: { 'example@marketplace': { token: secret } },
    }
    const plugin = loadedPlugin({
      manifest: {
        name: 'example',
        userConfig: {
          mode: {
            type: 'string',
            title: 'Mode',
            description: 'Execution mode',
            default: 'safe',
          },
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

    expect(result.errors).toEqual([])
    expect(result.inputs[0]?.options).toEqual({ mode: 'safe', token: secret })
    expect(result.inputs[0]?.fingerprintOptions).toEqual({ mode: 'safe' })
    expect(JSON.stringify(result.errors)).not.toContain(secret)
    expect(JSON.stringify(result.inputs[0], (key, value) => key === 'options' ? undefined : value)).not.toContain(secret)
  })

  test('does not access secure storage when no sensitive fields are declared', () => {
    const result = prepareModPlugins([loadedPlugin()], settings())
    expect(result.errors).toEqual([])
    expect(secureStorage.read).not.toHaveBeenCalled()
  })

  test('rejects only missing or invalid required sensitive options before admission', () => {
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

    expect(prepareModPlugins([plugin], settings())).toEqual({
      inputs: [],
      errors: [{
        plugin: 'example',
        stage: 'options',
        message: 'Options do not fit plugin.json userConfig: Token is required but not provided',
      }],
    })

    secureStorageData = {
      pluginSecrets: { 'example@marketplace': { token: 42 } },
    }
    clearPluginOptionsCache()
    const invalid = prepareModPlugins([plugin], settings())
    expect(invalid.inputs).toEqual([])
    expect(invalid.errors[0]?.message).toBe(
      'Options do not fit plugin.json userConfig: Token must be a string',
    )
  })

  test('sensitive optional fields, defaults and stale choices use the ordinary option contract', () => {
    const token = {type:'string' as const,title:'Token',description:'',sensitive:true}
    const plugin = loadedPlugin({manifest:{name:'example',userConfig:{
      optional:token,
      defaulted:{...token,required:true,default:'fake-default-token'},
      choice:{...token,required:true,options:['allowed','fallback'],default:'fallback'},
    }}})
    secureStorageData = {pluginSecrets:{'example@marketplace':{choice:'removed'}}}
    const result = prepareModPlugins([plugin], settings())
    expect(result.errors).toEqual([])
    expect(result.inputs[0]?.options).toEqual({optional:'',defaulted:'fake-default-token',choice:'fallback'})
    expect(result.inputs[0]?.fingerprintOptions).toEqual({})
  })

  test('sensitive choice validation never includes allowed secrets in diagnostics', () => {
    const allowed = 'fake-private-choice'
    const plugin = loadedPlugin({manifest:{name:'example',userConfig:{token:{
      type:'string',title:'Token',description:'',sensitive:true,required:true,
      options:[allowed],default:'invalid-default',
    }}}})
    const result = prepareModPlugins([plugin], settings())
    expect(result.inputs).toEqual([])
    expect(result.errors[0]?.message).toContain('Token must be one of')
    expect(JSON.stringify(result.errors)).not.toContain(allowed)
  })

  test('uses updated sensitive options after plugin option caches are cleared', () => {
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
    secureStorageData = {
      pluginSecrets: { 'example@marketplace': { token: 'first' } },
    }
    expect(prepareModPlugins([plugin], settings()).inputs[0]?.options).toEqual({ token: 'first' })

    secureStorageData = {
      pluginSecrets: { 'example@marketplace': { token: 'second' } },
    }
    expect(prepareModPlugins([plugin], settings()).inputs[0]?.options).toEqual({ token: 'first' })
    clearPluginOptionsCache()
    expect(prepareModPlugins([plugin], settings()).inputs[0]?.options).toEqual({ token: 'second' })
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

  test('parses tier lists without discarding unrelated settings on an invalid list', () => {
    expect(SettingsSchema().parse({
      prependPlugins: ['outer@marketplace'],
      appendPlugins: [],
    })).toMatchObject({ prependPlugins: ['outer@marketplace'], appendPlugins: [] })
    const parsed = SettingsSchema().parse({
      prependPlugins: 'not-a-list', appendPlugins: [1], disableAllHooks: true,
    })
    expect(parsed.disableAllHooks).toBe(true)
    expect(parsed.prependPlugins).toBeUndefined()
    expect(parsed.appendPlugins).toBeUndefined()
  })

  test('orders managed prepend, unlisted managed, user, append, and builtin seats', () => {
    const plugins = ['inner', 'user', 'unlisted', 'outer', 'first', 'builtin'].map(name =>
      loadedPlugin({ name, ...(name === 'builtin' ? {
        isBuiltin: true, source: 'builtin@builtin', repository: 'builtin@builtin',
      } : {}) }),
    )
    const result = prepareModPlugins(plugins, settings({
      policySettings: source({
        enabledPlugins: Object.fromEntries(['inner', 'unlisted', 'outer', 'first'].map(name => [`${name}@marketplace`, true])),
        prependPlugins: ['first@marketplace', 'outer@marketplace'],
        appendPlugins: ['inner@marketplace'],
      }),
    }))
    expect(result.errors).toEqual([])
    expect(result.inputs.map(input => [input.name, input.tier])).toEqual([
      ['first', 'prepend'], ['outer', 'prepend'], ['unlisted', 'prepend'],
      ['user', 'user'], ['inner', 'append'], ['builtin', 'builtin'],
    ])
    expect(result.inputs.every(input => input.isNative !== true)).toBe(true)
  })

  test('user tier lists apply only with no managed settings, and flag lists never seat plugins', () => {
    const plugins = ['one', 'two', 'three'].map(name => loadedPlugin({ name }))
    const userSettings = source({ prependPlugins: ['three@marketplace'], appendPlugins: ['one@marketplace'] })
    const flagSettings = source({ prependPlugins: ['two@marketplace'] })
    for (const policySettings of [null, source({})]) {
      const result = prepareModPlugins(plugins, settings({ userSettings, flagSettings, policySettings }))
      expect(result.errors).toEqual([])
      expect(result.inputs.map(input => [input.name, input.tier])).toEqual([
        ['three', 'prepend'], ['two', 'user'], ['one', 'append'],
      ])
    }
    for (const policySettings of [source({ disableAllHooks: false }), source({ prependPlugins: [] })]) {
      const result = prepareModPlugins(plugins, settings({ userSettings, flagSettings, policySettings }))
      expect(result.inputs.map(input => [input.name, input.tier])).toEqual([
        ['one', 'user'], ['two', 'user'], ['three', 'user'],
      ])
      expect(result.errors.some(error => /user.*ignored.*managed/i.test(error.message))).toBe(true)
    }
    const disabledSource = prepareModPlugins(plugins, settings({
      userSettings, flagSettings, enabledOptionSources: { user: false, flag: true },
    }))
    expect(disabledSource.inputs.every(input => input.tier === 'user')).toBe(true)
  })

  test('invalid policy seats are skipped, duplicates prefer prepend, and unlisted managed order stays stable', () => {
    const plugins = ['ordinary', 'a', 'b', 'both', 'last', 'builtin'].map(name =>
      loadedPlugin({ name, ...(name === 'builtin' ? {
        isBuiltin: true, source: 'builtin@builtin', repository: 'builtin@builtin',
      } : {}) }),
    )
    const result = prepareModPlugins(plugins, settings({
      policySettings: source({
        enabledPlugins: { 'a@marketplace': true, 'b@marketplace': true, 'both@marketplace': true, 'last@marketplace': true },
        prependPlugins: ['missing@marketplace', 'ordinary@marketplace', 'both@marketplace', 'both@marketplace', 'builtin@builtin'],
        appendPlugins: ['last@marketplace', 'both@marketplace'],
      }),
    }))
    expect(result.inputs.map(input => [input.name, input.tier])).toEqual([
      ['both', 'prepend'], ['a', 'prepend'], ['b', 'prepend'], ['ordinary', 'user'],
      ['last', 'append'], ['builtin', 'builtin'],
    ])
    expect(result.errors.filter(error => /skipped/.test(error.message))).toHaveLength(3)
    expect(result.errors.some(error => /both.*prepended/.test(error.message))).toBe(true)
  })

  test('an unreadable admin policy still owns the ordering keys', () => {
    const result = prepareModPlugins([loadedPlugin()], settings({
      hasManagedSettings: true,
      userSettings: source({ prependPlugins: ['example@marketplace'] }),
    }))
    expect(result.inputs.map(input => input.tier)).toEqual(['user'])
    expect(result.errors.some(error => /user.*ignored.*managed/i.test(error.message))).toBe(true)
  })

  test('managed native ordering resolves the builtin identity and rejects an inline name collision', () => {
    const result = prepareModPlugins([
      loadedPlugin(),
      loadedPlugin({name:'sec-default', source:'sec-default@inline', manifest:{name:'sec-default', isNative:true} as LoadedPlugin['manifest']}),
    ], settings({policySettings:source({prependPlugins:['sec-default@builtin']})}))
    expect(result.inputs.map(input => input.name)).toEqual(['example'])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({plugin:'sec-default', stage:'native'})
    expect(result.errors[0]?.message).toContain('host-owned')
  })

  test('user ordering does not grant policy eligibility when managed-only is active', () => {
    const result = prepareModPlugins([loadedPlugin()], settings({
      userSettings: source({ prependPlugins: ['example@marketplace'] }),
      hookPolicy: { managedOnly: true, allDisabled: false },
    }))
    expect(result.inputs).toEqual([])
    expect(result.errors.some(error => error.stage === 'policy')).toBe(true)
  })
})
