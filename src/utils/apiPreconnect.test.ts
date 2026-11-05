import { afterEach, expect, test } from 'bun:test'

const saved = { ...process.env }
const originalFetch = globalThis.fetch
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key]
  }
  Object.assign(process.env, saved)
  globalThis.fetch = originalFetch
})

// `fired` is module state: each case gets its own module instance.
async function preconnectWith(env: Record<string, string | undefined>) {
  for (const key of [
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_OPENAI',
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'ANTHROPIC_UNIX_SOCKET',
    'CLAUDE_CODE_CLIENT_CERT',
    'CLAUDE_CODE_CLIENT_KEY',
  ]) {
    delete process.env[key]
  }
  Object.assign(process.env, env)
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input))
    return new Response(null)
  }) as typeof fetch
  const { preconnectAnthropicApi } = await import(
    `./apiPreconnect.js?case=${Math.random()}`
  )
  preconnectAnthropicApi()
  return calls
}

test('preconnects to the Anthropic API by default', async () => {
  const calls = await preconnectWith({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/' })
  expect(calls).toEqual(['http://127.0.0.1:1/'])
})

test('skips the preconnect for the OpenAI provider (#807)', async () => {
  const calls = await preconnectWith({
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/',
    CLAUDE_CODE_USE_OPENAI: '1',
  })
  expect(calls).toEqual([])
})
