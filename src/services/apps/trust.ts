import type { ScopedMcpServerConfig } from '../mcp/types.js'
import type { CodexAppsMcpConfig } from './types.js'

const HOST_OWNED_CODEX_APPS = Symbol('host-owned-codex-apps')

type TrustedCodexAppsConfig = CodexAppsMcpConfig & {
  [HOST_OWNED_CODEX_APPS]: true
}

export function markHostOwnedCodexAppsConfig(
  config: CodexAppsMcpConfig,
): ScopedMcpServerConfig {
  Object.defineProperty(config, HOST_OWNED_CODEX_APPS, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  })
  return config
}

export function isHostOwnedCodexAppsConfig(
  config: ScopedMcpServerConfig,
): config is TrustedCodexAppsConfig {
  return (config as TrustedCodexAppsConfig)[HOST_OWNED_CODEX_APPS] === true
}
