import type { ToolUseBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { useMemo } from 'react'
import type { Tool, Tools } from '../../../Tool.js'
import { findRemoteDisplayTool } from '../../../remote/remoteDisplayTools.js'
import type { buildMessageLookups } from '../../../utils/messages.js'

export function useGetToolFromMessages(
  toolUseID: string,
  tools: Tools,
  lookups: ReturnType<typeof buildMessageLookups>,
): { tool: Tool; toolUse: ToolUseBlockParam } | null {
  return useMemo(() => {
    const toolUse = lookups.toolUseByToolUseID.get(toolUseID)
    if (!toolUse) {
      return null
    }
    return {
      tool: findRemoteDisplayTool(tools, toolUse.name),
      toolUse,
    }
  }, [toolUseID, lookups, tools])
}
