import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionMode } from '../../types/permissions.js'

const ALLOWED_AGENT_PERMISSION_MODES: Record<
  PermissionMode,
  ReadonlySet<PermissionMode>
> = {
  bypassPermissions: new Set([
    'bypassPermissions',
    'acceptEdits',
    'auto',
    'default',
    'dontAsk',
    'plan',
    'bubble',
  ]),
  acceptEdits: new Set(['acceptEdits', 'default', 'dontAsk', 'plan', 'bubble']),
  auto: new Set(['auto', 'acceptEdits', 'default', 'dontAsk', 'plan']),
  default: new Set(['default', 'dontAsk', 'plan', 'bubble']),
  bubble: new Set(['default', 'dontAsk', 'plan', 'bubble']),
  dontAsk: new Set(['dontAsk']),
  plan: new Set(['plan']),
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
  const mode = ALLOWED_AGENT_PERMISSION_MODES[context.mode].has(requestedMode)
    ? requestedMode
    : context.mode

  if (mode !== 'plan') {
    return mode === context.mode ? context : { ...context, mode }
  }
  if (
    context.mode === mode &&
    !context.isBypassPermissionsModeAvailable &&
    context.prePlanMode === undefined &&
    context.strippedDangerousRules === undefined
  ) {
    return context
  }

  return {
    ...context,
    mode,
    isBypassPermissionsModeAvailable: false,
    prePlanMode: undefined,
    strippedDangerousRules: undefined,
  }
}
