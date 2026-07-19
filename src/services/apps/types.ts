import type { ScopedMcpServerConfig } from '../mcp/types.js'

export const CODEX_APPS_SERVER_NAME = 'codex_apps'
export const CODEX_APPS_PLUGIN_RUNTIME_SERVER_NAME = 'codex_apps_plugins'
export const CODEX_APPS_MCP_URL =
  'https://chatgpt.com/backend-api/wham/apps'
export const CODEX_APPS_PLUGIN_RUNTIME_MCP_URL =
  'https://chatgpt.com/backend-api/ps/mcp'

export const CODEX_APPS_SERVER_NAMES = [
  CODEX_APPS_SERVER_NAME,
  CODEX_APPS_PLUGIN_RUNTIME_SERVER_NAME,
] as const

export type CodexAppsServerName = (typeof CODEX_APPS_SERVER_NAMES)[number]
export type CodexAppsSourceKind = 'connectors' | 'plugins'

export type CodexAppsConnectorInfo = {
  id?: string
  name?: string
  description?: string
}

/**
 * The wire shape intentionally remains an ordinary HTTP MCP config. Trust is
 * carried separately by an unexported symbol in trust.ts, so settings and
 * .mcp.json cannot opt themselves into the host-owned code path.
 */
export type CodexAppsMcpConfig = ScopedMcpServerConfig & {
  type: 'http'
  url:
    | typeof CODEX_APPS_MCP_URL
    | typeof CODEX_APPS_PLUGIN_RUNTIME_MCP_URL
}

export type CodexAppsEligibility =
  | { eligible: true }
  | {
      eligible: false
      reason:
        | 'feature-disabled'
        | 'provider-not-openai'
        | 'chatgpt-oauth-required'
    }
