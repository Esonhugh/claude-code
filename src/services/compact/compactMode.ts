import type { SettingsJson } from '../../utils/settings/types.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

export type CompactMode = 'claude' | 'codex'

export const DEFAULT_CODEX_COMPACT_RETAINED_USER_MESSAGE_TOKENS = 20_000

export type CodexCompactOptions = {
  retainedUserMessageTokens: number
  keepPostCompactAttachments: boolean
}

export function getCompactModeFromSettings(settings: SettingsJson): CompactMode {
  return settings.compact?.mode === 'codex' ? 'codex' : 'claude'
}

export function getCompactMode(): CompactMode {
  return getCompactModeFromSettings(getInitialSettings())
}

export function getCodexCompactOptionsFromSettings(
  settings: SettingsJson,
): CodexCompactOptions {
  return {
    retainedUserMessageTokens:
      settings.compact?.codex?.retainedUserMessageTokens ??
      DEFAULT_CODEX_COMPACT_RETAINED_USER_MESSAGE_TOKENS,
    keepPostCompactAttachments:
      settings.compact?.codex?.keepPostCompactAttachments ?? false,
  }
}

export function getCodexCompactOptions(): CodexCompactOptions {
  return getCodexCompactOptionsFromSettings(getInitialSettings())
}
