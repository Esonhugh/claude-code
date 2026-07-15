import type { ScopedMcpServerConfig } from '../mcp/types.js'
import { logForDebugging } from '../../utils/debug.js'
import { getCodexAppsEligibility } from './auth.js'
import { markHostOwnedCodexAppsConfig } from './trust.js'
import {
  CODEX_APPS_MCP_URL,
  CODEX_APPS_SERVER_NAME,
  type CodexAppsMcpConfig,
} from './types.js'

export type CodexAppsToolSetOptions = {
  include?: boolean
}

/**
 * Materializes the host-owned Apps MCP ToolSet into the existing MCP runtime.
 * It intentionally overwrites an untrusted config using the reserved name.
 */
export function withCodexAppsToolSet(
  configs: Record<string, ScopedMcpServerConfig>,
  { include = true }: CodexAppsToolSetOptions = {},
): Record<string, ScopedMcpServerConfig> {
  if (!include) {
    logForDebugging('[Codex Apps] ToolSet registration skipped: batch-excluded')
    return configs
  }
  const eligibility = getCodexAppsEligibility()
  if (!eligibility.eligible) {
    logForDebugging(
      `[Codex Apps] ToolSet registration skipped: ${eligibility.reason}`,
    )
    return configs
  }

  const appsConfig: CodexAppsMcpConfig = {
    type: 'http',
    url: CODEX_APPS_MCP_URL,
    scope: 'dynamic',
  }
  logForDebugging('[Codex Apps] Host-owned ToolSet registration materialized')
  return {
    ...configs,
    [CODEX_APPS_SERVER_NAME]: markHostOwnedCodexAppsConfig(appsConfig),
  }
}
