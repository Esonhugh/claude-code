import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionMode } from '../../types/permissions.js'
import { isPlanModeAvailable, PLAN_MODE_DISABLED_MESSAGE } from '../../utils/planModeV2.js'

const AGENT_PERMISSION_MODE_RANK: Record<PermissionMode, number> = {
  plan: 0,
  bubble: 1,
  default: 1,
  dontAsk: 1,
  acceptEdits: 2,
  auto: 3,
  bypassPermissions: 4,
}

export function shouldBubbleAgentPermissionPrompts(
  requestedMode: PermissionMode | undefined,
  effectiveMode: PermissionMode,
): boolean {
  return (
    requestedMode === 'bubble' &&
    effectiveMode !== 'plan' &&
    effectiveMode !== 'dontAsk'
  )
}

export function applyRequestedAgentPermissionMode(
  context: ToolPermissionContext,
  requestedMode: PermissionMode,
): ToolPermissionContext {
  const mode =
    context.mode === 'auto' && requestedMode === 'acceptEdits'
      ? context.mode
      : AGENT_PERMISSION_MODE_RANK[requestedMode] <=
          AGENT_PERMISSION_MODE_RANK[context.mode]
        ? requestedMode
        : context.mode

  if (mode === 'plan' && context.mode !== 'plan' && !isPlanModeAvailable()) {
    throw new Error(PLAN_MODE_DISABLED_MESSAGE)
  }
  return mode === context.mode ? context : { ...context, mode }
}
