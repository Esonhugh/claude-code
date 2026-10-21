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
): boolean {
  return requestedMode === 'bubble'
}

// Official 2.1.292: a definition's permissionMode never replaces a parent in
// bypassPermissions, acceptEdits or auto, never grants bypassPermissions, and
// bubble keeps a plan/dontAsk parent's mode.
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
  return declaredMode
}

// An explicit Agent/workflow mode is a ceiling: the agent runs in the
// requested mode while the parent's mode ranks at least as high, otherwise in
// the parent's mode. Re-evaluated against the parent's current mode, so the
// agent follows the parent widening (up to the ceiling) and narrowing.
export function capAgentPermissionMode(
  parentMode: PermissionMode,
  requestedMode: PermissionMode,
): PermissionMode {
  if (parentMode === 'auto' && requestedMode === 'acceptEdits') return parentMode
  return AGENT_PERMISSION_MODE_RANK[requestedMode] <=
    AGENT_PERMISSION_MODE_RANK[parentMode]
    ? requestedMode
    : parentMode
}

export function applyRequestedAgentPermissionMode(
  context: ToolPermissionContext,
  requestedMode: PermissionMode,
): ToolPermissionContext {
  const mode = capAgentPermissionMode(context.mode, requestedMode)

  if (mode === 'plan' && context.mode !== 'plan' && !isPlanModeAvailable()) {
    throw new Error(PLAN_MODE_DISABLED_MESSAGE)
  }
  return mode === context.mode ? context : { ...context, mode }
}
