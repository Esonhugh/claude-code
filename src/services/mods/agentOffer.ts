import { isDeepStrictEqual } from 'node:util'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { ModSnapshot } from './runtime.js'
import type { ModOrigin } from './types.js'

export type AgentOfferProjection = {
  snapshot?: ModSnapshot
  signal?: AbortSignal
}

function providerForAgent(
  agent: AgentDefinition,
  snapshot: ModSnapshot,
): ModOrigin {
  if (agent.source === 'built-in') {
    return { plugin: 'engine', tier: 'core' }
  }
  if (agent.source === 'plugin') {
    const provider = snapshot.pluginOrigin?.(agent.plugin)
    if (!provider) {
      throw new Error(
        `Mods snapshot cannot resolve agent plugin provider ${agent.plugin}`,
      )
    }
    return provider
  }
  return {
    plugin: agent.source,
    tier: agent.source === 'policySettings' ? 'prepend' : 'user',
  }
}

export async function isAgentOffered(
  agent: AgentDefinition,
  projection: AgentOfferProjection = {},
): Promise<boolean> {
  const { snapshot, signal } = projection
  if (!snapshot?.hasHooks('agent.offer')) return true
  signal?.throwIfAborted()
  const input = {
    agent: agent.agentType,
    description: agent.whenToUse,
    source: agent.source,
    provider: providerForAgent(agent, snapshot),
  }
  const result = await snapshot.dispatch(
    'agent.offer',
    input,
    async () => ({ isOffered: true }),
    {
      signal,
      validateInput: value => {
        for (const key of ['agent', 'description', 'source', 'provider'] as const) {
          if (!isDeepStrictEqual(value[key], input[key])) {
            throw new Error(`agent.offer cannot rewrite ${key}`)
          }
        }
      },
      validateResult: value => {
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          typeof (value as { isOffered?: unknown }).isOffered !== 'boolean' ||
          Object.keys(value).some(key => key !== 'isOffered')
        ) {
          throw new Error('agent.offer must return only isOffered')
        }
      },
    },
  )
  signal?.throwIfAborted()
  return (result as { isOffered: boolean }).isOffered
}

export async function projectOfferedAgents(
  agents: readonly AgentDefinition[],
  projection: AgentOfferProjection = {},
): Promise<AgentDefinition[]> {
  if (!projection.snapshot?.hasHooks('agent.offer')) return [...agents]
  const offered = await Promise.all(
    agents.map(agent => isAgentOffered(agent, projection)),
  )
  return agents.filter((_agent, index) => offered[index])
}
