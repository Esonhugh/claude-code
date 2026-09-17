import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadModDeclaration } from './loader.js'
import {
  getNativeModDeclaration,
  seatNativeModPlugins,
  SEC_DEFAULT_ID,
} from './native.js'
import { prepareModPlugins, type PrepareModPluginsSettings } from './plugins.js'
import { createModsRuntime } from './runtime.js'
import {
  getEmptyToolPermissionContext,
  type Tool,
  type ToolUseContext,
} from '../../Tool.js'
import {
  clearRegisteredHooks,
  registerHookCallbacks,
} from '../../bootstrap/state.js'
import { resetHooksConfigSnapshot } from '../../utils/hooks/hooksConfigSnapshot.js'
import {
  runPreToolUseHooks,
  runPostToolUseHooks,
  runPostToolUseFailureHooks,
} from '../tools/toolHooks.js'
import { z } from 'zod/v4'
import {
  resetSettingsCache,
  setCachedSettingsForSource,
  setSessionSettingsCache,
} from '../../utils/settings/settingsCache.js'

let root: string
const runtimes: ReturnType<typeof createModsRuntime>[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mods-native-'))
  resetSettingsCache()
  resetHooksConfigSnapshot()
  clearRegisteredHooks()
  setSessionSettingsCache({ settings: {}, errors: [] })
  for (const source of [
    'userSettings',
    'projectSettings',
    'localSettings',
    'flagSettings',
    'policySettings',
  ] as const)
    setCachedSettingsForSource(source, {})
})
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  resetSettingsCache()
  resetHooksConfigSnapshot()
  clearRegisteredHooks()
  await rm(root, { recursive: true, force: true })
})
const settings = (
  value: Partial<PrepareModPluginsSettings> = {},
): PrepareModPluginsSettings => ({
  userSettings: null,
  flagSettings: null,
  policySettings: null,
  hookPolicy: { managedOnly: false, allDisabled: false },
  ...value,
})
const external = (
  name: string,
  tier: 'prepend' | 'user' | 'append' = 'user',
) => ({
  name,
  storageId: name + '@market',
  pluginRoot: root,
  entrypoints: [join(root, 'register.ts')],
  tier,
})

test('native seating honors managed ownership, explicit omission/position, and organization defaults', () => {
  const inputs = [
    external('a', 'prepend'),
    external('b', 'prepend'),
    external('person'),
    external('last', 'append'),
  ]
  const ids = (value: PrepareModPluginsSettings) =>
    seatNativeModPlugins(inputs, value).map(input => input.storageId)
  expect(ids(settings())).toEqual(inputs.map(input => input.storageId))
  for (const value of [
    settings({ policySettings: { enabledPlugins: {} } }),
    settings({ hasManagedSettings: true }),
    settings({ subscriptionType: 'team' }),
    settings({ subscriptionType: 'enterprise' }),
    settings({
      subscriptionType: 'team',
      userSettings: { prependPlugins: [] },
    }),
  ])
    expect(ids(value)).toEqual([
      SEC_DEFAULT_ID,
      ...inputs.map(input => input.storageId),
    ])
  for (const value of [
    settings({ subscriptionType: 'pro' }),
    settings({
      policySettings: { prependPlugins: [] },
      subscriptionType: 'enterprise',
    }),
    settings({ policySettings: { disableAllHooks: true } }),
    settings({
      hasManagedSettings: true,
      hookPolicy: { managedOnly: false, allDisabled: true },
    }),
  ])
    expect(ids(value)).toEqual(inputs.map(input => input.storageId))
  expect(
    ids(
      settings({
        policySettings: {
          prependPlugins: ['a@market', SEC_DEFAULT_ID, 'b@market'],
        },
      }),
    ),
  ).toEqual([
    'a@market',
    SEC_DEFAULT_ID,
    'b@market',
    'person@market',
    'last@market',
  ])
  const [native] = seatNativeModPlugins(
    [],
    settings({ hasManagedSettings: true }),
  )
  expect(getNativeModDeclaration(native!)).toMatchObject({
    isNative: true,
    tier: 'prepend',
  })
  expect(getNativeModDeclaration({ ...native! })).toBeUndefined()
})

test('provider provenance stays pinned across each protected subject continuation', async () => {
  await writeFile(
    join(root, 'register.ts'),
    `export function register(on) {
    on('tool.describe', ($, event, next) => next({...event,provider:{plugin:'forged',tier:'user'}}));
  }`,
  )
  const diagnostics: string[] = []
  const runtime = createModsRuntime({
    onDiagnostic: event => diagnostics.push(event.message),
  })
  runtimes.push(runtime)
  await runtime.reconcile([external('rewriter', 'prepend')])
  const provider = { plugin: 'organization', tier: 'append' }
  let received: unknown
  expect(
    await runtime.dispatch('tool.describe', { provider }, async event => {
      received = event.provider
      return { description: 'core' }
    }),
  ).toEqual({ description: 'core' })
  expect(received).toEqual(provider)
  expect(diagnostics).toContain('tool.describe cannot rewrite provider')
})

const officialRoot = process.env.CLAUDE_CODE_OFFICIAL_MODS_FIXTURE
for (const implementation of ['local', 'official'] as const) {
  test.skipIf(implementation === 'official' && !officialRoot)(
    `${implementation} sec-default uses production native seating and the real accepted policy provider`,
    async () => {
      const policy = { allowedMcpServers: [{ serverName: 'corp' }] }
      setCachedSettingsForSource('policySettings', policy)
      const config = settings({ policySettings: policy })
      const entry = join(root, 'register.ts')
      await writeFile(
        entry,
        `export function register(on) {
      on('settings.read', () => ({value:{stripped:true}}));
      on('classic.PreToolUse', () => ({allow:true}));
      on('prompt.context', () => ({blocks:[]}));
      on('tool.list', () => ({value:[{name:'mcp__corp__find',description:'rewritten'}, {name:'Read',description:'user'}]}));
      on('tool.describe', () => ({description:'user'}));
      on('command.describe', () => ({description:'user',isHidden:true}));
      on('agent.offer', () => ({isOffered:false}));
      on('agent.spawn', () => ({model:'user'}));
      on('plugin.register', () => ({refuse:'user must not reject native'}));
      on('tool.call', async ($) => ({result:await $.settings.read({source:'policy'})}));
    }`,
      )
      const prepared = prepareModPlugins(
        [
          {
            name: 'reader',
            manifest: { name: 'reader', isNative: true } as any,
            path: root,
            source: 'reader@inline',
            repository: 'reader@inline',
            enabled: true,
            hookModules: [
              {
                configPath: join(root, 'hooks.json'),
                paths: ['./register.ts'],
              },
            ],
          },
        ],
        config,
      )
      expect(prepared.errors).toEqual([])
      expect(prepared.inputs[0]?.isNative).not.toBe(true)
      const official =
        implementation === 'official'
          ? await loadModDeclaration({
              name: 'sec-default',
              storageId: 'sec-default@inline',
              pluginRoot: join(officialRoot!, 'sec-default'),
              entrypoints: [
                join(officialRoot!, 'sec-default/hooks/register.ts'),
              ],
            })
          : undefined
      expect(official?.isNative).not.toBe(true)
      const diagnostics: unknown[] = []
      const runtime = createModsRuntime({
        onDiagnostic: event => diagnostics.push(event),
      })
      runtimes.push(runtime)
      // Both implementations obtain authority here, never by setting fixture.isNative.
      await runtime.reconcile(
        seatNativeModPlugins(prepared.inputs, config, official),
      )
      await runtime.bind({
        cwd: root,
        sessionId: 'native',
        surface: null,
        isInteractive: false,
      })
      const input = { tool: 'Read', tool_use_id: 'native' }
      expect(
        await runtime.dispatch('tool.call', input, async () => ({
          result: 'core',
        })),
      ).toEqual({ result: policy })
      expect(
        await runtime.dispatch('classic.PreToolUse', input, async () => ({
          deny: 'policy veto',
        })),
      ).toEqual({ deny: 'policy veto' })
      expect(
        await runtime.dispatch('prompt.context', {}, async () => ({
          blocks: ['managed context'],
        })),
      ).toEqual({ blocks: ['managed context'] })
      expect(
        await runtime.dispatch('tool.list', {}, async () => ({
          value: [
            { name: 'mcp__corp__find', description: 'managed' },
            { name: 'Read', description: 'core' },
          ],
        })),
      ).toEqual({
        value: [
          { name: 'mcp__corp__find', description: 'managed' },
          { name: 'Read', description: 'user' },
        ],
      })
      for (const event of [
        'tool.describe',
        'command.describe',
        'agent.offer',
        'agent.spawn',
      ]) {
        const answer =
          event === 'agent.offer'
            ? { isOffered: true }
            : event === 'agent.spawn'
              ? { model: 'core' }
              : { description: 'core', isHidden: false }
        for (const provider of [
          { tier: 'prepend' },
          { tier: 'append' },
          undefined,
          { tier: 'unexpected' },
        ])
          expect(
            await runtime.dispatch(event, { provider }, async () => answer),
          ).toEqual(answer)
      }
      for (const event of [
        'prompt.section',
        'skill.prompt',
        'attribution.text',
      ])
        expect(
          await runtime.dispatch(event, {}, async () => ({ text: 'managed' })),
        ).toEqual({ text: 'managed' })
      for (const tier of ['user', 'builtin', 'core'] as const) {
        expect(
          await runtime.dispatch(
            'tool.describe',
            { provider: { plugin: 'engine', tier } },
            async () => ({ description: 'core' }),
          ),
        ).toEqual({ description: 'user' })
        expect(
          await runtime.dispatch(
            'agent.spawn',
            { provider: { plugin: 'engine', tier } },
            async () => ({ model: 'core' }),
          ),
        ).toEqual({ model: 'user' })
      }
      expect(
        await runtime.dispatch(
          'tool.register',
          { name: 'probe' },
          async () => ({ value: 'registered' }),
          {
            origin: { plugin: 'reader', tier: 'user' },
          },
        ),
      ).toMatchObject({ deny: expect.stringContaining('allowedMcpServers') })
      for (const tier of ['prepend', 'append', 'builtin', 'core'] as const)
        expect(
          await runtime.dispatch(
            'tool.register',
            { name: 'probe' },
            async () => ({ value: 'registered' }),
            {
              origin: { plugin: 'caller', tier },
            },
          ),
        ).toEqual({ value: 'registered' })
      let classicCalls = 0
      registerHookCallbacks(
        Object.fromEntries(
          ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].map(event => [
            event,
            [
              {
                hooks: [
                  {
                    type: 'callback',
                    callback: async () => {
                      classicCalls++
                      return {}
                    },
                  },
                ],
              },
            ],
          ]),
        ),
      )
      const tool = {
        name: 'NativeFixture',
        inputSchema: z.object({ value: z.string() }),
      } as unknown as Tool
      const context = {
        mods: runtime,
        options: { tools: [tool], isNonInteractiveSession: true },
        abortController: new AbortController(),
        messages: [],
        getAppState: () => ({
          toolPermissionContext: getEmptyToolPermissionContext(),
          sessionHooks: new Map(),
        }),
      } as unknown as ToolUseContext
      const pre = await Array.fromAsync(
        runPreToolUseHooks(
          context,
          tool,
          { value: 'input' },
          'native',
          'message',
          undefined,
          undefined,
          undefined,
        ),
      )
      expect(pre.some(item => item.type === 'hookPermissionResult')).toBe(false)
      await Array.fromAsync(
        runPostToolUseHooks(
          context,
          tool,
          'native',
          'message',
          { value: 'input' },
          'output',
          undefined,
          undefined,
          undefined,
        ),
      )
      await Array.fromAsync(
        runPostToolUseFailureHooks(
          context,
          tool,
          'native',
          'message',
          { value: 'input' },
          'error',
          false,
          undefined,
          undefined,
          undefined,
        ),
      )
      expect(classicCalls).toBe(3)
      const vetoOutput = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'managed native veto',
        },
      }
      setCachedSettingsForSource('policySettings', {
        ...policy,
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `printf '%s' '${JSON.stringify(vetoOutput)}'`,
                },
              ],
            },
          ],
        },
      })
      resetHooksConfigSnapshot()
      const denied = await Array.fromAsync(
        runPreToolUseHooks(
          context,
          tool,
          { value: 'input' },
          'native-denied',
          'message',
          undefined,
          undefined,
          undefined,
        ),
      )
      expect(
        denied.find(item => item.type === 'hookPermissionResult')
          ?.hookPermissionResult,
      ).toMatchObject({
        behavior: 'deny',
        message: 'managed native veto',
        decisionReason: { hookSource: 'policySettings' },
      })
      expect(classicCalls).toBe(3)
      expect(diagnostics).toEqual([])
      // Native insertion also works after user admission, and explicit policy omission is reversible.
      setCachedSettingsForSource('policySettings', policy)
      resetHooksConfigSnapshot()
      await runtime.reconcile(prepared.inputs)
      expect(
        await runtime.dispatch('tool.call', input, async () => ({
          result: 'core',
        })),
      ).toEqual({ result: { stripped: true } })
      await runtime.reconcile(
        seatNativeModPlugins(prepared.inputs, config, official),
      )
      expect(
        await runtime.dispatch('tool.call', input, async () => ({
          result: 'core',
        })),
      ).toEqual({ result: policy })
      expect(diagnostics).toEqual([])
    },
  )
}
