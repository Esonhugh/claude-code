import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import axios from 'axios'
import * as auth from 'src/utils/auth.js'
import * as config from 'src/utils/config.js'
import { getOauthProfileFromApiKey } from './getOauthProfile.js'

const ENV_KEYS = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_OPENAI', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'] as const
const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
const spies: { mockRestore(): void }[] = []
let get: ReturnType<typeof spyOn>

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  get = spyOn(axios, 'get').mockResolvedValue({ data: { account: {} } } as never)
  spies.push(
    get,
    spyOn(auth, 'getAnthropicApiKey').mockReturnValue('fixture-only'),
    spyOn(config, 'getGlobalConfig').mockReturnValue({ oauthAccount: { accountUuid: 'fixture-account' } } as never),
  )
})

afterEach(() => {
  spies.splice(0).forEach(spy => spy.mockRestore())
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

test('a first-party session looks up the profile with its API key', async () => {
  expect(await getOauthProfileFromApiKey()).toEqual({ account: {} } as never)
  expect(get).toHaveBeenCalledTimes(1)
})

test.each([
  ['a gateway base URL', 'ANTHROPIC_BASE_URL', 'https://gateway.example.com'],
  ['the OpenAI provider', 'CLAUDE_CODE_USE_OPENAI', '1'],
  ['Bedrock', 'CLAUDE_CODE_USE_BEDROCK', '1'],
] as const)('%s never sends its API key to Anthropic', async (_label, key, value) => {
  process.env[key] = value
  expect(await getOauthProfileFromApiKey()).toBeUndefined()
  expect(get).not.toHaveBeenCalled()
})
