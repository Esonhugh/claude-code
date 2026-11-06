import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

let userSettings: Record<string, unknown> | undefined
const updates: Record<string, unknown>[] = []
mock.module('../utils/settings/settings.js', () => ({
  getSettingsForSource: () => userSettings,
  updateSettingsForSource: (_source: string, patch: Record<string, unknown>) => {
    updates.push(patch)
  },
}))

const { migrateOpenAIModelToOwnSetting } = await import('./migrateOpenAIModelToOwnSetting.js')

const envKeys = ['CLAUDE_CODE_USE_OPENAI', 'ANTHROPIC_BASE_URL'] as const
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))

beforeEach(() => {
  userSettings = undefined
  updates.length = 0
  for (const key of envKeys) delete process.env[key]
})
afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('migrateOpenAIModelToOwnSetting', () => {
  test('moves an OpenAI model id out of the shared model key', () => {
    userSettings = { model: 'gpt-5.6-terra' }
    migrateOpenAIModelToOwnSetting()
    expect(updates).toEqual([{ openaiModel: 'gpt-5.6-terra', model: undefined }])
  })

  test('keeps an existing openaiModel', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    userSettings = { model: 'o3', openaiModel: 'gpt-6-astra' }
    migrateOpenAIModelToOwnSetting()
    expect(updates).toEqual([{ openaiModel: 'gpt-6-astra', model: undefined }])
  })

  test('leaves Claude models, aliases and custom gateways alone', () => {
    for (const model of ['opus', 'claude-opus-5-5', 'fable[1m]']) {
      userSettings = { model }
      migrateOpenAIModelToOwnSetting()
    }
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com'
    userSettings = { model: 'gpt-5.6-terra' }
    migrateOpenAIModelToOwnSetting()
    expect(updates).toEqual([])
  })
})
