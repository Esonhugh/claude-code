import type { ScopedMcpServerConfig } from '../mcp/types.js'
import type {
  CodexAppsMcpConfig,
  CodexAppsSourceKind,
} from './types.js'

const HOST_OWNED_CODEX_APPS = Symbol('host-owned-codex-apps')

type TrustedCodexAppsConfig = CodexAppsMcpConfig & {
  [HOST_OWNED_CODEX_APPS]: CodexAppsSourceKind
}

export function markHostOwnedCodexAppsConfig(
  config: CodexAppsMcpConfig,
  kind: CodexAppsSourceKind = 'connectors',
): ScopedMcpServerConfig {
  Object.defineProperty(config, HOST_OWNED_CODEX_APPS, {
    configurable: false,
    enumerable: false,
    value: kind,
    writable: false,
  })
  return config
}

export function getHostOwnedCodexAppsKind(
  config: ScopedMcpServerConfig,
): CodexAppsSourceKind | undefined {
  const kind = (config as TrustedCodexAppsConfig)[HOST_OWNED_CODEX_APPS]
  return kind === 'connectors' || kind === 'plugins' ? kind : undefined
}

export function isHostOwnedCodexAppsConfig(
  config: ScopedMcpServerConfig,
): config is TrustedCodexAppsConfig {
  return getHostOwnedCodexAppsKind(config) !== undefined
}
