import { describe, expect, test } from 'bun:test'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { dispatchModEvent } from './dispatch.js'
import { isAgentOffered } from './agentOffer.js'
import type { ModDispatchOptions, ModSnapshot } from './runtime.js'
import type { ModDispatchHook, ModInput } from './types.js'

function agent(
  source: AgentDefinition['source'],
  overrides: Partial<AgentDefinition> = {},
): AgentDefinition {
  return {
    agentType: 'reviewer',
    whenToUse: 'Use for focused code review.',
    tools: ['Read'],
    getSystemPrompt: () => '',
    source,
    ...(source === 'built-in' ? { baseDir: 'built-in' as const } : {}),
    ...overrides,
  } as AgentDefinition
}

function snapshot(
  invoke: ModDispatchHook['invoke'],
  options: {
    inputs?: ModInput[]
    failures?: string[]
    pluginOrigin?: ModSnapshot['pluginOrigin']
  } = {},
): ModSnapshot {
  return {
    pluginOrigin: options.pluginOrigin,
    hasHooks: event => event === 'agent.offer',
    release() {},
    dispatch: (event, input, core, dispatchOptions?: ModDispatchOptions) => {
      options.inputs?.push(structuredClone(input))
      return dispatchModEvent({
        event,
        input,
        core,
        ...dispatchOptions,
        hooks: [
          {
            plugin: 'filter',
            tier: 'user',
            registration: { id: 1, event, hasCatch: false },
            invoke,
          },
        ],
        onFailure: (_plugin, error) =>
          options.failures?.push(
            error instanceof Error ? error.message : String(error),
          ),
      })
    },
  }
}

describe('agent.offer projection', () => {
  test('pins provider and preserves settings-source identity', async () => {
    const failures: string[] = []
    const mods = snapshot((_event, next) =>
      next({
        agent: 'reviewer',
        description: 'Use for focused code review.',
        source: 'policySettings',
        provider: { plugin: 'forged', tier: 'core' },
      }), { failures })

    await expect(
      isAgentOffered(agent('policySettings'), { snapshot: mods }),
    ).resolves.toBe(true)
    expect(failures).toEqual(['agent.offer cannot rewrite provider'])
  })

  test('uses canonical providers for built-in, plugin, and settings agents', async () => {
    const inputs: ModInput[] = []
    const mods = snapshot((event, next) => next(event), {
      inputs,
      pluginOrigin: storageId =>
        storageId === 'pack@market'
          ? { plugin: storageId, tier: 'append' }
          : undefined,
    })

    await expect(
      isAgentOffered(agent('built-in'), { snapshot: mods }),
    ).resolves.toBe(true)
    await expect(
      isAgentOffered(
        agent('plugin', {
          plugin: 'pack@market',
        } as Partial<AgentDefinition>),
        { snapshot: mods },
      ),
    ).resolves.toBe(true)
    await expect(
      isAgentOffered(agent('policySettings'), { snapshot: mods }),
    ).resolves.toBe(true)
    await expect(
      isAgentOffered(agent('projectSettings'), { snapshot: mods }),
    ).resolves.toBe(true)

    expect(inputs).toEqual([
      {
        agent: 'reviewer',
        description: 'Use for focused code review.',
        source: 'built-in',
        provider: { plugin: 'engine', tier: 'core' },
      },
      {
        agent: 'reviewer',
        description: 'Use for focused code review.',
        source: 'plugin',
        provider: { plugin: 'pack@market', tier: 'append' },
      },
      {
        agent: 'reviewer',
        description: 'Use for focused code review.',
        source: 'policySettings',
        provider: { plugin: 'policySettings', tier: 'prepend' },
      },
      {
        agent: 'reviewer',
        description: 'Use for focused code review.',
        source: 'projectSettings',
        provider: { plugin: 'projectSettings', tier: 'user' },
      },
    ])
  })

  for (const [name, invoke] of [
    [
      'throw',
      async () => {
        throw new Error('broken offer')
      },
    ],
    ['invalid result', async () => ({ isOffered: 'no' })],
  ] as const) {
    test(`passes through a hook ${name}`, async () => {
      const failures: string[] = []
      const mods = snapshot(invoke, { failures })
      await expect(
        isAgentOffered(agent('built-in'), { snapshot: mods }),
      ).resolves.toBe(true)
      expect(failures).toHaveLength(1)
    })
  }
})
