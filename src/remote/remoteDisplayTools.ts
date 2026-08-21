import { findToolByName, type Tool, type Tools } from '../Tool.js'
import { BashTool } from '../tools/BashTool/BashTool.js'
import { MCPTool } from '../tools/MCPTool/MCPTool.js'

const remoteDisplayToolCache = new Map<string, Tool>()

export function createRemoteDisplayTool(toolName: string): Tool {
  return {
    ...MCPTool,
    name: toolName,
    userFacingName: () => toolName,
    isEnabled: () => false,
    async call() {
      throw new Error(
        `Display-only remote tool ${toolName} cannot be executed locally`,
      )
    },
  } as Tool
}

export function findRemoteDisplayTool(
  tools: Tools,
  toolName: string,
): Tool {
  const knownTool =
    findToolByName(tools, toolName) ?? findToolByName([BashTool], toolName)
  if (knownTool) return knownTool

  const cached = remoteDisplayToolCache.get(toolName)
  if (cached) return cached

  const tool = createRemoteDisplayTool(toolName)
  remoteDisplayToolCache.set(toolName, tool)
  return tool
}
