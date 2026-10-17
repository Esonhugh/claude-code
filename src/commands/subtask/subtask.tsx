import type { ReactNode } from 'react'
import { FORK_GLYPH } from '../../constants/figures.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import { launchConversationFork } from '../../utils/conversationFork.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<ReactNode> {
  const directive = args.trim()
  if (!directive) {
    onDone('Usage: /subtask \\<task\\>', { display: 'system' })
    return null
  }
  const result = await launchConversationFork(
    directive, context, context.canUseTool ?? hasPermissionsToUseTool,
  )
  if (!result) {
    onDone(isCoordinatorMode()
      ? 'Subtasks are not available in coordinator sessions. Use /branch instead.'
      : 'Cannot start a subtask before the first conversation turn', { display: 'system' })
    return null
  }
  onDone(`${FORK_GLYPH} forked ${result.name} (${result.agentId.slice(-4)})`, { display: 'system' })
  return null
}
