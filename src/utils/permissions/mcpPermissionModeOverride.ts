import type { Tool, ToolUseContext } from '../../Tool.js'
import { PERMISSION_MODES } from '../../types/permissions.js'
import { normalizePermissionModeAlias } from './PermissionMode.js'

export type McpPermissionModeOverride = 'default' | 'auto'

const MAX_ASK_FOR_TOOLS = 32
const ASK_FOR_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Validates a set_mcp_permission_mode_override request like official 2.1.311:
 * the control channel may only pin a server to 'default' or 'auto', or clear
 * its pin with null.
 */
export function parseMcpPermissionModeOverride(request: {
  serverName?: unknown
  mode?: unknown
  askForTools?: unknown
}):
  | { serverName: string; override: McpPermissionModeOverride | undefined }
  | { error: string } {
  if (typeof request.serverName !== 'string') {
    return { error: 'set_mcp_permission_mode_override: serverName must be a string' }
  }
  let override: McpPermissionModeOverride | undefined
  if (request.mode !== null) {
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
    override = mode
  }
  // Official only reads askForTools for its Claude in Chrome host tools, which
  // this build doesn't have; malformed lists are still rejected like official.
  const { askForTools } = request
  if (
    askForTools !== undefined &&
    askForTools !== null &&
    (!Array.isArray(askForTools) ||
      askForTools.length > MAX_ASK_FOR_TOOLS ||
      !askForTools.every(
        entry =>
          typeof entry === 'object' &&
          entry !== null &&
          !Array.isArray(entry) &&
          typeof entry.name === 'string' &&
          ASK_FOR_TOOL_NAME.test(entry.name),
      ))
  ) {
    return {
      error: `set_mcp_permission_mode_override: askForTools must be a list of at most ${MAX_ASK_FOR_TOOLS} {name} entries, each name 1 to 64 letters, digits, underscores or hyphens`,
    }
  }
  return { serverName: request.serverName, override }
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
