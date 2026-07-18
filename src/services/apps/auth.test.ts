import assert from 'node:assert/strict'
import test from 'node:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalUseOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalDisableCodexApps = process.env.CLAUDE_CODE_DISABLE_CODEX_APPS
const authModule = await import('../../utils/auth.js')
const { getCodexAppsEligibility, requireCodexAppsOAuth } = await import(
  './auth.js'
)

function setAuthState({
  current,
  chatgpt,
}: {
  current: ReturnType<typeof authModule.getOpenAIAuthInfo>
  chatgpt: ReturnType<typeof authModule.getChatGPTOAuthInfo>
}): void {
  authModule.getOpenAIAuthInfo.cache.set(undefined, current)
  authModule.getChatGPTOAuthInfo.cache.set(undefined, chatgpt)
}

test('Codex Apps follows the credential selected for model requests', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_DISABLE_CODEX_APPS

  const chatgpt = {
    accessToken: 'chatgpt-token',
    accountId: 'account-123',
    isChatGPT: true,
  }

  try {
    setAuthState({
      current: { accessToken: 'dummy-api-key', isChatGPT: false },
      chatgpt,
    })
    assert.deepEqual(getCodexAppsEligibility(), {
      eligible: false,
      reason: 'chatgpt-oauth-required',
    })
    await assert.rejects(
      requireCodexAppsOAuth(),
      /requires ChatGPT OAuth authentication/,
    )

    setAuthState({ current: chatgpt, chatgpt })
    assert.deepEqual(getCodexAppsEligibility(), { eligible: true })
  } finally {
    authModule.getOpenAIAuthInfo.cache.clear?.()
    authModule.getChatGPTOAuthInfo.cache.clear?.()
    if (originalUseOpenAI === undefined) {
      delete process.env.CLAUDE_CODE_USE_OPENAI
    } else {
      process.env.CLAUDE_CODE_USE_OPENAI = originalUseOpenAI
    }
    if (originalDisableCodexApps === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_CODEX_APPS
    } else {
      process.env.CLAUDE_CODE_DISABLE_CODEX_APPS = originalDisableCodexApps
    }
  }
})
