import type { EffortValue } from './effort.js'

export type CacheTtl = '5m' | '1h'

/** An agent loop's request as it went out, once the API began to answer it. */
export type AgentRequest = {
  at: number
  model: string
  effort?: EffortValue
  cacheTtl?: CacheTtl
}

type RequestUsage = {
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null
    ephemeral_1h_input_tokens?: number | null
  } | null
}

const lastRequests = new Map<string, { request: AgentRequest; writtenTtl?: CacheTtl }>()

// The shorter lifetime when a request wrote both.
function writtenTtl(usage: RequestUsage): CacheTtl | undefined {
  if ((usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) > 0) return '5m'
  if ((usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0) return '1h'
  return undefined
}

export function recordAgentRequest(
  agentId: string,
  { at, model, effort, usage }: { at: number; model: string; effort?: EffortValue; usage?: RequestUsage },
): void {
  const written = usage?.cache_creation_input_tokens ?? 0
  const cached = written + (usage?.cache_read_input_tokens ?? 0) > 0
  // A request that only read keeps the lifetime the agent's last write was given.
  const ttl = written > 0 && usage ? writtenTtl(usage) : lastRequests.get(agentId)?.writtenTtl
  lastRequests.set(agentId, {
    request: {
      at,
      model,
      ...(effort !== undefined && { effort }),
      ...(cached && ttl && { cacheTtl: ttl }),
    },
    writtenTtl: ttl,
  })
}

export function getLastAgentRequest(agentId: string): AgentRequest | undefined {
  return lastRequests.get(agentId)?.request
}

export function resetAgentRequestsForTests(): void {
  lastRequests.clear()
}
