import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as auth from 'src/utils/auth.js'
import * as config from 'src/utils/config.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const { getAPIMetadata } = await import('./claude.js')

const ENV_KEYS = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_OPENAI', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_EXTRA_METADATA'] as const
const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
const spies: { mockRestore(): void }[] = []

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  spies.push(
    spyOn(config, 'getOrCreateUserID').mockReturnValue('fixture-device'),
    spyOn(auth, 'getOauthAccountInfo').mockReturnValue({ accountUuid: 'fixture-account' } as never),
  )
})

afterEach(() => {
  spies.splice(0).forEach(spy => spy.mockRestore())
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

const userId = () => JSON.parse(getAPIMetadata().user_id) as Record<string, string>

test('a first-party session keeps the device and account ids', () => {
  expect(userId()).toMatchObject({ device_id: 'fixture-device', account_uuid: 'fixture-account' })
  expect(userId().session_id).toBeString()
})

test.each([
  ['a gateway base URL', 'ANTHROPIC_BASE_URL', 'https://gateway.example.com'],
  ['Bedrock', 'CLAUDE_CODE_USE_BEDROCK', '1'],
  ['Vertex', 'CLAUDE_CODE_USE_VERTEX', '1'],
] as const)('%s gets only the session and the extra metadata', (_label, key, value) => {
  process.env[key] = value
  process.env.CLAUDE_CODE_EXTRA_METADATA = '{"team":"fixture"}'
  expect(Object.keys(userId()).sort()).toEqual(['session_id', 'team'])
})
