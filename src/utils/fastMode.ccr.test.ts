import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import axios from 'axios'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const savedEnv = { ...process.env }
const originalGet = axios.get
afterEach(() => {
  axios.get = originalGet
  process.env = { ...savedEnv }
})

test('CCR session asks the server with the injected OAuth token', async () => {
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_DISABLE_FAST_MODE',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'CLAUDE_CODE_USE_OPENAI',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ]) {
    delete process.env[key]
  }
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fast-ccr-'))
  process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'session-ingress-token'

  const calls: { url: string; auth?: string }[] = []
  axios.get = (async (url: string, config?: { headers?: Record<string, string> }) => {
    calls.push({ url, auth: config?.headers?.Authorization })
    return { data: { enabled: false, disabled_reason: 'extra_usage_disabled' } }
  }) as typeof axios.get

  const { setIsInteractive, setOauthTokenFromFd } = await import(
    '../bootstrap/state.js'
  )
  setIsInteractive(true)
  setOauthTokenFromFd('ccr-oauth-token')
  const { prefetchFastModeStatus, getFastModeDisabledReason } = await import(
    './fastMode.js'
  )
  await prefetchFastModeStatus()

  expect(calls).toHaveLength(1)
  expect(calls[0]!.url).toEndWith('/api/claude_code_penguin_mode')
  expect(calls[0]!.auth).toBe('Bearer ccr-oauth-token')
  expect(getFastModeDisabledReason()).toBe('extra_usage_disabled')
})
