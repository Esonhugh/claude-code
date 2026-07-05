import type { Tools } from '../../Tool.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { hasRequiredMcpServers } from './loadAgentsDir.js'

function getMcpServerName(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined
  const parts = toolName.split('__')
  return parts[1] || undefined
}

export function getAvailableMcpServerNames({
  appStateMcpTools,
  currentToolPool,
}: {
  appStateMcpTools: Tools
  currentToolPool: Tools
}): string[] {
  const names = new Set<string>()
  for (const tool of [...appStateMcpTools, ...currentToolPool]) {
    const name = getMcpServerName(tool.name)
    if (name) names.add(name)
  }
  return [...names]
}

export function getMissingRequiredMcpServers({
  agent,
  availableServers,
}: {
  agent: AgentDefinition
  availableServers: string[]
}): string[] {
  const required = agent.requiredMcpServers ?? []
  if (required.length === 0) return []
  if (hasRequiredMcpServers(agent, availableServers)) return []
  return required.filter(
    pattern =>
      !availableServers.some(server =>
        server.toLowerCase().includes(pattern.toLowerCase()),
      ),
  )
}

export const getAvailableMcpServerNamesForTesting = getAvailableMcpServerNames
export const getMissingRequiredMcpServersForTesting = getMissingRequiredMcpServers
