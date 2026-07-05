import type { ToolPermissionContext } from '../../Tool.js'
import {
  filterDeniedAgents,
  getDenyRuleForAgent,
} from '../../utils/permissions/permissions.js'
import { AGENT_TOOL_NAME } from './constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'

export type AgentTypeResolution = {
  agent: AgentDefinition
  matchKind: 'exact' | 'normalized'
  requestedType: string
}

function normalizeAgentType(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{White_Space}\p{Dash_Punctuation}_]+/gu, '')
}

function formatAvailableAgents(agents: readonly AgentDefinition[]): string {
  return agents.map(a => a.agentType).join(', ') || 'none'
}

export function resolveAgentType({
  requestedType,
  activeAgents,
  allowedAgentTypes,
  permissionContext,
}: {
  requestedType: string
  activeAgents: readonly AgentDefinition[]
  allowedAgentTypes?: string[]
  permissionContext: ToolPermissionContext
}): AgentTypeResolution {
  const scopedAgents = allowedAgentTypes
    ? activeAgents.filter(a => allowedAgentTypes.includes(a.agentType))
    : [...activeAgents]
  const availableAgents = filterDeniedAgents(
    scopedAgents,
    permissionContext,
    AGENT_TOOL_NAME,
  )

  const exact = availableAgents.find(agent => agent.agentType === requestedType)
  if (exact) {
    return { agent: exact, matchKind: 'exact', requestedType }
  }

  const normalizedRequested = normalizeAgentType(requestedType)
  const activeNormalizedMatches = activeAgents.filter(
    agent => normalizeAgentType(agent.agentType) === normalizedRequested,
  )
  const availableAgentTypes = new Set(
    availableAgents.map(agent => agent.agentType),
  )
  const normalizedMatches = availableAgents.filter(
    agent => normalizeAgentType(agent.agentType) === normalizedRequested,
  )

  if (activeNormalizedMatches.length > 1) {
    const availableMatches = activeNormalizedMatches.filter(agent =>
      availableAgentTypes.has(agent.agentType),
    )
    const formattedMatches = activeNormalizedMatches
      .map(agent =>
        availableAgentTypes.has(agent.agentType)
          ? agent.agentType
          : `${agent.agentType} (unavailable)`,
      )
      .join(', ')
    const exactNames = availableMatches.map(agent => agent.agentType).join(' or ')
    throw new Error(
      `Agent type '${requestedType}' is ambiguous — matches ${formattedMatches}. ${
        exactNames
          ? `Use the exact name: ${exactNames}`
          : `None of these are available. Available agents: ${formatAvailableAgents(availableAgents)}`
      }`,
    )
  }

  if (normalizedMatches.length === 1) {
    return {
      agent: normalizedMatches[0]!,
      matchKind: 'normalized',
      requestedType,
    }
  }

  const exactDenied = activeAgents.find(agent => agent.agentType === requestedType)
  const normalizedDenied = activeAgents.find(
    agent => normalizeAgentType(agent.agentType) === normalizedRequested,
  )
  const denied = exactDenied ?? normalizedDenied
  if (denied && !availableAgents.some(a => a.agentType === denied.agentType)) {
    const denyRule = getDenyRuleForAgent(
      permissionContext,
      AGENT_TOOL_NAME,
      denied.agentType,
    )
    if (denyRule) {
      throw new Error(
        `Agent type '${requestedType}' has been denied by permission rule '${AGENT_TOOL_NAME}(${denied.agentType})' from ${denyRule.source ?? 'settings'}.`,
      )
    }
    const availableText =
      availableAgents.length > 0
        ? formatAvailableAgents(availableAgents)
        : (allowedAgentTypes?.join(', ') ?? 'none')
    throw new Error(
      `Agent type '${requestedType}' not found. Available agents: ${availableText}`,
    )
  }

  throw new Error(
    `Agent type '${requestedType}' not found. Available agents: ${formatAvailableAgents(availableAgents)}`,
  )
}

export const resolveAgentTypeForTesting = resolveAgentType
