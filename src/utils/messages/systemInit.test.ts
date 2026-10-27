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

test('omits hidden and non-invocable commands from system init discovery', () => {
  const message = buildSystemInitMessage({
    ...baseInputs,
    commands: [
      { name: 'default-visible' },
      { name: 'visible', userInvocable: true },
      { name: 'hidden', isHidden: true },
      { name: 'internal', userInvocable: false },
      { name: 'hidden-internal', userInvocable: false, isHidden: true },
    ],
  })

  expect(message).toMatchObject({
    type: 'system',
    subtype: 'init',
    slash_commands: ['default-visible', 'visible'],
  })
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
