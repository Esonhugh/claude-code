import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionMode } from '../../types/permissions.js'
import { logForDebugging } from '../../utils/debug.js'
import { getAutoModeUnavailableReason } from '../../utils/permissions/permissionSetup.js'
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
): boolean {
  return requestedMode === 'bubble'
}

// Official 2.1.292: a definition's permissionMode never replaces a parent in
// bypassPermissions, acceptEdits or auto, never grants bypassPermissions,
// bubble keeps a plan/dontAsk parent's mode, and auto keeps the parent's mode
// while auto mode is unavailable.
export function resolveDeclaredAgentPermissionMode(
  parentMode: PermissionMode,
  declaredMode: PermissionMode | undefined,
): PermissionMode {
  if (
    !declaredMode ||
    parentMode === 'bypassPermissions' ||
    parentMode === 'acceptEdits' ||
    parentMode === 'auto' ||
    declaredMode === 'bypassPermissions' ||
    (declaredMode === 'bubble' &&
      (parentMode === 'plan' || parentMode === 'dontAsk'))
  ) {
    return parentMode
  }
  if (declaredMode === 'auto') {
    const reason = getAutoModeUnavailableReason()
    if (reason !== null) {
      logForDebugging(
        `Subagent definition's permissionMode would put it in auto mode, but auto mode is unavailable to this subagent (reason=${reason}); keeping parent mode '${parentMode}'.`,
        { level: 'warn' },
      )
      return parentMode
    }
  }
  return declaredMode
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
