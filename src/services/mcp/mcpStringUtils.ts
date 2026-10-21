/**
 * Pure string utility functions for MCP tool/server name parsing.
 * This file has no heavy dependencies to keep it lightweight for
 * consumers that only need string parsing (e.g., permissionValidation).
 */

import { normalizeNameForMCP } from './normalization.js'

/*
 * Extracts MCP server information from a tool name string
 * @param toolString The string to parse. Expected format: "mcp__serverName__toolName"
 * @returns An object containing server name and optional tool name, or null if not a valid MCP rule
 *
 * Splits at the first "__" after the prefix, so "mcp__my__server__tool" parses as
 * server="my" and tool="server__tool" even when the server is named "my__server".
 * Permission matching that must know the real server uses getMcpServerRuleNames().
 */
export function mcpInfoFromString(toolString: string): {
  serverName: string
  toolName: string | undefined
} | null {
  const parts = toolString.split('__')
  const [mcpPart, serverName, ...toolNameParts] = parts
  if (mcpPart !== 'mcp' || !serverName) {
    return null
  }
  // Join all parts after server name to preserve double underscores in tool names
  const toolName =
    toolNameParts.length > 0 ? toolNameParts.join('__') : undefined
  return { serverName, toolName }
}

/**
 * The server-level rule names ("mcp__<server>") that can address a tool's server.
 * With mcpInfo the server is known: its whole normalized name, plus the first
 * "__" segment that mcpInfoFromString() reads from the tool name. Without it,
 * any "__" may end the server name, so every such prefix of the tool name.
 */
export function getMcpServerRuleNames(tool: {
  name: string
  mcpInfo?: { serverName: string }
}): string[] {
  if (tool.mcpInfo) {
    const prefix = getMcpPrefix(tool.mcpInfo.serverName)
    const firstSegment = mcpInfoFromString(`${prefix}x`)?.serverName
    const names = [prefix.slice(0, -2)]
    if (firstSegment !== undefined) names.push(`mcp__${firstSegment}`)
    return names
  }
  const names: string[] = []
  if (!tool.name.startsWith('mcp__')) return names
  for (
    let end = tool.name.indexOf('__', 'mcp__'.length);
    end !== -1;
    end = tool.name.indexOf('__', end + 1)
  ) {
    names.push(tool.name.slice(0, end))
  }
  return names
}

/**
 * Generates the MCP tool/command name prefix for a given server
 * @param serverName Name of the MCP server
 * @returns The prefix string
 */
export function getMcpPrefix(serverName: string): string {
  return `mcp__${normalizeNameForMCP(serverName)}__`
}

/**
 * Builds a fully qualified MCP tool name from server and tool names.
 * Inverse of mcpInfoFromString().
 * @param serverName Name of the MCP server (unnormalized)
 * @param toolName Name of the tool (unnormalized)
 * @returns The fully qualified name, e.g., "mcp__server__tool"
 */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${getMcpPrefix(serverName)}${normalizeNameForMCP(toolName)}`
}

/**
 * Returns the name to use for permission rule matching.
 * For MCP tools, uses the fully qualified mcp__server__tool name so that
 * deny rules targeting builtins (e.g., "Write") don't match unprefixed MCP
 * replacements that share the same display name. Falls back to `tool.name`.
 */
export function getToolNameForPermissionCheck(tool: {
  name: string
  mcpInfo?: {
    serverName: string
    toolName: string
    permissionToolName?: string
  }
}): string {
  return tool.mcpInfo
    ? buildMcpToolName(
        tool.mcpInfo.serverName,
        tool.mcpInfo.permissionToolName ?? tool.mcpInfo.toolName,
      )
    : tool.name
}

/*
 * Extracts the display name from an MCP tool/command name
 * @param fullName The full MCP tool/command name (e.g., "mcp__server_name__tool_name")
 * @param serverName The server name to remove from the prefix
 * @returns The display name without the MCP prefix
 */
export function getMcpDisplayName(
  fullName: string,
  serverName: string,
): string {
  const prefix = `mcp__${normalizeNameForMCP(serverName)}__`
  return fullName.replace(prefix, '')
}

/**
 * Extracts just the tool/command display name from a userFacingName
 * @param userFacingName The full user-facing name (e.g., "github - Add comment to issue (MCP)")
 * @returns The display name without server prefix and (MCP) suffix
 */
export function extractMcpToolDisplayName(userFacingName: string): string {
  // This is really ugly but our current Tool type doesn't make it easy to have different display names for different purposes.

  // First, remove the (MCP) suffix if present
  let withoutSuffix = userFacingName.replace(/\s*\(MCP\)\s*$/, '')

  // Trim the result
  withoutSuffix = withoutSuffix.trim()

  // Then, remove the server prefix (everything before " - ")
  const dashIndex = withoutSuffix.indexOf(' - ')
  if (dashIndex !== -1) {
    const displayName = withoutSuffix.substring(dashIndex + 3).trim()
    return displayName
  }

  // If no dash found, return the string without (MCP)
  return withoutSuffix
}
