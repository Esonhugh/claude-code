import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

let settingsModel: string | null | undefined
const settings = await import('../settings/settings.js')
mock.module('../settings/settings.js', () => ({
  ...settings,
  getSettings_DEPRECATED: () => ({ model: settingsModel }),
  getSettings: () => ({}),
}))
const auth = await import('../auth.js')
mock.module('../auth.js', () => ({
  ...auth,
  getSubscriptionType: () => null,
  isClaudeAISubscriber: () => false,
  isMaxSubscriber: () => false,
  isProSubscriber: () => false,
  isTeamPremiumSubscriber: () => false,
}))

let teammateDefaultModel: string | null | undefined
const config = await import('../config.js')
mock.module('../config.js', () => ({
  ...config,
  getGlobalConfig: () => ({ teammateDefaultModel }),
}))
const { resolveTeammateModel } = await import('../swarm/teammateModel.js')
const { getDefaultMainLoopModel } = await import('./model.js')
const { getAgentModel } = await import('./agent.js')
const { setMainLoopModelOverride } = await import('../../bootstrap/state.js')
const envKeys = [
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_MODEL',
] as const
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
beforeEach(() => {
  teammateDefaultModel = undefined
  settingsModel = undefined
  for (const key of envKeys) delete process.env[key]
  setMainLoopModelOverride(undefined)
})
afterEach(() => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  setMainLoopModelOverride(undefined)
})

describe('named teammate model selection', () => {
  test('env > tool > definition > config > explicit parent > provider default', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'env-model'
    teammateDefaultModel = 'config-model'
    setMainLoopModelOverride('explicit-parent')
    expect(resolveTeammateModel('tool-model', 'effective-parent', 'definition-model')).toBe('env-model')
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    expect(resolveTeammateModel('tool-model', 'effective-parent', 'definition-model')).toBe('tool-model')
    expect(resolveTeammateModel(undefined, 'effective-parent', 'definition-model')).toBe('definition-model')
    expect(resolveTeammateModel(undefined, 'effective-parent')).toBe('config-model')
    teammateDefaultModel = undefined
    expect(resolveTeammateModel(undefined, 'effective-parent')).toBe('effective-parent')
    setMainLoopModelOverride(undefined)
    expect(resolveTeammateModel(undefined, 'effective-parent')).toBe(getDefaultMainLoopModel())
  })

  test('inherit and config null terminate fallback at the effective parent', () => {
    teammateDefaultModel = 'config-model'
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'inherit'
    expect(resolveTeammateModel('tool-model', 'parent', 'definition-model')).toBe('parent')
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    expect(resolveTeammateModel('inherit', 'parent', 'definition-model')).toBe('parent')
    expect(resolveTeammateModel(undefined, 'parent', 'inherit')).toBe('parent')
    teammateDefaultModel = null
    expect(resolveTeammateModel(undefined, 'parent')).toBe('parent')
    expect(getAgentModel(undefined, 'parent')).toBe('parent')
    teammateDefaultModel = 'config-model'
    expect(getAgentModel(undefined, 'parent')).toBe('parent')
  })

  test('explicit Anthropic-protocol GPT parent is inherited, even if equal to default', () => {
    setMainLoopModelOverride('gpt-5.6-sol')
    expect(resolveTeammateModel(undefined, 'gpt-5.6-sol')).toBe('gpt-5.6-sol')
    setMainLoopModelOverride(getDefaultMainLoopModel())
    expect(resolveTeammateModel(undefined, getDefaultMainLoopModel())).toBe(getDefaultMainLoopModel())
    setMainLoopModelOverride(null)
    expect(resolveTeammateModel(undefined, 'stale-parent')).toBe(getDefaultMainLoopModel())
  })

  test('parent env/settings identify explicit intent but inheritance uses the effective context', () => {
    process.env.ANTHROPIC_MODEL = 'env-parent'
    expect(resolveTeammateModel(undefined, 'effective-parent')).toBe('effective-parent')
    delete process.env.ANTHROPIC_MODEL
    settingsModel = 'settings-parent'
    expect(resolveTeammateModel(undefined, 'effective-parent')).toBe('effective-parent')
    settingsModel = null
    expect(resolveTeammateModel(undefined, 'effective-parent')).toBe(getDefaultMainLoopModel())
  })

  test('native OpenAI defaults and aliases use the provider mappings', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    expect(resolveTeammateModel(undefined, 'unused-parent')).toBe('gpt-5.6-sol')
    expect(resolveTeammateModel('opus', 'unused-parent')).toBe('gpt-5.6-sol')
    expect(resolveTeammateModel('sonnet', 'unused-parent')).toBe('gpt-5.6-terra')
    expect(resolveTeammateModel('haiku', 'unused-parent')).toBe('gpt-5.6-luna')
  })
})

describe('ordinary agent model selection', () => {
  test('env > tool > definition > effective parent; full IDs retain case', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'ENV/Custom-ID'
    expect(getAgentModel('definition', 'parent', 'tool')).toBe('ENV/Custom-ID')
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    expect(getAgentModel('definition', 'parent', 'Tool/Custom-ID')).toBe('Tool/Custom-ID')
    expect(getAgentModel('definition', 'parent')).toBe('definition')
    expect(getAgentModel(undefined, 'parent')).toBe('parent')
    expect(getAgentModel('definition', 'parent', 'inherit')).toBe('parent')
  })

  for (const alias of ['opus', 'sonnet', 'haiku'] as const) {
    test(`${alias} honors explicit alias env even for same-tier parent`, () => {
      const parent = `claude-${alias}-custom-version`
      expect(getAgentModel(alias, parent)).toBe(parent)
      process.env[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`] = `${alias}-configured`
      expect(getAgentModel(alias, parent)).toBe(`${alias}-configured`)
      expect(getAgentModel(undefined, parent, alias)).toBe(`${alias}-configured`)
      process.env.CLAUDE_CODE_SUBAGENT_MODEL = alias
      expect(getAgentModel(undefined, parent)).toBe(`${alias}-configured`)
    })
  }

  test('inherit retains parent plan-mode resolution', () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'plan-opus'
    setMainLoopModelOverride('opusplan')
    expect(getAgentModel(undefined, 'parent-sonnet', 'inherit', 'plan')).toBe('plan-opus')
    expect(getAgentModel(undefined, 'parent-sonnet', 'inherit', 'default')).toBe('parent-sonnet')
  })

  test('Bedrock aliases inherit parent region; explicit full IDs retain their region', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0'
    const parent = 'eu.anthropic.claude-opus-4-6-v1'
    expect(getAgentModel('haiku', parent)).toStartWith('eu.anthropic.')
    expect(getAgentModel(undefined, parent, 'us.anthropic.claude-sonnet-4-6')).toBe('us.anthropic.claude-sonnet-4-6')
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'haiku'
    expect(getAgentModel(undefined, parent)).toStartWith('eu.anthropic.')
  })

  test('env inherit stops fallback to tool and definition models', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'inherit'
    expect(getAgentModel('definition-model', 'parent-model', 'tool-model')).toBe('parent-model')
  })
})
