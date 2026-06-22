import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_CODEX_COMPACT_RETAINED_USER_MESSAGE_TOKENS,
  getCompactModeFromSettings,
  getCodexCompactOptionsFromSettings,
} from './compactMode.js'

describe('compact mode resolver', () => {
  test('defaults to claude mode when settings are empty', () => {
    expect(getCompactModeFromSettings({})).toBe('claude')
  })

  test('returns codex mode when explicitly configured', () => {
    expect(
      getCompactModeFromSettings({
        compact: { mode: 'codex' },
      }),
    ).toBe('codex')
  })

  test('returns codex defaults when codex options are omitted', () => {
    expect(
      getCodexCompactOptionsFromSettings({
        compact: { mode: 'codex' },
      }),
    ).toEqual({
      retainedUserMessageTokens:
        DEFAULT_CODEX_COMPACT_RETAINED_USER_MESSAGE_TOKENS,
      keepPostCompactAttachments: false,
    })
  })

  test('returns configured codex options', () => {
    expect(
      getCodexCompactOptionsFromSettings({
        compact: {
          mode: 'codex',
          codex: {
            retainedUserMessageTokens: 12000,
            keepPostCompactAttachments: true,
          },
        },
      }),
    ).toEqual({
      retainedUserMessageTokens: 12000,
      keepPostCompactAttachments: true,
    })
  })
})
