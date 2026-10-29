import type { Tool, ToolUseContext } from '../../Tool.js'
import { PERMISSION_MODES } from '../../types/permissions.js'
import { normalizePermissionModeAlias } from './PermissionMode.js'

export type McpPermissionModeOverride = 'default' | 'auto'

/**
 * Validates a set_mcp_permission_mode_override request like official 2.1.311:
 * the control channel may only pin a server to 'default' or 'auto', or clear
 * its pin with null.
 */
export function parseMcpPermissionModeOverride(request: {
  serverName?: unknown
  mode?: unknown
}):
  | { serverName: string; override: McpPermissionModeOverride | undefined }
  | { error: string } {
  if (typeof request.serverName !== 'string') {
    return { error: 'set_mcp_permission_mode_override: serverName must be a string' }
  }
  if (request.mode === null) return { serverName: request.serverName, override: undefined }
  const mode =
    typeof request.mode === 'string'
      ? PERMISSION_MODES.find(m => m === normalizePermissionModeAlias(request.mode as string))
      : undefined
  if (mode === undefined) {
    return { error: `Cannot set permission mode: must be one of ${[...PERMISSION_MODES].sort().join(', ')}` }
  }
  if (mode !== 'default' && mode !== 'auto') {
    return {
      error: `Permission mode override over the control channel is tighten-only ('default', 'auto', or null); rejected '${mode}'`,
    }
  }
  return { serverName: request.serverName, override: mode }
}

/**
 * A pinned MCP server's tools run in its pinned mode while the session is in
 * bypassPermissions, auto, or plan with bypass available. Pins never widen a
 * stricter session mode.
 */
export function withMcpPermissionModeOverride(
  tool: Pick<Tool, 'mcpInfo'>,
  context: ToolUseContext,
): ToolUseContext {
  const serverName = tool.mcpInfo?.serverName
  if (serverName === undefined) return context
  const permissionContext = context.getAppState().toolPermissionContext
  const overrides = permissionContext.mcpPermissionModeOverrides
  const override =
    overrides && Object.hasOwn(overrides, serverName) ? overrides[serverName] : undefined
  const { mode } = permissionContext
  if (
    override === undefined ||
    !(
      mode === 'bypassPermissions' ||
      mode === 'auto' ||
      (mode === 'plan' && permissionContext.isBypassPermissionsModeAvailable)
    )
  ) {
    return context
  }
  return {
    ...context,
    getAppState: () => {
      const state = context.getAppState()
      return {
        ...state,
        toolPermissionContext: { ...state.toolPermissionContext, mode: override },
      }
    },
  }
}
