import { afterAll, expect, test } from 'bun:test'
import type { SDKSystemMessage } from 'src/entrypoints/sdk/coreTypes.generated.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const previousApiKey = process.env.ANTHROPIC_API_KEY
process.env.ANTHROPIC_API_KEY = 'test-only'
const { buildSystemInitMessage } = await import('./systemInit.js')

afterAll(() => {
  if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = previousApiKey
})

const baseInputs = {
  tools: [],
  mcpClients: [],
  model: 'test-model',
  permissionMode: 'default' as const,
  agents: [],
  skills: [],
  plugins: [],
  fastMode: undefined,
}

test('lists hidden commands but omits non-invocable ones like official', () => {
  const message = buildSystemInitMessage({
    ...baseInputs,
    commands: [
      { name: 'default-visible' },
      { name: 'visible', userInvocable: true },
      { name: 'internal', userInvocable: false },
      { name: 'doctor', terminalOriented: true },
    ],
    capabilities: ['interrupt_receipt_v1'],
  })

  expect(message).toMatchObject({
    type: 'system',
    subtype: 'init',
    slash_commands: ['default-visible', 'visible', 'doctor'],
    terminal_slash_commands: ['doctor'],
    capabilities: ['interrupt_receipt_v1'],
  })
})

test('omits terminal_slash_commands and capabilities when empty', () => {
  const message = buildSystemInitMessage({
    ...baseInputs,
    commands: [{ name: 'visible' }],
  }) as SDKSystemMessage

  expect(message.terminal_slash_commands).toBeUndefined()
  expect(message.capabilities).toBeUndefined()
})

test('reports original_cwd and the auto-memory path like official', () => {
  const previous = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '0'
  const message = buildSystemInitMessage({ ...baseInputs, commands: [] }) as SDKSystemMessage
  if (previous === undefined) delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  else process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = previous
  expect(message.original_cwd).toBe(process.cwd())
  expect(message.memory_paths?.auto).toEndWith('/memory/')
})

test('lists agents in name order like official', () => {
  const message = buildSystemInitMessage({
    ...baseInputs,
    commands: [],
    agents: [{ agentType: 'general-purpose' }, { agentType: 'statusline-setup' }, { agentType: 'Explore' }, { agentType: 'Plan' }],
  }) as SDKSystemMessage
  expect(message.agents).toEqual(['Explore', 'general-purpose', 'Plan', 'statusline-setup'])
})

// Official 2.1.319 / SDK 0.3.318: init.plugins[].version is the manifest version, verbatim.
test('lists the manifest version of each plugin when it declares one', () => {
  const message = buildSystemInitMessage({
    ...baseInputs,
    commands: [],
    plugins: [
      { name: 'hm', path: '/p/hm', source: 'hm@inline', manifest: { version: '0.1.0' } },
      { name: 'bare', path: '/p/bare', source: 'bare@inline', manifest: {} },
    ],
  }) as SDKSystemMessage & { plugins: unknown[] }
  expect(message.plugins).toEqual([
    { name: 'hm', path: '/p/hm', source: 'hm@inline', version: '0.1.0' },
    { name: 'bare', path: '/p/bare', source: 'bare@inline' },
  ])
})

// Official 2.1.329 sends both whenever per-turn effort is decided; this
// build's ultrathink never raises the request to xhigh.
test('reports ultrathink as not raising the turn', () => {
  const message = buildSystemInitMessage({ ...baseInputs, commands: [] }) as SDKSystemMessage
  expect(message.ultrathink_available).toBe(false)
  expect(message.ultrathink_typed_raises).toBe(false)
})

test('reports served_by_anthropic from the provider, base URL and socket like official', () => {
  const keys = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_UNIX_SOCKET', 'CLAUDE_CODE_USE_BEDROCK'] as const
  const saved = keys.map(key => process.env[key])
  const served = (env: Partial<Record<(typeof keys)[number], string>>) => {
    for (const key of keys) {
      if (env[key] === undefined) delete process.env[key]
      else process.env[key] = env[key]
    }
    return (buildSystemInitMessage({ ...baseInputs, commands: [] }) as SDKSystemMessage).served_by_anthropic
  }
  try {
    expect(served({})).toBe(true)
    expect(served({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })).toBe(true)
    expect(served({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080' })).toBe(false)
    expect(served({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe(false)
    expect(served({ ANTHROPIC_UNIX_SOCKET: '/tmp/claude.sock' })).toBeUndefined()
  } finally {
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key]
      else process.env[key] = saved[i]
    })
  }
})
