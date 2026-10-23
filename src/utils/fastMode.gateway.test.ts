import assert from 'node:assert/strict'
import test from 'node:test'
import axios from 'axios'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

test('fast mode prefetch does not send a gateway API key to api.anthropic.com', async () => {
  const saved = { ...process.env }
  const calls: string[] = []
  const originalGet = axios.get
  axios.get = (async (url: string) => {
    calls.push(url)
    return { data: { enabled: true, disabled_reason: null } }
  }) as typeof axios.get
  try {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com'
    process.env.ANTHROPIC_API_KEY = 'sk-gateway-key'
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE
    delete process.env.CLAUDE_CODE_USE_OPENAI
    const { prefetchFastModeStatus } = await import('./fastMode.js')
    await prefetchFastModeStatus()
    assert.deepEqual(calls, [])
  } finally {
    axios.get = originalGet
    process.env = saved
  }
})
