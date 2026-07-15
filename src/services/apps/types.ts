import type { ScopedMcpServerConfig } from '../mcp/types.js'

export const CODEX_APPS_SERVER_NAME = 'codex_apps'
export const CODEX_APPS_MCP_URL =
  'https://chatgpt.com/backend-api/wham/apps'

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
  url: typeof CODEX_APPS_MCP_URL
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
